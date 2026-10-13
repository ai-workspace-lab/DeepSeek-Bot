# aiw-orchestrator

The AI Workspace orchestrator: a DeepSeek Harness (DSH) host plugin that takes task runs
from Accounts, selects the role, executor and model under the reviewed role policy, runs the
task on one DSH subagent provider, and appends fenced events back to Accounts.

It lives beside `ds-bot/` in this fork and shares no code with it, so DS Bot keeps syncing
with upstream. It targets DSH `0.2.1-alpha.1`.

```text
App ─▶ Bridge ─▶ Accounts (session, task run, ordered events, lease)
                     ▲  claim / renew / events
                     │
          DSH  ── aiw-orchestrator ── select(policy, live /v1/models) ──▶ ctx.subagents.start
                                                                          ├─ opencode   (dsh-subagent-acp)
                                                                          ├─ codex      (dsh-subagent-codex)
                                                                          ├─ claude-code(dsh-subagent-claude-code)
                                                                          └─ grok       (dsh-subagent-acp)
                     QMD MCP ◀── mem_context before, mem_remember (candidate) after
```

## What it owns, and what it does not

- **Owns:** role selection (the hard gates moved from Bridge `rolepolicy`), the dispatch of
  one run to one executor, lease renewal, cancel, and the run's events.
- **Does not own:** any durable task state. Accounts is the only store of sessions, runs and
  events. A restarted worker keeps nothing; an expired lease hands the run to the next claim.
- **Never:** retries on another model, falls back to another executor after dispatch, or
  writes a fact as confirmed. Memory it writes is a `candidate`.

## Role policy (v0.5)

Same document as the Bridge `role-router-policy` with one change: an executor names a DSH
subagent provider family instead of a Bridge provider.

```json
"executors": {
  "opencode": { "connection": "ai-internal", "subagent_provider_template": "opencode:{model_id}", "capabilities": { … } }
}
```

For a candidate model whose observed gateway id is `gpt-6.1-sol`, the orchestrator dispatches
only to a mounted provider named exactly `opencode:gpt-6.1-sol`; an unmounted name excludes the
candidate with `executor_unavailable`. Each provider instance pins its own model in the
executor's native configuration (see `cordis.patch.yml`). `example/role-router-policy.example.json`
ships disabled with every gateway id unobserved.

Gates, in order: policy enabled → role known and enabled → product mode → specialty →
absolute workspace → budget mode → per candidate (executor order outranks model order):
workspace, observed mapping, provider mounted, executor capabilities verified, live catalog
present and fresh, model id in the catalog byte for byte, model capabilities verified, context
window verified and large enough, data class allowed on the connection.

Effort is resolved and recorded on the decision; subagent providers fix their own model
settings per instance, so it is not applied to the executor yet.

## Accounts task scheduler contract

Implemented by Accounts under `/api/internal/task-scheduler`. The bearer token is the
scheduler's own credential (`AIW_TASK_SCHEDULER_TOKEN` here), accepted only on these routes and
only for the accounts Accounts allows it to serve; it is not the general internal token.

| Route | Body | Reply |
|---|---|---|
| `POST /claim` | `accountId, workerId, leaseTtlSeconds` | `200 { run: { id, sessionId, namespaceId, fence, leaseToken, leaseExpiresAt, attempt }, message: { text, routing } }`, or `204` |
| `POST /runs/{id}/renew` | `accountId, workerId, fence, leaseToken, leaseTtlSeconds` | `200 { leaseExpiresAt, cancelRequested }`, `409` once the lease is lost |
| `POST /runs/{id}/events` | `accountId, workerId, fence, leaseToken, clientRequestId, type, payload` | `200 { event, lastEventSeq }`, `409` once the lease is lost |

`routing` carries `role, roleMode, roleModel, productMode, specialty, dataClass,
workingDirectory, projectId, attachments, followUp, previousTurnFailed`. `clientRequestId` is
`<runId>/<fence>/<step>`, so a retried append is idempotent.

Events per run:

| Outcome | Events |
|---|---|
| completed | `run.progressed{selected}`, `run.progressed{memory}`?, `run.progressed{started}`, `assistant.message.created{text}`, `run.completed` |
| rejected | `run.failed{phase: rejected, code: ROLE_SELECTION_REJECTED, roleSelection}` |
| cancelled | … `run.progressed{started}`, `run.cancelled` (cancel seen on renewal aborts the subagent) |
| executor stopped | … `run.failed{code: EXECUTOR_STOPPED, stopReason, diagnostic}` |
| executor fault | … `run.failed{code: EXECUTION_FAILED, error}` |
| memory down | `run.progressed{memory_unavailable, error}`; the run continues |
| lease lost / worker stopping | nothing more: another worker owns the run, or will once the lease expires |

Events carry the role decision and identifiers, never memory content or the prompt.

## Memory

`memory.url` is the QMD MCP endpoint (Streamable HTTP). Before dispatch the orchestrator
calls `contextTool` with `{ workspace_id, project_id, query }` (workspace = the run's
namespace, project = `routing.projectId`, else the session) and quotes the result into the
prompt inside `<shared-memory>`, marked as data and not instructions. After a completed run it
calls `recordTool` with the answer as a `candidate` and its source (`task-run`, run id, session,
executor, model). Tool names are configuration: the target contract is `mem_context` /
`mem_remember`, and a QMD build without them fails the call loudly.

## Configuration

See `cordis.patch.yml`. `policyPath` must be absolute. Tokens are named by environment
variable (`accounts.tokenEnv`, `memory.tokenEnv`), never written into configuration. A bad
policy or configuration logs `aiw-orchestrator not_started` and leaves DSH running.

## Tests

```sh
npm test                                             # unit tests, no DSH needed
DSH_BIN=/path/to/node_modules/.bin/dsh node dev/integration.mjs receipt.json
```

`dev/integration.mjs` boots a real `dsh --profile web` in a throwaway `DSH_HOME` with this
plugin linked and the official `@deepseek-ai/dsh-subagent-acp`, pointed at
`dev/fake-acp-agent.mjs` (a scripted ACP agent, no model or key), against the in-process fake
Accounts, catalog and MCP server in `dev/fake-services.mjs`. It checks a completed run (memory
fenced into the prompt, cwd is the task workspace, candidate recorded), a cancel during the
run, and a rejected role, and writes a receipt. It does not exercise real executors, models,
Accounts or QMD.
