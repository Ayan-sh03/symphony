# Integrating your own agent

Symphony drives any coding agent through a single interface, `AgentSession`. The
orchestrator, tracker, workspace manager, prompt renderer, retry/reconciliation logic,
and the console are all **backend-neutral** — they never mention Codex. Adding a new
agent means writing one class and registering it. This guide walks through it, lists the
event vocabulary, and covers testing. A shorter section at the end covers adding a
**tracker adapter** the same way.

Everything here is plain TypeScript run directly by Node (no build step): edit a file,
`node --test`, run.

---

## 1. The contract

Your backend implements [`AgentSession`](src/agent/types.ts):

```ts
export interface AgentSession {
  start(): Promise<AgentSessionIdentity>;              // launch + prepare a thread
  runTurn(input: string, title?: string): Promise<AgentTurnResult>;
  stop(): void;                                        // idempotent teardown
  readonly threadId: string | null;
  readonly pid: string | null;                         // null if not a subprocess
}

export interface AgentSessionIdentity { threadId: string; }
export interface AgentTurnResult {
  status: "completed" | "failed" | "cancelled" | "timeout";
  error?: string;
}
```

A factory constructs one session per worker attempt:

```ts
export interface AgentFactory {
  readonly kind: string;                               // matches agent.kind in WORKFLOW.md
  create(opts: AgentSessionOptions): AgentSession;
}
```

`create` receives everything the run needs ([`AgentSessionOptions`](src/agent/types.ts)):

| Field | What it is |
|---|---|
| `workspacePath` | Absolute per-issue workspace. **Your agent MUST run with this as its cwd.** |
| `issue` | The normalized issue (id, identifier, title, description, labels, …). |
| `config` | The full typed `ServiceConfigValues`. Read your own section (e.g. `config.codex`, or a section you add). |
| `logger` | Structured logger. |
| `onUpdate(u)` | Emit an `AgentUpdate` to the orchestrator (metrics, activity log, stall detection). |
| `adapter` | Tracker adapter bound to this session — for executing provider-native tools host-side. |
| `toolSpecs` | Provider-native tool specs advertised for this session. |
| `env` | Child environment with tracker secrets already stripped. Pass this to your subprocess. |

### What each method must do

- **`start()`** — Launch the backend in `opts.workspacePath`, establish a thread/session,
  and return its id. Emit `session_started` on success or `startup_failed` then throw.
  *Lazy-id backends:* if your backend has no thread id until the first turn runs (e.g. a
  per-turn CLI that mints the id on first invocation), `start()` may just prepare and return
  a placeholder `{ threadId: "" }` — the runner does not consume the return value, it reads
  identity only from the `thread_id` you attach to updates. In that case, adopt the real id
  and emit `session_started` from the first `runTurn` once the backend reports it.
- **`runTurn(input, title)`** — Run exactly one turn to completion and resolve with the
  outcome. `input` is the full rendered prompt on the first turn and short continuation
  guidance on later turns (Symphony decides when to continue; you just run the turn you're
  given). Never resolve before the turn actually ends. Enforce a turn timeout and resolve
  `{status:"timeout"}` rather than hanging.
- **`stop()`** — Tear down the backend. Called once when the worker run ends (including when
  the orchestrator terminates a run via reconciliation or stall detection). Must be safe to
  call while a `runTurn` is in flight — settle that promise as `cancelled`/`failed`.

Continuation: the same session instance is reused across continuation turns within one
worker run; keep the thread alive between `runTurn` calls and only release it on `stop()`.

---

## 2. Emitting events (`AgentUpdate`)

`onUpdate` is how your backend feeds the orchestrator. Shape ([`AgentUpdate`](src/domain/types.ts)):

```ts
onUpdate({
  event: "agent_message",          // required
  timestamp: new Date().toISOString(),
  message: "…",                    // optional, shown in the activity log
  // usage / thread_id / turn_id as applicable
});
```

Events the orchestrator understands (emit the ones your backend can produce):

| Event | Effect |
|---|---|
| `session_started` | Marks the session live; carry `thread_id`. |
| `startup_failed` | Diagnostic on startup failure. |
| `turn_started` | Increments the turn counter; carry `turn_id`. |
| `turn_completed` / `turn_failed` / `turn_cancelled` | Activity log + status color. |
| `agent_message` | The model's text — `message` is shown in the log and as "last message". |
| `command` | A shell command the agent ran (`message`). |
| `file_change` | A file edit summary (`message`). |
| `reasoning` / `tool_call` | Optional extra activity. |
| `turn_input_required` / `turn_ended_with_error` / `unsupported_tool_call` | Surfaced as warnings/errors. |

Session id is derived by the orchestrator as `` `${thread_id}-${turn_id}` `` from the
`thread_id`/`turn_id` you attach to updates.

### Tokens

Report **absolute cumulative** token totals (the orchestrator de-dupes into deltas, so
resending the same totals is safe):

```ts
onUpdate({
  event: "notification", timestamp,
  usage: { input_tokens, output_tokens, total_tokens },
  absolute: true,
});
```

---

## 3. Files to change

| File | Change |
|---|---|
| `src/agent/<your-agent>.ts` | **New.** Your `AgentSession` implementation. |
| `src/agent/registry.ts` | Register the factory. |
| `src/config/config.ts` | *Optional* — add a typed config section if your agent needs settings. |
| `WORKFLOW.md` | Set `agent.kind: <your-agent>` (and any config section you added). |

### Register it

Either add it to the `FACTORIES` map in [`src/agent/registry.ts`](src/agent/registry.ts),
or call `registerAgentFactory` at startup:

```ts
import { registerAgentFactory } from "./agent/registry.ts";
import { MyAgentSession } from "./agent/myAgent.ts";

registerAgentFactory({
  kind: "my-agent",
  create: (opts) => new MyAgentSession(opts),
});
```

### Select it

```yaml
# WORKFLOW.md front matter
agent:
  kind: my-agent
```

The console's **⚙ Integrate** button lists every registered agent kind (the active one is
highlighted) and this checklist, so you can confirm your backend is wired in.

### Minimal skeleton

```ts
import type { AgentSession, AgentSessionIdentity, AgentSessionOptions, AgentTurnResult } from "./types.ts";

export class MyAgentSession implements AgentSession {
  private opts: AgentSessionOptions;
  private _threadId: string | null = null;
  constructor(opts: AgentSessionOptions) { this.opts = opts; }

  get threadId() { return this._threadId; }
  get pid() { return null; }

  async start(): Promise<AgentSessionIdentity> {
    // launch backend in this.opts.workspacePath, using this.opts.env
    this._threadId = "thread-123";
    this.emit("session_started");
    return { threadId: this._threadId };
  }

  async runTurn(input: string): Promise<AgentTurnResult> {
    this.emit("turn_started");
    // ... run one turn, streaming this.emit("agent_message", { message }) etc.
    this.emit("turn_completed");
    return { status: "completed" };
  }

  stop(): void { /* kill/close backend; idempotent */ }

  private emit(event: string, extra: Record<string, unknown> = {}) {
    this.opts.onUpdate({ event, timestamp: new Date().toISOString(), thread_id: this._threadId, ...extra });
  }
}
```

Use [`src/agent/appServerClient.ts`](src/agent/appServerClient.ts) (the Codex backend) as a
full reference: subprocess launch via `spawnShell`, JSON-RPC framing, timeouts, approval and
tool-call handling, token extraction.

---

## 4. Testing

Symphony's orchestrator test already exercises a backend end-to-end with a **fake agent** —
copy that pattern. See `makeFakeFactory` in
[`test/orchestrator.test.ts`](test/orchestrator.test.ts):

```ts
registerAgentFactory({
  kind: "my-agent",
  create: (opts) => ({
    get threadId() { return "t1"; },
    get pid() { return null; },
    async start() { opts.onUpdate({ event: "session_started", timestamp: new Date().toISOString() }); return { threadId: "t1" }; },
    async runTurn() {
      opts.onUpdate({ event: "turn_started", timestamp: new Date().toISOString() });
      // do work in opts.workspacePath, e.g. write SYMPHONY_RESULT.json
      return { status: "completed" };
    },
    stop() {},
  }),
});
```

Point `agent.kind` at your fake in the test workflow, start the orchestrator, and assert on
`orch.snapshot()` / `orch.issueDetail()`. Run:

```bash
node --test test/*.test.ts     # or: npm test
npx tsc --noEmit               # type-check
```

For a real backend, also do a live smoke test: point `WORKFLOW.md` at it, `node src/index.ts
--port 7878`, add an issue, and watch it run in the console (activity log included).

---

## 5. Integrating a tracker instead

Trackers follow the same shape. Implement [`TrackerAdapter`](src/tracker/types.ts) (required:
`fetchIssuesByStates`, `fetchIssuesByIds`, plus the agent-tool trio; optional: create/board
capabilities), then register it by `kind` in
[`src/tracker/registry.ts`](src/tracker/registry.ts) and set `tracker.kind` in `WORKFLOW.md`.

Key rules (see [`README.md`](README.md) → adapter profile, and SPEC §11):

- Normalize provider payloads into the `Issue` model; `id`/`identifier`/`title`/`state` are
  required non-empty strings, labels lowercased, `dispatchable` explicit.
- `fetchIssuesByStates([])` / `fetchIssuesByIds([])` return `[]` with **no** provider call.
- ID-refresh must **fail** on a malformed requested record; state-list may omit + log it.
- Optional `supportsCreate`/`createIssue` and `supportsBoard`/`listAllIssues`/`setIssueState`
  light up the console's **New issue** form, **Board**, and **Start/Hold/Reopen** actions
  automatically. Omit them and the UI hides those controls.
- Optional `supportsEdit`/`updateIssue`/`deleteIssue` light up the detail page's **Edit**
  and **Delete** actions (and `PATCH`/`DELETE /issues/<id>`). `updateIssue` is a patch —
  only the keys present are written — and covers title/description/priority/labels only:
  the identifier keys the record and its workspace, so a rename is a delete + create.
  The orchestrator refuses to delete an issue that is running or has a pending retry.
- Optional `setIssueDelivery` persists the delivery record for repository-backed projects
  (SPEC Appendix B): branch, commit, base, changed files, and whether the handoff needs a
  human. It is a **merge**, not a write — fields absent from the patch keep their stored
  value, which is how the orchestrator hands you git facts at completion and only
  `pushed_at` after a push. Absent fields are also your chance to fill in what only the
  tracker knows (the agent's summary and test report). Omit the method entirely and
  repository projects still work; they just carry no delivery record.

[`src/tracker/fileAdapter.ts`](src/tracker/fileAdapter.ts) is a complete, dependency-free
reference implementing all of the above.
