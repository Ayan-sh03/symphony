# Architecture

Symphony separates policy, coordination, execution, integrations, and observability so
agent and tracker backends can change without altering the orchestration loop.

```mermaid
flowchart TD
    W["WORKFLOW.md<br/>configuration and prompt"] --> C["Configuration"]
    C --> O["Orchestrator<br/>poll, dispatch, retry, reconcile"]
    O --> T["Tracker adapter<br/>file or GitHub"]
    O --> A["Agent session<br/>Codex or OpenCode"]
    O --> S["HTTP console and API"]
    A --> X["Isolated issue workspace"]
```

| Layer | Location | Responsibility |
|---|---|---|
| Policy | `WORKFLOW.md` | Tracker, workspace, agent, polling, and Liquid prompt |
| Configuration | `src/config`, `src/workflow` | Validation, defaults, path resolution, hot reload |
| Coordination | `src/orchestrator` | Dispatch, concurrency, continuation, retries, reconciliation |
| Execution | `src/workspace`, `src/agent` | Workspaces, worktrees, and coding-agent sessions |
| Integration | `src/tracker` | Issue normalization and host-side tracker tools |
| Observability | `src/history`, `src/server` | Activity history, costs, console, and HTTP API |
| Multi-project host | `src/project` | Independent orchestrators loaded from a project manifest |

## Execution flow

1. The tracker returns normalized, dispatchable issues in an active state.
2. The orchestrator reserves capacity and prepares an isolated workspace.
3. Symphony renders the workflow prompt and starts the configured agent in that
   workspace.
4. Agent updates feed the activity log, usage counters, and stall detection.
5. Host-side tracker tools apply comments and state changes without exposing tracker
   credentials to the agent.
6. Symphony re-reads the issue after a turn and either continues, retries, or finalizes
   the run.

Repository-backed projects use git worktrees and preserve their delivery branches.
Scratch projects use ordinary per-issue directories. Follow-up issues share the original
work stream so review fixes land on the same branch.

See [`SPEC.md`](../SPEC.md) for the complete behavioral contract and
[`INTEGRATION.md`](../INTEGRATION.md) for extension interfaces and tests.
