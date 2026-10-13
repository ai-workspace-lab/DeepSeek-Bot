// Shared policy fixtures: the Engineer loop the Bridge selector was tested with, moved to
// DSH subagent providers.
export const NOW = Date.parse('2026-10-07T12:00:00Z')
const HOUR = 3600_000

export const verified = value => ({
  value,
  state: 'verified',
  source: 'test',
  checked_at: new Date(NOW - HOUR).toISOString(),
  valid_until: new Date(NOW + 24 * HOUR).toISOString(),
})

const executorCapabilities = () => ({
  workspace_edit: verified(true),
  test_runner: verified(true),
})

export function engineerPolicy() {
  return {
    version: 'test-1',
    enabled: true,
    budget: { mode: 'gateway_quota' },
    limits: { context_reserve_tokens: 16000, catalog_max_age_seconds: 600 },
    connections: {
      'ai-internal': { base_url: 'https://gateway.example/v1', token_env: 'TEST_GATEWAY_TOKEN', allowed_data_classes: ['unclassified', 'internal'] },
    },
    executors: {
      opencode: { connection: 'ai-internal', subagent_provider_template: 'opencode:{model_id}', capabilities: executorCapabilities() },
      codex: { connection: 'ai-internal', subagent_provider_template: 'codex:{model_id}', capabilities: executorCapabilities() },
    },
    models: {
      'gpt-6.1-sol': {
        display_name: 'GPT 6.1 Sol',
        bindings: { 'ai-internal': { gateway_model_id: 'gpt-6.1-sol', capabilities: { tool_calling: verified(true) }, context_window: verified(400000) } },
      },
      'claude-opus-5-5': {
        display_name: 'Claude Opus 5.5',
        bindings: { 'ai-internal': { gateway_model_id: null } },
      },
    },
    roles: {
      engineer: {
        enabled: true,
        preferences: ['gpt-6.1-sol', 'claude-opus-5-5'],
        executors: ['opencode', 'codex'],
        required_model_capabilities: ['tool_calling'],
        required_executor_capabilities: ['workspace_edit', 'test_runner'],
        requires_workspace: true,
        tools: ['read', 'edit', 'bash'],
      },
      researcher: { enabled: false },
    },
  }
}

export const liveCatalog = (...ids) => ({ 'ai-internal': { connectionId: 'ai-internal', fetchedAt: NOW - 60_000, modelIds: ids } })

export const engineerRequest = (overrides = {}) => ({
  role: 'engineer',
  workingDirectory: '/srv/workspace/demo',
  promptBytes: 2000,
  availableProviders: ['opencode:gpt-6.1-sol', 'codex:gpt-6.1-sol'],
  now: NOW,
  ...overrides,
})
