/** Transactional completion (issue #32): real files, snapshots, and tracker records. */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { buildConfig } from "../src/config/config.ts";
import { parseWorkflow } from "../src/workflow/loader.ts";
import { Logger } from "../src/logger.ts";
import { registerAgentFactory } from "../src/agent/registry.ts";
import { runAgentAttempt, RESULT_FILE, type RunnerDeps } from "../src/agent/runner.ts";
import { WorkspaceManager } from "../src/workspace/manager.ts";
import { FileTrackerAdapter } from "../src/tracker/fileAdapter.ts";
import type { AgentSessionOptions } from "../src/agent/types.ts";
import { createExecutionSession, registerExecutionProviderFactory } from "../src/execution/registry.ts";
import type { ExecutionSession } from "../src/execution/types.ts";

const logger = new Logger([{ name: "null", write() {} }], "error");
const exec = promisify(execFile);
async function git(cwd: string, ...args: string[]) {
  return (await exec("git", ["-c", "core.autocrlf=false", "-C", cwd, ...args], { encoding: "utf8" })).stdout.trimEnd();
}
let sequence = 0;
async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cp-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const config = buildConfig(parseWorkflow("---\nagent:\n  max_turns: 1\n---\nWork"), path.join(root, "WORKFLOW.md"));
  const manager = new WorkspaceManager({ root: path.join(root, "workspaces"), hooks: config.hooks, logger });
  const adapter = new FileTrackerAdapter({ dir: path.join(root, "issues"), logger });
  const issue = await adapter.createIssue({ identifier: "T-32", title: "checkpoint work", state: "todo" });
  const kind = `checkpoint-agent-${sequence++}`;
  let turns = 0;
  const behavior = { async turn(opts: AgentSessionOptions) {
    await opts.execution.writeFile!("work.txt", "finished work\n");
    await opts.execution.writeFile!(RESULT_FILE, JSON.stringify({ state: "done", comment: "work complete" }));
  } };
  registerAgentFactory({ kind, create(opts) { return {
    threadId: "test", pid: null,
    async start() { return { threadId: "test" }; },
    async runTurn() { turns++; await behavior.turn(opts); return { status: "completed" as const }; },
    async stop() {},
  }; } });
  const deps: RunnerDeps = {
    config, agentKind: kind, stream: issue.identifier, isFollowUp: false,
    promptTemplate: "Work on {{ issue.identifier }}", adapter, workspaceManager: manager,
    logger, childEnv: process.env, isActiveState: (s) => s === "todo",
    isTerminalState: (s) => s === "done", isRoutable: () => true,
    onUpdate() {}, onSessionReady() {},
  };
  return { root, issue, deps, adapter, manager, behavior, get turns() { return turns; },
    workspace: manager.workspacePathFor(issue.identifier),
    run: () => runAgentAttempt(issue, null, deps),
    state: async () => (await adapter.fetchIssuesByIds([issue.id]))[0]!.state,
  };
}

test("a rejected tracker result fails the attempt and preserves the result and work", async (t) => {
  const f = await fixture(t);
  f.adapter.executeAgentTool = async () => ({ success: false, output: "tracker unavailable" });
  const outcome = await f.run();
  assert.equal(outcome.kind, "abnormal");
  assert.match(outcome.reason!, /tracker unavailable/);
  assert.equal(await f.state(), "todo");
  assert.equal(await fs.readFile(path.join(f.workspace, "work.txt"), "utf8"), "finished work\n");
  assert.equal(JSON.parse(await fs.readFile(path.join(f.workspace, RESULT_FILE), "utf8")).state, "done");
});

async function remote(f: Awaited<ReturnType<typeof fixture>>) {
  const kind = `checkpoint-runtime-${sequence++}`;
  const runtimes: string[] = [];
  const behavior = { configure(_session: ExecutionSession) {} };
  registerExecutionProviderFactory({ kind, capabilities: ["process", "filesystem", "workspace-snapshot"], async create(opts) {
    const directory = path.join(f.root, `remote-${runtimes.length}`);
    await fs.mkdir(directory);
    runtimes.push(directory);
    const session = await createExecutionSession("local", {}, { ...opts, workspacePath: directory });
    const close = session.close.bind(session);
    Object.defineProperty(session, "runtimeId", { value: directory });
    session.close = async () => { await close(); await fs.rm(directory, { recursive: true, force: true }); };
    behavior.configure(session);
    return session;
  } });
  f.deps.config.execution = { kind, provider: {} };
  return { runtimes, behavior };
}

test("remote work is verified on the host before the tracker can complete an issue", async (t) => {
  const f = await fixture(t);
  const r = await remote(f);
  await f.manager.createForIssue(f.issue.identifier);
  await fs.writeFile(path.join(f.workspace, "input.txt"), "starting work\n");
  f.behavior.turn = async (opts) => {
    assert.equal(Buffer.from(await opts.execution.readFile!("input.txt")).toString(), "starting work\n");
    await opts.execution.writeFile!("work.txt", "remote work\n");
    await opts.execution.writeFile!(RESULT_FILE, '{"state":"done"}');
  };
  const apply = f.adapter.executeAgentTool.bind(f.adapter);
  f.adapter.executeAgentTool = async (...args) => {
    assert.equal(await fs.readFile(path.join(f.workspace, "work.txt"), "utf8"), "remote work\n");
    return apply(...args);
  };
  assert.deepEqual(await f.run(), { kind: "normal" });
  assert.equal(await f.state(), "done");
  assert.equal(await fs.readFile(path.join(f.workspace, "work.txt"), "utf8"), "remote work\n");
  await assert.rejects(fs.stat(r.runtimes[0]!), { code: "ENOENT" });
});

async function repository(f: Awaited<ReturnType<typeof fixture>>) {
  const repo = path.join(f.root, "repo");
  await fs.mkdir(repo);
  await git(repo, "init", "-q", "-b", "main");
  await git(repo, "config", "user.name", "test");
  await git(repo, "config", "user.email", "test@example.com");
  await git(repo, "config", "core.autocrlf", "false");
  await fs.writeFile(path.join(repo, "tracked.txt"), "base\n");
  await fs.writeFile(path.join(repo, "deleted.txt"), "remove me\n");
  await fs.writeFile(path.join(repo, ".gitignore"), ".env\nignored/\n");
  await git(repo, "add", ".");
  await git(repo, "commit", "-qm", "base");
  f.manager.update(path.dirname(f.workspace), f.deps.config.hooks, {
    repository: repo, base_branch: "main", branch_template: "issue/{identifier}",
  });
  await f.manager.createForIssue(f.issue.identifier);
  return repo;
}

test("Git checkpoint retains the delivery worktree, commits, index, dirty bytes, deletions, and ignored host files", async (t) => {
  const f = await fixture(t);
  const repo = await repository(f);
  await remote(f);
  const gitPointer = await fs.readFile(path.join(f.workspace, ".git"), "utf8");
  await fs.writeFile(path.join(f.workspace, ".env"), "host secret");
  let head = "";
  f.behavior.turn = async (opts) => {
    const dir = opts.workspacePath;
    await git(dir, "config", "user.name", "test");
    await git(dir, "config", "user.email", "test@example.com");
    await fs.writeFile(path.join(dir, "committed.txt"), "remote commit\n");
    await git(dir, "add", "committed.txt");
    await git(dir, "commit", "-qm", "remote change");
    head = await git(dir, "rev-parse", "HEAD");
    await fs.writeFile(path.join(dir, "tracked.txt"), "staged\n");
    await git(dir, "add", "tracked.txt");
    await fs.writeFile(path.join(dir, "tracked.txt"), "unstaged\n");
    await fs.rm(path.join(dir, "deleted.txt"));
    await fs.writeFile(path.join(dir, "binary.bin"), Buffer.from([0, 255, 17]));
    await opts.execution.writeFile!(RESULT_FILE, '{"state":"done"}');
  };
  const outcome = await f.run();
  assert.deepEqual(outcome, { kind: "normal" });
  assert.equal(await f.state(), "done");
  assert.equal(await fs.readFile(path.join(f.workspace, ".git"), "utf8"), gitPointer);
  assert.equal(await git(repo, "rev-parse", "issue/T-32"), head);
  assert.equal(await git(f.workspace, "show", ":tracked.txt"), "staged");
  assert.equal(await fs.readFile(path.join(f.workspace, "tracked.txt"), "utf8"), "unstaged\n");
  await assert.rejects(fs.stat(path.join(f.workspace, "deleted.txt")), { code: "ENOENT" });
  assert.deepEqual(await fs.readFile(path.join(f.workspace, "binary.bin")), Buffer.from([0, 255, 17]));
  assert.equal(await fs.readFile(path.join(f.workspace, ".env"), "utf8"), "host secret");
  assert.match(await git(repo, "worktree", "list", "--porcelain"), /branch refs\/heads\/issue\/T-32/);
  assert.equal(await git(repo, "show", "main:tracked.txt"), "base");
});

for (const execution of ["local", "remote"]) {
  test(`${execution} tracker retry uses the saved result without rerunning the agent`, async (t) => {
    const f = await fixture(t);
    if (execution === "remote") await remote(f);
    const apply = f.adapter.executeAgentTool.bind(f.adapter);
    f.adapter.executeAgentTool = async () => { throw new Error("tracker disconnected"); };
    assert.equal((await f.run()).kind, "abnormal");
    assert.equal(await f.state(), "todo");
    // An agent rerun would destroy the checkpoint; recovery must finish its handoff first.
    f.behavior.turn = async () => { throw new Error("must not rerun completed work"); };
    f.adapter.executeAgentTool = apply;
    assert.deepEqual(await f.run(), { kind: "normal" });
    assert.equal(await f.state(), "done");
    assert.equal(f.turns, 1);
    assert.equal(await fs.readFile(path.join(f.workspace, "work.txt"), "utf8"), "finished work\n");
  });
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

test("Stop during checkpoint export preserves work without applying its completion, including on retry", async (t) => {
  const f = await fixture(t);
  const r = await remote(f);
  const exporting = deferred();
  const release = deferred();
  let stop!: () => Promise<void>;
  f.deps.onSessionReady = (s) => { stop = s; };
  r.behavior.configure = (session) => {
    const exportSnapshot = session.exportSnapshot!.bind(session);
    session.exportSnapshot = async (options) => {
      exporting.resolve(); await release.promise;
      return exportSnapshot(options);
    };
  };
  const run = f.run();
  await exporting.promise;
  await stop(); release.resolve();
  assert.equal((await run).kind, "abnormal");
  assert.equal(await f.state(), "todo");
  f.behavior.turn = async () => { throw new Error("retry deliberately interrupted"); };
  await f.run();
  assert.equal(await f.state(), "todo", "cancelled completion must not be replayed");
});

test("remote tracker tools cannot complete an issue ahead of a verified checkpoint", async (t) => {
  const f = await fixture(t);
  const r = await remote(f);
  r.behavior.configure = (session) => { session.exportSnapshot = async () => { throw new Error("export disconnected"); }; };
  f.behavior.turn = async (opts) => {
    await opts.execution.writeFile!("work.txt", "only remote copy");
    const write = await opts.adapter.executeAgentTool("update_issue_state", { state: "done" }, { issue: f.issue });
    assert.equal(write.success, false, "direct mutations must be refused while work is remote");
    const queued = await opts.adapter.executeAgentTool("set_issue_result", { state: "done", comment: "complete" }, { issue: f.issue });
    assert.equal(queued.success, true);
    assert.equal(await f.state(), "todo");
  };
  assert.equal((await f.run()).kind, "abnormal");
  assert.equal(await f.state(), "todo");
  assert.equal(await fs.readFile(path.join(r.runtimes[0]!, "work.txt"), "utf8"), "only remote copy");
});

test("failed export retains the runtime, blocks replacement attempts, and prevents workspace cleanup", async (t) => {
  const f = await fixture(t);
  const r = await remote(f);
  r.behavior.configure = (session) => { session.exportSnapshot = async () => { throw new Error("export disconnected"); }; };
  const outcome = await f.run();
  assert.equal(outcome.kind, "abnormal");
  assert.equal(await f.state(), "todo");
  assert.equal(await fs.readFile(path.join(r.runtimes[0]!, "work.txt"), "utf8"), "finished work\n");
  await f.manager.cleanupForIssue(f.issue.identifier);
  assert.ok((await fs.stat(f.workspace)).isDirectory());
  const retry = await f.run();
  assert.equal(retry.kind, "abnormal");
  assert.match(retry.reason!, /recover runtime/);
  assert.equal(r.runtimes.length, 1, "do not create abandoned runtimes on automatic or manual retries");
});
