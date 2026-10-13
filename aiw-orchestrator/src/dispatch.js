// Runs one task on one DSH subagent provider. The parent is an ordinary DSH root Session in
// the task's workspace; it stays as the audit record of the delegation.

export const WORKSPACE_LABEL = 'AI Workspace'

const outputText = output => (output ?? []).filter(part => part?.type === 'text').map(part => part.text).join('').trim()

export class SubagentDispatcher {
  constructor(ctx) {
    this.ctx = ctx
  }

  providers() {
    return this.ctx.subagents.list()
  }

  async workspaceFor(path) {
    const registry = this.ctx.workspaceRegistry
    const existing = await registry.resolveByPath(path)
    return existing ?? registry.create(path, WORKSPACE_LABEL)
  }

  // Resolves { stopReason, text, diagnostic, parentSessionId, childId }. Child-level failures
  // resolve with a non-completed stopReason; only infrastructure faults reject.
  async run({ workingDirectory, provider, prompt, label, signal }) {
    const workspace = await this.workspaceFor(workingDirectory)
    const { sessionId } = await this.ctx.sessionController.create({ workspaceId: workspace.id })
    const resolved = await this.ctx.sessionController.resolveAgent(sessionId)
    if ('error' in resolved) throw new Error(resolved.error?.message ?? 'parent session unavailable')
    const run = await this.ctx.subagents.start(provider, {
      label,
      prompt: [{ type: 'text', text: prompt }],
      parent: resolved.agent,
      signal,
    })
    try {
      const result = await run.result
      return {
        stopReason: result.stopReason,
        text: outputText(result.output),
        diagnostic: result.diagnostic,
        parentSessionId: sessionId,
        childId: run.id,
      }
    } finally {
      await run.dispose()
    }
  }
}
