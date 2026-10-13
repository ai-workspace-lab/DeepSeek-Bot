// In-process stand-ins for the integration run: an Accounts task scheduler (claim, renew,
// events, per the contract in README.md), a /v1/models catalog, and a QMD-like MCP server.
// They hold everything in memory and are for this checkout's tests only.
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'

const WORKER_EVENTS = new Set(['run.progressed', 'assistant.message.created', 'run.completed', 'run.failed', 'run.cancelled'])

const readJson = req => new Promise((resolve, reject) => {
  let body = ''
  req.on('data', (chunk) => { body += chunk })
  req.on('end', () => {
    try {
      resolve(body ? JSON.parse(body) : {})
    } catch (error) {
      reject(error)
    }
  })
})

const send = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'content-type': 'application/json', ...headers })
  res.end(body === undefined ? undefined : JSON.stringify(body))
}

export async function startFakeServices({ schedulerToken, accountId, modelIds, memoryText }) {
  const queue = []
  const runs = new Map()
  const events = []
  const mcpCalls = []

  const enqueue = (message) => {
    const run = { id: randomUUID(), sessionId: `sess-${queue.length + runs.size + 1}`, namespaceId: 'ns-int', fence: 0, attempt: 0, state: 'queued', cancelRequested: false, message }
    queue.push(run)
    return run
  }

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://local')
      if (url.pathname === '/v1/models') {
        if (req.headers.authorization !== 'Bearer catalog-token') return send(res, 401, { error: 'unauthorized' })
        return send(res, 200, { data: modelIds.map(id => ({ id })) })
      }
      if (url.pathname === '/mcp') {
        const message = await readJson(req)
        mcpCalls.push(message)
        if (message.id === undefined) return send(res, 202)
        const reply = result => send(res, 200, { jsonrpc: '2.0', id: message.id, result }, { 'mcp-session-id': 'int-mcp' })
        if (message.method === 'initialize') return reply({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake-qmd', version: '0' } })
        if (message.method === 'tools/call' && message.params.name === 'mem_context') return reply({ content: [{ type: 'text', text: memoryText }] })
        if (message.method === 'tools/call' && message.params.name === 'mem_remember') return reply({ content: [{ type: 'text', text: 'recorded' }] })
        return reply({ isError: true, content: [{ type: 'text', text: `unknown tool ${message.params?.name}` }] })
      }
      const prefix = '/api/internal/task-scheduler'
      if (!url.pathname.startsWith(prefix)) return send(res, 404, { error: 'not found' })
      if (req.headers.authorization !== `Bearer ${schedulerToken}`) return send(res, 401, { error: 'unauthorized' })
      const body = await readJson(req)
      if (body.accountId !== accountId) return send(res, 403, { error: 'account not allowed' })
      const path = url.pathname.slice(prefix.length)
      if (path === '/claim') {
        const run = queue.shift()
        if (!run) return send(res, 204)
        run.state = 'running'
        run.fence++
        run.attempt++
        run.leaseToken = randomUUID()
        run.leaseExpiresAt = new Date(Date.now() + body.leaseTtlSeconds * 1000).toISOString()
        runs.set(run.id, run)
        const { message, ...wire } = run
        return send(res, 200, { run: { id: wire.id, sessionId: wire.sessionId, namespaceId: wire.namespaceId, fence: wire.fence, leaseToken: wire.leaseToken, leaseExpiresAt: wire.leaseExpiresAt, attempt: wire.attempt }, message })
      }
      const match = /^\/runs\/([^/]+)\/(renew|events)$/.exec(path)
      const run = match && runs.get(decodeURIComponent(match[1]))
      if (!run) return send(res, 404, { error: 'unknown run' })
      if (run.fence !== body.fence || run.leaseToken !== body.leaseToken || run.state !== 'running') return send(res, 409, { error: 'lease conflict' })
      if (match[2] === 'renew') {
        run.leaseExpiresAt = new Date(Date.now() + body.leaseTtlSeconds * 1000).toISOString()
        return send(res, 200, { leaseExpiresAt: run.leaseExpiresAt, cancelRequested: run.cancelRequested })
      }
      // Mirror the Accounts checks a worker must satisfy, so the run catches a drifting client.
      if (!/^[A-Za-z0-9._:-]{1,128}$/.test(body.clientRequestId ?? '') || !WORKER_EVENTS.has(body.type)) return send(res, 400, { error: 'invalid event' })
      const duplicate = events.find(event => event.clientRequestId === body.clientRequestId)
      if (duplicate) return send(res, 200, { event: duplicate, lastEventSeq: events.length })
      const event = { seq: events.length + 1, runId: run.id, type: body.type, payload: body.payload, clientRequestId: body.clientRequestId }
      events.push(event)
      if (['run.completed', 'run.failed', 'run.cancelled'].includes(body.type)) run.state = body.type.slice(4)
      return send(res, 200, { event, lastEventSeq: events.length })
    } catch (error) {
      send(res, 500, { error: error.message })
    }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  return {
    base,
    enqueue,
    events,
    mcpCalls,
    runs,
    requestCancel: (runId) => { runs.get(runId).cancelRequested = true },
    close: () => new Promise(resolve => server.close(resolve)),
  }
}
