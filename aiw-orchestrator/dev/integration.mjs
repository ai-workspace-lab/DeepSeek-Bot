// Real-DSH integration run: boots `dsh --profile web` with this plugin and the official
// dsh-subagent-acp provider pointed at dev/fake-acp-agent.mjs, against the in-process fakes
// in dev/fake-services.mjs. No model, key or network service is used.
//
//   DSH_BIN=/path/to/node_modules/.bin/dsh node dev/integration.mjs [receipt.json]
//
// It installs the plugin (link) and @deepseek-ai/dsh-subagent-acp into a throwaway DSH_HOME,
// so the version of the provider matches DSH_SUBAGENT_ACP_VERSION (default 0.2.1-alpha.1).
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { startFakeServices } from './fake-services.mjs'

const plugin = resolve(import.meta.dirname, '..')
const dshBin = process.env.DSH_BIN
assert.ok(dshBin && existsSync(dshBin), 'DSH_BIN must point at an installed dsh executable')
const acpVersion = process.env.DSH_SUBAGENT_ACP_VERSION ?? '0.2.1-alpha.1'
const receiptPath = process.argv[2]

const home = mkdtempSync(join(tmpdir(), 'aiw-it-home-'))
const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'aiw-it-ws-')))
const records = process.env.AIW_IT_RECORDS ?? mkdtempSync(join(tmpdir(), "aiw-it-rec-"))
const env = { ...process.env, DSH_HOME: home, AIW_IT_SCHED_TOKEN: 'it-sched-token', AIW_IT_CATALOG_TOKEN: 'catalog-token' }
const dsh = (...args) => execFileSync(dshBin, args, { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

const freePort = () => new Promise((done) => {
  const server = createServer()
  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address()
    server.close(() => done(port))
  })
})
const sleep = ms => new Promise(done => setTimeout(done, ms))
async function until(what, check, timeoutMs = 60_000) {
  const end = Date.now() + timeoutMs
  for (;;) {
    const value = check()
    if (value) return value
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await sleep(100)
  }
}

const services = await startFakeServices({ schedulerToken: 'it-sched-token', accountId: 'acct-it', modelIds: ['fake-model'], memoryText: 'MEMORY-FACT: the build uses pnpm.' })
let web
const receipt = { startedAt: new Date().toISOString(), dshVersion: undefined, subagentAcpVersion: acpVersion, scenarios: [] }
try {
  receipt.dshVersion = dsh('--version').trim()
  dsh('--profile', 'web', '--dump-default-config')
  dsh('plugin', '--profile', 'web', 'add', `link:${plugin}`, `@deepseek-ai/dsh-subagent-acp@${acpVersion}`)
  // The fake agent loads the ACP SDK from the DSH install, whose dependencies are complete;
  // the profile's hoisted copy leaves the SDK's own peers to its host.
  const sdkEntry = process.env.FAKE_ACP_SDK ?? createRequire(join(dirname(dirname(realpathSync(dshBin))), 'package.json')).resolve('@agentclientprotocol/sdk')

  const verified = value => ({ value, state: 'verified', source: 'integration', checked_at: new Date(Date.now() - 3600_000).toISOString(), valid_until: new Date(Date.now() + 86400_000).toISOString() })
  const policyPath = join(home, 'policy.json')
  writeFileSync(policyPath, JSON.stringify({
    version: 'integration-1',
    enabled: true,
    budget: { mode: 'gateway_quota' },
    limits: { context_reserve_tokens: 1000, catalog_max_age_seconds: 600 },
    connections: { it: { base_url: `${services.base}/v1`, token_env: 'AIW_IT_CATALOG_TOKEN', allowed_data_classes: ['unclassified'] } },
    executors: { opencode: { connection: 'it', subagent_provider_template: 'opencode:{model_id}', capabilities: { workspace_edit: verified(true) } } },
    models: { 'fake-model': { display_name: 'Fake', bindings: { it: { gateway_model_id: 'fake-model', capabilities: { tool_calling: verified(true) }, context_window: verified(100000) } } } },
    roles: {
      engineer: { enabled: true, preferences: ['fake-model'], executors: ['opencode'], required_model_capabilities: ['tool_calling'], required_executor_capabilities: ['workspace_edit'], requires_workspace: true },
      researcher: { enabled: false },
    },
  }))
  const patchPath = join(home, 'integration.patch.yml')
  writeFileSync(patchPath, `- insert:
    - id: subagent-acp-opencode-fake
      name: '@deepseek-ai/dsh-subagent-acp'
      config:
        providerName: 'opencode:fake-model'
        command: ${JSON.stringify(process.execPath)}
        args: [${JSON.stringify(join(plugin, 'dev', 'fake-acp-agent.mjs'))}, ${JSON.stringify(records)}]
        permission: reject
        env:
          FAKE_ACP_SDK: ${JSON.stringify(sdkEntry)}
          FAKE_ACP_DELAY_MS: '30000'
    - id: aiw-orchestrator
      name: aiw-orchestrator
      config:
        policyPath: ${JSON.stringify(policyPath)}
        workerId: dsh-integration
        workspaces:
          it-repo: ${JSON.stringify(workspace)}
        leaseTtlSeconds: 30
        renewEveryMs: 300
        pollIntervalMs: 200
        accounts:
          baseUrl: ${JSON.stringify(services.base)}
          tokenEnv: AIW_IT_SCHED_TOKEN
          accountId: acct-it
        memory:
          url: ${JSON.stringify(`${services.base}/mcp`)}
          contextTool: mem_context
          recordTool: mem_remember
`)

  const port = await freePort()
  const logPath = join(home, 'web.log')
  web = spawn(dshBin, ['--profile', 'web', '--patch', patchPath, '--no-open', '--port', String(port)], { env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let log = ''
  web.stdout.on('data', (chunk) => { log += chunk })
  web.stderr.on('data', (chunk) => { log += chunk })
  await until('dsh web and the orchestrator to start', () => /aiw-orchestrator (started|not_started)/.test(log), 120_000)
  assert.match(log, /aiw-orchestrator started/, `orchestrator did not start:\n${log.split('\n').filter(line => line.includes('aiw-orchestrator')).join('\n')}`)

  const eventsOf = runId => services.events.filter(event => event.runId === runId)
  const terminal = runId => eventsOf(runId).find(event => ['run.completed', 'run.failed', 'run.cancelled'].includes(event.type))
  const prompts = () => (existsSync(join(records, 'acp-prompts.jsonl')) ? readFileSync(join(records, 'acp-prompts.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [])

  // 1. Completed run through the real subagent seam, with memory fenced into the prompt.
  const done = services.enqueue({ text: 'Make the failing test pass.', routing: { role: 'engineer', workspace: 'it-repo' } })
  const doneEnd = await until('run 1 to settle', () => terminal(done.id))
  assert.equal(doneEnd.type, 'run.completed', JSON.stringify(eventsOf(done.id), null, 2))
  const answer = eventsOf(done.id).find(event => event.type === 'assistant.message.created')
  assert.match(answer.payload.text, /^FAKE-ACP-DONE chars=\d+$/)
  const session = prompts().find(entry => entry.kind === 'session')
  assert.equal(session.cwd, workspace)
  const prompt = prompts().find(entry => entry.kind === 'prompt')
  assert.match(prompt.text, /<shared-memory>\nMEMORY-FACT: the build uses pnpm\.\n<\/shared-memory>/)
  assert.ok(prompt.text.endsWith('Task:\nMake the failing test pass.'))
  assert.ok(services.mcpCalls.some(call => call.params?.name === 'mem_remember' && call.params.arguments.status === 'candidate'))
  receipt.scenarios.push({ name: 'completed', events: eventsOf(done.id).map(event => [event.seq, event.type, event.payload.phase ?? null]) })

  // 2. Cancel requested while the executor holds the prompt.
  const slow = services.enqueue({ text: '[slow] long task', routing: { role: 'engineer', workspace: 'it-repo' } })
  await until('run 2 to start', () => eventsOf(slow.id).find(event => event.payload.phase === 'started'))
  await until('the executor to receive run 2', () => prompts().some(entry => entry.kind === 'prompt' && entry.text.includes('[slow]')))
  services.requestCancel(slow.id)
  const slowEnd = await until('run 2 to settle', () => terminal(slow.id), 30_000)
  assert.equal(slowEnd.type, 'run.cancelled', JSON.stringify(eventsOf(slow.id), null, 2))
  await until('the executor to see the cancel', () => prompts().some(entry => entry.kind === 'cancelled'), 10_000)
  receipt.scenarios.push({ name: 'cancelled', events: eventsOf(slow.id).map(event => [event.seq, event.type, event.payload.phase ?? null]) })

  // 3. A role the policy has not enabled is rejected before any dispatch.
  const before = prompts().filter(entry => entry.kind === 'prompt').length
  const rejected = services.enqueue({ text: 'Survey the field.', routing: { role: 'researcher', workspace: 'it-repo' } })
  const rejectedEnd = await until('run 3 to settle', () => terminal(rejected.id))
  assert.equal(rejectedEnd.type, 'run.failed')
  assert.equal(rejectedEnd.payload.roleSelection.code, 'role_not_enabled')
  assert.equal(prompts().filter(entry => entry.kind === 'prompt').length, before)
  receipt.scenarios.push({ name: 'rejected', events: eventsOf(rejected.id).map(event => [event.seq, event.type, event.payload.phase ?? null]) })

  receipt.result = 'pass'
  console.log('integration: pass')
} catch (error) {
  receipt.result = 'fail'
  receipt.error = error.message
  console.error(`integration: fail: ${error.message}`)
  process.exitCode = 1
} finally {
  if (web?.pid) {
    try {
      process.kill(-web.pid, 'SIGTERM')
    } catch {}
    await sleep(500)
    try {
      process.kill(-web.pid, 'SIGKILL')
    } catch {}
  }
  await services.close()
  if (!process.env.AIW_IT_KEEP) for (const dir of [home, workspace, ...(process.env.AIW_IT_RECORDS ? [] : [records])]) rmSync(dir, { recursive: true, force: true })
  receipt.finishedAt = new Date().toISOString()
  if (receiptPath) {
    writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`)
    console.log(`receipt: ${receiptPath}`)
  }
}
