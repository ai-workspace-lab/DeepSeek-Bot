// The pure selector: one task contract in, one executor + model decision or an explicit
// rejection out. It has no side effects; it never dispatches, retries or falls back.
import { isAbsolute } from 'node:path'
import {
  BUDGET_MODES, EFFORT_LEVELS, MODEL_ID_PLACEHOLDER, ROLES,
  effortIndex, enabledRoles, factPositiveInt, factState, factVerified,
} from './policy.js'

export const MODE = { auto: 'auto', manual: 'manual' }

export const CODE = {
  policyDisabled: 'policy_disabled',
  roleRequired: 'role_required',
  roleUnknown: 'role_unknown',
  roleNotEnabled: 'role_not_enabled',
  roleNotAllowedForMode: 'role_not_allowed_for_mode',
  specialtyRequired: 'specialty_required',
  workspaceUnauthorized: 'workspace_unauthorized',
  budgetUnconfigured: 'budget_unconfigured',
  modelUnknown: 'model_unknown',
  noEligibleCandidate: 'no_eligible_candidate',
}

export const EXCLUSION = {
  workspaceRequired: 'workspace_required',
  pendingMapping: 'pending_mapping',
  executorUnavailable: 'executor_unavailable',
  executorCapability: 'executor_capability_unverified',
  catalogUnavailable: 'catalog_unavailable',
  catalogStale: 'catalog_stale',
  notInLiveCatalog: 'not_in_live_catalog',
  capabilityUnverified: 'capability_unverified',
  contextUnknown: 'context_unknown',
  contextInsufficient: 'context_insufficient',
  egressNotAllowed: 'egress_not_allowed',
}

const trim = value => (typeof value === 'string' ? value.trim() : '')
const dataClassOrDefault = value => trim(value) || 'unclassified'

function reject(decision, code, message, ...nextSteps) {
  return { ...decision, selected: false, code, message, nextSteps: [...(decision.nextSteps ?? []), ...nextSteps] }
}

// The subagent provider registry name for one executor and model. Executors bind their
// model per provider instance, so each (executor, model) pair is its own registered name.
export function subagentProviderName(executor, modelId) {
  return executor.subagent_provider_template.replaceAll(MODEL_ID_PLACEHOLDER, modelId)
}

// Start at the role's start level, apply the rules in a fixed order, clamp to the range.
export function resolveEffort(range, rules, signals) {
  const decision = { start: range.start, min: range.min, max: range.max, adjustments: [] }
  let level = effortIndex(range.start)
  if (signals.promptTokens > rules.large_context_tokens || signals.attachments >= rules.large_context_attachments) {
    level++
    decision.adjustments.push(`+1 large context: ${signals.promptTokens} tokens, ${signals.attachments} attachments`)
  }
  if (signals.followUp && signals.promptChars < rules.short_follow_up_chars) {
    level--
    decision.adjustments.push(`-1 short follow-up: ${signals.promptChars} characters`)
  }
  if (signals.previousTurnFailed) {
    level++
    decision.adjustments.push('+1 retry after a failed turn')
  }
  if (level < effortIndex(range.min)) {
    level = effortIndex(range.min)
    decision.adjustments.push(`clamped to min ${range.min}`)
  }
  if (level > effortIndex(range.max)) {
    level = effortIndex(range.max)
    decision.adjustments.push(`clamped to max ${range.max}`)
  }
  decision.level = EFFORT_LEVELS[level]
  return decision
}

function evaluate({ policy, role, key, model, execId, exec, catalogs, available, request, estimate, maxAgeMs, now }) {
  const exclude = (code, detail) => ({ model: key, executor: execId, code, detail })
  if (!isAbsolute(trim(request.workingDirectory))) {
    return exclude(EXCLUSION.workspaceRequired, 'executors need an authorized absolute workspace')
  }
  const binding = model.bindings?.[exec.connection]
  const modelId = trim(binding?.gateway_model_id ?? '')
  if (!modelId) return exclude(EXCLUSION.pendingMapping, `no observed gateway model id on ${exec.connection}`)
  const provider = subagentProviderName(exec, modelId)
  if (!available.has(provider)) return exclude(EXCLUSION.executorUnavailable, `subagent provider ${provider} is not mounted`)
  for (const capability of role.required_executor_capabilities ?? []) {
    const fact = exec.capabilities?.[capability]
    if (!factVerified(fact, now)) return exclude(EXCLUSION.executorCapability, `${capability} is ${factState(fact, now)}`)
  }
  const snapshot = catalogs?.[exec.connection]
  if (!snapshot || snapshot.error) {
    return exclude(EXCLUSION.catalogUnavailable, snapshot?.error || `no live catalog for ${exec.connection}`)
  }
  if (now - snapshot.fetchedAt > maxAgeMs) {
    return exclude(EXCLUSION.catalogStale, `catalog fetched at ${new Date(snapshot.fetchedAt).toISOString()}`)
  }
  if (!snapshot.modelIds.includes(modelId)) {
    return exclude(EXCLUSION.notInLiveCatalog, `${modelId} is not returned by ${exec.connection} /v1/models`)
  }
  for (const capability of role.required_model_capabilities ?? []) {
    const fact = binding.capabilities?.[capability]
    if (!factVerified(fact, now)) return exclude(EXCLUSION.capabilityUnverified, `${capability} is ${factState(fact, now)}`)
  }
  if (!factVerified(binding.context_window, now)) {
    return exclude(EXCLUSION.contextUnknown, `context window is ${factState(binding.context_window, now)}`)
  }
  const window = factPositiveInt(binding.context_window)
  if (window === undefined) return exclude(EXCLUSION.contextUnknown, 'context window value is not a positive number')
  if (window < estimate) return exclude(EXCLUSION.contextInsufficient, 'estimated tokens exceed the verified window')
  const allowed = policy.connections[exec.connection].allowed_data_classes ?? []
  if (!allowed.includes(dataClassOrDefault(request.dataClass))) {
    return exclude(EXCLUSION.egressNotAllowed, `data class ${dataClassOrDefault(request.dataClass)} may not be sent to ${exec.connection}`)
  }
  return undefined
}

// request: { role, roleMode, manualModel, productMode, specialty, dataClass,
//   workingDirectory, promptBytes, promptChars, attachments, followUp,
//   previousTurnFailed, availableProviders: string[], now: epoch ms }
export function select(policy, catalogs, request) {
  const now = request.now ?? Date.now()
  const mode = trim(request.roleMode) === MODE.manual ? MODE.manual : MODE.auto
  let decision = { selected: false, roleMode: mode, excluded: [], reasons: [] }
  if (!policy?.enabled) {
    if (policy) decision.policyVersion = policy.version
    return reject(decision, CODE.policyDisabled, 'role policy is not enabled', 'enable the reviewed policy before routing by role')
  }
  decision.policyVersion = policy.version
  decision.enabledRoles = enabledRoles(policy)

  let roleId = trim(request.role).toLowerCase()
  if (!roleId) {
    if (mode === MODE.manual || decision.enabledRoles.length !== 1) {
      return reject(decision, CODE.roleRequired, 'role must be chosen', 'pick one of the enabled roles')
    }
    roleId = decision.enabledRoles[0]
    decision.reasons.push(`auto: ${roleId} is the only enabled role`)
  }
  decision.role = roleId
  if (!ROLES.includes(roleId)) return reject(decision, CODE.roleUnknown, `unknown role ${roleId}`, 'pick one of the enabled roles')
  const role = policy.roles?.[roleId]
  if (!role?.enabled) return reject(decision, CODE.roleNotEnabled, `role ${roleId} is not enabled in this policy`, 'pick one of the enabled roles')
  const productMode = trim(request.productMode)
  if (productMode && !(role.product_modes ?? []).includes(productMode)) {
    return reject(decision, CODE.roleNotAllowedForMode, `role ${roleId} is not available in product mode ${productMode}`,
      `pick a role allowed in ${productMode} or the default mode`)
  }
  if (role.requires_specialty && !trim(request.specialty)) {
    return reject(decision, CODE.specialtyRequired, 'specialist tasks need a specialty', 'state the specialty')
  }
  if (role.requires_workspace && !isAbsolute(trim(request.workingDirectory))) {
    return reject(decision, CODE.workspaceUnauthorized, `role ${roleId} needs an authorized absolute workspace`, 'open or authorize a workspace')
  }
  if (policy.budget.mode !== BUDGET_MODES.gatewayQuota) {
    return reject(decision, CODE.budgetUnconfigured, `paid dispatch is disabled by budget.mode=${policy.budget.mode}`,
      'configure the connection quota and set budget.mode=gateway_quota')
  }

  let candidates = role.preferences ?? []
  if (mode === MODE.manual) {
    const key = trim(request.manualModel)
    const model = policy.models?.[key]
    if (!model || model.candidate_only) {
      return reject(decision, CODE.modelUnknown, `model ${key} is not a selectable entry in the policy registry`,
        'choose a registered model or finish its activation steps')
    }
    candidates = [key]
  }

  const promptTokens = Math.trunc((request.promptBytes ?? 0) / 2)
  const estimate = promptTokens + policy.limits.context_reserve_tokens
  decision.estimatedTokens = estimate
  const available = new Set((request.availableProviders ?? []).map(trim))
  const maxAgeMs = policy.limits.catalog_max_age_seconds * 1000

  // Executor order outranks model order: the first executor that passes every gate wins,
  // even with a later-preferred model.
  for (const execId of role.executors ?? []) {
    const exec = policy.executors[execId]
    for (const key of candidates) {
      const model = policy.models[key]
      const exclusion = evaluate({ policy, role, key, model, execId, exec, catalogs, available, request, estimate, maxAgeMs, now })
      if (exclusion) {
        decision.excluded.push(exclusion)
        continue
      }
      const modelId = trim(model.bindings[exec.connection].gateway_model_id)
      decision = {
        ...decision,
        selected: true,
        executor: execId,
        connection: exec.connection,
        modelKey: key,
        modelId,
        subagentProvider: subagentProviderName(exec, modelId),
        tools: [...(role.tools ?? [])],
      }
      decision.reasons.push(`${mode}: ${key} on ${execId} is the first executor and model in ${roleId} order that passed every hard gate`)
      if (role.effort) {
        decision.effort = resolveEffort(role.effort, policy.limits.effort_rules, {
          promptTokens,
          attachments: request.attachments ?? 0,
          promptChars: request.promptChars ?? 0,
          followUp: request.followUp === true,
          previousTurnFailed: request.previousTurnFailed === true,
        })
      }
      return decision
    }
  }
  return reject(decision, CODE.noEligibleCandidate, 'no candidate passed the hard gates',
    'verify missing capabilities', 'switch to a connected executor', 'choose a model manually', 'narrow the task')
}

// The decision as recorded on task events: identifiers and reasons only, never prompts.
export function decisionSummary(decision) {
  const keys = ['selected', 'code', 'message', 'policyVersion', 'role', 'roleMode', 'executor', 'connection',
    'modelKey', 'modelId', 'subagentProvider', 'tools', 'estimatedTokens', 'effort', 'reasons', 'excluded',
    'enabledRoles', 'nextSteps']
  return Object.fromEntries(keys.filter(key => decision[key] !== undefined).map(key => [key, decision[key]]))
}
