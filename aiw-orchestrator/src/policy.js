// Role policy: the reviewed, editable document that decides which executor and model a
// task may use. Loading validates every reference so a broken policy fails at start, not
// as a silent mis-selection later.
import { readFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'

export const ROLES = ['chat', 'worker', 'engineer', 'architect', 'researcher', 'specialist']
export const STATE = { verified: 'verified', declared: 'declared', unknown: 'unknown' }
export const PRODUCT_MODES = ['work', 'code']
export const BUDGET_MODES = { disabled: 'disabled', gatewayQuota: 'gateway_quota' }
export const EFFORT_LEVELS = ['off', 'low', 'medium', 'high', 'max']
export const MODEL_ID_PLACEHOLDER = '{model_id}'

const policyError = message => new Error(`role policy: ${message}`)

const time = (value) => {
  if (value === undefined || value === null || value === '') return undefined
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? undefined : parsed
}

// A fact counts only while it is verified and its evidence has not expired.
export function factVerified(fact, now) {
  if (fact?.state !== STATE.verified) return false
  const validUntil = time(fact.valid_until)
  return validUntil !== undefined && now < validUntil
}

export function factState(fact, now) {
  if (fact?.state === STATE.verified) return factVerified(fact, now) ? STATE.verified : STATE.unknown
  if (fact?.state === STATE.declared) return STATE.declared
  return STATE.unknown
}

export function factPositiveInt(fact) {
  const value = fact?.value
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.trunc(value) : undefined
}

export function effortIndex(level) {
  return EFFORT_LEVELS.indexOf(level)
}

function validateEffortRange(range) {
  const [start, low, high] = [range.start, range.min, range.max].map(effortIndex)
  if (start < 0 || low < 0 || high < 0) throw policyError(`effort start, min and max must be one of ${EFFORT_LEVELS.join(', ')}`)
  if (low > start || start > high) throw policyError(`effort needs min <= start <= max, got ${range.min} <= ${range.start} <= ${range.max}`)
}

function validateEffortRules(rules) {
  if (!rules) throw policyError('a role has an effort range but limits.effort_rules is missing')
  for (const key of ['large_context_tokens', 'large_context_attachments', 'short_follow_up_chars']) {
    if (!(Number.isInteger(rules[key]) && rules[key] > 0)) throw policyError(`limits.effort_rules.${key} must be a positive integer`)
  }
}

const nonEmpty = value => typeof value === 'string' && value.trim() !== ''

export function validatePolicy(policy) {
  if (!policy || typeof policy !== 'object') throw policyError('document must be an object')
  if (!nonEmpty(policy.version)) throw policyError('version is required')
  const budget = policy.budget?.mode
  if (!Object.values(BUDGET_MODES).includes(budget)) throw policyError(`unsupported budget.mode ${JSON.stringify(budget)}`)
  const limits = policy.limits ?? {}
  if (!(Number.isInteger(limits.context_reserve_tokens) && limits.context_reserve_tokens > 0)) throw policyError('limits.context_reserve_tokens must be positive')
  if (!(Number.isInteger(limits.catalog_max_age_seconds) && limits.catalog_max_age_seconds > 0)) throw policyError('limits.catalog_max_age_seconds must be positive')

  const connections = policy.connections ?? {}
  for (const [id, conn] of Object.entries(connections)) {
    if (nonEmpty(conn.base_url) === nonEmpty(conn.base_url_env)) throw policyError(`connection ${id} needs exactly one of base_url or base_url_env`)
    if (!nonEmpty(conn.token_env)) throw policyError(`connection ${id} has no token_env`)
  }
  const executors = policy.executors ?? {}
  for (const [id, exec] of Object.entries(executors)) {
    if (!Object.hasOwn(connections, exec.connection)) throw policyError(`executor ${id} references unknown connection ${JSON.stringify(exec.connection)}`)
    if (!nonEmpty(exec.subagent_provider_template) || !exec.subagent_provider_template.includes(MODEL_ID_PLACEHOLDER)) {
      throw policyError(`executor ${id} subagent_provider_template must contain ${MODEL_ID_PLACEHOLDER}`)
    }
  }
  const models = policy.models ?? {}
  for (const [key, model] of Object.entries(models)) {
    for (const connId of Object.keys(model.bindings ?? {})) {
      if (!Object.hasOwn(connections, connId)) throw policyError(`model ${key} binds unknown connection ${connId}`)
    }
  }
  for (const [roleId, role] of Object.entries(policy.roles ?? {})) {
    if (!ROLES.includes(roleId)) throw policyError(`unknown role ${roleId}`)
    for (const key of role.preferences ?? []) {
      if (!Object.hasOwn(models, key)) throw policyError(`role ${roleId} prefers unknown model ${key}`)
      if (models[key].candidate_only) throw policyError(`role ${roleId} prefers candidate_only model ${key}`)
    }
    for (const execId of role.executors ?? []) {
      if (!Object.hasOwn(executors, execId)) throw policyError(`role ${roleId} references unknown executor ${execId}`)
    }
    for (const mode of role.product_modes ?? []) {
      if (!PRODUCT_MODES.includes(mode)) throw policyError(`role ${roleId} lists product mode ${mode}; only work and code route by role`)
    }
    if (role.effort) {
      validateEffortRange(role.effort)
      validateEffortRules(limits.effort_rules)
    }
  }
  return policy
}

export function parsePolicy(text) {
  let policy
  try {
    policy = JSON.parse(text)
  } catch (error) {
    throw policyError(`decode: ${error.message}`)
  }
  return validatePolicy(policy)
}

export async function loadPolicy(path) {
  if (!isAbsolute(path)) throw policyError(`policy path must be absolute: ${path}`)
  return parsePolicy(await readFile(path, 'utf8'))
}

export function enabledRoles(policy) {
  return ROLES.filter(role => policy.roles?.[role]?.enabled === true)
}

export function resolveBaseUrl(conn, env = process.env) {
  if (nonEmpty(conn.base_url_env)) return (env[conn.base_url_env.trim()] ?? '').trim()
  return (conn.base_url ?? '').trim()
}
