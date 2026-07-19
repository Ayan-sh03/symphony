# CLAUDE.md

Guidance for working in this repo. Read this before making changes.

## What Symphony is

A long-running service that polls an issue tracker, creates a per-issue git-free
workspace, and runs a coding-agent session (Codex or opencode) to work each issue.
It ships with an operational web console. The full contract lives in `SPEC.md`;
`WORKFLOW.md` is the runtime config, `INTEGRATION.md` covers adding backends.

## Running & testing

```bash
npm start                    # runs ./WORKFLOW.md; add --port N for the console
node src/index.ts <workflow> --port 8420
node src/index.ts --projects symphony.projects.json --port 8420   # multi-project
npm test                     # node --test (the whole suite)
npm run typecheck            # tsc --noEmit
```

- **No build step.** TypeScript is executed directly by Node (>=22.6; dev runs on
  24) in type-stripping mode. `tsc` is used only for `--noEmit` type-checking.
- Because there's no emit, **all relative imports use the `.ts` extension**
  (`allowImportingTsExtensions`). Keep that.
- Type-stripping means **no runtime-typed syntax**: no `enum`, no TS parameter
  properties (`constructor(private x)`), no namespaces. Declare fields explicitly.
- ESM only (`"type":"module"`). Import Node builtins as `node:*`.
- Runtime deps are intentionally minimal: `liquidjs` (prompt rendering,
  `src/prompt/render.ts`), `yaml` (workflow parsing, `src/workflow/loader.ts`), and
  `lit-html` (console rendering, served to the browser as-is — never imported
  server-side). Everything else is Node stdlib — prefer stdlib over adding a
  dependency. Reading agent transcripts uses stdlib `node:sqlite` (`DatabaseSync`).

## Architecture

Entry: `src/index.ts` → `Orchestrator` (`src/orchestrator/orchestrator.ts`) is the
core loop; optional `SymphonyHttpServer` serves the console + JSON API; a
`WorkflowWatcher` hot-reloads `WORKFLOW.md`.

Two pluggable registries keep the system agent- and tracker-agnostic — **add a
backend by implementing the interface and registering it; no other layer changes:**

- **Agents** — `src/agent/registry.ts`. Implement `AgentSession` + `AgentFactory`
  (`src/agent/types.ts`), register in `FACTORIES`. Kinds: `codex`
  (`appServerClient.ts`, JSON-RPC over stdio), `opencode` (`opencodeSession.ts`).
  Optional `AgentFactory.readTranscript(query)` reads a finished run's log back
  from the backend's own on-disk store so logs survive restarts (our in-memory
  history is capped). Codex: `~/.codex/sessions/**/rollout-*.jsonl`. opencode:
  the migrated SQLite db at `<dataDir>/opencode.db` (read-only) — the old
  `storage/*.json` tree is abandoned. Both keyed by the run's workspace path.
- **Trackers** — `src/tracker/registry.ts`. Implement the adapter, add its kind.
  Currently `file` (`fileAdapter.ts`).

**Projects (multi-project host layer, `src/project/`).** A project is one
`WORKFLOW.md` anchored at a cwd (its issues + workspace resolve relative to that
dir, so distinct dirs are isolated). `ProjectManager` (`manager.ts`) owns one
independent, SPEC-conformant `Orchestrator` + `WorkflowWatcher` per project and
runs them all concurrently. Projects come from a persistent manifest
(`manifest.ts`, `symphony.projects.json` = `{id,name,workflow}[]`); the console can
append one at runtime. With no `--projects` flag / manifest, the host runs a single
`default` project (back-compat). This is a host extension above the single-workflow
SPEC — the orchestrator itself is unchanged and unaware of projects.

The console is a small client-side app in `src/server/ui/` — plain browser ES
modules rendered with **lit-html** (no bundler, no build step): the server serves
the files from disk at `/ui/*` (`httpServer.ts`, which also maps
`/ui/vendor/lit-html/*` onto `node_modules/lit-html`), and
`src/server/dashboard.ts` is just the HTML shell with the first snapshot inlined.
All painting goes through one unconditional lit render (`ui/app.js`); lit diffs the
DOM in place, so background polls never wipe focus, open menus, or form input —
**don't add render guards or manual DOM patching**, just update `ui/store.js` state
and call `rerender()`. It is project-scoped: routes are hash-routed under a project
id (`#/<pid>`, `#/<pid>/issue/<id>`, `#/<pid>/new`, `#/<pid>/integrate`,
`#/<pid>/add-project`), a header dropdown switches projects (persisted in
`localStorage`), and every fetch hits `/api/v1/projects/<pid>/…` (`state`,
`issues`, `refresh`, `<identifier>`, …). `/api/v1/projects` lists/creates projects.

## Conventions

- **Commits:** atomic, lowercase, one-line messages. **Do not** add a
  `Co-Authored-By` / "Generated with" trailer.
- Match the surrounding code's style. Files carry a header comment citing the
  relevant `SPEC.md` section — keep that pattern.
- Every change should keep `npm test` and `npm run typecheck` green.

## Windows notes (this is a Windows dev box)

- Primary shell is PowerShell; a Bash tool is also available.
- `agent-browser` must be driven via PowerShell here (the bash node shim is broken).
