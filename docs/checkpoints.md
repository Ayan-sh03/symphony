# Checkpoints and completion

Remote work reaches the host before Symphony applies an agent's result to the
tracker. This is Phase 4 ([#32](https://github.com/Ayan-sh03/symphony/issues/32)).
The implementation is in `src/workspace/checkpoint.ts` and `src/agent/runner.ts`.

## Execution contract

Providers that operate directly on the host workspace advertise `host-workspace`.
The built-in local provider does this and retains its existing multi-turn sessions.
Other providers must advertise `workspace-snapshot` and implement both snapshot
methods. Their new runtime workspace must be empty so the runner can import the
host's starting snapshot before running hooks or starting an agent.

A remote attempt runs one agent turn. After a successful turn, the runner stops
the agent, runs `after_run`, exports the workspace, and validates it in host staging.
Stopping between attempts gives the provider a quiescent workspace to export without
requiring a new pause/resume protocol from every agent backend. An active issue
continues in a fresh runtime from the last imported checkpoint; `max_turns` remains
an upper bound. Hooks run once per attempt.

The runner writes the verified snapshot and pending result to a host journal before
changing the delivery workspace. Publication checks that the host still matches
the starting snapshot, then verifies the imported files and Git state. Only then
does it apply the result to the tracker. `SYMPHONY_ISSUE.json` and
`SYMPHONY_RESULT.json` are excluded from transferred checkpoint files; the result
is stored separately in the journal.

For Git worktrees, publication keeps the registered worktree and its administrative
metadata, transfers commits and staged blobs, preserves dirty and untracked files,
and advances the existing delivery branch with a compare-and-swap. Host-only
ignored files stay on the host. A collision with incoming files fails the import.
Symphony expects exclusive workspace ownership during publication; arbitrary
external filesystem writes cannot participate in this transaction.

Remote agents can use `set_issue_result` or write `SYMPHONY_RESULT.json` to queue
a handoff. Other mutating tracker tools are unavailable to remote sessions; read
tools remain host-side. This prevents direct tracker writes from bypassing the
checkpoint. Providers and agent plugins remain trusted code.

## Failure behavior

| Failure | Behavior |
|---|---|
| Tracker rejects or throws | Keep the result pending. Retry the handoff before starting another agent. |
| Host files changed | Keep both the host work and verified checkpoint. Refuse to overwrite the host. |
| Import fails | Keep the verified snapshot and result. Retry import before tracker write-back. |
| Tracker fails after import | Keep the imported work. Recheck it before retrying the tracker. |
| Agent turn fails | Archive its work separately; the next attempt starts from the last successful checkpoint. |
| Export or snapshot validation fails | Retain the runtime and halt the issue so its only work copy is not destroyed. |
| Git rollback fails | Retain staging and the previous workspace, record their paths, and halt the issue. |
| Stop during checkpointing | Preserve work, but discard the cancelled completion before a later retry can replay it. |

Local result write-back also uses the journal. A failed tracker request no longer
deletes its result or reruns completed work. Scratch result files from failed turns
are cleared before starting a fresh attempt.

Tracker delivery is at least once. A provider can apply a request and lose its
response; replay may repeat comments unless that tracker implements deduplication.
The host import does not repeat once it has been verified and recorded.

## Recovery files

Records live below
`<workspace.root>/.symphony-checkpoints/<sha256-of-stream>/`, outside the disposable
issue workspace. Cleanup preserves workspaces with pending results or retained
runtimes. Follow-ups use the same stream journal and cannot consume another issue's
pending handoff.

- `pending.json`: the expected host state, verified snapshot, import status, and
  result awaiting acknowledgment. Local handoffs have no snapshot payload.
- `last.json`: the most recently acknowledged record.
- `recovery-*.json`: snapshots from unsuccessful attempts. These are not automatically
  promoted to the retry baseline.
- `runtime.json`: provider and runtime ID when work could not be saved on the host.
- `recovery-required.txt`: paths and errors when publication could not roll back.
- `previous`, `index.previous`, and retained staging directories: recovery material
  from an interrupted publication.

After a tracker outage, use Retry; Symphony replays the pending handoff. For a host
conflict, first preserve the operator's edits separately and resolve the conflict
before retrying. Recovery snapshots can be inspected using `stageWorkspaceSnapshot`
or imported into an empty directory using `importWorkspaceSnapshot`; supply the
trusted base from the originating host checkpoint, not from untrusted input.

For a retained runtime, recover its work with the provider's tools before destroying
it or removing `runtime.json`. For an interrupted Git publication, preserve all
listed directories and restore the workspace, branch, and index consistently before
removing the recovery marker and retrying. Automatic runtime reconnection and
crash reconciliation remain Phase 6 (#31). Checkpoint archives are intentionally
retained; prune them only after confirming their work has been delivered or saved
elsewhere.

## Tests

`test/checkpoints.test.ts` exercises real host files, temporary Git worktrees,
destructible fake runtimes, tracker failures, cancellation, corruption, and filesystem
faults. It also checks that the orchestrator halts a runtime whose work cannot be
exported. Existing local execution tests cover both built-in agent protocols.

```sh
node --test test/checkpoints.test.ts test/executionSessions.test.ts
npm test -- --experimental-test-coverage
npm run typecheck
```
