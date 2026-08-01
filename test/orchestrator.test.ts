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
import { refKey } from "../src/workspace/manager.ts";

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

/**
 * Fake backend that reports token usage the way real ones do — absolute cumulative
 * totals — before finishing the work. Used to exercise cost estimation.
 */
function makeUsageFactory(behavior: string, input: number, output: number, holdMs = 0): AgentFactory {
  return {
    kind: `fake-${behavior}`,
    create(opts: AgentSessionOptions): AgentSession {
      const thread = "t1";
      return {
        get threadId() { return thread; },
        get pid() { return "0"; },
        async start() { return { threadId: thread }; },
        async runTurn() {
          opts.onUpdate({ event: "turn_started", timestamp: new Date().toISOString(), thread_id: thread, turn_id: "turn1" });
          opts.onUpdate({
            event: "notification",
            timestamp: new Date().toISOString(),
            thread_id: thread,
            turn_id: "turn1",
            kind: "token_usage",
            absolute: true,
            usage: { input_tokens: input, output_tokens: output, total_tokens: input + output },
          });
          // Optionally stay alive after reporting, so a test can observe the live row.
          if (holdMs) await new Promise((r) => setTimeout(r, holdMs));
          fs.writeFileSync(
            path.join(opts.workspacePath, "SYMPHONY_RESULT.json"),
            JSON.stringify({ state: "done", comment: `spent ${input + output}` }),
          );
          return { status: "completed" } as const;
        },
        stop() { /* no-op */ },
      };
    },
  };
}

interface SetupOptions {
  /** Extra YAML appended under the `agent:` block (indented two spaces). */
  agentExtra?: string;
  /** Additional issue records beyond T-1. */
  extraIssues?: Record<string, unknown>[];
}

function setup(behavior: string, opts: SetupOptions = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sym-orch-"));
  const issuesDir = path.join(dir, "issues");
  fs.mkdirSync(issuesDir);
  fs.writeFileSync(
    path.join(issuesDir, "T-1.json"),
    JSON.stringify({ id: "T-1", identifier: "T-1", title: "task", description: "do it", state: "todo", dispatchable: true }),
  );
  for (const issue of opts.extraIssues ?? []) {
    fs.writeFileSync(path.join(issuesDir, `${issue.id}.json`), JSON.stringify(issue));
  }
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
  max_retry_backoff_ms: 2000${opts.agentExtra ?? ""}
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

test("onChange subscriptions are disposable; disposed observers stop firing", () => {
  const { wfPath, workflow, config } = setup("done");
  const orch = new Orchestrator({ config, workflow, workflowPath: wfPath, logger: silent });
  let hits = 0;
  const dispose = orch.onChange(() => { hits++; });
  (orch as any).notify();
  assert.equal(hits, 1);
  dispose();
  (orch as any).notify();
  assert.equal(hits, 1, "disposed observer no longer fires");
  orch.stop();
});

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

test("an issue pinned to an uninstalled backend halts alone; the rest keep dispatching", async () => {
  const ran: Record<string, string> = {};
  registerAgentFactory(makeRecordingFactory("gate-ok", ran));
  // Registered and selectable, but discovery says this host cannot run it.
  registerAgentFactory({
    ...makeRecordingFactory("gate-missing", ran),
    detect: async () => ({
      kind: "gate-missing", registered: true, installed: false, command: "gate-missing",
      command_field: "gate.command", usable: false, reason: "gate-missing not found on PATH",
      checked_at: new Date().toISOString(),
    }),
  });

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sym-gate-"));
  const issuesDir = path.join(dir, "issues");
  fs.mkdirSync(issuesDir);
  fs.writeFileSync(path.join(issuesDir, "G-1.json"),
    JSON.stringify({ id: "G-1", identifier: "G-1", title: "runnable", description: "x", state: "todo", dispatchable: true }));
  fs.writeFileSync(path.join(issuesDir, "G-2.json"),
    JSON.stringify({ id: "G-2", identifier: "G-2", title: "stranded", description: "x", state: "todo", dispatchable: true, agent: "gate-missing" }));
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
  kind: gate-ok
  max_turns: 1
---
Work on {{ issue.identifier }}`;
  fs.writeFileSync(wfPath, src);
  const workflow = parseWorkflow(src);
  const config = buildConfig(workflow, wfPath);
  const orch = new Orchestrator({ config, workflow, workflowPath: wfPath, logger: silent });
  await orch.start();
  try {
    const halted = await waitFor(() => orch.snapshot().halted.some((h) => (h as { issue_id: string }).issue_id === "G-2"));
    assert.ok(halted, "the pinned issue should halt rather than spawn a missing CLI");
    const entry = orch.snapshot().halted.find((h) => (h as { issue_id: string }).issue_id === "G-2") as { reason: string };
    assert.match(entry.reason, /agent_unavailable/);
    assert.match(entry.reason, /not found on PATH/);
    assert.ok(await waitFor(() => ran["G-1"] === "gate-ok"), "an unrelated issue still dispatches");
    assert.equal(ran["G-2"], undefined, "the missing backend is never constructed");
  } finally {
    orch.stop();
  }
});

test("a runtime default the host cannot run parks dispatch instead of spawning it", async () => {
  const ran: Record<string, string> = {};
  registerAgentFactory(makeRecordingFactory("park-ok", ran));
  registerAgentFactory({
    ...makeRecordingFactory("park-missing", ran),
    detect: async () => ({
      kind: "park-missing", registered: true, installed: false, command: "park-missing",
      command_field: "park.command", usable: false, reason: "park-missing not found on PATH",
      checked_at: new Date().toISOString(),
    }),
  });

  const { wfPath, workflow, config } = setupWith("park-ok", [todo("P-1")]);
  const orch = new Orchestrator({ config, workflow, workflowPath: wfPath, logger: silent });
  // The console lets an operator select an uninstalled backend; nothing may reach a spawn.
  orch.setDefaultAgent("park-missing");
  await orch.start();
  try {
    const meta = orch.snapshot().meta as { default_agent: string; agents: { blocked: boolean; effective_default: string } };
    assert.equal(meta.default_agent, "park-missing", "the reported default is the one dispatch would use");
    assert.equal(meta.agents.effective_default, "park-missing", "availability and dispatch agree on the kind");
    assert.equal(meta.agents.blocked, true);

    await waitFor(() => false, 700); // a few poll intervals
    assert.equal(ran["P-1"], undefined, "the missing backend is never constructed");
    assert.equal(orch.snapshot().halted.length, 0, "a bad default parks the backlog rather than halting it");

    // Point the default back at something real and the parked issue simply runs.
    orch.setDefaultAgent("park-ok");
    assert.ok(await waitFor(() => ran["P-1"] === "park-ok"), "dispatch resumes once the default is runnable");
  } finally {
    orch.stop();
  }
});

test("installing a backend clears the halts discovery caused", async () => {
  const ran: Record<string, string> = {};
  let installed = false;
  registerAgentFactory(makeRecordingFactory("heal-ok", ran));
  registerAgentFactory({
    ...makeRecordingFactory("heal-late", ran),
    detect: async () => ({
      kind: "heal-late", registered: true, installed, command: "heal-late",
      command_field: "heal.command", usable: installed,
      reason: installed ? undefined : "heal-late not found on PATH",
      checked_at: new Date().toISOString(),
    }),
  });

  const { wfPath, workflow, config } = setupWith("heal-ok", [todo("H-1", { agent: "heal-late" })]);
  const orch = new Orchestrator({ config, workflow, workflowPath: wfPath, logger: silent });
  await orch.start();
  const isHalted = () => orch.snapshot().halted.some((h) => (h as { issue_id: string }).issue_id === "H-1");
  try {
    assert.ok(await waitFor(isHalted), "the pinned issue halts while its backend is missing");

    // The halt described this machine, not the issue — installing the CLI must undo it
    // without an operator touching every halted issue.
    installed = true;
    let cleared = false;
    for (let i = 0; i < 50 && !cleared; i += 1) {
      await orch.refreshAgentDetection();
      cleared = !isHalted();
      if (!cleared) await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(cleared, "the agent_unavailable halt is released once the backend appears");
    assert.ok(await waitFor(() => ran["H-1"] === "heal-late"), "and the issue dispatches on it");
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
  const { dir, issuesDir, wfPath, workflow, config } = setup("fail");
  const ws = path.join(dir, "ws", "T-1");
  const orch = new Orchestrator({ config, workflow, workflowPath: wfPath, logger: silent });
  await orch.start();
  try {
    const retried = await waitFor(() => orch.snapshot().counts.retrying >= 1);
    assert.ok(retried, "precondition: a retry is pending");
    assert.ok(fs.existsSync(ws), "precondition: the run created a workspace");
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
    assert.equal(fs.existsSync(ws), false, "the workspace goes with the record it belonged to");

    // Nothing is left to act on, so the console hides Edit/Delete for the ghost.
    assert.equal((await orch.issueDetailFor("T-1"))?.tracked, false);

    // The retained log outlives the issue so the detail page stays readable.
    assert.ok(orch.issueDetail("T-1")?.recent_events.length, "in-memory history survives the delete");

    await assert.rejects(() => orch.deleteIssue("T-1"), /unknown issue/, "deleting twice is a not-found");
  } finally {
    orch.stop();
  }
});

test("deleteIssue refuses a running issue; editing one is visible on its detail view", async () => {
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

    // Editing a running issue is allowed; the detail view reads the dispatched
    // snapshot, so that snapshot has to pick the amended fields up.
    await orch.updateIssue("T-1", { title: "renamed mid-run" });
    assert.equal(orch.issueDetail("T-1")?.title, "renamed mid-run");
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
    assert.equal(d.parent_delivery_sha, null, "first delivery on this stream");
    assert.equal(d.history_rewritten, false);

    // …and git corroborates it: the delivered commit is anchored by a ref, so the
    // record is no longer a claim git cannot back up.
    const tagRef = `refs/symphony/tagmeta/${refKey("T-1")}`;
    assert.equal(git(repo, ["rev-parse", `${tagRef}^{commit}`]).trim(), d.commit_sha,
      "the delivery is anchored in git, not only in the tracker");
    assert.equal(JSON.parse(git(repo, ["cat-file", "tag", tagRef]).split("\n\n")[1]!).branch, "issue/T-1",
      "the tag message carries the delivery record itself");
    assert.equal(git(repo, ["log", "-1", "--format=%an", "issue/T-1"]).trim(), "Symphony (fake-git-clean)",
      "the agent's commit is attributed to Symphony");

    // …the disposable worktree is gone, but the branch keeps the work in the repo.
    const cleaned = await waitFor(() => !fs.existsSync(wsPath));
    assert.ok(cleaned, "worktree removed after delivery");
    assert.equal(git(repo, ["show", "issue/T-1:feature.txt"]), "work from fake-git-clean\n");

    // The console views expose it: board review_state + detail delivery.
    const board = await orch.board();
    assert.equal(board.review_state, "review");
    assert.equal(board.issues[0]!.needs_attention, false);
    assert.equal(board.issues[0]!.ahead, 1, "the delivered commit is not in the base yet");
    assert.equal(board.issues[0]!.behind, 0);
    assert.equal(board.issues[0]!.merged_hint, false, "unmerged work is never hinted as merged");
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

test("repository project: a merged branch is hinted on the board, never auto-closed", async () => {
  registerAgentFactory(makeGitFactory("fake-git-merged", { dirty: false }));
  const repo = initRepo();
  const { issuesDir, wfPath, workflow, config } = setupDelivery("fake-git-merged", repo);
  const orch = new Orchestrator({ config, workflow, workflowPath: wfPath, logger: silent });
  await orch.start();
  try {
    assert.ok(await waitFor(() => readIssue(issuesDir).state === "review"));
    // An issue that never ran has no branch and no delivery. It must not be hinted
    // as merged: a branch with no commits of its own is trivially an ancestor of
    // the base, which is the verified false positive the `delivered` guard exists
    // for.
    fs.writeFileSync(
      path.join(issuesDir, "T-2.json"),
      JSON.stringify({ id: "T-2", identifier: "T-2", title: "never run", description: "", state: "backlog", dispatchable: false }),
    );
    // The operator merges the delivered branch, as they would after reviewing it.
    // The board is read for the first time only now, so no cached count is in play.
    git(repo, ["merge", "-q", "--no-edit", "issue/T-1"]);
    const rows = (await orch.board()).issues;
    const row = rows.find((i) => i.identifier === "T-1")!;
    assert.equal(row.ahead, 0, "the base now contains everything the branch had");
    assert.equal(row.merged_hint, true);
    assert.equal(readIssue(issuesDir).state, "review", "a hint is not a state change");
    const never = rows.find((i) => i.identifier === "T-2")!;
    assert.equal(never.merged_hint, false, "no delivery, no hint");
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

// ---- follow-up issues / work streams (SPEC Appendix B.5) ----

/**
 * Backend that holds each turn open for `holdMs` and records, per workspace path,
 * how many sessions were ever live at once. Two issues sharing a stream share a
 * workspace, so anything above 1 means they collided in it.
 */
function makeConcurrencyFactory(kind: string, holdMs: number) {
  const live = new Map<string, number>();
  const peak = new Map<string, number>();
  let peakOverall = 0;
  let liveOverall = 0;
  const factory: AgentFactory = {
    kind,
    create(opts: AgentSessionOptions): AgentSession {
      const ws = opts.workspacePath;
      return {
        get threadId() { return "t1"; },
        get pid() { return "0"; },
        async start() { return { threadId: "t1" }; },
        async runTurn() {
          const n = (live.get(ws) ?? 0) + 1;
          live.set(ws, n);
          liveOverall += 1;
          peak.set(ws, Math.max(peak.get(ws) ?? 0, n));
          peakOverall = Math.max(peakOverall, liveOverall);
          try {
            await new Promise((r) => setTimeout(r, holdMs));
            fs.writeFileSync(
              path.join(ws, "SYMPHONY_RESULT.json"),
              JSON.stringify({ state: "done", comment: `worked in ${path.basename(ws)}` }),
            );
            return { status: "completed" } as const;
          } finally {
            live.set(ws, (live.get(ws) ?? 1) - 1);
            liveOverall -= 1;
          }
        },
        stop() { /* no-op */ },
      };
    },
  };
  return { factory, peakFor: (ws: string) => peak.get(ws) ?? 0, peakOverall: () => peakOverall };
}

/** Project with `issues` pre-written as records, workspaces plain directories. */
function setupWith(kind: string, records: Record<string, unknown>[], extraAgent = "") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sym-stream-"));
  const issuesDir = path.join(dir, "issues");
  fs.mkdirSync(issuesDir);
  for (const rec of records) {
    fs.writeFileSync(path.join(issuesDir, `${rec.identifier}.json`), JSON.stringify(rec));
  }
  const wfPath = path.join(dir, "WORKFLOW.md");
  const src = `---
tracker:
  kind: file
  provider:
    dir: ./issues
  active_states: ["todo", "in progress"]
  terminal_states: ["done"]
polling:
  interval_ms: 100
workspace:
  root: ./ws
agent:
  kind: ${kind}
  max_turns: 1
  max_concurrent_agents: 2
  max_retry_backoff_ms: 2000
${extraAgent}---
Work on {{ issue.identifier }}`;
  fs.writeFileSync(wfPath, src);
  const workflow = parseWorkflow(src);
  const config = buildConfig(workflow, wfPath);
  return { dir, issuesDir, wfPath, workflow, config };
}

const todo = (identifier: string, over: Record<string, unknown> = {}) => ({
  id: identifier, identifier, title: `task ${identifier}`, description: "x", state: "todo", dispatchable: true, ...over,
});

test("a follow-up freezes the parent's stream, so a chain stays on one branch", async () => {
  registerAgentFactory(makeFakeFactory("done"));
  const { issuesDir, wfPath, workflow, config } = setupWith("fake-done", [todo("S-1", { state: "backlog" })]);
  const orch = new Orchestrator({ config, workflow, workflowPath: wfPath, logger: silent });
  try {
    assert.equal(orch.canFollowUp(), true);
    const child = await orch.createIssue({ identifier: "S-1-a", title: "review fixes", state: "backlog", follow_up_for: "S-1" });
    assert.equal(child.follow_up_for, "S-1");
    assert.equal(child.stream_identifier, "S-1");

    // A follow-up of the follow-up still names the branch the first issue opened.
    const grandchild = await orch.createIssue({ identifier: "S-1-b", title: "more review fixes", state: "backlog", follow_up_for: "S-1-a" });
    assert.equal(grandchild.follow_up_for, "S-1-a", "lineage points at the issue it answers");
    assert.equal(grandchild.stream_identifier, "S-1", "…but the work stream is still the original");

    // All three share one workspace path, which is what keeps them on one branch.
    const paths = await Promise.all(["S-1", "S-1-a", "S-1-b"].map(async (i) => (await orch.issueDetailFor(i))!.workspace.path));
    assert.equal(new Set(paths).size, 1, "one workspace per stream");

    // An ordinary issue is untouched: its own stream, its own workspace.
    const plain = await orch.createIssue({ identifier: "S-2", title: "unrelated", state: "backlog" });
    assert.equal(plain.stream_identifier, null);
    assert.notEqual((await orch.issueDetailFor("S-2"))!.workspace.path, paths[0]);
  } finally {
    orch.stop();
  }
});

test("follow-up creation refuses an unknown parent and self-reference", async () => {
  registerAgentFactory(makeFakeFactory("done"));
  const { wfPath, workflow, config } = setupWith("fake-done", [todo("S-1", { state: "backlog" })]);
  const orch = new Orchestrator({ config, workflow, workflowPath: wfPath, logger: silent });
  try {
    await assert.rejects(
      () => orch.createIssue({ identifier: "S-9", title: "orphan", follow_up_for: "NOPE-1" }),
      (e: Error) => e.name === "OrchestratorError" && /unknown issue NOPE-1/.test(e.message),
    );
    await assert.rejects(
      () => orch.createIssue({ identifier: "S-8", title: "ouroboros", follow_up_for: "S-8" }),
      (e: Error) => e.name === "OrchestratorError" && /cannot follow up on itself/.test(e.message),
    );
  } finally {
    orch.stop();
  }
});

test("issues sharing a stream never run at the same time; separate streams still do", async () => {
  const { factory, peakFor, peakOverall } = makeConcurrencyFactory("fake-serial", 400);
  registerAgentFactory(factory);
  const { dir, wfPath, workflow, config } = setupWith("fake-serial", [
    todo("Q-1"),
    todo("Q-1-a", { follow_up_for: "Q-1", stream_identifier: "Q-1" }),
    todo("Q-2"),
  ]);
  const orch = new Orchestrator({ config, workflow, workflowPath: wfPath, logger: silent });
  await orch.start();
  try {
    const shared = path.join(dir, "ws", "Q-1");
    const done = await waitFor(
      () => ["Q-1", "Q-1-a", "Q-2"].every((i) => {
        const rec = JSON.parse(fs.readFileSync(path.join(dir, "issues", `${i}.json`), "utf8"));
        return rec.state === "done";
      }),
      15000,
    );
    assert.ok(done, "every issue in the stream still gets worked, just one at a time");
    assert.equal(peakFor(shared), 1, "the shared workspace never had two live sessions");
    assert.ok(peakOverall() >= 2, "unrelated streams still run concurrently");
  } finally {
    orch.stop();
  }
});

test("deleting one issue of a stream leaves the shared workspace for its siblings", async () => {
  registerAgentFactory(makeFakeFactory("done"));
  const { dir, wfPath, workflow, config } = setupWith("fake-done", [
    todo("D-1", { state: "backlog" }),
    todo("D-1-a", { state: "backlog", follow_up_for: "D-1", stream_identifier: "D-1" }),
  ]);
  const orch = new Orchestrator({ config, workflow, workflowPath: wfPath, logger: silent });
  try {
    const shared = path.join(dir, "ws", "D-1");
    fs.mkdirSync(shared, { recursive: true });
    fs.writeFileSync(path.join(shared, "work.txt"), "in progress\n");

    await orch.deleteIssue("D-1");
    assert.ok(fs.existsSync(shared), "the follow-up still needs the workspace it shares");

    // Once the last member goes, so does the workspace.
    await orch.deleteIssue("D-1-a");
    assert.ok(!fs.existsSync(shared), "nothing left in the stream, nothing left to keep");
  } finally {
    orch.stop();
  }
});

/**
 * Repo-mode backend that commits real work, holds the turn open, and records how many
 * sessions were ever live at once in each workspace. The git delivery path is where the
 * post-run window is widest: several awaited `git` subprocesses run after the entry has
 * already left the running set.
 */
function makeGitConcurrencyFactory(kind: string, holdMs: number) {
  const live = new Map<string, number>();
  const peak = new Map<string, number>();
  const factory: AgentFactory = {
    kind,
    create(o: AgentSessionOptions): AgentSession {
      const ws = o.workspacePath;
      const id = o.issue.identifier;
      return {
        get threadId() { return "t1"; },
        get pid() { return "0"; },
        async start() { return { threadId: "t1" }; },
        async runTurn() {
          const n = (live.get(ws) ?? 0) + 1;
          live.set(ws, n);
          peak.set(ws, Math.max(peak.get(ws) ?? 0, n));
          try {
            fs.writeFileSync(path.join(ws, `${id}.txt`), `work from ${id}\n`);
            git(ws, ["add", `${id}.txt`]);
            git(ws, ["commit", "-qm", `work for ${id}`]);
            await new Promise((r) => setTimeout(r, holdMs));
            fs.writeFileSync(
              path.join(ws, "SYMPHONY_RESULT.json"),
              JSON.stringify({ state: "done", comment: `${id} done`, tests: "npm test: ok" }),
            );
            return { status: "completed" } as const;
          } finally {
            live.set(ws, (live.get(ws) ?? 1) - 1);
          }
        },
        stop() { /* no-op */ },
      };
    },
  };
  return { factory, peakFor: (ws: string) => peak.get(ws) ?? 0 };
}

test("a stream stays busy while its delivery is recorded and its worktree removed", async () => {
  const { factory, peakFor } = makeGitConcurrencyFactory("fake-git-stream", 150);
  registerAgentFactory(factory);
  const repo = initRepo();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sym-orch-stream-"));
  const issuesDir = path.join(dir, "issues");
  fs.mkdirSync(issuesDir);
  // Two issues on one branch: the follow-up must wait for the parent's delivery to be
  // read out of the worktree and the worktree removed, not just for its turn to end.
  fs.writeFileSync(path.join(issuesDir, "R-1.json"),
    JSON.stringify({ id: "R-1", identifier: "R-1", title: "first pass", description: "x", state: "todo", dispatchable: true }));
  fs.writeFileSync(path.join(issuesDir, "R-1-a.json"),
    JSON.stringify({ id: "R-1-a", identifier: "R-1-a", title: "review fixes", description: "x", state: "todo",
      dispatchable: true, follow_up_for: "R-1", stream_identifier: "R-1" }));
  const wfPath = path.join(dir, "WORKFLOW.md");
  const src = `---
tracker:
  kind: file
  provider:
    dir: ./issues
  active_states: ["todo", "in progress"]
  terminal_states: ["done"]
polling:
  interval_ms: 100
workspace:
  root: ./ws
  repository: "${repo.replace(/\\/g, "/")}"
agent:
  kind: fake-git-stream
  max_turns: 1
  max_concurrent_agents: 2
  max_retry_backoff_ms: 2000
---
Work on {{ issue.identifier }}`;
  fs.writeFileSync(wfPath, src);
  const workflow = parseWorkflow(src);
  const config = buildConfig(workflow, wfPath);
  const orch = new Orchestrator({ config, workflow, workflowPath: wfPath, logger: silent });
  await orch.start();
  try {
    const read = (i: string) => JSON.parse(fs.readFileSync(path.join(issuesDir, `${i}.json`), "utf8"));
    const both = await waitFor(() => read("R-1").state === "review" && read("R-1-a").state === "review", 20000);
    assert.ok(both, "both issues deliver");
    assert.equal(peakFor(path.join(dir, "ws", "R-1")), 1, "never two live sessions in the shared worktree");

    // Both landed on the one branch, and the second delivery covers the whole stream.
    assert.equal(read("R-1").delivery.branch, "issue/R-1");
    assert.equal(read("R-1-a").delivery.branch, "issue/R-1");
    assert.deepEqual(read("R-1-a").delivery.files_changed.sort(), ["R-1-a.txt", "R-1.txt"]);
    assert.equal(read("R-1-a").delivery.needs_attention, false, "the sibling's run must not contaminate the delivery");
  } finally {
    orch.stop();
  }
});

// ---- cost estimation (extension, PLAN M5) ----

const PRICING = `
  pricing:
    input_per_mtok: 2
    output_per_mtok: 10`;

test("board totals carry the cost of the tokens spent", async () => {
  // 1M input @ $2 + 0.5M output @ $10 = $7.00
  registerAgentFactory(makeUsageFactory("usage-a", 1_000_000, 500_000));
  const { wfPath, workflow, config } = setup("usage-a", { agentExtra: PRICING });
  const orch = new Orchestrator({ config, workflow, workflowPath: wfPath, logger: silent });
  await orch.start();
  try {
    const spent = await waitFor(() => orch.snapshot().codex_totals.total_tokens === 1_500_000);
    assert.ok(spent, "totals should accumulate the reported usage");
    const cost = orch.snapshot().codex_totals.estimated_cost!;
    assert.equal(cost.amount, 7);
    assert.equal(cost.currency, "USD");
    assert.equal(cost.partial, false);
  } finally {
    orch.stop();
  }
});

test("a live run row carries its own cost", async () => {
  registerAgentFactory(makeUsageFactory("usage-slow", 1_000_000, 500_000, 1500));
  const { wfPath, workflow, config } = setup("usage-slow", { agentExtra: PRICING });
  const orch = new Orchestrator({ config, workflow, workflowPath: wfPath, logger: silent });
  await orch.start();
  try {
    const live = await waitFor(() => {
      const rows = orch.snapshot().running as { tokens: { total_tokens: number } }[];
      return rows.length === 1 && rows[0].tokens.total_tokens === 1_500_000;
    });
    assert.ok(live, "should observe the running row after it reports usage");
    const row = (orch.snapshot().running as { tokens: { estimated_cost: { amount: number } | null } }[])[0];
    assert.equal(row.tokens.estimated_cost!.amount, 7);
    const detail = orch.issueDetail("T-1")!;
    assert.equal(detail.tokens!.estimated_cost!.amount, 7, "the detail view agrees while running");
  } finally {
    orch.stop();
  }
});

test("a finished issue still reports what it spent", async () => {
  registerAgentFactory(makeUsageFactory("usage-a", 1_000_000, 500_000));
  const { wfPath, workflow, config } = setup("usage-a", { agentExtra: PRICING });
  const orch = new Orchestrator({ config, workflow, workflowPath: wfPath, logger: silent });
  await orch.start();
  try {
    const settled = await waitFor(() => orch.issueDetail("T-1")?.status === "completed");
    assert.ok(settled, "issue should settle to completed");
    const detail = orch.issueDetail("T-1")!;
    assert.equal(detail.running, null, "the live session is gone");
    assert.equal(detail.agent, "fake-usage-a", "the retained log names the backend that ran it");
    assert.equal(detail.tokens!.total_tokens, 1_500_000);
    assert.equal(detail.tokens!.estimated_cost!.amount, 7);
  } finally {
    orch.stop();
  }
});

test("without pricing the counts survive and every cost is null", async () => {
  registerAgentFactory(makeUsageFactory("usage-a", 1_000_000, 500_000));
  const { wfPath, workflow, config } = setup("usage-a");
  const orch = new Orchestrator({ config, workflow, workflowPath: wfPath, logger: silent });
  await orch.start();
  try {
    const spent = await waitFor(() => orch.snapshot().codex_totals.total_tokens === 1_500_000);
    assert.ok(spent, "tokens are still counted when unpriced");
    assert.equal(orch.snapshot().codex_totals.estimated_cost, null);
    const settled = await waitFor(() => orch.issueDetail("T-1")?.status === "completed");
    assert.ok(settled);
    assert.equal(orch.issueDetail("T-1")!.tokens!.estimated_cost, null);
  } finally {
    orch.stop();
  }
});

test("each backend's tokens are priced at that backend's own rate", async () => {
  // fake-usage-a spends 1M input, fake-usage-b spends 2M input. Priced at $2 and $20
  // per Mtok: $2 + $40 = $42. Pricing the 3M flat at either rate would not give that.
  registerAgentFactory(makeUsageFactory("usage-a", 1_000_000, 0));
  registerAgentFactory(makeUsageFactory("usage-b", 2_000_000, 0));
  const { wfPath, workflow, config } = setup("usage-a", {
    agentExtra: `
  pricing:
    fake-usage-a:
      input_per_mtok: 2
      output_per_mtok: 0
    fake-usage-b:
      input_per_mtok: 20
      output_per_mtok: 0`,
    extraIssues: [
      { id: "T-2", identifier: "T-2", title: "other", description: "do it", state: "todo", dispatchable: true, agent: "fake-usage-b" },
    ],
  });
  const orch = new Orchestrator({ config, workflow, workflowPath: wfPath, logger: silent });
  await orch.start();
  try {
    const spent = await waitFor(() => orch.snapshot().codex_totals.total_tokens === 3_000_000);
    assert.ok(spent, "both backends should report usage");
    assert.equal(orch.snapshot().codex_totals.estimated_cost!.amount, 42);
  } finally {
    orch.stop();
  }
});

test("an unpriced backend makes the total a flagged lower bound", async () => {
  registerAgentFactory(makeUsageFactory("usage-a", 1_000_000, 0));
  registerAgentFactory(makeUsageFactory("usage-b", 2_000_000, 0));
  const { wfPath, workflow, config } = setup("usage-a", {
    agentExtra: `
  pricing:
    fake-usage-a:
      input_per_mtok: 2
      output_per_mtok: 0`,
    extraIssues: [
      { id: "T-2", identifier: "T-2", title: "other", description: "do it", state: "todo", dispatchable: true, agent: "fake-usage-b" },
    ],
  });
  const orch = new Orchestrator({ config, workflow, workflowPath: wfPath, logger: silent });
  await orch.start();
  try {
    const spent = await waitFor(() => orch.snapshot().codex_totals.total_tokens === 3_000_000);
    assert.ok(spent, "both backends should report usage");
    const cost = orch.snapshot().codex_totals.estimated_cost!;
    assert.equal(cost.amount, 2, "only the priced backend contributes");
    assert.equal(cost.partial, true);
    assert.deepEqual(cost.unpriced, ["fake-usage-b"]);
  } finally {
    orch.stop();
  }
});
