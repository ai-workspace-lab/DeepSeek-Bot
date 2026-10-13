import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { CatalogCache, fetchCatalog } from '../src/catalog.js'
import { loadPolicy, parsePolicy } from '../src/policy.js'
import { CODE, select } from '../src/selector.js'
import { NOW, engineerPolicy, engineerRequest } from './fixtures.js'

const base = '"version":"v","budget":{"mode":"disabled"},"limits":{"context_reserve_tokens":1,"catalog_max_age_seconds":1}'

test('parse rejects broken references', () => {
  const cases = {
    'unknown executor': `{${base},"roles":{"engineer":{"executors":["missing"]}}}`,
    'unknown model': `{${base},"roles":{"engineer":{"preferences":["missing"]}}}`,
    'bad budget': '{"version":"v","budget":{"mode":"hard"},"limits":{"context_reserve_tokens":1,"catalog_max_age_seconds":1}}',
    'unknown role': `{${base},"roles":{"boss":{}}}`,
    'no base url': `{${base},"connections":{"c":{"token_env":"T"}}}`,
    'two base urls': `{${base},"connections":{"c":{"base_url":"https://gateway.example/v1","base_url_env":"U","token_env":"T"}}}`,
    'template without model id': `{${base},"connections":{"c":{"base_url":"https://g.example/v1","token_env":"T"}},"executors":{"e":{"connection":"c","subagent_provider_template":"opencode"}}}`,
    'candidate model preferred': `{${base},"models":{"m":{"candidate_only":true}},"roles":{"engineer":{"preferences":["m"]}}}`,
    'chat product mode': `{${base},"roles":{"engineer":{"product_modes":["chat"]}}}`,
    'effort without rules': `{${base},"roles":{"engineer":{"effort":{"start":"high","min":"low","max":"max"}}}}`,
    'not json': '{',
  }
  for (const [name, raw] of Object.entries(cases)) {
    assert.throws(() => parsePolicy(raw), /role policy/, name)
  }
  assert.equal(parsePolicy(JSON.stringify(engineerPolicy())).version, 'test-1')
})

test('the shipped example policy loads and stays disabled', async () => {
  const policy = await loadPolicy(join(import.meta.dirname, '..', 'example', 'role-router-policy.example.json'))
  assert.equal(policy.enabled, false)
  assert.equal(policy.budget.mode, 'disabled')
  for (const [key, model] of Object.entries(policy.models)) {
    for (const [conn, binding] of Object.entries(model.bindings)) {
      assert.equal(binding.gateway_model_id, null, `example must not claim an observed id: ${key} on ${conn}`)
    }
  }
  assert.equal(select(policy, {}, engineerRequest()).code, CODE.policyDisabled)
  for (const exec of Object.values(policy.executors)) assert.match(exec.subagent_provider_template, /\{model_id\}/)
})

test('policy paths must be absolute', async () => {
  await assert.rejects(loadPolicy('relative.json'), /absolute/)
  const dir = await mkdtemp(join(tmpdir(), 'aiw-policy-'))
  const path = join(dir, 'policy.json')
  await writeFile(path, JSON.stringify(engineerPolicy()))
  assert.equal((await loadPolicy(path)).version, 'test-1')
})

async function modelsServer(handler) {
  const server = createServer(handler)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(resolve => server.close(resolve)) }
}

test('fetchCatalog keeps exact ids and reports errors without the token', async () => {
  let calls = 0
  const server = await modelsServer((req, res) => {
    calls++
    if (req.url !== '/v1/models' || req.headers.authorization !== 'Bearer secret-token') {
      res.writeHead(401).end()
      return
    }
    res.end('{"data":[{"id":"gpt-6.1-sol"},{"id":"Grok4.7"},{"id":""}]}')
  })
  try {
    const connection = { base_url: `${server.url}/v1/`, token_env: 'TEST_GATEWAY_TOKEN' }
    const ok = await fetchCatalog({ connectionId: 'ai-internal', connection, now: NOW, env: { TEST_GATEWAY_TOKEN: 'secret-token' } })
    assert.equal(ok.error, undefined)
    assert.deepEqual(ok.modelIds, ['gpt-6.1-sol', 'Grok4.7'])

    const denied = await fetchCatalog({ connectionId: 'ai-internal', connection, now: NOW, env: { TEST_GATEWAY_TOKEN: 'wrong' } })
    assert.match(denied.error, /401/)
    assert.doesNotMatch(denied.error, /wrong/)

    const missing = await fetchCatalog({ connectionId: 'ai-internal', connection, now: NOW, env: {} })
    assert.match(missing.error, /TEST_GATEWAY_TOKEN/)

    const fromEnv = { base_url_env: 'TEST_BASE', token_env: 'TEST_GATEWAY_TOKEN' }
    assert.match((await fetchCatalog({ connectionId: 'c', connection: fromEnv, now: NOW, env: { TEST_GATEWAY_TOKEN: 'secret-token' } })).error, /TEST_BASE/)
    const viaEnv = await fetchCatalog({ connectionId: 'c', connection: fromEnv, now: NOW, env: { TEST_GATEWAY_TOKEN: 'secret-token', TEST_BASE: `${server.url}/v1` } })
    assert.deepEqual(viaEnv.modelIds, ['gpt-6.1-sol', 'Grok4.7'])
    assert.ok(calls >= 3)
  } finally {
    await server.close()
  }
})

test('the catalog cache refreshes after half the max age and retries failures after a delay', async () => {
  let calls = 0
  const fetchImpl = async () => {
    calls++
    return new Response('{"data":[{"id":"gpt-6.1-sol"}]}', { status: 200 })
  }
  const cache = new CatalogCache({ env: { TEST_GATEWAY_TOKEN: 't' }, fetchImpl })
  const policy = engineerPolicy()
  await cache.snapshot(policy, NOW)
  await cache.snapshot(policy, NOW + 200_000)
  assert.equal(calls, 1)
  await cache.snapshot(policy, NOW + 301_000)
  assert.equal(calls, 2)

  const failing = new CatalogCache({ env: {}, fetchImpl })
  const first = await failing.snapshot(policy, NOW)
  assert.match(first['ai-internal'].error, /TEST_GATEWAY_TOKEN/)
  assert.equal(await failing.snapshot(policy, NOW + 10_000).then(s => s['ai-internal'].fetchedAt), NOW)
  assert.equal(await failing.snapshot(policy, NOW + 31_000).then(s => s['ai-internal'].fetchedAt), NOW + 31_000)
})
