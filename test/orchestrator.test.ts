import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { Orchestrator } from "../src/orchestrator/orchestrator.ts";
import { registerAgentFactory } from "../src/agent/registry.ts";
import type { AgentFactory, AgentSession, AgentSessionOptions } from "../src/agent/types.ts";
import { buildConfig } from "../src/config/config.ts";
import { parseWorkflow } from "../src/workflow/loader.ts";
import { Logger } from "../src/logger.ts";

const silent = new Logger([{ name: "null", write() {} }], "error");

/** Fake agent backend: on its first turn writes a "done" result file, then completes. */
function makeFakeFactory(behavior: "done" | "fail"): AgentFactory {
  return {
    kind: `fake-${behavior}`,
    create(opts: AgentSessionOptions): AgentSession {
      const thread = "t1";
      return {
        get threadId() { return thread; },
        get pid() { return "0"; },
        async start() {
          opts.onUpdate({ event: "session_started", timestamp: new Date().toISOString(), thread_id: thread, turn_id: null });
          return { threadId: thread };
        },
        async runTurn() {
          opts.onUpdate({ event: "turn_started", timestamp: new Date().toISOString(), thread_id: thread, turn_id: "turn1" });
          if (behavior === "fail") return { status: "failed", error: "boom" } as const;
          fs.writeFileSync(
            path.join(opts.workspacePath, "SYMPHONY_RESULT.json"),
            JSON.stringify({ state: "done", comment: "fake did the work" }),
          );
          return { status: "completed" } as const;
        },
        stop() { /* no-op */ },
      };
    },
  };
}

/** Fake backend that records which issue it ran for, then completes with a done result. */
function makeRecordingFactory(kind: string, ran: Record<string, string>): AgentFactory {
  return {
    kind,
    create(opts: AgentSessionOptions): AgentSession {
      ran[opts.issue.id] = kind;
      return {
        get threadId() { return "t1"; },
        get pid() { return "0"; },
        async start() { return { threadId: "t1" }; },
        async runTurn() {
          fs.writeFileSync(
            path.join(opts.workspacePath, "SYMPHONY_RESULT.json"),
            JSON.stringify({ state: "done", comment: `ran ${kind}` }),
          );
          return { status: "completed" } as const;
        },
        stop() { /* no-op */ },
      };
    },
  };
}

function setup(behavior: "done" | "fail") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sym-orch-"));
  const issuesDir = path.join(dir, "issues");
  fs.mkdirSync(issuesDir);
  fs.writeFileSync(
    path.join(issuesDir, "T-1.json"),
    JSON.stringify({ id: "T-1", identifier: "T-1", title: "task", description: "do it", state: "todo", dispatchable: true }),
  );
  const wfPath = path.join(dir, "WORKFLOW.md");
  const src = `---
tracker:
  kind: file
  provider:
    dir: ./issues
  active_states: ["todo", "in progress"]
  terminal_states: ["done"]
polling:
  interval_ms: 200
workspace:
  root: ./ws
agent:
  kind: fake-${behavior}
  max_turns: 2
  max_retry_backoff_ms: 2000
---
Work on {{ issue.identifier }}: {{ issue.title }}{% if attempt %} (attempt {{ attempt }}){% endif %}`;
  fs.writeFileSync(wfPath, src);
  const workflow = parseWorkflow(src);
  const config = buildConfig(workflow, wfPath);
  return { dir, issuesDir, wfPath, workflow, config };
}

function readState(issuesDir: string): string {
  return JSON.parse(fs.readFileSync(path.join(issuesDir, "T-1.json"), "utf8")).state;
}

async function waitFor(fn: () => boolean, timeoutMs = 8000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

test("dispatches todo issue, applies self-tracking result, transitions to done", async () => {
  registerAgentFactory(makeFakeFactory("done"));
  const { issuesDir, wfPath, workflow, config } = setup("done");
  const orch = new Orchestrator({ config, workflow, workflowPath: wfPath, logger: silent });
  await orch.start();
  try {
    const ok = await waitFor(() => readState(issuesDir) === "done");
    assert.ok(ok, "issue should transition to done via the agent result write-back");
    // After terminal transition, snapshot should eventually show no running sessions.
    const drained = await waitFor(() => orch.snapshot().counts.running === 0);
    assert.ok(drained, "running set should drain after terminal transition");

    // The activity log is retained after the run finishes (SPEC §13.7.2 recent_events).
    // The short continuation retry may briefly report "retrying" first; wait it out.
    const settled = await waitFor(() => orch.issueDetail("T-1")?.status === "completed");
    assert.ok(settled, "finished issue detail should settle to completed from history");
    const detail = orch.issueDetail("T-1")!;
    assert.ok(detail.recent_events.some((e) => e.event === "turn_started"), "log should include turn_started");
    // Finished views carry no tracker state of their own; issueDetailFor enriches it.
    assert.equal(detail.state, undefined, "sync history detail has no state field");
    assert.equal((await orch.issueDetailFor("T-1"))?.state, "done");
  } finally {
    orch.stop();
  }
});

test("invalid workflow reload does not crash and keeps operating (SPEC 6.2)", async () => {
  registerAgentFactory(makeFakeFactory("done"));
  const { wfPath, workflow, config } = setup("done");
  const orch = new Orchestrator({ config, workflow, workflowPath: wfPath, logger: silent });
  await orch.start();
  try {
    // Reload with an unsupported agent.kind — must be rejected, not thrown, last-good kept.
    orch.reload(parseWorkflow(`---
tracker:
  kind: file
  provider:
    dir: ./issues
  active_states: ["todo"]
  terminal_states: ["done"]
agent:
  kind: totally-unknown-agent
---
body`));
    // Service still responds to snapshot and keeps processing under the good config.
    assert.ok(orch.snapshot().generated_at);
    const ok = await waitFor(() => orch.snapshot().counts.running >= 0);
    assert.ok(ok);
  } finally {
    orch.stop();
  }
});

test("per-issue agent override wins; others use the default agent", async () => {
  const ran: Record<string, string> = {};
  registerAgentFactory(makeRecordingFactory("rec-a", ran));
  registerAgentFactory(makeRecordingFactory("rec-b", ran));

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sym-multi-"));
  const issuesDir = path.join(dir, "issues");
  fs.mkdirSync(issuesDir);
  // A-1 has no override → default (rec-a). A-2 pins rec-b.
  fs.writeFileSync(path.join(issuesDir, "A-1.json"),
    JSON.stringify({ id: "A-1", identifier: "A-1", title: "one", description: "x", state: "todo", dispatchable: true }));
  fs.writeFileSync(path.join(issuesDir, "A-2.json"),
    JSON.stringify({ id: "A-2", identifier: "A-2", title: "two", description: "x", state: "todo", dispatchable: true, agent: "rec-b" }));
  const wfPath = path.join(dir, "WORKFLOW.md");
  const src = `---
tracker:
  kind: file
  provider:
    dir: ./issues
  active_states: ["todo"]
  terminal_states: ["done"]
polling:
  interval_ms: 200
workspace:
  root: ./ws
agent:
  kind: rec-a
  max_turns: 1
---
Work on {{ issue.identifier }}`;
  fs.writeFileSync(wfPath, src);
  const workflow = parseWorkflow(src);
  const config = buildConfig(workflow, wfPath);
  const orch = new Orchestrator({ config, workflow, workflowPath: wfPath, logger: silent });
  await orch.start();
  try {
    const done = await waitFor(() => ran["A-1"] != null && ran["A-2"] != null);
    assert.ok(done, "both issues should be dispatched");
    assert.equal(ran["A-1"], "rec-a", "no override → default agent");
    assert.equal(ran["A-2"], "rec-b", "per-issue override selects that backend");
  } finally {
    orch.stop();
  }
});

test("runtime default-agent override changes the effective default", async () => {
  registerAgentFactory(makeRecordingFactory("rec-a", {}));
  registerAgentFactory(makeRecordingFactory("rec-b", {}));
  const { wfPath, workflow, config } = setup("done");
  // config default is fake-done; switch it to rec-b at runtime.
  const orch = new Orchestrator({ config, workflow, workflowPath: wfPath, logger: silent });
  assert.equal(orch.effectiveDefaultAgent(), "fake-done");
  orch.setDefaultAgent("rec-b");
  assert.equal(orch.effectiveDefaultAgent(), "rec-b");
  assert.throws(() => orch.setDefaultAgent("no-such-agent"));
  assert.equal(orch.snapshot().meta.default_agent, "rec-b");
});

test("issueDetailFor returns an idle view for a never-run issue instead of null", async () => {
  registerAgentFactory(makeFakeFactory("done"));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sym-idle-"));
  const issuesDir = path.join(dir, "issues");
  fs.mkdirSync(issuesDir);
  // Parked in backlog: never active, so it is never dispatched or tracked in running/history.
  fs.writeFileSync(path.join(issuesDir, "B-1.json"),
    JSON.stringify({ id: "B-1", identifier: "B-1", title: "parked", description: "x", state: "backlog", dispatchable: false }));
  const wfPath = path.join(dir, "WORKFLOW.md");
  const src = `---
tracker:
  kind: file
  provider:
    dir: ./issues
  backlog_states: ["backlog"]
  active_states: ["todo"]
  terminal_states: ["done"]
workspace:
  root: ./ws
agent:
  kind: fake-done
---
Work on {{ issue.identifier }}`;
  fs.writeFileSync(wfPath, src);
  const workflow = parseWorkflow(src);
  const config = buildConfig(workflow, wfPath);
  const orch = new Orchestrator({ config, workflow, workflowPath: wfPath, logger: silent });
  // Not started: nothing dispatches, so B-1 exists only in the tracker.
  assert.equal(orch.issueDetail("B-1"), null, "sync detail has no live/finished entry");
  const detail = await orch.issueDetailFor("B-1");
  assert.ok(detail, "async detail should fall back to the tracker");
  assert.equal(detail!.state, "backlog");
  assert.equal(detail!.agent, "fake-done");
  assert.equal(await orch.issueDetailFor("NOPE-9"), null, "unknown identifier still null");
});

test("failing agent schedules a backoff retry", async () => {
  registerAgentFactory(makeFakeFactory("fail"));
  const { wfPath, workflow, config } = setup("fail");
  const orch = new Orchestrator({ config, workflow, workflowPath: wfPath, logger: silent });
  await orch.start();
  try {
    const retried = await waitFor(() => orch.snapshot().counts.retrying >= 1);
    assert.ok(retried, "a failed worker should populate the retry queue");
    const snap = orch.snapshot();
    const row = (snap.retrying as Array<{ error: string | null }>)[0];
    assert.ok(row && typeof row.error === "string");
  } finally {
    orch.stop();
  }
});

test("retries stop at max_retry_attempts and the issue halts until its state changes", async () => {
  registerAgentFactory(makeFakeFactory("fail"));
  const { issuesDir, wfPath } = setup("fail");
  // Rebuild config with a tight cap and short backoff so the limit is hit quickly.
  const src = fs.readFileSync(wfPath, "utf8").replace("max_retry_backoff_ms: 2000", "max_retry_backoff_ms: 100\n  max_retry_attempts: 2");
  fs.writeFileSync(wfPath, src);
  const wf = parseWorkflow(src);
  const config = buildConfig(wf, wfPath);
  assert.equal(config.max_retry_attempts, 2);
  const orch = new Orchestrator({ config, workflow: wf, workflowPath: wfPath, logger: silent });
  await orch.start();
  try {
    const haltedSeen = await waitFor(() => orch.snapshot().counts.halted === 1);
    assert.ok(haltedSeen, "issue should halt after exhausting retries");
    assert.equal(orch.snapshot().counts.retrying, 0, "no retry stays queued after the halt");
    const h = (orch.snapshot().halted as Array<{ issue_id: string; reason: string; attempts: number }>)[0]!;
    assert.equal(h.issue_id, "T-1");
    assert.match(h.reason, /retry limit reached/);
    assert.equal(orch.issueDetail("T-1")?.status, "halted");
    // Halted views carry no tracker state of their own; issueDetailFor enriches it
    // from the tracker so the console can show the issue's current state.
    const haltedDetail = await orch.issueDetailFor("T-1");
    assert.equal(haltedDetail?.status, "halted");
    assert.equal(haltedDetail?.state, "todo");

    // Halted = held: it must not be re-dispatched by subsequent ticks.
    orch.requestRefresh();
    await new Promise((r) => setTimeout(r, 600));
    assert.equal(orch.snapshot().counts.running, 0, "halted issue is not re-dispatched");
    assert.equal(orch.snapshot().counts.halted, 1, "halt persists across ticks while still active");

    // A manual state change releases the hold.
    await orch.setIssueState("T-1", "backlog");
    assert.equal(orch.snapshot().counts.halted, 0, "state change clears the halt");
    assert.equal(readState(issuesDir), "backlog");
  } finally {
    orch.stop();
  }
});

test("stopIssue cancels a pending retry and holds the issue for the operator", async () => {
  registerAgentFactory(makeFakeFactory("fail"));
  const { wfPath, workflow, config } = setup("fail");
  const orch = new Orchestrator({ config, workflow, workflowPath: wfPath, logger: silent });
  await orch.start();
  try {
    const retried = await waitFor(() => orch.snapshot().counts.retrying >= 1);
    assert.ok(retried, "precondition: a retry is pending");
    const halt = orch.stopIssue("T-1");
    assert.ok(halt, "stopIssue should report the halted entry");
    assert.equal(halt!.reason, "stopped by operator");
    assert.equal(orch.snapshot().counts.retrying, 0, "pending retry is canceled");
    assert.equal(orch.snapshot().counts.halted, 1, "issue is held for the operator");
    assert.equal(orch.stopIssue("T-1")!.reason, "stopped by operator", "stop is idempotent");
    assert.equal(orch.stopIssue("NOPE-9"), null, "unknown issue → null");

    // Held: refresh must not re-dispatch while the issue is still active.
    orch.requestRefresh();
    await new Promise((r) => setTimeout(r, 600));
    assert.equal(orch.snapshot().counts.running, 0, "stopped issue is not re-dispatched");
    assert.equal(orch.snapshot().counts.halted, 1);
  } finally {
    orch.stop();
  }
});

test("stopIssue terminates a running session and holds the issue for the operator", async () => {
  // Agent whose turn never finishes on its own — only stop() settles it.
  let release: (() => void) | null = null;
  registerAgentFactory({
    kind: "fake-hang",
    create(opts: AgentSessionOptions): AgentSession {
      return {
        get threadId() { return "t1"; },
        get pid() { return "0"; },
        async start() {
          opts.onUpdate({ event: "session_started", timestamp: new Date().toISOString(), thread_id: "t1", turn_id: null });
          return { threadId: "t1" };
        },
        runTurn() {
          return new Promise((resolve) => {
            release = () => resolve({ status: "failed", error: "session stopped" });
          });
        },
        stop() { release?.(); },
      };
    },
  });
  const { wfPath } = setup("fail");
  const src = fs.readFileSync(wfPath, "utf8").replace("kind: fake-fail", "kind: fake-hang");
  fs.writeFileSync(wfPath, src);
  const orch = new Orchestrator({ config: buildConfig(parseWorkflow(src), wfPath), workflow: parseWorkflow(src), workflowPath: wfPath, logger: silent });
  await orch.start();
  try {
    const started = await waitFor(() => orch.snapshot().counts.running >= 1);
    assert.ok(started, "precondition: a session is running");

    const halt = orch.stopIssue("T-1");
    assert.ok(halt, "stopIssue should report the halted entry");
    assert.equal(halt!.reason, "stopped by operator");
    const exited = await waitFor(() => orch.snapshot().counts.running === 0);
    assert.ok(exited, "the running worker terminates");
    assert.equal(orch.snapshot().counts.retrying, 0, "a stopped run schedules no retry");
    assert.equal(orch.snapshot().counts.halted, 1, "issue is held for the operator");

    // Held: refresh must not re-dispatch while the issue is still active.
    orch.requestRefresh();
    await new Promise((r) => setTimeout(r, 600));
    assert.equal(orch.snapshot().counts.running, 0, "stopped issue is not re-dispatched");

    // A manual state change releases the hold.
    await orch.setIssueState("T-1", "backlog");
    assert.equal(orch.snapshot().counts.halted, 0, "state change clears the hold");
  } finally {
    orch.stop();
  }
});

test("updateIssue amends the tracker record and is reflected on the board", async () => {
  registerAgentFactory(makeFakeFactory("fail"));
  const { issuesDir, wfPath, workflow, config } = setup("fail");
  // Park the issue so nothing dispatches while we edit it.
  fs.writeFileSync(
    path.join(issuesDir, "T-1.json"),
    JSON.stringify({ id: "T-1", identifier: "T-1", title: "task", description: "do it", state: "backlog" }),
  );
  const orch = new Orchestrator({ config, workflow, workflowPath: wfPath, logger: silent });
  await orch.start();
  try {
    assert.equal(orch.canEditIssues(), true);
    const updated = await orch.updateIssue("T-1", { title: "renamed", labels: ["docs"] });
    assert.equal(updated.title, "renamed");
    const row = (await orch.board()).issues.find((i) => i.id === "T-1")!;
    assert.equal(row.title, "renamed");
    assert.deepEqual(row.labels, ["docs"]);
    // The edit form is fed by the detail payload, so it must carry the editable fields.
    const detail = await orch.issueDetailFor("T-1");
    assert.equal(detail!.title, "renamed");
    assert.equal(detail!.description, "do it");
    assert.deepEqual(detail!.labels, ["docs"]);
  } finally {
    orch.stop();
  }
});

test("deleteIssue refuses a pending retry, then succeeds once stopped, keeping the log", async () => {
  registerAgentFactory(makeFakeFactory("fail"));
  const { issuesDir, wfPath, workflow, config } = setup("fail");
  const orch = new Orchestrator({ config, workflow, workflowPath: wfPath, logger: silent });
  await orch.start();
  try {
    const retried = await waitFor(() => orch.snapshot().counts.retrying >= 1);
    assert.ok(retried, "precondition: a retry is pending");
    await assert.rejects(() => orch.deleteIssue("T-1"), /pending retry/, "a retrying issue must be stopped first");
    assert.ok(fs.existsSync(path.join(issuesDir, "T-1.json")), "the refused delete left the record alone");

    // Stop puts it on the operator hold; deleting then releases the hold with it.
    assert.ok(orch.stopIssue("T-1"));
    assert.equal(orch.snapshot().counts.halted, 1);
    const gone = await orch.deleteIssue("T-1");
    assert.equal(gone.issue_identifier, "T-1");
    assert.equal(fs.existsSync(path.join(issuesDir, "T-1.json")), false);
    assert.equal(orch.snapshot().counts.halted, 0, "deleting releases the hold and its claim");
    assert.equal((await orch.board()).issues.length, 0);

    // The retained log outlives the issue so the detail page stays readable.
    assert.ok(orch.issueDetail("T-1")?.recent_events.length, "in-memory history survives the delete");

    await assert.rejects(() => orch.deleteIssue("T-1"), /unknown issue/, "deleting twice is a not-found");
  } finally {
    orch.stop();
  }
});

test("deleteIssue refuses a running issue", async () => {
  let release: (() => void) | null = null;
  registerAgentFactory({
    kind: "fake-hang",
    create(_opts: AgentSessionOptions): AgentSession {
      return {
        get threadId() { return "t1"; },
        get pid() { return "0"; },
        async start() { return { threadId: "t1" }; },
        runTurn() {
          return new Promise((resolve) => { release = () => resolve({ status: "failed", error: "session stopped" }); });
        },
        stop() { release?.(); },
      };
    },
  });
  const { issuesDir, wfPath } = setup("fail");
  const src = fs.readFileSync(wfPath, "utf8").replace("kind: fake-fail", "kind: fake-hang");
  fs.writeFileSync(wfPath, src);
  const wf = parseWorkflow(src);
  const orch = new Orchestrator({ config: buildConfig(wf, wfPath), workflow: wf, workflowPath: wfPath, logger: silent });
  await orch.start();
  try {
    const started = await waitFor(() => orch.snapshot().counts.running >= 1);
    assert.ok(started, "precondition: a session is running");
    await assert.rejects(() => orch.deleteIssue("T-1"), /is running/);
    assert.ok(fs.existsSync(path.join(issuesDir, "T-1.json")), "a live issue's record is never removed");
  } finally {
    orch.stop();
  }
});

// ---- delivery flow (repository-backed workspaces) ----

/** Git repo the project's workspaces branch from. */
function initRepo(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "sym-orch-repo-"));
  execFileSync("git", ["init", "-q", repo]);
  execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
  execFileSync("git", ["-C", repo, "config", "user.name", "Symphony test"]);
  fs.writeFileSync(path.join(repo, "README.md"), "base\n");
  execFileSync("git", ["-C", repo, "add", "README.md"]);
  execFileSync("git", ["-C", repo, "commit", "-qm", "initial"]);
  return repo;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
}

/**
 * Fake backend that does real repo work in the worktree: commit a file, and
 * (dirty variant) leave an uncommitted file behind, then hand off with done.
 */
function makeGitFactory(kind: string, opts: { dirty: boolean }): AgentFactory {
  return {
    kind,
    create(o: AgentSessionOptions): AgentSession {
      return {
        get threadId() { return "t1"; },
        get pid() { return "0"; },
        async start() { return { threadId: "t1" }; },
        async runTurn() {
          fs.writeFileSync(path.join(o.workspacePath, "feature.txt"), `work from ${kind}\n`);
          git(o.workspacePath, ["add", "feature.txt"]);
          git(o.workspacePath, ["commit", "-qm", "implement the feature"]);
          if (opts.dirty) fs.writeFileSync(path.join(o.workspacePath, "wip.txt"), "uncommitted\n");
          fs.writeFileSync(
            path.join(o.workspacePath, "SYMPHONY_RESULT.json"),
            JSON.stringify({ state: "done", comment: "feature implemented and committed", tests: "npm test: 3 passed" }),
          );
          return { status: "completed" } as const;
        },
        stop() { /* no-op */ },
      };
    },
  };
}

/** Repo-mode project: one issue, workspaces are worktrees of `repo`. */
function setupDelivery(kind: string, repo: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sym-orch-del-"));
  const issuesDir = path.join(dir, "issues");
  fs.mkdirSync(issuesDir);
  fs.writeFileSync(
    path.join(issuesDir, "T-1.json"),
    JSON.stringify({ id: "T-1", identifier: "T-1", title: "task", description: "do it", state: "todo", dispatchable: true }),
  );
  const wfPath = path.join(dir, "WORKFLOW.md");
  const src = `---
tracker:
  kind: file
  provider:
    dir: ./issues
  active_states: ["todo", "in progress"]
  terminal_states: ["done"]
polling:
  interval_ms: 200
workspace:
  root: ./ws
  repository: "${repo.replace(/\\/g, "/")}"
agent:
  kind: ${kind}
  max_turns: 2
  max_retry_backoff_ms: 2000
---
Work on {{ issue.identifier }}: {{ issue.title }}`;
  fs.writeFileSync(wfPath, src);
  const workflow = parseWorkflow(src);
  const config = buildConfig(workflow, wfPath);
  return { dir, issuesDir, wfPath, workflow, config, wsPath: path.join(dir, "ws", "T-1") };
}

function readIssue(issuesDir: string) {
  return JSON.parse(fs.readFileSync(path.join(issuesDir, "T-1.json"), "utf8"));
}

test("repository project: completion records the delivery and lands in review, not done", async () => {
  registerAgentFactory(makeGitFactory("fake-git-clean", { dirty: false }));
  const repo = initRepo();
  const { issuesDir, wfPath, workflow, config, wsPath } = setupDelivery("fake-git-clean", repo);
  const orch = new Orchestrator({ config, workflow, workflowPath: wfPath, logger: silent });
  await orch.start();
  try {
    const reviewed = await waitFor(() => readIssue(issuesDir).state === "review");
    assert.ok(reviewed, "issue moves to the review state instead of done");

    // The deliverable is recorded on the issue…
    const rec = readIssue(issuesDir);
    const d = rec.delivery;
    assert.ok(d, "delivery record written to the tracker");
    assert.equal(d.branch, "issue/T-1");
    assert.equal(d.needs_attention, false);
    assert.equal(d.tests, "npm test: 3 passed", "tests enriched from the result envelope");
    assert.equal(d.summary, "feature implemented and committed", "summary enriched from the result comment");
    assert.deepEqual(d.files_changed, ["feature.txt"]);
    assert.match(git(repo, ["rev-parse", "issue/T-1"]), new RegExp(`^${d.commit_sha}`), "recorded SHA is the branch head");

    // …the disposable worktree is gone, but the branch keeps the work in the repo.
    const cleaned = await waitFor(() => !fs.existsSync(wsPath));
    assert.ok(cleaned, "worktree removed after delivery");
    assert.equal(git(repo, ["show", "issue/T-1:feature.txt"]), "work from fake-git-clean\n");

    // The console views expose it: board review_state + detail delivery.
    const board = await orch.board();
    assert.equal(board.review_state, "review");
    assert.equal(board.issues[0]!.needs_attention, false);
    const detail = await orch.issueDetailFor("T-1");
    assert.equal(detail?.state, "review");
    assert.equal(detail?.delivery?.branch, "issue/T-1");
    assert.equal(orch.snapshot().meta.review_state, "review");

    // Mark done is the operator's explicit accept.
    await orch.setIssueState("T-1", "done");
    assert.equal(readIssue(issuesDir).state, "done");
  } finally {
    orch.stop();
  }
});

test("repository project: uncommitted work flags needs_attention and preserves the worktree", async () => {
  registerAgentFactory(makeGitFactory("fake-git-dirty", { dirty: true }));
  const repo = initRepo();
  const { issuesDir, wfPath, workflow, config, wsPath } = setupDelivery("fake-git-dirty", repo);
  const orch = new Orchestrator({ config, workflow, workflowPath: wfPath, logger: silent });
  await orch.start();
  try {
    const reviewed = await waitFor(() => readIssue(issuesDir).state === "review");
    assert.ok(reviewed, "issue still reaches review");
    await new Promise((r) => setTimeout(r, 400)); // give cleanup a chance to misbehave
    assert.ok(fs.existsSync(wsPath), "worktree with uncommitted changes is preserved");
    const d = readIssue(issuesDir).delivery;
    assert.equal(d.needs_attention, true);
    assert.match(d.attention_reason, /uncommitted changes/);
    assert.deepEqual(d.uncommitted, ["?? wip.txt"]);
    const board = await orch.board();
    assert.equal(board.issues[0]!.needs_attention, true, "board surfaces the attention flag");
  } finally {
    orch.stop();
  }
});

test("pushIssueBranch pushes the delivered branch and records pushed_at", async () => {
  registerAgentFactory(makeGitFactory("fake-git-push", { dirty: false }));
  const repo = initRepo();
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), "sym-orch-remote-"));
  execFileSync("git", ["init", "-q", "--bare", bare]);
  git(repo, ["remote", "add", "origin", bare]);
  const { issuesDir, wfPath, workflow, config } = setupDelivery("fake-git-push", repo);
  const orch = new Orchestrator({ config, workflow, workflowPath: wfPath, logger: silent });
  await orch.start();
  try {
    const reviewed = await waitFor(() => readIssue(issuesDir).state === "review");
    assert.ok(reviewed, "precondition: delivered to review");

    const r = await orch.pushIssueBranch("T-1");
    assert.equal(r.branch, "issue/T-1");
    const ref = execFileSync("git", ["--git-dir", bare, "show-ref", "--verify", "refs/heads/issue/T-1"], { encoding: "utf8" });
    assert.match(ref, /issue\/T-1/);
    assert.equal(readIssue(issuesDir).delivery.pushed_at, r.pushed_at, "push is stamped on the delivery");
  } finally {
    orch.stop();
  }
});

test("pushIssueBranch rejects scratch projects and issues without a delivery", async () => {
  registerAgentFactory(makeFakeFactory("done"));
  const { wfPath, workflow, config } = setup("done");
  const orch = new Orchestrator({ config, workflow, workflowPath: wfPath, logger: silent });
  await assert.rejects(() => orch.pushIssueBranch("T-1"), /no workspace\.repository/, "scratch project");
  orch.stop();

  registerAgentFactory(makeGitFactory("fake-git-nopush", { dirty: false }));
  const repo = initRepo();
  const del = setupDelivery("fake-git-nopush", repo);
  const orch2 = new Orchestrator({ config: del.config, workflow: del.workflow, workflowPath: del.wfPath, logger: silent });
  await assert.rejects(() => orch2.pushIssueBranch("T-1"), /no recorded delivery/, "nothing delivered yet");
  orch2.stop();
});

/**
 * Fake backend that behaves like a real coding agent: it moves the issue to the
 * terminal state through the tracker tool *mid-turn*, then keeps working for a
 * while (committing, verifying) before the turn completes. Records whether the
 * orchestrator stopped the session out from under the live turn.
 */
function makeMidTurnFactory(kind: string, seen: { cancelled: boolean }): AgentFactory {
  return {
    kind,
    create(o: AgentSessionOptions): AgentSession {
      let stopped = false;
      return {
        get threadId() { return "t1"; },
        get pid() { return "0"; },
        async start() { return { threadId: "t1" }; },
        async runTurn() {
          await o.adapter.executeAgentTool(
            "set_issue_result",
            { state: "done", comment: "did the work mid-turn" },
            { issue: o.issue },
          );
          // Several poll/reconcile cycles of after-work while the turn is live.
          for (let i = 0; i < 10 && !stopped; i++) await new Promise((r) => setTimeout(r, 100));
          if (stopped) { seen.cancelled = true; return { status: "cancelled", error: "session stopped" } as const; }
          return { status: "completed" } as const;
        },
        stop() { stopped = true; },
      };
    },
  };
}

test("an issue moved to terminal mid-turn finishes as delivered, not a failed/cancelled run", async () => {
  const seen = { cancelled: false };
  registerAgentFactory(makeMidTurnFactory("fake-midturn", seen));
  const { issuesDir, wfPath, workflow, config } = setup("done");
  // The workflow's agent kind comes from setup(); point it at the mid-turn fake.
  const cfg = { ...config, agent_kind: "fake-midturn" };
  const orch = new Orchestrator({ config: cfg, workflow, workflowPath: wfPath, logger: silent });
  await orch.start();
  try {
    assert.ok(await waitFor(() => readState(issuesDir) === "done"), "agent's own tool call moves the issue");
    const settled = await waitFor(() => orch.issueDetail("T-1")?.status === "delivered", 12000);
    assert.ok(settled, `run should archive as delivered, got ${orch.issueDetail("T-1")?.status}`);
    assert.equal(seen.cancelled, false, "the live turn was left to finish inside the grace window");
    const detail = orch.issueDetail("T-1")!;
    assert.equal(detail.last_error, null, "a terminal handoff is not a worker error");
    assert.ok(!detail.recent_events.some((e) => e.event === "worker_failed"), "no worker_failed row in the log");
  } finally {
    orch.stop();
  }
});
