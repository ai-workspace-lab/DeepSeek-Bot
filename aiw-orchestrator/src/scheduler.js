// The worker loop: claim a run from Accounts, select its role, executor and model, run it
// on one DSH subagent, and append fenced events until it settles. Accounts stays the only
// durable task state; this loop keeps nothing a restart would need.
import { LeaseLostError } from './accounts.js'
import { decisionSummary, select } from './selector.js'
import { withMemory } from './memory.js'

export const PHASE = { rejected: 'rejected', selected: 'selected', memory: 'memory', memoryUnavailable: 'memory_unavailable', started: 'started' }
const RECORD_TEXT_MAX = 2_000

const wait = (ms, signal) => new Promise((resolve) => {
  if (signal?.aborted) return resolve()
  const timer = setTimeout(resolve, ms)
  signal?.addEventListener('abort', () => {
    clearTimeout(timer)
    resolve()
  }, { once: true })
})

const trim = value => (typeof value === 'string' ? value.trim() : '')

// The run names a workspace by key; only this host's configuration turns a key into a
// directory, so a message can never point an executor at a path of its choosing.
export function workspaceDirectory(workspaces, key) {
  const name = trim(key)
  return name && Object.hasOwn(workspaces ?? {}, name) ? workspaces[name] : ''
}

export function selectionRequest(message, availableProviders, now, workspaces) {
  const routing = message.routing ?? {}
  const text = message.text
  return {
    role: trim(routing.role),
    roleMode: trim(routing.roleMode),
    manualModel: trim(routing.roleModel),
    productMode: trim(routing.productMode),
    specialty: trim(routing.specialty),
    dataClass: trim(routing.dataClass),
    workingDirectory: workspaceDirectory(workspaces, routing.workspace),
    promptBytes: Buffer.byteLength(text, 'utf8'),
    promptChars: [...text].length,
    attachments: Number.isInteger(routing.attachments) ? routing.attachments : 0,
    followUp: routing.followUp === true,
    previousTurnFailed: routing.previousTurnFailed === true,
    availableProviders,
    now,
  }
}

export class Scheduler {
  constructor({ accounts, policy, catalogs, dispatcher, memory, workspaces = {}, log = () => {}, now = Date.now, leaseTtlSeconds = 60, renewEveryMs = 20_000, pollIntervalMs = 2_000 }) {
    Object.assign(this, { accounts, policy, catalogs, dispatcher, memory, workspaces, log, now, leaseTtlSeconds, renewEveryMs, pollIntervalMs })
    this.stopping = undefined
    this.loop = undefined
  }

  start() {
    if (this.loop) return
    this.stopping = new AbortController()
    this.loop = this.runLoop(this.stopping.signal)
  }

  async stop() {
    this.stopping?.abort()
    await this.loop
    this.loop = undefined
  }

  async runLoop(signal) {
    while (!signal.aborted) {
      let claimed
      try {
        claimed = await this.accounts.claim(this.leaseTtlSeconds)
      } catch (error) {
        this.log('warn', 'claim_failed', { error: error.message })
      }
      if (claimed) await this.process(claimed, signal)
      else await wait(this.pollIntervalMs, signal)
    }
  }

  // Processes one claimed run to a terminal event, or stops quietly once the lease is lost:
  // another worker owns the run then, and anything this one appended would be fenced out.
  async process({ run, message }, stopSignal) {
    const lease = { lost: false, expiresAt: Date.parse(run.leaseExpiresAt) || this.now() + this.leaseTtlSeconds * 1000 }
    let step = 0
    const append = async (type, payload) => {
      if (lease.lost) return
      try {
        await this.accounts.appendEvent(run, { type, payload, clientRequestId: `${run.id}:${run.fence}:${++step}` })
      } catch (error) {
        if (error instanceof LeaseLostError) {
          lease.lost = true
          this.log('warn', 'lease_lost', { run: run.id })
          return
        }
        throw error
      }
    }

    try {
      await this.execute({ run, message, lease, append, stopSignal })
    } catch (error) {
      this.log('error', 'run_failed', { run: run.id, error: error.message })
      await append('run.failed', { code: 'ORCHESTRATOR_ERROR', error: error.message }).catch((appendError) => {
        this.log('error', 'run_failed_event_lost', { run: run.id, error: appendError.message })
      })
    }
  }

  async execute({ run, message, lease, append, stopSignal }) {
    const now = this.now()
    const catalogs = await this.catalogs.snapshot(this.policy, now)
    const decision = select(this.policy, catalogs, selectionRequest(message, this.dispatcher.providers(), now, this.workspaces))
    const roleSelection = decisionSummary(decision)
    if (!decision.selected) {
      await append('run.failed', { phase: PHASE.rejected, code: 'ROLE_SELECTION_REJECTED', roleSelection })
      return
    }
    await append('run.progressed', { phase: PHASE.selected, roleSelection })

    const routing = message.routing ?? {}
    const scope = { workspaceId: run.namespaceId, projectId: trim(routing.projectId) || run.sessionId }
    let prompt = message.text
    if (this.memory) {
      try {
        const memory = await this.memory.context({ ...scope, query: message.text })
        if (memory.text) {
          prompt = withMemory(message.text, memory.text)
          await append('run.progressed', { phase: PHASE.memory, tool: memory.tool, chars: memory.text.length, truncated: memory.truncated === true })
        }
      } catch (error) {
        await append('run.progressed', { phase: PHASE.memoryUnavailable, error: error.message })
      }
    }

    const abort = new AbortController()
    const cancel = { requested: false }
    const onStop = () => abort.abort(new Error('worker stopping'))
    stopSignal?.addEventListener('abort', onStop, { once: true })
    const renewal = this.keepLease(run, lease, cancel, abort)
    await append('run.progressed', { phase: PHASE.started, executor: decision.executor, subagentProvider: decision.subagentProvider })

    let outcome
    try {
      outcome = await this.dispatcher.run({
        workingDirectory: workspaceDirectory(this.workspaces, routing.workspace),
        provider: decision.subagentProvider,
        prompt,
        label: `${decision.role} · ${decision.modelKey}`,
        signal: abort.signal,
      })
    } catch (error) {
      outcome = { error }
    } finally {
      stopSignal?.removeEventListener('abort', onStop)
      renewal.stop()
      await renewal.done
    }

    if (lease.lost) return
    // A worker that stops mid-run leaves the run to its lease: once it expires, Accounts
    // hands the run to the next claim instead of recording a failure nobody caused.
    if (stopSignal?.aborted && !cancel.requested) {
      this.log('info', 'run_released', { run: run.id })
      return
    }
    const resolved = { resolvedRole: decision.role, resolvedModelId: decision.modelId, executor: decision.executor, subagentProvider: decision.subagentProvider }
    if (cancel.requested) {
      await append('run.cancelled', { ...resolved, stopReason: outcome.stopReason ?? 'aborted' })
      return
    }
    if (outcome.error) {
      await append('run.failed', { ...resolved, code: 'EXECUTION_FAILED', error: outcome.error.message })
      return
    }
    if (outcome.stopReason !== 'completed') {
      await append('run.failed', { ...resolved, code: 'EXECUTOR_STOPPED', stopReason: outcome.stopReason, diagnostic: outcome.diagnostic })
      return
    }
    await append('assistant.message.created', { text: outcome.text, childId: outcome.childId, parentSessionId: outcome.parentSessionId })
    let memoryRecord
    if (this.memory) {
      try {
        memoryRecord = await this.memory.record({
          ...scope,
          eventId: `${run.id}:${run.fence}`,
          source: { kind: 'task-run', taskRunId: run.id, sessionId: run.sessionId, executor: decision.executor, modelId: decision.modelId },
          text: outcome.text.slice(0, RECORD_TEXT_MAX),
        })
      } catch (error) {
        await append('run.progressed', { phase: PHASE.memoryUnavailable, error: error.message })
      }
    }
    await append('run.completed', { ...resolved, stopReason: outcome.stopReason, ...(memoryRecord ? { memoryRecordedBy: memoryRecord } : {}) })
  }

  // Renews the lease while the run is live. A cancel request or a lost lease aborts the run;
  // a renewal that cannot reach Accounts is retried until the lease would expire.
  keepLease(run, lease, cancel, abort) {
    const stopped = new AbortController()
    const done = (async () => {
      while (!stopped.signal.aborted) {
        await wait(this.renewEveryMs, stopped.signal)
        if (stopped.signal.aborted) return
        try {
          const renewed = await this.accounts.renew(run, this.leaseTtlSeconds)
          lease.expiresAt = Date.parse(renewed.leaseExpiresAt) || this.now() + this.leaseTtlSeconds * 1000
          if (renewed.cancelRequested && !cancel.requested) {
            cancel.requested = true
            abort.abort(new Error('cancel requested'))
          }
        } catch (error) {
          if (error instanceof LeaseLostError) {
            lease.lost = true
            abort.abort(new Error('lease lost'))
            return
          }
          this.log('warn', 'lease_renew_failed', { run: run.id, error: error.message })
          if (this.now() >= lease.expiresAt) {
            lease.lost = true
            abort.abort(new Error('lease expired'))
            return
          }
        }
      }
    })()
    return { stop: () => stopped.abort(), done }
  }
}
