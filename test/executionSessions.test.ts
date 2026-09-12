import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildConfig } from "../src/config/config.ts";
import { parseWorkflow } from "../src/workflow/loader.ts";
import { Logger } from "../src/logger.ts";
import { CodexAppServerClient } from "../src/agent/appServerClient.ts";
import { OpencodeSession } from "../src/agent/opencodeSession.ts";
import { registerAgentFactory } from "../src/agent/registry.ts";
import { registerExecutionProviderFactory } from "../src/execution/registry.ts";
import { runAgentAttempt, type RunnerDeps } from "../src/agent/runner.ts";
import { WorkspaceManager } from "../src/workspace/manager.ts";
import type { AgentSessionOptions } from "../src/agent/types.ts";
import type { ExecutionSession, ProcessExit, ProcessHandle } from "../src/execution/types.ts";
import type { Issue } from "../src/domain/types.ts";
import type { TrackerAdapter } from "../src/tracker/types.ts";

const logger = new Logger([{ name: "null", write() {} }], "error");
const issue: Issue = {
  id: "T-28", identifier: "T-28", title: "runtime test", state: "todo", description: null,
  native_ref: null, priority: null, branch_name: null, url: null, assignee_id: null,
  labels: [], blocked_by: [], dispatchable: true, agent: null, model: null,
  follow_up_for: null, stream_identifier: null, created_at: null, updated_at: null,
};
function config() {
  return buildConfig(parseWorkflow("---\nagent:\n  max_turns: 1\n---\nWork"), path.resolve("WORKFLOW.md"));
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}
function processHandle(onInput: (text: string) => void = () => {}) {
  const done = deferred<ProcessExit>();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let kills = 0;
  const handle: ProcessHandle = {
    pid: "remote-process", stdout, stderr,
    stdin: new Writable({ write(data, _encoding, cb) { onInput(data.toString()); cb(); } }),
    exit: done.promise, wait: () => done.promise,
    async kill() { kills++; done.resolve({ code: null, signal: "SIGKILL" }); await done.promise; },
  };
  return { handle, stdout, stderr, done, get kills() { return kills; } };
}
function options(execution: ExecutionSession): AgentSessionOptions & { execution: ExecutionSession } {
  const c = config();
  c.codex.command = "missing-codex-for-runtime-test";
  c.codex.read_timeout_ms = 80;
  c.opencode.command = "missing-opencode-for-runtime-test";
  return {
    execution, workspacePath: "/runtime/work", issue, config: c, logger,
    onUpdate() {}, adapter: {} as TrackerAdapter, toolSpecs: [], env: {},
  };
}

test("Codex uses execution transport, runtime cwd, and awaits termination", async () => {
  const requests: any[] = [];
  const p = processHandle((line) => {
    const request = JSON.parse(line); requests.push(request);
    const result = request.method === "thread/start" ? { thread: { id: "remote-thread" } } : {};
    p.stdout.write(JSON.stringify({ id: request.id, result }) + "\n");
    if (request.method === "turn/start") p.stdout.write(JSON.stringify({ method: "turn/completed", params: { turn: { status: "completed" } } }) + "\n");
  });
  const killed = deferred<void>();
  p.handle.kill = async () => { await killed.promise; p.done.resolve({ code: null, signal: "SIGKILL" }); };
  let command = "";
  const execution = { runtimeId: "remote", workspacePath: "/runtime/work", async spawn(c: string) { command = c; return p.handle; }, async close() {} };
  const client = new CodexAppServerClient(options(execution));
  try {
    assert.deepEqual(await client.start(), { threadId: "remote-thread" });
    assert.equal(command, "missing-codex-for-runtime-test");
    assert.equal(client.pid, "remote-process");
    assert.equal((await client.runTurn("do work")).status, "completed");
    assert.equal(requests.find((r) => r.method === "thread/start").params.cwd, "/runtime/work");
    let stopped = false;
    const stop = Promise.resolve(client.stop()).then(() => { stopped = true; });
    await Promise.resolve(); assert.equal(stopped, false);
    killed.resolve(); await stop;
  } finally { killed.resolve(); await client.stop(); }
});

test("OpenCode uses execution transport, stdin, and continuation session", async () => {
  const commands: string[] = [];
  const inputs: string[] = [];
  const execution = {
    runtimeId: "remote", workspacePath: "/runtime/work", async close() {},
    async spawn(command: string) {
      commands.push(command);
      const p = processHandle((text) => {
        inputs.push(text);
        p.stdout.write(JSON.stringify({ type: "text", sessionID: "ses_remote", part: { text: "done" } }) + "\n");
        p.done.resolve({ code: 0, signal: null });
      });
      return p.handle;
    },
  };
  const client = new OpencodeSession(options(execution));
  try {
    await client.start();
    assert.equal((await client.runTurn("first\n\"prompt\"", "title")).status, "completed");
    assert.equal((await client.runTurn("continue")).status, "completed");
    assert.deepEqual(inputs, ["first\n\"prompt\"", "continue"]);
    assert.match(commands[0]!, /--dir "\/runtime\/work"/);
    assert.match(commands[1]!, /-s "ses_remote"/);
  } finally { await client.stop(); }
});

test("stopping while an asynchronous spawn is pending kills the late process", async () => {
  for (const Client of [CodexAppServerClient, OpencodeSession]) {
    const pending = deferred<ProcessHandle>();
    const p = processHandle();
    const execution = { runtimeId: "remote", workspacePath: "/runtime/work", spawn: () => pending.promise, async close() {} };
    const client = new Client(options(execution));
    const work = (Client === CodexAppServerClient ? client.start() : client.runTurn("work")).catch(() => null);
    const stop = client.stop();
    pending.resolve(p.handle);
    await stop; await work;
    assert.ok(p.kills > 0, Client.name);
  }
});

let counter = 0;
function runnerFixture(t: { after: (fn: () => void) => void }, failure = "") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sym-runtime-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const events: string[] = [];
  const files = new Map<string, string>();
  const c = config();
  const kind = `runtime-test-${counter++}`;
  c.execution = { kind, provider: { template: "test" } };
  const execution = {
    runtimeId: "remote", workspacePath: "/runtime/work",
    async spawn() { throw new Error("unused"); },
    async writeFile(name: string, data: string | Uint8Array) { events.push(`write:${name}`); files.set(name, String(data)); },
    async readFile(name: string) { events.push(`read:${name}`); if (!files.has(name)) throw Object.assign(new Error("missing"), { code: "ENOENT" }); return Buffer.from(files.get(name)!); },
    async removeFile(name: string) { events.push(`remove:${name}`); files.delete(name); },
    async close() { await Promise.resolve(); events.push("close"); if (failure === "close") throw new Error("close failed"); },
  };
  registerExecutionProviderFactory({ kind, capabilities: ["process", "filesystem"], create(opts) {
    events.push("create"); assert.deepEqual(opts.env, { AGENT_KEY: "allowed" }); return execution;
  } });
  registerAgentFactory({ kind, create(opts) {
    events.push("agent");
    assert.equal((opts as any).execution, execution);
    assert.equal(opts.workspacePath, "/runtime/work");
    if (failure === "init") throw new Error("init failed");
    return {
      threadId: "remote-thread", pid: "remote-process",
      async start() { events.push("start"); if (failure === "start") throw new Error("start failed"); return { threadId: "remote-thread" }; },
      async runTurn() { events.push("turn"); if (failure === "turn") throw new Error("turn failed"); files.set("SYMPHONY_RESULT.json", '{"state":"done"}'); return { status: "completed" as const }; },
      async stop() { await Promise.resolve(); events.push("stop"); if (failure === "stop") throw new Error("stop failed"); },
    };
  } });
  const manager = new WorkspaceManager({ root, hooks: c.hooks, logger });
  manager.runBeforeRun = async (_path, ...args: unknown[]) => { assert.equal(args[0], execution); events.push("before"); return failure !== "before"; };
  manager.runAfterRun = async (_path, ...args: unknown[]) => { assert.equal(args[0], execution); events.push("after"); };
  const adapter = {
    agentToolSpecs: () => [],
    async executeAgentTool() { events.push("tracker"); return { success: true, output: {} }; },
    async fetchIssuesByIds() { return []; },
  } as unknown as TrackerAdapter;
  const deps: RunnerDeps = {
    config: c, agentKind: kind, stream: issue.identifier, isFollowUp: false,
    promptTemplate: "Work", adapter, workspaceManager: manager, logger, childEnv: { AGENT_KEY: "allowed" },
    isActiveState: () => true, isTerminalState: () => false, isRoutable: () => true,
    onUpdate() {}, onSessionReady() {},
  };
  return { events, files, deps, execution };
}

test("runner uses runtime files and awaits stop, after_run, and close", async (t) => {
  const f = runnerFixture(t);
  assert.deepEqual(await runAgentAttempt(issue, null, f.deps), { kind: "normal" });
  assert.deepEqual(f.events, ["create", "before", "write:SYMPHONY_ISSUE.json", "agent", "start", "turn", "read:SYMPHONY_RESULT.json", "tracker", "remove:SYMPHONY_RESULT.json", "stop", "after", "close"]);
  assert.equal(JSON.parse(f.files.get("SYMPHONY_ISSUE.json")!).id, issue.id);
});

for (const failure of ["before", "init", "start", "turn", "stop", "close"]) {
  test(`runner closes the runtime on ${failure} failure`, async (t) => {
    const f = runnerFixture(t, failure);
    const outcome = await runAgentAttempt(issue, null, f.deps);
    assert.equal(outcome.kind, "abnormal");
    assert.equal(f.events.at(-1), "close");
    assert.equal(f.events.filter((e) => e === "close").length, 1);
  });
}

test("run hooks execute inside the provided runtime even without a host directory", async () => {
  const c = config(); c.hooks.before_run = "prepare"; c.hooks.after_run = "finish";
  const manager = new WorkspaceManager({ root: "/no-host-workspace", hooks: c.hooks, logger });
  const commands: string[] = [];
  const execution = { runtimeId: "remote", workspacePath: "/runtime/work", async close() {}, async spawn(command: string) {
    commands.push(command); const p = processHandle(); p.done.resolve({ code: 0, signal: null }); return p.handle;
  } };
  assert.equal(await (manager.runBeforeRun as Function)("/no-host-workspace", execution), true);
  await (manager.runAfterRun as Function)("/no-host-workspace", execution);
  assert.deepEqual(commands, ["prepare", "finish"]);
});
