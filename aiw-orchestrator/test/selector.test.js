import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CODE, EXCLUSION, decisionSummary, resolveEffort, select } from '../src/selector.js'
import { NOW, engineerPolicy, engineerRequest, liveCatalog } from './fixtures.js'

const excluded = (decision, model, code) => decision.excluded.some(item => item.model === model && item.code === code)
const assertExcluded = (decision, model, code) => assert.ok(excluded(decision, model, code), `expected ${model} excluded with ${code}, got ${JSON.stringify(decision.excluded)}`)

test('engineer picks the first preference that passes every gate', () => {
  const decision = select(engineerPolicy(), liveCatalog('gpt-6.1-sol', 'other'), engineerRequest())
  assert.equal(decision.selected, true)
  assert.equal(decision.executor, 'opencode')
  assert.equal(decision.modelId, 'gpt-6.1-sol')
  assert.equal(decision.subagentProvider, 'opencode:gpt-6.1-sol')
  assert.equal(decision.roleMode, 'auto')
  assert.equal(decision.policyVersion, 'test-1')
})

test('a catalog id without an observed mapping is not selected', () => {
  const policy = engineerPolicy()
  policy.roles.engineer.preferences = ['claude-opus-5-5']
  const decision = select(policy, liveCatalog('gpt-6.1-sol', 'claude-opus-5-5'), engineerRequest())
  assert.equal(decision.selected, false)
  assert.equal(decision.code, CODE.noEligibleCandidate)
  assertExcluded(decision, 'claude-opus-5-5', EXCLUSION.pendingMapping)
})

test('a model missing from the live catalog is rejected', () => {
  const decision = select(engineerPolicy(), liveCatalog('something-else'), engineerRequest())
  assert.equal(decision.selected, false)
  assertExcluded(decision, 'gpt-6.1-sol', EXCLUSION.notInLiveCatalog)
})

test('model ids are compared byte for byte', () => {
  const decision = select(engineerPolicy(), liveCatalog('gpt-6-1-sol', 'GPT-6.1-SOL'), engineerRequest())
  assert.equal(decision.selected, false)
})

test('a stale or failed catalog excludes the candidate', () => {
  const stale = liveCatalog('gpt-6.1-sol')
  stale['ai-internal'].fetchedAt = NOW - 3600_000
  assertExcluded(select(engineerPolicy(), stale, engineerRequest()), 'gpt-6.1-sol', EXCLUSION.catalogStale)
  const failed = { 'ai-internal': { connectionId: 'ai-internal', fetchedAt: NOW, modelIds: [], error: 'GET returned 401' } }
  assertExcluded(select(engineerPolicy(), failed, engineerRequest()), 'gpt-6.1-sol', EXCLUSION.catalogUnavailable)
})

test('engineer without an absolute workspace is rejected', () => {
  for (const workingDirectory of ['', 'relative/dir']) {
    const decision = select(engineerPolicy(), liveCatalog('gpt-6.1-sol'), engineerRequest({ workingDirectory }))
    assert.equal(decision.code, CODE.workspaceUnauthorized)
  }
})

test('executor capabilities must be verified, not declared', () => {
  const policy = engineerPolicy()
  for (const exec of Object.values(policy.executors)) exec.capabilities.test_runner = { value: true, state: 'declared' }
  const decision = select(policy, liveCatalog('gpt-6.1-sol'), engineerRequest())
  assert.equal(decision.selected, false)
  assertExcluded(decision, 'gpt-6.1-sol', EXCLUSION.executorCapability)
})

test('expired evidence counts as unknown', () => {
  const policy = engineerPolicy()
  policy.models['gpt-6.1-sol'].bindings['ai-internal'].capabilities.tool_calling = {
    value: true, state: 'verified', valid_until: new Date(NOW - 1000).toISOString(),
  }
  assertExcluded(select(policy, liveCatalog('gpt-6.1-sol'), engineerRequest()), 'gpt-6.1-sol', EXCLUSION.capabilityUnverified)
})

test('context window gates: too small, and unknown', () => {
  assertExcluded(select(engineerPolicy(), liveCatalog('gpt-6.1-sol'), engineerRequest({ promptBytes: 800000 })), 'gpt-6.1-sol', EXCLUSION.contextInsufficient)
  const policy = engineerPolicy()
  policy.models['gpt-6.1-sol'].bindings['ai-internal'].context_window = { state: 'unknown' }
  assertExcluded(select(policy, liveCatalog('gpt-6.1-sol'), engineerRequest()), 'gpt-6.1-sol', EXCLUSION.contextUnknown)
})

test('egress gate refuses a data class the connection may not receive', () => {
  assertExcluded(select(engineerPolicy(), liveCatalog('gpt-6.1-sol'), engineerRequest({ dataClass: 'confidential' })), 'gpt-6.1-sol', EXCLUSION.egressNotAllowed)
})

test('an unmounted provider moves selection to the next executor', () => {
  const decision = select(engineerPolicy(), liveCatalog('gpt-6.1-sol'), engineerRequest({ availableProviders: ['codex:gpt-6.1-sol'] }))
  assert.equal(decision.selected, true)
  assert.equal(decision.executor, 'codex')
  assert.equal(decision.subagentProvider, 'codex:gpt-6.1-sol')
  assertExcluded(decision, 'gpt-6.1-sol', EXCLUSION.executorUnavailable)
})

test('a disabled budget refuses paid dispatch', () => {
  const policy = engineerPolicy()
  policy.budget.mode = 'disabled'
  assert.equal(select(policy, liveCatalog('gpt-6.1-sol'), engineerRequest()).code, CODE.budgetUnconfigured)
})

test('role gates: not enabled, unknown, only-enabled auto pick, manual needs a role, policy off', () => {
  const policy = engineerPolicy()
  assert.equal(select(policy, liveCatalog('gpt-6.1-sol'), engineerRequest({ role: 'researcher' })).code, CODE.roleNotEnabled)
  assert.equal(select(policy, liveCatalog('gpt-6.1-sol'), engineerRequest({ role: 'wizard' })).code, CODE.roleUnknown)
  const auto = select(policy, liveCatalog('gpt-6.1-sol'), engineerRequest({ role: '' }))
  assert.equal(auto.selected, true)
  assert.equal(auto.role, 'engineer')
  assert.equal(select(policy, liveCatalog('gpt-6.1-sol'), engineerRequest({ role: '', roleMode: 'manual', manualModel: 'gpt-6.1-sol' })).code, CODE.roleRequired)
  policy.enabled = false
  assert.equal(select(policy, liveCatalog('gpt-6.1-sol'), engineerRequest()).code, CODE.policyDisabled)
})

test('a manual model goes through the same gates', () => {
  const manual = select(engineerPolicy(), liveCatalog('gpt-6.1-sol'), engineerRequest({ roleMode: 'manual', manualModel: 'claude-opus-5-5' }))
  assert.equal(manual.selected, false)
  assertExcluded(manual, 'claude-opus-5-5', EXCLUSION.pendingMapping)
  assert.equal(select(engineerPolicy(), liveCatalog('gpt-6.1-sol'), engineerRequest({ roleMode: 'manual', manualModel: 'not-registered' })).code, CODE.modelUnknown)
})

test('specialist tasks need a specialty', () => {
  const policy = engineerPolicy()
  policy.roles.specialist = { enabled: true, requires_specialty: true }
  assert.equal(select(policy, liveCatalog('gpt-6.1-sol'), engineerRequest({ role: 'specialist' })).code, CODE.specialtyRequired)
})

test('product mode gate', () => {
  const policy = engineerPolicy()
  policy.roles.engineer.product_modes = ['code']
  assert.equal(select(policy, liveCatalog('gpt-6.1-sol'), engineerRequest({ productMode: 'work' })).code, CODE.roleNotAllowedForMode)
  assert.equal(select(policy, liveCatalog('gpt-6.1-sol'), engineerRequest({ productMode: 'code' })).selected, true)
})

test('effort starts at the role start, follows the rules and clamps', () => {
  const policy = engineerPolicy()
  policy.roles.engineer.effort = { start: 'high', min: 'medium', max: 'max' }
  policy.limits.effort_rules = { large_context_tokens: 32000, large_context_attachments: 3, short_follow_up_chars: 200 }
  const decision = select(policy, liveCatalog('gpt-6.1-sol'), engineerRequest({ attachments: 3 }))
  assert.equal(decision.effort.level, 'max')
  const rules = policy.limits.effort_rules
  const range = { start: 'medium', min: 'medium', max: 'high' }
  assert.equal(resolveEffort(range, rules, { promptTokens: 10, attachments: 0, promptChars: 50, followUp: true }).level, 'medium')
  assert.deepEqual(resolveEffort(range, rules, { promptTokens: 40000, attachments: 0, promptChars: 0, previousTurnFailed: true }).adjustments.at(-1), 'clamped to max high')
})

test('the decision summary carries identifiers and reasons, never the prompt', () => {
  const decision = select(engineerPolicy(), liveCatalog('gpt-6.1-sol'), engineerRequest())
  const summary = decisionSummary(decision)
  assert.equal(summary.subagentProvider, 'opencode:gpt-6.1-sol')
  assert.ok(!('prompt' in summary))
})
