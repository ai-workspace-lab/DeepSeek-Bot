// Live model catalog: GET {base}/models per connection, kept byte-for-byte. A catalog only
// says what the token can see; it proves nothing about tools, context or quality.
import { resolveBaseUrl } from './policy.js'

const FETCH_TIMEOUT_MS = 10_000
const ERROR_RETRY_MS = 30_000
const MAX_BODY_BYTES = 8 << 20

export async function fetchCatalog({ connectionId, connection, now, env = process.env, fetchImpl = fetch }) {
  const snapshot = { connectionId, fetchedAt: now, modelIds: [] }
  const tokenEnv = connection.token_env.trim()
  const token = (env[tokenEnv] ?? '').trim()
  if (!token) return { ...snapshot, error: `token env ${tokenEnv} is not set` }
  const baseUrl = resolveBaseUrl(connection, env)
  if (!baseUrl) return { ...snapshot, error: `base url env ${connection.base_url_env} is not set` }
  const endpoint = `${baseUrl.replace(/\/+$/, '')}/models`
  let response
  try {
    response = await fetchImpl(endpoint, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
  } catch (error) {
    return { ...snapshot, error: `GET ${endpoint}: ${error.message}` }
  }
  const body = await response.text()
  if (body.length > MAX_BODY_BYTES) return { ...snapshot, error: `GET ${endpoint} returned more than ${MAX_BODY_BYTES} bytes` }
  if (response.status !== 200) return { ...snapshot, error: `GET ${endpoint} returned ${response.status}` }
  let decoded
  try {
    decoded = JSON.parse(body)
  } catch (error) {
    return { ...snapshot, error: `decode /models: ${error.message}` }
  }
  const ids = Array.isArray(decoded?.data) ? decoded.data.map(item => item?.id).filter(id => typeof id === 'string' && id !== '') : []
  return { ...snapshot, modelIds: ids }
}

// Refreshes a connection once its snapshot is older than half the policy's max age, and a
// failed one after a short delay, so a selection never reads a catalog the gate would reject
// as stale while a fresh one was one request away.
export class CatalogCache {
  constructor({ env = process.env, fetchImpl = fetch, log = () => {} } = {}) {
    this.env = env
    this.fetchImpl = fetchImpl
    this.log = log
    this.snapshots = new Map()
  }

  async snapshot(policy, now) {
    const refreshAfterMs = policy.limits.catalog_max_age_seconds * 1000 / 2
    const result = {}
    for (const [connectionId, connection] of Object.entries(policy.connections ?? {})) {
      let snapshot = this.snapshots.get(connectionId)
      const stale = !snapshot || now - snapshot.fetchedAt > refreshAfterMs || (snapshot.error && now - snapshot.fetchedAt > ERROR_RETRY_MS)
      if (stale) {
        snapshot = await fetchCatalog({ connectionId, connection, now, env: this.env, fetchImpl: this.fetchImpl })
        if (snapshot.error) this.log('warn', 'catalog_fetch_failed', { connection: connectionId, error: snapshot.error })
        this.snapshots.set(connectionId, snapshot)
      }
      result[connectionId] = snapshot
    }
    return result
  }
}
