# Symphony

[![CI](https://github.com/Ayan-sh03/symphony/actions/workflows/ci.yml/badge.svg)](https://github.com/Ayan-sh03/symphony/actions/workflows/ci.yml)

Symphony turns issue trackers into queues for autonomous coding agents. It polls for
work, creates an isolated workspace for each issue, runs Codex or OpenCode, and reports
the result back to the tracker. A built-in web console shows issues and live agent
activity.

## Quick start

Requirements:

- Node.js 22.6 or newer (Node.js 24 recommended)
- An authenticated [Codex](https://github.com/openai/codex) or OpenCode CLI

```bash
npm install
node src/index.ts ./WORKFLOW.md --port 8420
```

Open <http://127.0.0.1:8420>. The included workflow uses the local file tracker, so
issues are stored in [`issues/`](issues) and no tracker credentials are needed. Create
an issue in the console, then select **Start** to send it to an agent.

To use another workflow or host several projects:

```bash
node src/index.ts path/to/WORKFLOW.md --port 8420
node src/index.ts --projects symphony.projects.json --port 8420
```

## Development

TypeScript runs directly in Node.js; there is no build step.

```bash
npm test
npm run typecheck
```

## Documentation

- [Operations guide](docs/operations.md) — console, issue lifecycle, retries, API,
  Docker, and security
- [Tracker guide](docs/trackers.md) — file and GitHub tracker setup and behavior
- [Architecture](docs/architecture.md) — system structure and execution flow
- [Integration guide](INTEGRATION.md) — add an agent backend or tracker adapter
- [Workflow examples](WORKFLOW.md) — local file tracker and Codex configuration
- [Service specification](SPEC.md) — complete configuration and behavioral contract

## Security

Symphony runs coding agents unattended and is intended for trusted environments. Keep
the console bound to loopback unless you provide your own access controls, and review
the [security guidance](docs/operations.md#security) before using it on sensitive code.
