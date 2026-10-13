// A scripted ACP agent for the integration run: it answers every prompt with a fixed reply
// that echoes what it received, records each prompt next to itself, and honours cancel.
// It calls no model and needs no key. Run with the ACP SDK that dsh-subagent-acp ships:
//   node dev/fake-acp-agent.mjs <record-dir>
// FAKE_ACP_DELAY_MS holds a prompt that contains "[slow]" open (for cancel tests);
// FAKE_ACP_SDK points at the SDK.
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { pathToFileURL } from 'node:url'

const recordDir = process.argv[2]
// The parent keeps stderr out of results, so startup faults are written beside the records.
process.on('uncaughtException', (error) => {
  appendFileSync(join(recordDir, 'acp-agent-errors.log'), `${error.stack ?? error}\n`)
  process.exit(1)
})
const sdk = await import(pathToFileURL(process.env.FAKE_ACP_SDK).href)
const delayMs = Number(process.env.FAKE_ACP_DELAY_MS ?? 0)
const pending = new Map()

const record = entry => appendFileSync(join(recordDir, 'acp-prompts.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`)

const stream = sdk.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin))
// eslint-disable-next-line no-new
new sdk.AgentSideConnection(connection => ({
  async initialize() {
    return { protocolVersion: sdk.PROTOCOL_VERSION, agentCapabilities: { loadSession: false } }
  },
  async authenticate() {
    return {}
  },
  async newSession(params) {
    const sessionId = `fake-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    record({ kind: 'session', sessionId, cwd: params.cwd })
    return { sessionId }
  },
  async prompt(params) {
    const text = params.prompt.filter(part => part.type === 'text').map(part => part.text).join('\n')
    record({ kind: 'prompt', sessionId: params.sessionId, text })
    if (delayMs > 0 && text.includes('[slow]')) {
      const cancelled = await new Promise((resolve) => {
        const timer = setTimeout(() => resolve(false), delayMs)
        pending.set(params.sessionId, () => {
          clearTimeout(timer)
          resolve(true)
        })
      })
      pending.delete(params.sessionId)
      if (cancelled) {
        record({ kind: 'cancelled', sessionId: params.sessionId })
        return { stopReason: 'cancelled' }
      }
    }
    await connection.sessionUpdate({
      sessionId: params.sessionId,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `FAKE-ACP-DONE chars=${text.length}` } },
    })
    return { stopReason: 'end_turn' }
  },
  async cancel(params) {
    pending.get(params.sessionId)?.()
  },
}), stream)
