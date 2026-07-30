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
  Kinds: `file` (`fileAdapter.ts`), `github` (`githubAdapter.ts`, REST over stdlib
  `fetch`; Symphony state is a `sym:<state>` label, PAT read from `provider.token_env`).

**Projects (multi-project host layer, `src/project/`).** A project is one
`WORKFLOW.md` anchored at a cwd (its issues + workspace resolve relative to that
dir, so distinct dirs are isolated). `ProjectManager` (`manager.ts`) owns one
independent, SPEC-conformant `Orchestrator` + `WorkflowWatcher` per project and
runs them all concurrently. Projects come from a persistent manifest
(`manifest.ts`, `symphony.projects.json` = `{id,name,workflow}[]`); the console can
append one at runtime. With no `--projects` flag / manifest, the host runs a single
`default` project (back-compat). This is a host extension above the single-workflow
SPEC — the orchestrator itself is unchanged and unaware of projects.

**Repository delivery (extension, SPEC Appendix B).** Set `workspace.repository` and a
project's workspaces become **git worktrees** of that repo on `issue/<identifier>`
(`workspace.branch_template`), cut from `workspace.base_branch` — the base is recorded
in the repo's local config at creation, since HEAD moves. On completion the orchestrator
records an `IssueDelivery` (branch, SHA, base, files, tests, summary) via the optional
`TrackerAdapter.setIssueDelivery` and parks the issue in `tracker.review_state`; an
operator marks it done. Cleanup removes the worktree, **never** the branch, and preserves
it whenever the work isn't safely captured (dirty, missing branch, unknown status).
Pushing (`workspace.delivery_mode: push|pr`) is a manual console action only. `WORKFLOW.dev.md`
is the self-dev instance of this. **All git in `workspace/manager.ts` is async on purpose** —
every project, agent and the console share one event loop.

**Follow-ups / work streams (extension, SPEC Appendix B.5).** An issue may carry
`follow_up_for` (lineage) and `stream_identifier` (the identifier whose branch and
workspace it shares), both set at creation and immutable. The workspace manager is keyed
by *stream*, not issue id — `Orchestrator.streamOf()` resolves it, and everything that
touches a workspace passes the result. So a review follow-up lands on the branch it is
answering instead of forking a second one from base. The invariant that falls out: one
workspace per stream means **one member of a stream in flight at a time**, enforced in
`shouldDispatch` and again in `onRetryTimer` (which bypasses it). `busyStreams()` is the
whole rule and deliberately outlives `running` — it also covers finalizing, retrying and
halted members, because each still owns the workspace; releasing at worker exit lets a
sibling into a worktree that is about to be cleaned for someone else. Cleanup likewise
refuses any stream that still has a member. Ordinary issues are their own stream and
behave exactly as before.

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
`issues`, `refresh`, `<identifier>`, `issues/<id>/push-branch`, …).
`/api/v1/projects` lists/creates projects. The API is unauthenticated and
`push-branch` reaches a remote with ambient git credentials — bind it to loopback.

## Conventions

- **Commits:** atomic, lowercase, one-line messages. **Do not** add a
  `Co-Authored-By` / "Generated with" trailer.
- Match the surrounding code's style. Files carry a header comment citing the
  relevant `SPEC.md` section — keep that pattern.
- Every change should keep `npm test` and `npm run typecheck` green.

## Windows notes (this is a Windows dev box)

- Primary shell is PowerShell; a Bash tool is also available.
- `agent-browser` must be driven via PowerShell here (the bash node shim is broken).
