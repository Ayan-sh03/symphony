/** Transactional completion (issue #32): real files, snapshots, and tracker records. */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildConfig } from "../src/config/config.ts";
import { parseWorkflow } from "../src/workflow/loader.ts";
import { Logger } from "../src/logger.ts";
import { registerAgentFactory } from "../src/agent/registry.ts";
import { runAgentAttempt, RESULT_FILE, type RunnerDeps } from "../src/agent/runner.ts";
import { WorkspaceManager } from "../src/workspace/manager.ts";
import { FileTrackerAdapter } from "../src/tracker/fileAdapter.ts";
import type { AgentSessionOptions } from "../src/agent/types.ts";

const logger = new Logger([{ name: "null", write() {} }], "error");
let sequence = 0;
async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sym-checkpoint-test-"));
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
