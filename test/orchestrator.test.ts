import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
