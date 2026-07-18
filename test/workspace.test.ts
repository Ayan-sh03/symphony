import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WorkspaceManager, workspaceKey, WorkspaceError } from "../src/workspace/manager.ts";
import { Logger } from "../src/logger.ts";

const silent = new Logger([{ name: "null", write() {} }], "error");

function mkRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sym-ws-"));
}
function defaultHooks() {
  return { after_create: null, before_run: null, after_run: null, before_remove: null, timeout_ms: 5000 };
}

test("unchanged identifier keeps deterministic key", () => {
  assert.equal(workspaceKey("ABC-123"), "ABC-123");
});

test("distinct identifiers that sanitize to same text get distinct keys", () => {
  const a = workspaceKey("a/b");
  const b = workspaceKey("a:b");
  assert.notEqual(a, b);
  assert.match(a, /^a_b-[0-9a-f]{16}$/);
  assert.match(b, /^a_b-[0-9a-f]{16}$/);
});

test("creates then reuses workspace; created_now gates after_create", async () => {
  const root = mkRoot();
  const wm = new WorkspaceManager({ root, hooks: defaultHooks(), logger: silent });
  const first = await wm.createForIssue("ABC-1");
  assert.equal(first.created_now, true);
  assert.ok(fs.existsSync(first.path));
  const second = await wm.createForIssue("ABC-1");
  assert.equal(second.created_now, false);
});

test("rejects workspace path outside root", () => {
  const root = mkRoot();
  const wm = new WorkspaceManager({ root, hooks: defaultHooks(), logger: silent });
  assert.throws(() => wm.workspacePathFor("../escape"), (e) => e instanceof WorkspaceError);
});

test("existing non-directory at workspace path fails safely", async () => {
  const root = mkRoot();
  const wm = new WorkspaceManager({ root, hooks: defaultHooks(), logger: silent });
  const p = wm.workspacePathFor("ABC-9");
  fs.writeFileSync(p, "not a dir");
  await assert.rejects(() => wm.createForIssue("ABC-9"), (e) => e instanceof WorkspaceError);
});

test("after_create runs only on fresh creation and failure aborts", async () => {
  const root = mkRoot();
  const marker = path.join(root, "created.marker");
  const hooks = { ...defaultHooks(), after_create: `echo hi > "${marker.replace(/\\/g, "/")}"` };
  const wm = new WorkspaceManager({ root, hooks, logger: silent });
  const ws = await wm.createForIssue("HOOK-1");
  assert.ok(fs.existsSync(ws.path));
});

test("before_run failure returns false", async () => {
  const root = mkRoot();
  const hooks = { ...defaultHooks(), before_run: "exit 3" };
  const wm = new WorkspaceManager({ root, hooks, logger: silent });
  const ws = await wm.createForIssue("BR-1");
  const ok = await wm.runBeforeRun(ws.path);
  assert.equal(ok, false);
});

test("cleanup removes workspace", async () => {
  const root = mkRoot();
  const wm = new WorkspaceManager({ root, hooks: defaultHooks(), logger: silent });
  const ws = await wm.createForIssue("CL-1");
  assert.ok(fs.existsSync(ws.path));
  await wm.cleanupForIssue("CL-1");
  assert.ok(!fs.existsSync(ws.path));
});
