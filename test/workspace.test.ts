import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
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
function initRepo(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "sym-repo-"));
  execFileSync("git", ["init", "-q", repo]);
  execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
  execFileSync("git", ["-C", repo, "config", "user.name", "Symphony test"]);
  fs.writeFileSync(path.join(repo, "README.md"), "base\n");
  execFileSync("git", ["-C", repo, "add", "README.md"]);
  execFileSync("git", ["-C", repo, "commit", "-qm", "initial"]);
  return repo;
}

test("git worktree cleanup retains the issue branch and its committed work", async () => {
  const repo = initRepo();
  const root = path.join(repo, ".symphony", "workspaces");
  const wm = new WorkspaceManager({ root, hooks: defaultHooks(), logger: silent, repository: repo });
  const ws = await wm.createForIssue("DELIVERY-1");
  assert.equal(execFileSync("git", ["-C", ws.path, "branch", "--show-current"], { encoding: "utf8" }).trim(), "issue/DELIVERY-1");
  fs.writeFileSync(path.join(ws.path, "delivered.txt"), "kept by the branch\n");
  execFileSync("git", ["-C", ws.path, "add", "delivered.txt"]);
  execFileSync("git", ["-C", ws.path, "commit", "-qm", "deliver issue work"]);
  await wm.cleanupForIssue("DELIVERY-1");
  assert.ok(!fs.existsSync(ws.path), "the disposable worktree is removed");
  assert.match(execFileSync("git", ["-C", repo, "branch", "--list", "issue/DELIVERY-1"], { encoding: "utf8" }), /issue\/DELIVERY-1/);
  assert.equal(execFileSync("git", ["-C", repo, "show", "issue/DELIVERY-1:delivered.txt"], { encoding: "utf8" }), "kept by the branch\n");
});

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
}

test("branch_template names the issue branch", async () => {
  const repo = initRepo();
  const root = path.join(repo, ".symphony", "workspaces");
  const wm = new WorkspaceManager({ root, hooks: defaultHooks(), logger: silent, repository: repo, branchTemplate: "feat/{identifier}-work" });
  assert.equal(wm.branchNameFor("SYM-9"), "feat/SYM-9-work");
  const ws = await wm.createForIssue("SYM-9");
  assert.equal(git(ws.path, ["branch", "--show-current"]).trim(), "feat/SYM-9-work");
});

test("base_branch cuts the worktree from the given ref, not HEAD", async () => {
  const repo = initRepo();
  git(repo, ["checkout", "-qb", "base-b"]);
  fs.writeFileSync(path.join(repo, "only-on-base.txt"), "base branch content\n");
  git(repo, ["add", "only-on-base.txt"]);
  git(repo, ["commit", "-qm", "base branch commit"]);
  const baseSha = git(repo, ["rev-parse", "base-b"]).trim();
  git(repo, ["checkout", "-q", "-"]);
  const root = path.join(repo, ".symphony", "workspaces");
  const wm = new WorkspaceManager({ root, hooks: defaultHooks(), logger: silent, repository: repo, baseBranch: "base-b" });
  const ws = await wm.createForIssue("BASE-1");
  assert.equal(git(ws.path, ["rev-parse", "HEAD"]).trim(), baseSha, "worktree starts at the configured base");
  assert.ok(fs.existsSync(path.join(ws.path, "only-on-base.txt")));
});

test("deliveryInfo reports branch facts; null for scratch projects and missing worktrees", async () => {
  const repo = initRepo();
  const root = path.join(repo, ".symphony", "workspaces");
  const plain = new WorkspaceManager({ root, hooks: defaultHooks(), logger: silent });
  assert.equal(plain.deliveryInfo("X-1"), null, "no repository configured");
  const wm = new WorkspaceManager({ root, hooks: defaultHooks(), logger: silent, repository: repo });
  assert.equal(wm.deliveryInfo("X-1"), null, "worktree does not exist yet");

  const ws = await wm.createForIssue("X-1");
  fs.writeFileSync(path.join(ws.path, "feature.ts"), "export const x = 1;\n");
  git(ws.path, ["add", "feature.ts"]);
  git(ws.path, ["commit", "-qm", "add feature"]);
  const info = wm.deliveryInfo("X-1")!;
  const base = git(repo, ["branch", "--show-current"]).trim();
  assert.equal(info.branch, "issue/X-1");
  assert.equal(info.commit_sha, git(ws.path, ["rev-parse", "HEAD"]).trim());
  assert.equal(info.base_branch, base, "no configured base: the repo's current branch");
  assert.deepEqual(info.files_changed, ["feature.ts"]);
  assert.deepEqual(info.uncommitted, []);
  assert.equal(info.branch_exists, true);

  fs.writeFileSync(path.join(ws.path, "dirty.txt"), "not committed\n");
  fs.writeFileSync(path.join(ws.path, "SYMPHONY_ISSUE.json"), "{}");
  const dirty = wm.deliveryInfo("X-1")!;
  assert.deepEqual(dirty.uncommitted, ["?? dirty.txt"], "runner's own issue file is excluded");
});

test("cleanup preserves a dirty worktree and one whose branch is gone", async () => {
  const repo = initRepo();
  const root = path.join(repo, ".symphony", "workspaces");
  const wm = new WorkspaceManager({ root, hooks: defaultHooks(), logger: silent, repository: repo });

  // Uncommitted work: the worktree must survive cleanup.
  const dirty = await wm.createForIssue("KEEP-1");
  fs.writeFileSync(path.join(dirty.path, "wip.txt"), "uncommitted\n");
  await wm.cleanupForIssue("KEEP-1");
  assert.ok(fs.existsSync(dirty.path), "uncommitted work is never deleted");

  // Branch ref removed out-of-band: committed work would be lost, so preserve.
  const orphaned = await wm.createForIssue("KEEP-2");
  fs.writeFileSync(path.join(orphaned.path, "done.txt"), "committed\n");
  git(orphaned.path, ["add", "done.txt"]);
  git(orphaned.path, ["commit", "-qm", "committed work"]);
  git(repo, ["update-ref", "-d", "refs/heads/issue/KEEP-2"]); // bypasses the worktree checkout guard
  await wm.cleanupForIssue("KEEP-2");
  assert.ok(fs.existsSync(orphaned.path), "worktree preserved when its branch is missing");
});

test("pushBranch pushes the issue branch to origin", async () => {
  const repo = initRepo();
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), "sym-remote-"));
  execFileSync("git", ["init", "-q", "--bare", bare]);
  git(repo, ["remote", "add", "origin", bare]);
  const root = path.join(repo, ".symphony", "workspaces");
  const wm = new WorkspaceManager({ root, hooks: defaultHooks(), logger: silent, repository: repo });
  const ws = await wm.createForIssue("PUSH-1");
  fs.writeFileSync(path.join(ws.path, "pushed.txt"), "on the remote\n");
  git(ws.path, ["add", "pushed.txt"]);
  git(ws.path, ["commit", "-qm", "push me"]);
  wm.pushBranch("issue/PUSH-1");
  const ref = execFileSync("git", ["--git-dir", bare, "show-ref", "--verify", "refs/heads/issue/PUSH-1"], { encoding: "utf8" });
  assert.match(ref, /issue\/PUSH-1/);

  const plain = new WorkspaceManager({ root, hooks: defaultHooks(), logger: silent });
  assert.throws(() => plain.pushBranch("issue/PUSH-1"), WorkspaceError, "scratch projects cannot push");
});

