import assert from 'node:assert/strict'
import { test } from 'node:test'
import { LeaseLostError } from '../src/accounts.js'
import { SubagentDispatcher } from '../src/dispatch.js'
import { Scheduler, selectionRequest } from '../src/scheduler.js'
import { NOW, engineerPolicy, liveCatalog } from './fixtures.js'

const run = (overrides = {}) => ({ id: 'run-1', sessionId: 'sess-1', namespaceId: 'ns-1', fence: 2, leaseToken: 'lease', leaseExpiresAt: new Date(NOW + 60_000).toISOString(), ...overrides })
const WORKSPACES = { demo: '/srv/workspace/demo' }
const message = (routing = {}) => ({ text: 'make the failing test pass', routing: { role: 'engineer', workspace: 'demo', ...routing } })

function fakeAccounts({ renew } = {}) {
  const events = []
  return {
    events,
    renewals: 0,
    async claim() { return undefined },
    async renew() {
      this.renewals++
      return renew ? renew(this.renewals) : { leaseExpiresAt: new Date(NOW + 120_000).toISOString(), cancelRequested: false }
    },
    async appendEvent(claimed, event) {
      events.push({ runId: claimed.id, fence: claimed.fence, ...event })
      return { lastEventSeq: events.length }
    },
  }
}

function fakeDispatcher(behaviour) {
  const calls = []
  return {
    calls,
    providers: () => ['opencode:gpt-6.1-sol', 'codex:gpt-6.1-sol'],
    async run(request) {
      calls.push(request)
      return behaviour(request)
    },
  }
}

const catalogs = { snapshot: async () => liveCatalog('gpt-6.1-sol') }

function scheduler({ accounts, dispatcher, memory, renewEveryMs = 5 }) {
  return new Scheduler({ accounts, policy: engineerPolicy(), catalogs, dispatcher, memory, workspaces: WORKSPACES, now: () => NOW, renewEveryMs, leaseTtlSeconds: 60 })
}

const types = accounts => accounts.events.map(event => event.type)

test('selection request is derived from the claimed message and this host\'s workspaces only', () => {
  const request = selectionRequest(message({ roleMode: 'manual', roleModel: 'gpt-6.1-sol', attachments: 2, followUp: true }), ['p'], NOW, WORKSPACES)
  assert.equal(request.workingDirectory, '/srv/workspace/demo')
  assert.equal(selectionRequest(message({ workspace: 'unknown' }), [], NOW, WORKSPACES).workingDirectory, '')
  assert.equal(selectionRequest(message({ workspace: 'toString' }), [], NOW, WORKSPACES).workingDirectory, '')
  assert.equal(selectionRequest(message({ workspace: undefined, workingDirectory: '/etc' }), [], NOW, WORKSPACES).workingDirectory, '')
  assert.equal(request.role, 'engineer')
  assert.equal(request.manualModel, 'gpt-6.1-sol')
  assert.equal(request.promptBytes, Buffer.byteLength('make the failing test pass'))
  assert.equal(request.attachments, 2)
  assert.equal(request.followUp, true)
  assert.deepEqual(request.availableProviders, ['p'])
})

test('a completed run appends selected, started, the answer and completed, with idempotency keys', async () => {
  const accounts = fakeAccounts()
  const dispatcher = fakeDispatcher(async () => ({ stopReason: 'completed', text: 'All tests pass.', childId: 'child-1', parentSessionId: 'dsh-1' }))
  await scheduler({ accounts, dispatcher }).process({ run: run(), message: message() })
  assert.deepEqual(types(accounts), ['run.progressed', 'run.progressed', 'assistant.message.created', 'run.completed'])
  assert.deepEqual(accounts.events.map(event => event.clientRequestId), ['run-1:2:1', 'run-1:2:2', 'run-1:2:3', 'run-1:2:4'])
  assert.equal(accounts.events[0].payload.phase, 'selected')
  assert.equal(accounts.events[0].payload.roleSelection.subagentProvider, 'opencode:gpt-6.1-sol')
  assert.equal(accounts.events[2].payload.text, 'All tests pass.')
  assert.equal(accounts.events[3].payload.resolvedModelId, 'gpt-6.1-sol')
  assert.equal(dispatcher.calls[0].provider, 'opencode:gpt-6.1-sol')
  assert.equal(dispatcher.calls[0].workingDirectory, '/srv/workspace/demo')
  assert.equal(dispatcher.calls[0].prompt, 'make the failing test pass')
  for (const event of accounts.events) assert.equal(event.fence, 2)
})

test('a rejected selection fails the run without dispatching', async () => {
  const accounts = fakeAccounts()
  const dispatcher = fakeDispatcher(async () => assert.fail('must not dispatch'))
  await scheduler({ accounts, dispatcher }).process({ run: run(), message: message({ workspace: 'not-configured' }) })
  assert.deepEqual(types(accounts), ['run.failed'])
  assert.equal(accounts.events[0].payload.phase, 'rejected')
  assert.equal(accounts.events[0].payload.roleSelection.code, 'workspace_unauthorized')
})

test('a cancel request seen on renewal aborts the executor and records cancelled', async () => {
  const accounts = fakeAccounts({ renew: () => ({ leaseExpiresAt: new Date(NOW + 120_000).toISOString(), cancelRequested: true }) })
  const dispatcher = fakeDispatcher(({ signal }) => new Promise(resolve => signal.addEventListener('abort', () => resolve({ stopReason: 'aborted', text: '' }))))
  await scheduler({ accounts, dispatcher }).process({ run: run(), message: message() })
  assert.equal(types(accounts).at(-1), 'run.cancelled')
  assert.ok(!types(accounts).includes('run.failed'))
})

test('a lost lease stops the run quietly: no terminal event from a fenced-out worker', async () => {
  const accounts = fakeAccounts({ renew: () => { throw new LeaseLostError('lost') } })
  const dispatcher = fakeDispatcher(({ signal }) => new Promise(resolve => signal.addEventListener('abort', () => resolve({ stopReason: 'aborted', text: '' }))))
  await scheduler({ accounts, dispatcher }).process({ run: run(), message: message() })
  assert.deepEqual(types(accounts), ['run.progressed', 'run.progressed'])
})

test('a lease that cannot be renewed past its expiry aborts the run', async () => {
  const accounts = fakeAccounts({ renew: () => { throw new Error('ECONNREFUSED') } })
  const dispatcher = fakeDispatcher(({ signal }) => new Promise(resolve => signal.addEventListener('abort', () => resolve({ stopReason: 'aborted', text: '' }))))
  await scheduler({ accounts, dispatcher }).process({ run: run({ leaseExpiresAt: new Date(NOW - 1).toISOString() }), message: message() })
  assert.ok(!types(accounts).some(type => ['run.completed', 'run.failed', 'run.cancelled'].includes(type)))
})

test('an appended event rejected for the fence ends the run without more writes', async () => {
  const accounts = fakeAccounts()
  accounts.appendEvent = async function (claimed, event) {
    this.events.push(event)
    if (this.events.length === 2) throw new LeaseLostError('fenced')
    return {}
  }
  const dispatcher = fakeDispatcher(async () => ({ stopReason: 'completed', text: 'done' }))
  await scheduler({ accounts, dispatcher }).process({ run: run(), message: message() })
  assert.equal(accounts.events.length, 2)
})

test('executor failures are recorded with safe detail', async () => {
  const stopped = fakeAccounts()
  await scheduler({ accounts: stopped, dispatcher: fakeDispatcher(async () => ({ stopReason: 'max-tokens', text: 'partial', diagnostic: 'Subagent failure (provider: ACP; stage: prompt)' })) })
    .process({ run: run(), message: message() })
  assert.equal(types(stopped).at(-1), 'run.failed')
  assert.equal(stopped.events.at(-1).payload.code, 'EXECUTOR_STOPPED')
  assert.equal(stopped.events.at(-1).payload.stopReason, 'max-tokens')

  const crashed = fakeAccounts()
  await scheduler({ accounts: crashed, dispatcher: fakeDispatcher(async () => { throw new Error('spawn opencode ENOENT') }) })
    .process({ run: run(), message: message() })
  assert.equal(crashed.events.at(-1).payload.code, 'EXECUTION_FAILED')
})

test('memory: context is fenced into the prompt, the answer is recorded as a candidate, failures leave a receipt', async () => {
  const accounts = fakeAccounts()
  const recorded = []
  const memory = {
    async context(scope) {
      assert.deepEqual({ ...scope, query: undefined }, { workspaceId: 'ns-1', projectId: 'proj-9', query: undefined })
      return { text: 'The repo uses pnpm.', tool: 'mem_context' }
    },
    async record(entry) {
      recorded.push(entry)
      return 'mem_remember'
    },
  }
  const dispatcher = fakeDispatcher(async () => ({ stopReason: 'completed', text: 'Fixed.' }))
  await scheduler({ accounts, dispatcher, memory }).process({ run: run(), message: message({ projectId: 'proj-9' }) })
  assert.match(dispatcher.calls[0].prompt, /<shared-memory>\nThe repo uses pnpm\.\n<\/shared-memory>/)
  assert.ok(dispatcher.calls[0].prompt.endsWith('Task:\nmake the failing test pass'))
  const memoryEvent = accounts.events.find(event => event.payload.phase === 'memory')
  assert.equal(memoryEvent.payload.chars, 'The repo uses pnpm.'.length)
  assert.ok(!JSON.stringify(accounts.events).includes('The repo uses pnpm.'), 'memory content stays out of task events')
  assert.equal(recorded[0].eventId, 'run-1:2')
  assert.equal(recorded[0].source.taskRunId, 'run-1')
  assert.equal(accounts.events.at(-1).payload.memoryRecordedBy, 'mem_remember')

  const down = fakeAccounts()
  const failing = { context: async () => { throw new Error('qmd unreachable') }, record: async () => { throw new Error('qmd unreachable') } }
  await scheduler({ accounts: down, dispatcher: fakeDispatcher(async () => ({ stopReason: 'completed', text: 'ok' })), memory: failing })
    .process({ run: run(), message: message() })
  assert.equal(down.events.filter(event => event.payload.phase === 'memory_unavailable').length, 2)
  assert.equal(types(down).at(-1), 'run.completed')
})

test('a stopping worker releases the run to its lease instead of failing it', async () => {
  const accounts = fakeAccounts()
  const stop = new AbortController()
  const dispatcher = fakeDispatcher(({ signal }) => new Promise((resolve) => {
    signal.addEventListener('abort', () => resolve({ stopReason: 'aborted', text: '' }))
    setTimeout(() => stop.abort(), 5)
  }))
  await scheduler({ accounts, dispatcher, renewEveryMs: 10_000 }).process({ run: run(), message: message() }, stop.signal)
  assert.deepEqual(types(accounts), ['run.progressed', 'run.progressed'])
})

test('the loop claims, processes and stops', async () => {
  const accounts = fakeAccounts()
  let claims = 0
  accounts.claim = async () => (++claims === 1 ? { run: run(), message: message() } : undefined)
  const dispatcher = fakeDispatcher(async () => ({ stopReason: 'completed', text: 'ok' }))
  const loop = new Scheduler({ accounts, policy: engineerPolicy(), catalogs, dispatcher, workspaces: WORKSPACES, now: () => NOW, pollIntervalMs: 5, renewEveryMs: 1000 })
  loop.start()
  while (!types(accounts).includes('run.completed')) await new Promise(resolve => setTimeout(resolve, 5))
  await loop.stop()
  assert.ok(claims >= 2)
})

test('the dispatcher runs one subagent under a root session in the task workspace and always disposes it', async () => {
  const log = []
  const ctx = {
    subagents: {
      list: () => ['opencode:gpt-6.1-sol'],
      async start(provider, request) {
        log.push(['start', provider, request.parent.id, request.prompt, request.label])
        return {
          id: 'child-1',
          result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: 'Done ' }, { type: 'image' }, { type: 'text', text: 'now.' }] }),
          dispose: async () => log.push(['dispose']),
        }
      },
    },
    workspaceRegistry: {
      resolveByPath: async () => undefined,
      create: async (path, label) => { log.push(['workspace', path, label]); return { id: 'ws-1' } },
    },
    sessionController: {
      create: async ({ workspaceId }) => { log.push(['session', workspaceId]); return { sessionId: 'dsh-1' } },
      resolveAgent: async () => ({ agent: { id: 'agent-1' } }),
    },
  }
  const dispatcher = new SubagentDispatcher(ctx)
  assert.deepEqual(dispatcher.providers(), ['opencode:gpt-6.1-sol'])
  const outcome = await dispatcher.run({ workingDirectory: '/srv/w', provider: 'opencode:gpt-6.1-sol', prompt: 'p', label: 'engineer · gpt', signal: new AbortController().signal })
  assert.deepEqual(outcome, { stopReason: 'completed', text: 'Done now.', diagnostic: undefined, parentSessionId: 'dsh-1', childId: 'child-1' })
  assert.deepEqual(log, [
    ['workspace', '/srv/w', 'AI Workspace'],
    ['session', 'ws-1'],
    ['start', 'opencode:gpt-6.1-sol', 'agent-1', [{ type: 'text', text: 'p' }], 'engineer · gpt'],
    ['dispose'],
  ])

  ctx.subagents.start = async () => ({ id: 'c', result: Promise.reject(new Error('transport fault')), dispose: async () => log.push(['dispose-after-fault']) })
  await assert.rejects(dispatcher.run({ workingDirectory: '/srv/w', provider: 'x', prompt: 'p', signal: new AbortController().signal }), /transport fault/)
  assert.deepEqual(log.at(-1), ['dispose-after-fault'])

  ctx.sessionController.resolveAgent = async () => ({ error: { message: 'session archived' } })
  await assert.rejects(dispatcher.run({ workingDirectory: '/srv/w', provider: 'x', prompt: 'p', signal: new AbortController().signal }), /session archived/)
})
