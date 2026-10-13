// AI Workspace orchestrator: a DSH host plugin that takes task runs from Accounts, selects
// role, executor and model under the reviewed role policy, and runs each task on one DSH
// subagent provider (OpenCode, Codex, Claude Code, Grok). It keeps no durable state.
import { isAbsolute } from 'node:path'
import { AccountsClient } from './src/accounts.js'
import { CatalogCache } from './src/catalog.js'
import { SubagentDispatcher } from './src/dispatch.js'
import { McpHttpClient, TaskMemory } from './src/memory.js'
import { loadPolicy } from './src/policy.js'
import { Scheduler } from './src/scheduler.js'

export const name = 'aiw-orchestrator'
export const inject = ['subagents', 'sessionController', 'workspaceRegistry']

const required = (value, field) => {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`aiw-orchestrator: config.${field} is required`)
  return value.trim()
}

// Secrets are named by environment variable in config and read here, never written to config.
const secretFrom = (env, field, envName) => {
  const value = (env[required(envName, field)] ?? '').trim()
  if (!value) throw new Error(`aiw-orchestrator: environment variable ${envName} (config.${field}) is not set`)
  return value
}

// Workspace keys are plain identifiers mapped to absolute directories this host authorizes.
export function parseWorkspaces(workspaces = {}) {
  if (typeof workspaces !== 'object' || workspaces === null || Array.isArray(workspaces)) throw new Error('aiw-orchestrator: config.workspaces must map keys to absolute paths')
  const result = {}
  for (const [key, path] of Object.entries(workspaces)) {
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(key) || key === '.' || key === '..') throw new Error(`aiw-orchestrator: workspace key ${JSON.stringify(key)} is not a plain identifier`)
    if (typeof path !== 'string' || !isAbsolute(path)) throw new Error(`aiw-orchestrator: workspace ${key} must be an absolute path`)
    result[key] = path
  }
  return result
}

export function buildScheduler(ctx, config, { policy, env = process.env, fetchImpl = fetch, log }) {
  const workspaces = parseWorkspaces(config.workspaces)
  const accountsConfig = config.accounts ?? {}
  const accounts = new AccountsClient({
    baseUrl: accountsConfig.baseUrlEnv ? secretFrom(env, 'accounts.baseUrlEnv', accountsConfig.baseUrlEnv) : required(accountsConfig.baseUrl, 'accounts.baseUrl'),
    token: secretFrom(env, 'accounts.tokenEnv', accountsConfig.tokenEnv),
    accountId: required(accountsConfig.accountId, 'accounts.accountId'),
    workerId: required(config.workerId, 'workerId'),
    fetchImpl,
  })
  let memory
  if (config.memory) {
    const client = new McpHttpClient({
      url: required(config.memory.url, 'memory.url'),
      token: config.memory.tokenEnv ? secretFrom(env, 'memory.tokenEnv', config.memory.tokenEnv) : undefined,
      fetchImpl,
    })
    memory = new TaskMemory({ client, contextTool: config.memory.contextTool, recordTool: config.memory.recordTool })
  }
  return new Scheduler({
    accounts,
    policy,
    catalogs: new CatalogCache({ env, fetchImpl, log }),
    dispatcher: new SubagentDispatcher(ctx),
    memory,
    workspaces,
    log,
    leaseTtlSeconds: config.leaseTtlSeconds ?? 60,
    renewEveryMs: config.renewEveryMs ?? 20_000,
    pollIntervalMs: config.pollIntervalMs ?? 2_000,
  })
}

export function apply(ctx, config = {}) {
  const log = (level, event, fields = {}) => {
    const line = `aiw-orchestrator ${event} ${JSON.stringify(fields)}`
    if (level === 'error') console.error(line)
    else if (level === 'warn') console.warn(line)
    else console.info(line)
  }
  ctx.effect(() => {
    let scheduler
    let stopped = false
    // A policy or configuration error stops this plugin loudly and leaves DSH running.
    Promise.resolve()
      .then(() => loadPolicy(required(config.policyPath, 'policyPath')))
      .then((policy) => {
        if (stopped) return
        scheduler = buildScheduler(ctx, config, { policy, log })
        scheduler.start()
        log('info', 'started', { policyVersion: policy.version, enabled: policy.enabled, workerId: config.workerId })
      })
      .catch(error => log('error', 'not_started', { error: error.message }))
    return () => {
      stopped = true
      return scheduler?.stop()
    }
  }, 'aiw-orchestrator: scheduler')
}
