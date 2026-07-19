---
# Symphony's own workflow — Symphony tracks itself with the built-in file tracker
# and executes work with the Codex coding agent. No external credentials required.
tracker:
  kind: file
  provider:
    dir: ./issues
  required_labels: []
  # `backlog` is a parking state: issues here are NOT dispatched. Move an issue to
  # `todo` (an active state) — via the console Start button or the API — to run it.
  backlog_states: ["backlog"]
  active_states: ["todo", "in progress"]
  terminal_states: ["done", "canceled"]

polling:
  interval_ms: 5000

workspace:
  root: ./.symphony/workspaces

agent:
  kind: codex
  max_concurrent_agents: 2
  max_turns: 6
  max_retry_backoff_ms: 120000
  # Give up after this many failed attempts (0 = retry forever). A halted issue
  # stays on the board with Stop/Hold/Retry controls until you change its state.
  max_retry_attempts: 3

codex:
  command: codex app-server
  approval_policy: never
  thread_sandbox: danger-full-access
  turn_sandbox_policy:
    type: dangerFullAccess
  turn_timeout_ms: 900000
  stall_timeout_ms: 300000
  # codex app-server boots MCP servers on thread/start; give the startup
  # handshake a generous budget (the spec default of 5000ms is too tight).
  read_timeout_ms: 60000
---
You are Symphony's autonomous coding agent working a single tracked issue.

## Issue

- Key: {{ issue.identifier }}
- Title: {{ issue.title }}
- State: {{ issue.state }}
{% if issue.priority %}- Priority: {{ issue.priority }}{% endif %}
{% if attempt %}- Attempt: {{ attempt }}{% endif %}

### Description

{{ issue.description }}

## Your job

1. Complete the work described above **inside this workspace directory only**. A copy
   of the full issue is available in `SYMPHONY_ISSUE.json`.
2. Do real, verifiable work: create or edit files here as needed to satisfy the issue.
3. When the work reaches its handoff point, record the outcome so Symphony can update
   the tracker. Write a file named `SYMPHONY_RESULT.json` in this directory with:

   ```json
   {
     "state": "done",
     "comment": "One or two sentences describing what you accomplished.",
     "pr_url": null
   }
   ```

   - Use `"state": "done"` when the issue is fully complete.
   - Use another active state name (for example `"in progress"`) if you made progress
     but the issue is not finished; Symphony will schedule another turn.
   - The `comment` is required; `pr_url` is optional.

4. Do not ask for confirmation — you are running unattended. Do not modify anything
   outside this workspace directory.
