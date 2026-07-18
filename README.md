# Symphony

A long-running automation service that continuously reads work from a configured issue
tracker, creates an isolated per-issue workspace, and runs a coding agent session for
each issue inside that workspace. This is a complete implementation of [`SPEC.md`](./SPEC.md)
(Symphony Service Specification, Draft v1).

Symphony is a scheduler/runner and tracker **reader**. Ticket writes (state transitions,
comments) are performed by the coding agent through host-side tools / a write-back channel;
the orchestrator never edits tickets itself.

## Quick start

Requirements: **Node.js ≥ 22.6** (24+ recommended — TypeScript runs directly, no build step)
and an authenticated **Codex** CLI (`codex app-server` must work).

```bash
npm install
npm start                 # runs ./WORKFLOW.md
# or
node src/index.ts ./WORKFLOW.md --port 7878
```

Open <http://127.0.0.1:7878> for the live console. It shows a **Board** of every issue
grouped by state (backlog, active, done — completed work stays visible), the live running
sessions, a detail drawer, and CTAs: **＋ New issue**, per-issue **Start** / **Hold** /
**Reopen**, and **Poll now**.

Click any issue to open its detail drawer with a timestamped **activity log** — the agent's
messages, shell commands, file edits, and turn lifecycle. Logs stream while a run is active
and are retained after it finishes (also at `GET /api/v1/<identifier>` as `recent_events`).

New work lands in a `backlog` state and does **not** run until you move it to an active
state (`todo`) — click **Start**, or `POST /api/v1/issues/<id>/state {"state":"todo"}`.

HTTP API: `GET /api/v1/state`, `GET /api/v1/issues` (board), `POST /api/v1/issues`
(`{ "identifier": "SYM-3", "title": "...", "state": "backlog" }`),
`POST /api/v1/issues/<id>/state`, `POST /api/v1/refresh`. Editing JSON files in `issues/`
by hand still works too.

Run the conformance tests:

```bash
npm test        # node --test test/
npm run typecheck
```

## "It tracks itself"

The shipped `WORKFLOW.md` uses the built-in **`file` tracker** (`tracker.kind: file`),
whose issues are JSON files in [`./issues`](./issues). Symphony reads those issues,
dispatches Codex to work each one in an isolated workspace, and the agent reports its
outcome back into the same issue store — so Symphony manages its own backlog with no
external tracker or credentials. See the end-to-end path below.

### How the agent transitions a tracked issue

1. The runner writes the normalized issue into the workspace as `SYMPHONY_ISSUE.json`.
2. The agent does the work in the workspace and writes `SYMPHONY_RESULT.json`
   (`{ "state": "...", "comment": "...", "pr_url": null }`).
3. After each turn the runner applies that result to the tracker via the adapter's
   `set_issue_result` tool, then re-checks state for continuation. A terminal state ends
   the run and the workspace is cleaned up.

The `file` adapter also advertises provider-native agent tools (`update_issue_state`,
`add_issue_comment`, `set_issue_result`) that execute **host-side**; if a Codex build
requests them via `item/tool/call`, they run against the issue store directly.

## Architecture

Layered exactly as SPEC §3.2, each layer independently portable:

```
Policy         WORKFLOW.md (YAML front matter + Liquid prompt body)
Configuration  src/config/config.ts        typed getters, defaults, $VAR, path norm
Coordination   src/orchestrator/*          single-authority state machine
Execution      src/workspace/*, src/agent/*  workspaces + agent sessions
Integration    src/tracker/*               tracker adapters + agent tools
Observability  src/logger.ts, src/server/* structured logs + HTTP dashboard/API
```

> **Integrating your own agent or tracker?** See [INTEGRATION.md](INTEGRATION.md) for the
> full walkthrough (files to change, the event vocabulary, testing). The console's
> **⚙ Integrate** button lists registered backends and the checklist.

### Agent backends are pluggable

The Execution layer talks to a coding agent only through the `AgentSession` interface
(`src/agent/types.ts`). **Codex is one backend** (`src/agent/appServerClient.ts`),
selected by `agent.kind: codex`. To add another agent:

1. Implement `AgentSession` (`start` → `runTurn`* → `stop`, emitting `AgentUpdate`s) and an
   `AgentFactory`.
2. Register it with `registerAgentFactory(factory)` (`src/agent/registry.ts`).
3. Select it with `agent.kind: <your-kind>` in `WORKFLOW.md`.

No orchestrator, runner, workspace, or tracker code changes. The runner, retry logic,
reconciliation, prompt rendering, and observability are all agent-neutral.

### Tracker adapters are pluggable

Adapters implement `TrackerAdapter` (`src/tracker/types.ts`) and are registered by `kind`
in `src/tracker/registry.ts`. Ship a new one (Linear, GitHub Projects, Jira, …) by mapping
provider payloads into the normalized `Issue` and deriving `dispatchable`.

## Trust & safety posture (SPEC §15.1 — required disclosure)

This implementation targets **trusted environments** and runs Codex in a **high-trust**
configuration by default:

- `codex.approval_policy: never` and `codex.thread_sandbox: danger-full-access` /
  `codex.turn_sandbox_policy: { type: dangerFullAccess }` — no approval round-trips; the
  agent may run commands and edit files within its workspace unattended.
- User-input-required turns are treated as a **hard failure** (the run does not stall).
- Unsupported dynamic tool calls return a structured failure and the session continues.

Baseline controls always enforced (SPEC §9.5, §15.2):

- The agent's cwd is always the per-issue workspace path.
- Workspace paths are sanitized (`[A-Za-z0-9._-]`, collision-resistant hash suffix) and
  are validated to stay inside the configured workspace root.

To harden (SPEC §15.5): tighten `approval_policy`/sandbox in `WORKFLOW.md`, run under a
dedicated OS user on a dedicated volume, and restrict which issues are eligible for
dispatch (states/labels/`dispatchable`).

## `file` tracker adapter profile (SPEC §11.2 — required)

- **`tracker.kind`**: `file`
- **`tracker.provider` keys**: `dir` (string path; default `./issues`, relative to the
  `WORKFLOW.md` directory; supports `~` and `$VAR`). No secret keys;
  `secret_environment_names()` returns `[]`.
- **Scope / pagination**: every `*.json` file directly under `dir` is one issue; no paging
  limit; files are read in sorted order.
- **`id` / `native_ref` mapping**: `id` defaults to `identifier` when absent; `native_ref`
  is preserved verbatim when it is a JSON object, else normalized to `null`.
- **Normalization**: required non-empty strings `id`/`identifier`/`title`/`state`; `labels`
  trimmed+lowercased+deduped; `priority` integer-or-null (1..4 rank first); `dispatchable`
  from the file (default `true`); timestamps pass through as strings-or-null.
- **Malformed record** = missing/blank required field or unreadable/non-object JSON.
  State-list reads log & omit malformed records; ID-refresh **fails** on a malformed
  requested record (`tracker_response`). Empty state/id lists return `[]` with no read.
- **Agent tools** (mutate tracker state): `update_issue_state({state, comment?})`,
  `add_issue_comment({comment})`, `set_issue_result({state?, comment?, pr_url?})`. Unknown
  tool names return a structured failure. Results are JSON-safe `{success, output}`.
- **Error mapping**: `AdapterError{category, message}` where category ∈
  `invalid_tracker_config | unsupported_tracker_kind | tracker_request | tracker_response`.

## Configuration cheat sheet

All fields, defaults, and semantics are in SPEC §6.4. The front matter keys are
`tracker`, `polling`, `workspace`, `hooks`, `agent`, `codex`, and (extension) `server`.
`agent.kind` (default `codex`) selects the agent backend. `WORKFLOW.md` is watched and
hot-reloaded; invalid reloads keep the last-good config and log an operator-visible error.

## Conformance

`npm test` covers the Core Conformance matrix (SPEC §17): workflow/config parsing and
reload, strict prompt rendering, workspace sanitization/containment/hooks, tracker
normalization + malformed handling + empty-list short-circuits + agent tools, and
orchestrator dispatch/continuation/backoff/retry via a fake agent backend. The Codex
app-server client is exercised by the real integration run described in "It tracks itself".
