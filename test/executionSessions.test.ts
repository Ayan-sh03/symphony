import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runScript } from "../src/shell.ts";
import { buildConfig } from "../src/config/config.ts";
import { parseWorkflow } from "../src/workflow/loader.ts";
import { Logger } from "../src/logger.ts";
import { CodexAppServerClient } from "../src/agent/appServerClient.ts";
import { OpencodeSession } from "../src/agent/opencodeSession.ts";
import { registerAgentFactory } from "../src/agent/registry.ts";
import { createExecutionSession, registerExecutionProviderFactory } from "../src/execution/registry.ts";
import { runAgentAttempt, type RunnerDeps } from "../src/agent/runner.ts";
import { WorkspaceManager } from "../src/workspace/manager.ts";
import type { AgentSessionOptions } from "../src/agent/types.ts";
import type { ExecutionSession, ProcessExit, ProcessHandle } from "../src/execution/types.ts";
import type { Issue } from "../src/domain/types.ts";
import type { TrackerAdapter } from "../src/tracker/types.ts";
import { runExecutionHook } from "../src/execution/hooks.ts";
import { Orchestrator } from "../src/orchestrator/orchestrator.ts";

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
  registerExecutionProviderFactory({ kind, capabilities: ["process", "filesystem", "host-workspace"], create(opts) {
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
  return { events, files, deps, execution, root };
}

test("runner uses runtime files and awaits stop, after_run, and close", async (t) => {
  const f = runnerFixture(t);
  assert.deepEqual(await runAgentAttempt(issue, null, f.deps), { kind: "normal" });
  assert.deepEqual(f.events, ["create", "remove:SYMPHONY_RESULT.json", "before", "write:SYMPHONY_ISSUE.json", "agent", "start", "turn", "read:SYMPHONY_RESULT.json", "tracker", "remove:SYMPHONY_RESULT.json", "stop", "after", "close"]);
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

test("cancelling a hook waits for its process to terminate", async () => {
  const abort = new AbortController();
  const p = processHandle();
  const killed = deferred<void>();
  const killing = deferred<void>();
  p.handle.kill = async () => { killing.resolve(); await killed.promise; p.done.resolve({ code: null, signal: "SIGKILL" }); };
  const execution = { runtimeId: "remote", workspacePath: "/runtime/work", async close() {}, async spawn() { return p.handle; } };
  let settled = false;
  const run = (runExecutionHook as Function)(execution, "long hook", 100, abort.signal).then(() => { settled = true; });
  abort.abort();
  await killing.promise;
  assert.equal(settled, false);
  killed.resolve(); await run;
  // Cancellation must trigger promptly, not only when the hook timeout fires.
  assert.ok(abort.signal.aborted);
});

test("an already cancelled hook never starts a process", async () => {
  const abort = new AbortController(); abort.abort();
  let spawned = false;
  const execution = { runtimeId: "remote", workspacePath: "/runtime/work", async close() {}, async spawn() {
    spawned = true; const p = processHandle(); p.done.resolve({ code: 0, signal: null }); return p.handle;
  } };
  const result = await (runExecutionHook as Function)(execution, "prepare", 100, abort.signal);
  assert.equal(spawned, false);
  assert.equal(result.ok, false);
});

test("runner cancellation during before_run terminates the hook and skips the agent", async (t) => {
  const f = runnerFixture(t);
  const p = processHandle();
  const started = deferred<void>();
  Object.assign(f.execution, { spawn: async () => { started.resolve(); return p.handle; } });
  const c = config(); c.hooks.before_run = "long hook"; c.hooks.timeout_ms = 500;
  const manager = new WorkspaceManager({ root: path.join(os.tmpdir(), `sym-cancel-${counter++}`), hooks: c.hooks, logger });
  // Keep fixture-owned workspace creation and use the real hook implementation.
  f.deps.workspaceManager.runBeforeRun = manager.runBeforeRun.bind(manager);
  let stop!: () => Promise<void>;
  f.deps.onSessionReady = (s) => { stop = s; };
  const run = runAgentAttempt(issue, null, f.deps);
  await started.promise; await stop();
  // Let cancellation microtasks settle without advancing a hook timeout.
  await new Promise((r) => setImmediate(r));
  assert.equal(p.kills, 1);
  const result = await run;
  assert.equal(result.kind, "abnormal");
  assert.ok(!f.events.includes("agent"));
  assert.equal(f.events.at(-1), "close");
});

test("orchestrator shutdown waits for a late runtime and prevents agent startup", async (t) => {
  const f = runnerFixture(t);
  const creating = deferred<void>();
  const created = deferred<ExecutionSession>();
  registerExecutionProviderFactory({ kind: f.deps.config.execution.kind, capabilities: ["process", "filesystem", "host-workspace"], create() {
    creating.resolve(); return created.promise;
  } });
  const workflow = parseWorkflow(`---\ntracker:\n  kind: file\n  active_states: [todo]\n  terminal_states: [done]\n  provider:\n    dir: ./issues\nworkspace:\n  root: ./ws\nagent:\n  kind: ${f.deps.agentKind}\n---\nWork`);
  const c = buildConfig(workflow, path.join(f.root, "WORKFLOW.md")); c.execution = f.deps.config.execution;
  const orch = new Orchestrator({ config: c, workflow, workflowPath: path.join(f.root, "WORKFLOW.md"), logger });
  // Shutdown timing is independent of filesystem watcher lifetime.
  (orch as unknown as { adapter: TrackerAdapter }).adapter = {
    ...f.deps.adapter, kind: "file", secretEnvironmentNames: () => [],
    async fetchIssuesByStates(states) { return states.includes("todo") ? [issue] : []; },
    async fetchIssuesByIds() { return [issue]; },
  };
  try {
    await orch.start(); await creating.promise;
    let settled = false;
    const shutdown = Promise.resolve(orch.stop()).then(() => { settled = true; });
    await Promise.resolve();
    assert.equal(settled, false, "shutdown must await the worker cleanup");
    created.resolve(f.execution); await shutdown;
    assert.ok(!f.events.includes("agent"));
    assert.equal(f.events.at(-1), "close");
  } finally { created.resolve(f.execution); await orch.stop(); }
});

for (const kind of ["codex", "opencode"]) {
  test(`${kind} completes a worker through real local processes, hooks, and files`, async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sym-local-agent-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const script = path.join(root, "agent.cjs");
    fs.writeFileSync(script, `
      const fs = require('node:fs');
      const mode = process.argv[2];
      if (mode === 'before' || mode === 'after') {
        fs.appendFileSync('hooks.txt', mode + '\\n');
      } else {
        const issue = JSON.parse(fs.readFileSync('SYMPHONY_ISSUE.json', 'utf8'));
        if (issue.id !== 'T-28' || process.env.SYMPHONY_TEST_VALUE !== 'present') process.exit(2);
        const done = () => fs.writeFileSync('SYMPHONY_RESULT.json', JSON.stringify({ state: 'done', comment: mode }));
        const send = (v) => process.stdout.write(JSON.stringify(v) + '\\n');
        if (mode === 'codex') {
          require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
            const r = JSON.parse(line);
            send({ id: r.id, result: r.method === 'thread/start' ? { thread: { id: 'local-thread' } } : {} });
            if (r.method === 'turn/start') {
              done();
              send({ method: 'turn/completed', params: { turn: { status: 'completed' } } });
              setTimeout(() => process.exit(0), 20);
            }
          });
        } else {
          process.stdin.resume();
          process.stdin.on('end', () => {
            done(); send({ type: 'text', sessionID: 'local-thread', part: { text: 'done' } });
          });
        }
      }
    `);
    const command = `"${process.execPath}" "${script}"`;
    const c = config(); c.codex.command = `${command} codex`; c.opencode.command = `${command} opencode`;
    c.hooks.before_run = `${command} before`; c.hooks.after_run = `${command} after`;
    c.codex.read_timeout_ms = 5000;
    const manager = new WorkspaceManager({ root: path.join(root, "ws"), hooks: c.hooks, logger });
    let applied: unknown;
    const adapter = { agentToolSpecs: () => [], async fetchIssuesByIds() { return []; }, async executeAgentTool(_tool: string, result: unknown) {
      applied = result; return { success: true, output: {} };
    } } as unknown as TrackerAdapter;
    const result = await runAgentAttempt(issue, null, {
      config: c, agentKind: kind, stream: issue.id, isFollowUp: false, promptTemplate: "work",
      adapter, workspaceManager: manager, logger, childEnv: { ...process.env, SYMPHONY_TEST_VALUE: "present" },
      isActiveState: () => true, isTerminalState: () => false, isRoutable: () => true, onUpdate() {}, onSessionReady() {},
    });
    assert.deepEqual(result, { kind: "normal" });
    assert.deepEqual(applied, { state: "done", comment: kind });
    assert.equal(fs.readFileSync(path.join(manager.workspacePathFor(issue.id), "hooks.txt"), "utf8"), "before\nafter\n");
    assert.equal(fs.existsSync(path.join(manager.workspacePathFor(issue.id), "SYMPHONY_RESULT.json")), false);
  });
}

test("agent spawn and transport failures settle without leaking pending turns", async () => {
  for (const Client of [CodexAppServerClient, OpencodeSession]) {
    const execution = { runtimeId: "remote", workspacePath: "/runtime/work", async close() {}, async spawn(): Promise<ProcessHandle> { throw new Error("transport down"); } };
    const client = new Client(options(execution));
    if (Client === CodexAppServerClient) await assert.rejects(client.start(), /transport down/);
    else assert.match((await client.runTurn("work")).error!, /transport down/);
    await client.stop(); await client.stop();
  }
  const p = processHandle();
  const execution = { runtimeId: "remote", workspacePath: "/runtime/work", async close() {}, async spawn() { return p.handle; } };
  const client = new OpencodeSession(options(execution));
  const turn = client.runTurn("work");
  p.done.resolve({ code: null, signal: null, error: "disconnected" });
  assert.match((await turn).error!, /disconnected/);
  await client.stop();
});

test("OpenCode timeout waits for kill and permits a clean continuation", async () => {
  let count = 0;
  const killed = deferred<void>();
  const killing = deferred<void>();
  const p = processHandle();
  p.handle.kill = async () => { killing.resolve(); await killed.promise; p.done.resolve({ code: null, signal: "SIGKILL" }); };
  const execution = { runtimeId: "remote", workspacePath: "/runtime/work", async close() {}, async spawn() {
    if (count++ === 0) return p.handle;
    const next = processHandle(); next.done.resolve({ code: 0, signal: null }); return next.handle;
  } };
  const opts = options(execution); opts.config.opencode.turn_timeout_ms = 5;
  const client = new OpencodeSession(opts);
  let settled = false;
  const turn = client.runTurn("work").then((result) => { settled = true; return result; });
  await killing.promise; assert.equal(settled, false);
  killed.resolve(); assert.equal((await turn).status, "timeout");
  assert.equal((await client.runTurn("retry")).status, "completed");
  await client.stop();
});

test("hook timeouts await kill and output stays bounded", async () => {
  const p = processHandle();
  const execution = { runtimeId: "remote", workspacePath: "/runtime/work", async close() {}, async spawn() { return p.handle; } };
  const run = runExecutionHook(execution, "slow", 5);
  await Promise.resolve();
  p.stdout.write("x".repeat(100_000)); p.stderr.write("y".repeat(100_000));
  const result = await run;
  assert.equal(result.timedOut, true); assert.equal(p.kills, 1);
  assert.equal(result.stdout.length, 64 * 1024); assert.equal(result.stderr.length, 64 * 1024);
});

test("runner reports a runtime read failure instead of treating it as a missing result", async (t) => {
  const f = runnerFixture(t);
  f.execution.readFile = async () => { throw new Error("runtime disconnected"); };
  const result = await runAgentAttempt(issue, null, f.deps);
  assert.equal(result.kind, "abnormal");
  assert.match(result.reason!, /runtime disconnected/);
  assert.ok(!f.events.includes("tracker"));
  assert.equal(f.events.at(-1), "close");
});

test("cancellation while reading a result prevents tracker write-back", async (t) => {
  const f = runnerFixture(t);
  let stop!: () => Promise<void>;
  f.deps.onSessionReady = (s) => { stop = s; };
  f.execution.readFile = async () => { await stop(); return Buffer.from('{"state":"done"}'); };
  assert.equal((await runAgentAttempt(issue, null, f.deps)).kind, "abnormal");
  assert.ok(!f.events.includes("tracker"));
  assert.ok(f.files.has("SYMPHONY_RESULT.json"));
});

test("concurrent local close calls both await process cleanup", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sym-close-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const execution = await createExecutionSession("local", {}, { workspacePath: root, env: process.env, logger });
  const p = await execution.spawn!(`"${process.execPath}" -e "setTimeout(()=>{},100)"`);
  const release = deferred<void>();
  const kill = p.kill.bind(p);
  p.kill = async (signal) => { await release.promise; await kill(signal); };
  const first = execution.close();
  let settled = false;
  const second = execution.close().then(() => { settled = true; });
  await Promise.resolve();
  try { assert.equal(settled, false); }
  finally { release.resolve(); await first; await second; }
});

// ---- issue #39: a stop must terminate the whole owned tree, not just the shell wrapper ----

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function waitForFile(file: string, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for ${file}`);
}

/** Force-kill a surviving test process so a failed assertion cannot leak one. */
async function forceKillTree(pid: number): Promise<void> {
  if (!alive(pid)) return;
  if (process.platform === "win32") {
    await new Promise<void>((resolve) => {
      const c = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      c.once("exit", () => resolve());
      c.once("error", () => resolve());
    });
  } else {
    try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
  }
}

/**
 * Write a script whose process spawns a long-lived grandchild that records its pid
 * and heartbeats. Running it through `spawnShell` yields shell → script → grandchild,
 * so a wrapper-only kill leaves the grandchild observable as a live writer.
 */
function writeTreeScript(dir: string): string {
  const script = path.join(dir, "tree.cjs");
  fs.writeFileSync(script, [
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "const { spawn } = require('node:child_process');",
    "const dir = process.argv[2];",
    "fs.writeFileSync(path.join(dir, 'parent.pid'), String(process.pid));",
    "const code = \"const fs=require('node:fs');const p=require('node:path');\" +",
    "  \"const dir=process.argv[1];fs.writeFileSync(p.join(dir,'child.pid'),String(process.pid));\" +",
    "  \"setInterval(()=>fs.appendFileSync(p.join(dir,'heartbeat.txt'),'x'),25);\";",
    "spawn(process.execPath, ['-e', code, dir], { stdio: 'ignore' });",
    "setInterval(() => {}, 1000);",
  ].join("\n"));
  return script;
}

function treeFile(dir: string, name: string): number {
  return Number(fs.readFileSync(path.join(dir, name), "utf8"));
}

/** Start a shell → script → grandchild tree and resolve once it is heartbeating. */
async function startTree(execution: ExecutionSession, root: string, script: string): Promise<number> {
  await execution.spawn!(`"${process.execPath}" "${script}" "${root}"`);
  await waitForFile(path.join(root, "child.pid"));
  await waitForFile(path.join(root, "heartbeat.txt"));
  await new Promise((r) => setTimeout(r, 80)); // let the heartbeat grow
  return treeFile(root, "child.pid");
}

test("stopping a local process terminates descendants, not just the shell wrapper (#39)", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sym-tree-kill-"));
  const execution = await createExecutionSession("local", {}, { workspacePath: root, env: process.env, logger });
  let childPid = 0;
  try {
    const script = writeTreeScript(root);
    const handle = await execution.spawn!(`"${process.execPath}" "${script}" "${root}"`);
    await waitForFile(path.join(root, "child.pid"));
    childPid = treeFile(root, "child.pid");
    await waitForFile(path.join(root, "heartbeat.txt"));
    await new Promise((r) => setTimeout(r, 80));

    await handle.kill("SIGKILL");

    assert.equal(alive(childPid), false, "kill() must terminate the descendant process");
    // Snapshot after kill returns: the child may still write while taskkill walks the
    // tree, but once the awaited kill resolves no further heartbeat may appear.
    const settled = fs.statSync(path.join(root, "heartbeat.txt")).size;
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(
      fs.statSync(path.join(root, "heartbeat.txt")).size, settled,
      "the descendant must stop heartbeating once kill() has returned",
    );
  } finally {
    await execution.close();
    await forceKillTree(childPid);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("local execution close terminates descendant processes (#39)", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sym-tree-close-"));
  const execution = await createExecutionSession("local", {}, { workspacePath: root, env: process.env, logger });
  let childPid = 0;
  try {
    const script = writeTreeScript(root);
    childPid = await startTree(execution, root, script);

    await execution.close();

    assert.equal(alive(childPid), false, "close() must terminate the descendant process");
    const settled = fs.statSync(path.join(root, "heartbeat.txt")).size;
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(fs.statSync(path.join(root, "heartbeat.txt")).size, settled, "descendant must stop heartbeating");
  } finally {
    await forceKillTree(childPid);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("concurrent kill calls share one tree termination and all await it (#39)", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sym-tree-idem-"));
  const execution = await createExecutionSession("local", {}, { workspacePath: root, env: process.env, logger });
  let childPid = 0;
  try {
    const script = writeTreeScript(root);
    const handle = await execution.spawn!(`"${process.execPath}" "${script}" "${root}"`);
    await waitForFile(path.join(root, "child.pid"));
    childPid = treeFile(root, "child.pid");
    await waitForFile(path.join(root, "heartbeat.txt"));

    await Promise.all([handle.kill("SIGKILL"), handle.kill("SIGKILL"), handle.kill("SIGKILL")]);

    assert.equal(alive(childPid), false, "all concurrent kills must observe the descendant as terminated");
  } finally {
    await execution.close();
    await forceKillTree(childPid);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a timed-out hook script does not leak its descendant processes (#39)", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sym-tree-timeout-"));
  let childPid = 0;
  try {
    const script = writeTreeScript(root);
    const result = await runScript(`"${process.execPath}" "${script}" "${root}"`, root, 3000, process.env);

    assert.equal(result.timedOut, true);
    await waitForFile(path.join(root, "child.pid"));
    childPid = treeFile(root, "child.pid");
    assert.equal(alive(childPid), false, "a timed-out script must not leave its descendants running");
    const settled = fs.statSync(path.join(root, "heartbeat.txt")).size;
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(fs.statSync(path.join(root, "heartbeat.txt")).size, settled,
      "timeout completion must mean the descendant has stopped writing");
  } finally {
    await forceKillTree(childPid);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
