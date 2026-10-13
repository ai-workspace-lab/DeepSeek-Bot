import assert from 'node:assert/strict'
import { test } from 'node:test'
import { apply, buildScheduler, inject, name } from '../index.js'
import { engineerPolicy } from './fixtures.js'

const ctx = { subagents: { list: () => [] }, sessionController: {}, workspaceRegistry: {} }
const config = {
  workerId: 'dsh-mac-1',
  accounts: { baseUrl: 'https://accounts.example', tokenEnv: 'AIW_SCHED_TOKEN', accountId: 'acct-1' },
  memory: { url: 'http://127.0.0.1:8181/mcp', contextTool: 'mem_context', recordTool: 'mem_remember' },
}

test('the plugin declares only the services it uses', () => {
  assert.equal(name, 'aiw-orchestrator')
  assert.deepEqual(inject, ['subagents', 'sessionController', 'workspaceRegistry'])
})

test('buildScheduler reads secrets from the named environment variables only', () => {
  const scheduler = buildScheduler(ctx, config, { policy: engineerPolicy(), env: { AIW_SCHED_TOKEN: 'tok' }, log: () => {} })
  assert.equal(scheduler.accounts.token, 'tok')
  assert.equal(scheduler.memory.contextTool, 'mem_context')
  assert.equal(scheduler.leaseTtlSeconds, 60)
  assert.throws(() => buildScheduler(ctx, config, { policy: engineerPolicy(), env: {}, log: () => {} }), /AIW_SCHED_TOKEN/)
  assert.throws(() => buildScheduler(ctx, { ...config, workerId: '' }, { policy: engineerPolicy(), env: { AIW_SCHED_TOKEN: 'tok' }, log: () => {} }), /workerId/)
  assert.throws(() => buildScheduler(ctx, { ...config, accounts: { ...config.accounts, accountId: undefined } }, { policy: engineerPolicy(), env: { AIW_SCHED_TOKEN: 'tok' }, log: () => {} }), /accountId/)
  const noMemory = buildScheduler(ctx, { ...config, memory: undefined }, { policy: engineerPolicy(), env: { AIW_SCHED_TOKEN: 'tok' }, log: () => {} })
  assert.equal(noMemory.memory, undefined)
})

test('a bad policy path stops the plugin loudly without throwing into DSH', async () => {
  const effects = []
  const errors = []
  const original = console.error
  console.error = line => errors.push(line)
  try {
    apply({ ...ctx, effect: (fn, label) => effects.push({ dispose: fn(), label }) }, { ...config, policyPath: 'relative.json' })
    await new Promise(resolve => setTimeout(resolve, 20))
  } finally {
    console.error = original
  }
  assert.equal(effects[0].label, 'aiw-orchestrator: scheduler')
  assert.match(errors.join('\n'), /aiw-orchestrator not_started .*absolute/)
  await effects[0].dispose()
})
