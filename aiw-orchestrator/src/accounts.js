// Accounts task scheduler client. Accounts owns sessions, task runs, ordered events and the
// run lease; this worker only claims a run, renews its lease and appends fenced events.
// The scheduler token is its own credential, scoped to these routes and to the accounts
// Accounts allows for it, never the general internal service token.

export class LeaseLostError extends Error {
  constructor(message) {
    super(message)
    this.code = 'aiw/lease-lost'
  }
}

export class AccountsError extends Error {
  constructor(message, status) {
    super(message)
    this.code = 'aiw/accounts'
    this.status = status
  }
}

const REQUEST_TIMEOUT_MS = 15_000

export class AccountsClient {
  constructor({ baseUrl, token, accountId, workerId, fetchImpl = fetch }) {
    for (const [name, value] of Object.entries({ baseUrl, token, accountId, workerId })) {
      if (typeof value !== 'string' || value.trim() === '') throw new Error(`accounts client: ${name} is required`)
    }
    this.base = `${baseUrl.trim().replace(/\/+$/, '')}/api/internal/task-scheduler`
    this.token = token.trim()
    this.accountId = accountId.trim()
    this.workerId = workerId.trim()
    this.fetchImpl = fetchImpl
  }

  async post(path, body) {
    let response
    try {
      response = await this.fetchImpl(`${this.base}${path}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ accountId: this.accountId, ...body }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
    } catch (error) {
      throw new AccountsError(`POST ${path}: ${error.message}`)
    }
    if (response.status === 204) return undefined
    const text = await response.text()
    if (response.status === 409) throw new LeaseLostError(`POST ${path}: lease no longer held`)
    if (response.status !== 200) throw new AccountsError(`POST ${path} returned ${response.status}`, response.status)
    try {
      return JSON.parse(text)
    } catch (error) {
      throw new AccountsError(`POST ${path}: decode: ${error.message}`, response.status)
    }
  }

  // Resolves undefined when no run is eligible.
  async claim(leaseTtlSeconds) {
    const claimed = await this.post('/claim', { workerId: this.workerId, leaseTtlSeconds })
    if (!claimed) return undefined
    const { run, message } = claimed
    if (!run?.id || !Number.isInteger(run.fence) || !run.leaseToken || typeof message?.text !== 'string') {
      throw new AccountsError('claim: incomplete run in response', 200)
    }
    return { run, message: { text: message.text, routing: message.routing ?? {} } }
  }

  // Resolves { leaseExpiresAt, cancelRequested }; LeaseLostError once another worker holds it.
  async renew(run, leaseTtlSeconds) {
    const renewed = await this.post(`/runs/${encodeURIComponent(run.id)}/renew`, {
      workerId: this.workerId, fence: run.fence, leaseToken: run.leaseToken, leaseTtlSeconds,
    })
    return { leaseExpiresAt: renewed?.leaseExpiresAt, cancelRequested: renewed?.cancelRequested === true }
  }

  // clientRequestId makes a retried append idempotent on the Accounts side.
  async appendEvent(run, { type, payload, clientRequestId }) {
    return this.post(`/runs/${encodeURIComponent(run.id)}/events`, {
      workerId: this.workerId, fence: run.fence, leaseToken: run.leaseToken, clientRequestId, type, payload,
    })
  }
}
