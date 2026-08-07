# Operations guide

This guide covers running Symphony and operating its console. For every configuration
field and its exact semantics, see [`SPEC.md`](../SPEC.md).

## Running Symphony

Run one workflow:

```bash
node src/index.ts ./WORKFLOW.md --port 8420
```

Run several projects from a manifest:

```bash
node src/index.ts --projects symphony.projects.json --port 8420
```

The server binds to loopback by default. Use `--host <address>` or `SYMPHONY_HOST` to
change the bind address. `WORKFLOW.md` is watched for changes; an invalid reload is
reported and the last valid configuration remains active.

## Console and issue lifecycle

The console groups issues by state and streams agent messages, commands, file changes,
token usage, and run status. New issues created by the built-in file tracker begin in
`backlog`. Select **Start** to move one to `todo`, the default active state.

A failed run retries with exponential backoff. `agent.max_retry_attempts` controls the
limit (`3` by default and `0` for unlimited retries). **Stop** ends a running attempt or
cancels a pending retry. **Hold** stops the attempt and returns the issue to the backlog.

For repository-backed workspaces, a follow-up issue can reuse the original issue's
branch and workspace. Follow-ups in the same work stream run sequentially; unrelated
issues may continue in parallel.

## HTTP API

All project operations are scoped under `/api/v1/projects/<project-id>`.

| Method | Endpoint | Purpose |
|---|---|---|
| `GET`, `POST` | `/api/v1/projects` | List or add projects |
| `GET` | `/api/v1/projects/<pid>/state` | Read the complete project state |
| `GET`, `POST` | `/api/v1/projects/<pid>/issues` | List or create issues |
| `GET` | `/api/v1/projects/<pid>/<identifier>` | Read issue details and recent events |
| `PATCH`, `DELETE` | `/api/v1/projects/<pid>/issues/<id>` | Edit or delete an issue |
| `POST` | `/api/v1/projects/<pid>/issues/<id>/state` | Change state, for example `{"state":"todo"}` |
| `POST` | `/api/v1/projects/<pid>/issues/<id>/stop` | Stop a run or pending retry |
| `POST` | `/api/v1/projects/<pid>/issues/<id>/follow-up` | Continue work on the same branch |
| `POST` | `/api/v1/projects/<pid>/issues/<id>/push-branch` | Push a delivered repository branch |
| `POST` | `/api/v1/projects/<pid>/refresh` | Poll the tracker immediately |

Some routes depend on tracker or workspace capabilities and return `501` when the
configured backend does not support them.

## Docker

The included Compose setup exposes the console at <http://localhost:8420>, mounts
`WORKFLOW.md` and `issues/`, and stores workspaces in a named volume.

```bash
docker compose up
docker compose restart
```

Agent CLIs and their credentials are intentionally not included in the image. Mount the
CLI binary and its configuration into the container, or extend the image with a stage
that installs the required agent. Without an agent CLI, the console and file tracker
still run, but active issues fail the agent preflight check.

## Security

The default workflow is designed for unattended execution in a trusted environment. In
particular, it disables approval round trips and may grant the agent broad filesystem
and command access inside its workspace.

Recommended safeguards:

- Keep the HTTP server on loopback or place it behind authentication. The API itself is
  unauthenticated, and repository actions can use the host's ambient Git credentials.
- Run Symphony as a dedicated OS user on a dedicated volume.
- Restrict eligible issues through states, labels, and the `dispatchable` flag.
- Tighten the agent approval and sandbox settings in `WORKFLOW.md` where possible.

Symphony always sanitizes workspace names, validates that paths stay beneath the
configured workspace root, and runs each agent from its issue workspace.

## Testing

```bash
npm test
npm run typecheck
```

The suite covers workflow parsing, prompt rendering, workspace containment, trackers,
agent sessions, dispatch, continuation, backoff, and retry behavior.
