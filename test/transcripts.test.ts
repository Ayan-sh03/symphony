/**
 * Hermetic tests for the backend transcript readers (the `readTranscript` capability).
 * We build tiny on-disk fixtures matching the real Codex rollout and opencode storage
 * layouts, point the readers at them via CODEX_HOME / OPENCODE_DATA_DIR, and assert the
 * mapping onto the console's activity-log vocabulary. No real agent is involved.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import { readCodexTranscript } from "../src/agent/codexTranscript.ts";
import { readOpencodeTranscript } from "../src/agent/opencodeTranscript.ts";

const query = (workspacePath: string) => ({
  workspacePath,
  sessionId: null,
  config: {} as never,
  logger: { warn() {} } as never,
});

test("readCodexTranscript maps a rollout jsonl onto activity events", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "codex-home-"));
  const ws = path.join(home, "ws", "SYM-2");
  const dir = path.join(home, "sessions", "2026", "07", "18");
  await fs.mkdir(dir, { recursive: true });
  const line = (o: unknown) => JSON.stringify(o);
  const rollout = [
    line({ timestamp: "2026-07-18T09:51:25.000Z", type: "session_meta", payload: { session_id: "sid-1", cwd: ws, originator: "symphony" } }),
    line({ timestamp: "2026-07-18T09:51:26.000Z", type: "event_msg", payload: { type: "task_started", turn_id: "t1" } }),
    line({ timestamp: "2026-07-18T09:51:27.000Z", type: "event_msg", payload: { type: "agent_message", message: "hello" } }),
    line({ timestamp: "2026-07-18T09:51:28.000Z", type: "response_item", payload: { type: "function_call", name: "shell_command", arguments: JSON.stringify({ command: "ls -R" }) } }),
    line({ timestamp: "2026-07-18T09:51:29.000Z", type: "event_msg", payload: { type: "patch_apply_end", changes: { [path.join(ws, "ABOUT.md")]: {} }, stdout: "A ABOUT.md" } }),
    line({ timestamp: "2026-07-18T09:51:30.000Z", type: "event_msg", payload: { type: "token_count", info: {} } }),
    line({ timestamp: "2026-07-18T09:51:31.000Z", type: "event_msg", payload: { type: "task_complete", last_agent_message: "done" } }),
  ].join("\n");
  await fs.writeFile(path.join(dir, "rollout-2026-07-18T09-51-25-sid-1.jsonl"), rollout);

  const prev = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  try {
    const events = await readCodexTranscript(query(ws));
    assert.deepEqual(events.map((e) => e.event), [
      "session_started", "turn_started", "agent_message", "command", "file_change", "turn_completed",
    ]);
    assert.equal(events[2]!.message, "hello");
    assert.equal(events[3]!.message, "ls -R");
    assert.equal(events[4]!.message, "ABOUT.md");
    assert.equal(events[5]!.message, "done");
  } finally {
    if (prev === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = prev;
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("readCodexTranscript returns [] when no rollout matches the workspace", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "codex-home-"));
  const prev = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  try {
    assert.deepEqual(await readCodexTranscript(query(path.join(home, "ws", "SYM-9"))), []);
  } finally {
    if (prev === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = prev;
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("readOpencodeTranscript maps db messages+parts onto activity events", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "oc-data-"));
  const dataDir = path.join(root, "opencode");
  await fs.mkdir(dataDir, { recursive: true });
  const ws = path.join(root, "ws", "SYM-3");
  const sid = "ses_abc";
  const mid = "msg_1";

  const db = new DatabaseSync(path.join(dataDir, "opencode.db"));
  db.exec("CREATE TABLE session (id TEXT, directory TEXT, time_updated INTEGER)");
  db.exec("CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, data TEXT)");
  db.exec("CREATE TABLE part (id TEXT, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT)");
  db.prepare("INSERT INTO session VALUES (?, ?, ?)").run(sid, ws.replace(/\\/g, "/"), 2);
  db.prepare("INSERT INTO message VALUES (?, ?, ?, ?)").run(mid, sid, 1000, JSON.stringify({ id: mid, role: "assistant" }));
  const part = (id: string, tc: number, data: unknown) =>
    db.prepare("INSERT INTO part VALUES (?, ?, ?, ?, ?)").run(id, mid, sid, tc, JSON.stringify(data));
  part("prt_1", 1, { type: "text", text: "hi" });
  part("prt_2", 2, { type: "tool", tool: "bash", state: { input: { command: "ls" } } });
  part("prt_3", 3, { type: "tool", tool: "write", state: { input: { filePath: path.join(ws, "A.md") } } });
  db.close();

  const prev = process.env.OPENCODE_DATA_DIR;
  process.env.OPENCODE_DATA_DIR = dataDir;
  try {
    const events = await readOpencodeTranscript(query(ws));
    assert.deepEqual(events.map((e) => e.event), ["session_started", "agent_message", "command", "file_change"]);
    assert.equal(events[1]!.message, "hi");
    assert.equal(events[2]!.message, "ls");
    assert.equal(events[3]!.message, "A.md");
  } finally {
    if (prev === undefined) delete process.env.OPENCODE_DATA_DIR; else process.env.OPENCODE_DATA_DIR = prev;
    await fs.rm(root, { recursive: true, force: true });
  }
});
