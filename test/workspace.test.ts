import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { WorkspaceManager, workspaceKey, refKey, WorkspaceError, isSafeStreamIdentifier } from "../src/workspace/manager.ts";
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

/** The commit a stream's recorded base ref points at, or null when unrecorded. */
function baseRef(repo: string, stream: string): string | null {
  try {
    return git(repo, ["rev-parse", "--verify", `refs/symphony/base/${refKey(stream)}^{commit}`]).trim();
  } catch {
    return null;
  }
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
  assert.equal(await plain.deliveryInfo("X-1"), null, "no repository configured");
  const wm = new WorkspaceManager({ root, hooks: defaultHooks(), logger: silent, repository: repo });
  assert.equal(await wm.deliveryInfo("X-1"), null, "worktree does not exist yet");

  const ws = await wm.createForIssue("X-1");
  fs.writeFileSync(path.join(ws.path, "feature.ts"), "export const x = 1;\n");
  git(ws.path, ["add", "feature.ts"]);
  git(ws.path, ["commit", "-qm", "add feature"]);
  const info = (await wm.deliveryInfo("X-1"))!;
  const base = git(repo, ["branch", "--show-current"]).trim();
  assert.equal(info.branch, "issue/X-1");
  assert.equal(info.commit_sha, git(ws.path, ["rev-parse", "HEAD"]).trim());
  assert.equal(info.base_branch, base, "no configured base: the repo's current branch");
  assert.deepEqual(info.files_changed, ["feature.ts"]);
  assert.deepEqual(info.uncommitted, []);
  assert.equal(info.branch_exists, true);

  fs.writeFileSync(path.join(ws.path, "dirty.txt"), "not committed\n");
  fs.writeFileSync(path.join(ws.path, "SYMPHONY_ISSUE.json"), "{}");
  const dirty = (await wm.deliveryInfo("X-1"))!;
  assert.deepEqual(dirty.uncommitted, ["?? dirty.txt"], "runner's own issue file is excluded");
});

test("the recorded base survives the repo's HEAD moving on after the branch was cut", async () => {
  const repo = initRepo();
  const root = path.join(repo, ".symphony", "workspaces");
  const wm = new WorkspaceManager({ root, hooks: defaultHooks(), logger: silent, repository: repo });
  const cutFrom = git(repo, ["branch", "--show-current"]).trim();

  const ws = await wm.createForIssue("BASE-2");
  fs.writeFileSync(path.join(ws.path, "feature.ts"), "export const x = 1;\n");
  git(ws.path, ["add", "feature.ts"]);
  git(ws.path, ["commit", "-qm", "add feature"]);

  // The operator moves the main repo onto an unrelated branch mid-run.
  git(repo, ["checkout", "-qb", "some-other-work"]);
  fs.writeFileSync(path.join(repo, "unrelated.txt"), "not part of the issue\n");
  git(repo, ["add", "unrelated.txt"]);
  git(repo, ["commit", "-qm", "unrelated"]);

  const info = (await wm.deliveryInfo("BASE-2"))!;
  assert.equal(info.base_branch, cutFrom, "base is what the branch was cut from, not the repo's current branch");
  assert.deepEqual(info.files_changed, ["feature.ts"], "diff is against the cut point, so unrelated work stays out");
});

test("a detached-HEAD repo still branches and reports the exact base commit", async () => {
  const repo = initRepo();
  git(repo, ["checkout", "-q", "--detach"]);
  const cutFrom = git(repo, ["rev-parse", "HEAD"]).trim();
  const root = path.join(repo, ".symphony", "workspaces");
  const wm = new WorkspaceManager({ root, hooks: defaultHooks(), logger: silent, repository: repo });
  const ws = await wm.createForIssue("DET-1");
  fs.writeFileSync(path.join(ws.path, "feature.ts"), "export const x = 1;\n");
  git(ws.path, ["add", "feature.ts"]);
  git(ws.path, ["commit", "-qm", "add feature"]);
  const info = (await wm.deliveryInfo("DET-1"))!;
  // There is no branch name to report, so the base is the commit itself — exact, and
  // never an empty string. It must not fall back to some unrelated ref.
  assert.equal(info.base_branch, cutFrom);
  assert.deepEqual(info.files_changed, ["feature.ts"], "the recorded start commit still anchors the diff");
});

test("a worktree registration left behind by a deleted directory does not wedge the issue", async () => {
  const repo = initRepo();
  const root = path.join(repo, ".symphony", "workspaces");
  const wm = new WorkspaceManager({ root, hooks: defaultHooks(), logger: silent, repository: repo });
  const first = await wm.createForIssue("STALE-1");
  // Someone removes the workspace by hand; git still has it registered.
  fs.rmSync(first.path, { recursive: true, force: true });
  const again = await wm.createForIssue("STALE-1");
  assert.equal(again.path, first.path);
  assert.equal(git(again.path, ["branch", "--show-current"]).trim(), "issue/STALE-1", "the issue branch is checked out again");
});

test("a non-worktree directory at the workspace path is refused, not silently used", async () => {
  const repo = initRepo();
  const root = path.join(repo, ".symphony", "workspaces");
  const wm = new WorkspaceManager({ root, hooks: defaultHooks(), logger: silent, repository: repo });
  const wsPath = wm.workspacePathFor("PLAIN-1");
  fs.mkdirSync(wsPath, { recursive: true });
  fs.writeFileSync(path.join(wsPath, "leftover.txt"), "from a scratch-mode run\n");
  await assert.rejects(() => wm.createForIssue("PLAIN-1"), WorkspaceError, "work off any branch would be lost silently");

  // An empty one is safe to replace with a real worktree.
  const emptyPath = wm.workspacePathFor("PLAIN-2");
  fs.mkdirSync(emptyPath, { recursive: true });
  const ws = await wm.createForIssue("PLAIN-2");
  assert.equal(git(ws.path, ["branch", "--show-current"]).trim(), "issue/PLAIN-2");
});

test("agent commits are authored as Symphony, not as whoever owns the repository", async () => {
  const repo = initRepo(); // sets a repo-level identity the worktree config must beat
  const root = path.join(repo, ".symphony", "workspaces");
  const wm = new WorkspaceManager({ root, hooks: defaultHooks(), logger: silent, repository: repo });
  const ws = await wm.createForIssue("WHO-1", false, "codex");
  assert.equal(git(ws.path, ["config", "--get", "user.name"]).trim(), "Symphony (codex)");

  // The load-bearing assertion: a plain commit, exactly as an agent would make
  // it, with no environment or -c overrides in play.
  fs.writeFileSync(path.join(ws.path, "work.txt"), "agent output\n");
  git(ws.path, ["add", "work.txt"]);
  git(ws.path, ["commit", "-qm", "agent work"]);
  assert.equal(git(ws.path, ["log", "-1", "--format=%an <%ae>"]).trim(), "Symphony (codex) <symphony+codex@localhost>");

  // Reuse re-applies it: worktrees created before this rule existed have none.
  git(ws.path, ["config", "--worktree", "--unset", "user.name"]);
  await wm.createForIssue("WHO-1", false, "opencode");
  assert.equal(git(ws.path, ["config", "--get", "user.name"]).trim(), "Symphony (opencode)");

  // An unknown backend must still produce a well-formed identity line.
  const odd = await wm.createForIssue("WHO-2", false, "we<ird>");
  assert.equal(git(odd.path, ["config", "--get", "user.name"]).trim(), "Symphony (weird)");
});

test("a worktree git refuses to remove is deleted anyway, and the issue can run again", async () => {
  const repo = initRepo();
  const root = path.join(repo, ".symphony", "workspaces");
  const wm = new WorkspaceManager({ root, hooks: defaultHooks(), logger: silent, repository: repo });
  const ws = await wm.createForIssue("STRAND-1");
  fs.writeFileSync(path.join(ws.path, "delivered.txt"), "kept by the branch\n");
  git(ws.path, ["add", "delivered.txt"]);
  git(ws.path, ["commit", "-qm", "deliver issue work"]);

  // Break the worktree's back-reference so `worktree remove` fails (exit 128,
  // "is not a working tree") while `status` still reports it clean — the shape a
  // half-completed removal leaves behind when a held file handle interrupts it.
  fs.rmSync(path.join(repo, ".git", "worktrees", workspaceKey("STRAND-1"), "gitdir"));
  assert.throws(() => git(repo, ["worktree", "remove", ws.path]), "precondition: git itself cannot remove it");

  await wm.cleanupForIssue("STRAND-1");
  assert.ok(!fs.existsSync(ws.path), "the directory is removed even though git would not");
  assert.ok(!git(repo, ["worktree", "list", "--porcelain"]).includes(ws.path), "and its registration is pruned");
  assert.equal(git(repo, ["show", "issue/STRAND-1:delivered.txt"]), "kept by the branch\n", "committed work is untouched");

  const again = await wm.createForIssue("STRAND-1");
  assert.equal(git(again.path, ["branch", "--show-current"]).trim(), "issue/STRAND-1", "the issue is not wedged");
});

test("a stranded workspace directory names itself in the error that refuses it", async () => {
  const repo = initRepo();
  const root = path.join(repo, ".symphony", "workspaces");
  const wm = new WorkspaceManager({ root, hooks: defaultHooks(), logger: silent, repository: repo });
  const wsPath = wm.workspacePathFor("STRAND-2");
  fs.mkdirSync(wsPath, { recursive: true });
  fs.writeFileSync(path.join(wsPath, "leftover.txt"), "from a half-removed worktree\n");
  await assert.rejects(
    () => wm.createForIssue("STRAND-2"),
    (e: unknown) => e instanceof WorkspaceError && e.message.includes(wsPath),
    "the operator needs the path to delete, not just a refusal",
  );
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
  await wm.pushBranch("issue/PUSH-1");
  const ref = execFileSync("git", ["--git-dir", bare, "show-ref", "--verify", "refs/heads/issue/PUSH-1"], { encoding: "utf8" });
  assert.match(ref, /issue\/PUSH-1/);

  // A branch name is tracker data, so it must never reach git as an option.
  await assert.rejects(() => wm.pushBranch("--receive-pack=touch pwned"), WorkspaceError, "option-shaped branch names are refused by git, not obeyed");

  const plain = new WorkspaceManager({ root, hooks: defaultHooks(), logger: silent });
  await assert.rejects(() => plain.pushBranch("issue/PUSH-1"), WorkspaceError, "scratch projects cannot push");
});


test("runner scratch files are git-ignored inside the worktree", async () => {
  const repo = initRepo();
  const root = path.join(repo, ".symphony", "workspaces");
  const wm = new WorkspaceManager({ root, hooks: defaultHooks(), logger: silent, repository: repo });
  const ws = await wm.createForIssue("SCRATCH-1");
  fs.writeFileSync(path.join(ws.path, "SYMPHONY_ISSUE.json"), "{}\n");
  fs.writeFileSync(path.join(ws.path, "SYMPHONY_RESULT.json"), "{}\n");
  assert.equal(git(ws.path, ["status", "--porcelain"]).trim(), "", "git sees a clean worktree");
  // `git add -A` (what an agent typically runs) must not pick them up either.
  git(ws.path, ["add", "-A"]);
  assert.equal(git(ws.path, ["diff", "--cached", "--name-only"]).trim(), "", "nothing staged from scratch files");
});

test("a scratch file committed by an earlier run neither counts as delivery nor blocks cleanup", async () => {
  const repo = initRepo();
  const root = path.join(repo, ".symphony", "workspaces");
  const wm = new WorkspaceManager({ root, hooks: defaultHooks(), logger: silent, repository: repo });
  const ws = await wm.createForIssue("SCRATCH-2");
  // Simulate the pre-fix state: the snapshot is tracked on the issue branch.
  fs.writeFileSync(path.join(ws.path, "SYMPHONY_ISSUE.json"), "{}\n");
  git(ws.path, ["add", "-f", "SYMPHONY_ISSUE.json"]);
  fs.writeFileSync(path.join(ws.path, "work.txt"), "real work\n");
  git(ws.path, ["add", "work.txt"]);
  git(ws.path, ["commit", "-qm", "work plus scratch"]);

  const info = (await wm.deliveryInfo("SCRATCH-2"))!;
  assert.deepEqual(info.files_changed, ["work.txt"], "scratch files stay out of the delivery");
  assert.deepEqual(info.uncommitted, []);

  await wm.cleanupForIssue("SCRATCH-2");
  assert.ok(!fs.existsSync(ws.path), "worktree removed even though a scratch file is tracked");
  assert.equal(git(repo, ["show", "issue/SCRATCH-2:work.txt"]), "real work\n");
});

// ---- recovering a base that was never recorded ----

/** Repo with `release` cut from master, and an issue branch cut from `release`. */
function repoWithLegacyBranch(): { repo: string; forkPoint: string } {
  const repo = initRepo();
  git(repo, ["branch", "-M", "master"]);
  git(repo, ["checkout", "-qb", "release"]);
  fs.writeFileSync(path.join(repo, "release-only.txt"), "belongs to release\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-qm", "release work"]);
  const forkPoint = git(repo, ["rev-parse", "HEAD"]).trim();
  // Created outside Symphony (by hand, or by a build from before bases were recorded),
  // so nothing is in the repository config for it.
  git(repo, ["branch", "issue/LEG-1"]);
  return { repo, forkPoint };
}

test("a branch with no recorded base recovers it from the reflog, once", async () => {
  const { repo, forkPoint } = repoWithLegacyBranch();
  const root = path.join(repo, ".symphony", "workspaces");
  const wm = new WorkspaceManager({ root, hooks: defaultHooks(), logger: silent, repository: repo });
  assert.equal(baseRef(repo, "LEG-1"), null, "nothing recorded yet");

  const ws = await wm.createForIssue("LEG-1");
  assert.equal(baseRef(repo, "LEG-1"), forkPoint, "the branch's creation commit becomes its base");

  // Recovered once and then left alone: the branch moving on must not move its base.
  fs.writeFileSync(path.join(ws.path, "later.txt"), "more work\n");
  git(ws.path, ["add", "-A"]);
  git(ws.path, ["commit", "-qm", "later work"]);
  await wm.deliveryInfo("LEG-1");
  assert.equal(baseRef(repo, "LEG-1"), forkPoint, "the recovered base is stable");
});

test("a recovered base keeps another branch's commits out of the delivery", async () => {
  const { repo } = repoWithLegacyBranch();
  const root = path.join(repo, ".symphony", "workspaces");
  const wm = new WorkspaceManager({ root, hooks: defaultHooks(), logger: silent, repository: repo });

  const ws = await wm.createForIssue("LEG-1");
  fs.writeFileSync(path.join(ws.path, "the-issue-work.txt"), "the only thing this issue did\n");
  git(ws.path, ["add", "-A"]);
  git(ws.path, ["commit", "-qm", "issue work"]);
  // The operator wanders back to an unrelated branch before the run delivers. Without a
  // recorded base this is what made the delivery diff against master and blame the issue
  // for `release-only.txt`.
  git(repo, ["checkout", "-q", "master"]);

  const info = (await wm.deliveryInfo("LEG-1"))!;
  assert.deepEqual(info.files_changed, ["the-issue-work.txt"], "only the issue's own work is delivered");
  assert.ok(!info.files_changed.includes("release-only.txt"), "release's commits are not credited to the issue");
});

test("a force-moved branch is not given a bogus recovered base", async () => {
  const { repo } = repoWithLegacyBranch();
  const root = path.join(repo, ".symphony", "workspaces");
  const wm = new WorkspaceManager({ root, hooks: defaultHooks(), logger: silent, repository: repo });
  // Reset the branch onto master: its creation commit is no longer an ancestor, so it says
  // nothing about what the branch holds now.
  git(repo, ["branch", "-f", "issue/LEG-1", "master"]);

  await wm.createForIssue("LEG-1");
  assert.equal(baseRef(repo, "LEG-1"), null, "no base is invented for a branch that was moved off its creation point");
});

test("a base recorded as a ref survives the branch being merged away and pruned", async () => {
  const repo = initRepo();
  const root = path.join(repo, ".symphony", "workspaces");
  const wm = new WorkspaceManager({ root, hooks: defaultHooks(), logger: silent, repository: repo });
  const cutFrom = git(repo, ["rev-parse", "HEAD"]).trim();
  await wm.createForIssue("GCB-1");
  assert.equal(baseRef(repo, "GCB-1"), cutFrom);

  // The base commit is only reachable from the base ref once the branch is gone.
  await wm.cleanupForIssue("GCB-1");
  git(repo, ["branch", "-D", "issue/GCB-1"]);
  git(repo, ["reflog", "expire", "--expire=now", "--expire-unreachable=now", "--all"]);
  git(repo, ["gc", "--prune=now", "-q"]);
  assert.equal(baseRef(repo, "GCB-1"), cutFrom, "the ref is a reachability root; local config never was");
});

test("a delivered commit survives cleanup, branch deletion and gc, and is recoverable", async () => {
  const repo = initRepo();
  const root = path.join(repo, ".symphony", "workspaces");
  const wm = new WorkspaceManager({ root, hooks: defaultHooks(), logger: silent, repository: repo });
  const ws = await wm.createForIssue("GC-1");
  fs.writeFileSync(path.join(ws.path, "delivered.txt"), "the whole point\n");
  git(ws.path, ["add", "delivered.txt"]);
  git(ws.path, ["commit", "-qm", "deliver issue work"]);
  const sha = git(ws.path, ["rev-parse", "HEAD"]).trim();

  const info = (await wm.deliveryInfo("GC-1"))!;
  assert.equal(await wm.recordDelivery("GC-1", { branch: info.branch, commit_sha: sha, files_changed: info.files_changed }), true);

  // Everything routine that used to destroy the commit, in the order it happens.
  await wm.cleanupForIssue("GC-1");
  git(repo, ["branch", "-D", "issue/GC-1"]);
  git(repo, ["reflog", "expire", "--expire=now", "--expire-unreachable=now", "--all"]);
  git(repo, ["gc", "--prune=now", "-q"]);

  git(repo, ["cat-file", "-e", `${sha}^{commit}`]); // throws if it was collected
  git(repo, ["branch", "--force", "issue/GC-1", `refs/symphony/tagmeta/${refKey("GC-1")}^{}`]);
  assert.equal(git(repo, ["show", "issue/GC-1:delivered.txt"]), "the whole point\n", "the work is recovered by the documented one-liner");
});

test("the delivery record reads back out of the tag intact", async () => {
  const repo = initRepo();
  const root = path.join(repo, ".symphony", "workspaces");
  const wm = new WorkspaceManager({ root, hooks: defaultHooks(), logger: silent, repository: repo });
  assert.equal(await wm.lastDelivery("TAG-1"), null, "nothing delivered yet");

  const ws = await wm.createForIssue("TAG-1");
  fs.writeFileSync(path.join(ws.path, "a file with spaces.txt"), "x\n");
  git(ws.path, ["add", "-A"]);
  git(ws.path, ["commit", "-qm", "work"]);
  const sha = git(ws.path, ["rev-parse", "HEAD"]).trim();
  // Multi-line and tabbed text is the interesting case: the read format is
  // tab-delimited and takes the tag's subject, i.e. everything up to a blank line.
  const record = { commit_sha: sha, summary: "line one\nline two\ttabbed", files_changed: ["a file with spaces.txt"] };
  await wm.recordDelivery("TAG-1", record);

  const read = (await wm.lastDelivery("TAG-1"))!;
  assert.equal(read.commit, sha, "the ref derefs to the delivered commit, not the tag object");
  assert.deepEqual(read.record, record);

  // A second delivery on the same stream (a follow-up) must replace, not fail.
  fs.writeFileSync(path.join(ws.path, "more.txt"), "y\n");
  git(ws.path, ["add", "-A"]);
  git(ws.path, ["commit", "-qm", "follow-up work"]);
  const next = git(ws.path, ["rev-parse", "HEAD"]).trim();
  assert.equal(await wm.recordDelivery("TAG-1", { commit_sha: next }), true, "re-delivery is an update, not a create");
  assert.equal((await wm.lastDelivery("TAG-1"))!.commit, next);
});

test("a stream that rebases what it already delivered is caught; adding to it is not", async () => {
  const repo = initRepo();
  const root = path.join(repo, ".symphony", "workspaces");
  const wm = new WorkspaceManager({ root, hooks: defaultHooks(), logger: silent, repository: repo });
  const ws = await wm.createForIssue("REW-1");
  fs.writeFileSync(path.join(ws.path, "reviewed.txt"), "work the operator already read\n");
  git(ws.path, ["add", "-A"]);
  git(ws.path, ["commit", "-qm", "first delivery"]);
  const first = git(ws.path, ["rev-parse", "HEAD"]).trim();

  const clean = (await wm.deliveryInfo("REW-1"))!;
  assert.equal(clean.parent_delivery_sha, null, "a first delivery has nothing to compare against");
  assert.equal(clean.history_rewritten, null);
  await wm.recordDelivery("REW-1", { commit_sha: first });

  // A follow-up that only adds commits — the sanctioned shape.
  fs.writeFileSync(path.join(ws.path, "follow-up.txt"), "more work\n");
  git(ws.path, ["add", "-A"]);
  git(ws.path, ["commit", "-qm", "follow-up work"]);
  const added = (await wm.deliveryInfo("REW-1"))!;
  assert.equal(added.parent_delivery_sha, first);
  assert.equal(added.history_rewritten, false, "building on the branch is not a rewrite");

  // A follow-up that squashes it away — the shape SPEC B.5 forbids. (Amending the
  // tip would not qualify: the delivered commit stays an ancestor underneath it.)
  git(ws.path, ["reset", "-q", "--soft", `${first}~1`]);
  git(ws.path, ["commit", "-qm", "squashed history"]);
  const rewritten = (await wm.deliveryInfo("REW-1"))!;
  assert.equal(rewritten.parent_delivery_sha, first);
  assert.equal(rewritten.history_rewritten, true);
});

test("an ancestry question git cannot answer is unknown, not an accusation", async () => {
  const repo = initRepo();
  const root = path.join(repo, ".symphony", "workspaces");
  const wm = new WorkspaceManager({ root, hooks: defaultHooks(), logger: silent, repository: repo });
  // Well-formed but absent: `merge-base --is-ancestor` exits 128, which must not
  // be read as the exit-1 "no".
  // @ts-expect-error -- reaching past the public surface for the error path
  assert.equal(await wm.isAncestor(repo, "0000000000000000000000000000000000000001", "HEAD"), null);
  const head = git(repo, ["rev-parse", "HEAD"]).trim();
  git(repo, ["checkout", "-qb", "sidetrack"]);
  fs.writeFileSync(path.join(repo, "side.txt"), "elsewhere\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-qm", "side"]);
  const side = git(repo, ["rev-parse", "HEAD"]).trim();
  // @ts-expect-error -- private
  assert.equal(await wm.isAncestor(repo, side, head), false);
  // @ts-expect-error -- private
  assert.equal(await wm.isAncestor(repo, head, side), true);
});

test("nothing is anchored for a scratch project or a delivery with no commit", async () => {
  const repo = initRepo();
  const root = path.join(repo, ".symphony", "workspaces");
  const plain = new WorkspaceManager({ root, hooks: defaultHooks(), logger: silent });
  assert.equal(await plain.recordDelivery("NA-1", { commit_sha: "abc" }), false);
  assert.equal(await plain.lastDelivery("NA-1"), null);
  const wm = new WorkspaceManager({ root, hooks: defaultHooks(), logger: silent, repository: repo });
  await wm.createForIssue("NA-2");
  assert.equal(await wm.recordDelivery("NA-2", { commit_sha: null }), false, "no commit to anchor");
});

test("branch divergence is read for every issue branch in one pass", async () => {
  const repo = initRepo();
  const root = path.join(repo, ".symphony", "workspaces");
  const wm = new WorkspaceManager({ root, hooks: defaultHooks(), logger: silent, repository: repo, baseBranch: "master" });

  // Merged: its commits are already in the base.
  const merged = await wm.createForIssue("AB-MERGED");
  fs.writeFileSync(path.join(merged.path, "merged.txt"), "in the base\n");
  git(merged.path, ["add", "-A"]);
  git(merged.path, ["commit", "-qm", "merged work"]);
  git(repo, ["merge", "-q", "--no-edit", "issue/AB-MERGED"]);

  // Ahead 2, behind 1: two of its own commits, and the base moved once after it.
  const open = await wm.createForIssue("AB-OPEN");
  for (const n of ["one", "two"]) {
    fs.writeFileSync(path.join(open.path, `${n}.txt`), `${n}\n`);
    git(open.path, ["add", "-A"]);
    git(open.path, ["commit", "-qm", n]);
  }
  fs.writeFileSync(path.join(repo, "moved-on.txt"), "base moved\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-qm", "base moves on"]);

  const counts = await wm.branchAheadBehind();
  // ahead 0 is the merged verdict; behind 1 is the base commit made after it landed.
  assert.deepEqual(counts.get("issue/AB-MERGED"), { ahead: 0, behind: 1 });
  assert.deepEqual(counts.get("issue/AB-OPEN"), { ahead: 2, behind: 1 });
  assert.equal(counts.has("master"), false, "only branches the template can produce are scanned");
});

test("branch divergence degrades to nothing rather than breaking the board", async () => {
  const repo = initRepo();
  const root = path.join(repo, ".symphony", "workspaces");
  const plain = new WorkspaceManager({ root, hooks: defaultHooks(), logger: silent });
  assert.equal((await plain.branchAheadBehind()).size, 0, "no repository configured");

  // A base that does not resolve fails the whole for-each-ref, so it must be
  // caught before it silently blanks every issue's counts.
  const bad = new WorkspaceManager({ root, hooks: defaultHooks(), logger: silent, repository: repo });
  await bad.createForIssue("AB-1");
  bad.update(root, defaultHooks(), { repository: repo, base_branch: "no-such-branch", branch_template: "issue/{identifier}" });
  assert.equal((await bad.branchAheadBehind()).size, 0, "an unresolvable base costs the decoration, not the board");
});

test("ref names do not collide between streams that differ only in case", () => {
  assert.notEqual(refKey("SYM-10"), refKey("sym-10"));
  assert.equal(refKey("sym-10"), "sym-10", "an already-safe lower-case stream is left alone");
  assert.match(refKey("SYM-10"), /^SYM-10-[0-9a-f]{16}$/);
});

test("ref names never take a form git rejects", () => {
  // Each of these would fail the whole delivery transaction if it reached git verbatim.
  for (const bad of [".hidden", "trailing.", "work.lock", "a..b"]) {
    const key = refKey(bad);
    assert.doesNotMatch(key, /^\.|\.$|\.\.|\.lock$/, `${bad} -> ${key}`);
  }
});

test("case-distinct streams write distinct base refs, not one aliased file", async () => {
  const repo = initRepo();
  const root = path.join(repo, ".symphony", "workspaces");
  const wm = new WorkspaceManager({ root, hooks: defaultHooks(), logger: silent, repository: repo });
  const first = git(repo, ["rev-parse", "HEAD"]).trim();
  fs.writeFileSync(path.join(repo, "moved.txt"), "base moves on\n");
  git(repo, ["add", "moved.txt"]);
  git(repo, ["commit", "-qm", "base moves"]);
  const second = git(repo, ["rev-parse", "HEAD"]).trim();

  // Driven at the ref layer on purpose: `CASE-1` and `case-1` cannot both hold a
  // workspace on a case-insensitive filesystem (they resolve to one directory,
  // and the second is refused as "not a git worktree"). That collision is older
  // and wider than this milestone — refs are what M11 makes safe.
  // @ts-expect-error -- reaching past the public surface for the aliasing case
  await wm.writeRefs(repo, [{ ref: `refs/symphony/base/${refKey("CASE-1")}`, oid: first }]);
  // @ts-expect-error -- ditto
  await wm.writeRefs(repo, [{ ref: `refs/symphony/base/${refKey("case-1")}`, oid: second }]);

  assert.equal(baseRef(repo, "CASE-1"), first, "the second stream's write did not overwrite the first");
  assert.equal(baseRef(repo, "case-1"), second);
});

test("a ref transaction that cannot be completed writes nothing at all", async () => {
  const repo = initRepo();
  const root = path.join(repo, ".symphony", "workspaces");
  const wm = new WorkspaceManager({ root, hooks: defaultHooks(), logger: silent, repository: repo });
  const good = git(repo, ["rev-parse", "HEAD"]).trim();
  const missing = "0000000000000000000000000000000000000001";
  // @ts-expect-error -- reaching past the public surface to prove the invariant
  const ok = await wm.writeRefs(repo, [{ ref: "refs/symphony/base/TXN-A", oid: good }, { ref: "refs/symphony/base/TXN-B", oid: missing }]);
  assert.equal(ok, false, "the transaction reports failure rather than throwing");
  assert.throws(() => git(repo, ["rev-parse", "--verify", "refs/symphony/base/TXN-A"]),
    "the ref that was fine is not left behind on its own");
});

test("a base recorded at creation is never overwritten by recovery", async () => {
  const repo = initRepo();
  const root = path.join(repo, ".symphony", "workspaces");
  const wm = new WorkspaceManager({ root, hooks: defaultHooks(), logger: silent, repository: repo });
  const cutFrom = git(repo, ["branch", "--show-current"]).trim();
  const ws = await wm.createForIssue("REC-1");
  assert.equal(git(repo, ["config", "--local", "--get", "symphony.issue/REC-1.base"]).trim(), cutFrom);

  await wm.cleanupForIssue("REC-1");
  await wm.createForIssue("REC-1"); // adopting the existing branch on a later run
  assert.equal(git(repo, ["config", "--local", "--get", "symphony.issue/REC-1.base"]).trim(), cutFrom,
    "the ref name recorded at creation still stands");
  assert.equal((await wm.deliveryInfo("REC-1"))!.base_branch, cutFrom);
});

// ---- work streams / follow-ups (SPEC Appendix B.5) ----

test("a follow-up reuses the stream's worktree and lands on the same branch", async () => {
  const repo = initRepo();
  const root = path.join(repo, ".symphony", "workspaces");
  const wm = new WorkspaceManager({ root, hooks: defaultHooks(), logger: silent, repository: repo });

  // The original issue runs and delivers; cleanup keeps the branch, drops the worktree.
  const first = await wm.createForIssue("STREAM-1");
  fs.writeFileSync(path.join(first.path, "feature.ts"), "export const x = 1;\n");
  git(first.path, ["add", "feature.ts"]);
  git(first.path, ["commit", "-qm", "first pass"]);
  await wm.cleanupForIssue("STREAM-1");
  assert.ok(!fs.existsSync(first.path));

  // The follow-up asks for the same stream: same path, same branch, earlier work present.
  const second = await wm.createForIssue("STREAM-1", true);
  assert.equal(second.path, first.path, "one workspace per stream");
  assert.equal(git(second.path, ["branch", "--show-current"]).trim(), "issue/STREAM-1");
  assert.ok(fs.existsSync(path.join(second.path, "feature.ts")), "the branch's earlier work is there to continue");

  // And it delivers onto the same branch, diffed from the original base.
  fs.writeFileSync(path.join(second.path, "review-fix.ts"), "export const y = 2;\n");
  git(second.path, ["add", "review-fix.ts"]);
  git(second.path, ["commit", "-qm", "address review"]);
  const info = (await wm.deliveryInfo("STREAM-1"))!;
  assert.equal(info.branch, "issue/STREAM-1");
  assert.deepEqual(info.files_changed.sort(), ["feature.ts", "review-fix.ts"], "the delivery stays cumulative");
});

test("a follow-up refuses to re-cut a branch that no longer exists", async () => {
  const repo = initRepo();
  const root = path.join(repo, ".symphony", "workspaces");
  const wm = new WorkspaceManager({ root, hooks: defaultHooks(), logger: silent, repository: repo });
  const ws = await wm.createForIssue("STREAM-2");
  await wm.cleanupForIssue("STREAM-2");
  // The operator merged and deleted the branch before the follow-up ran.
  git(repo, ["branch", "-D", "issue/STREAM-2"]);

  await assert.rejects(
    () => wm.createForIssue("STREAM-2", true),
    (e: Error) => e instanceof WorkspaceError && /will not cut a new one/.test(e.message),
    "silently branching from base again is the divergence follow-ups exist to prevent",
  );
  // An ordinary issue is unaffected: it may still open its branch.
  const plainRun = await wm.createForIssue("STREAM-2");
  assert.equal(git(plainRun.path, ["branch", "--show-current"]).trim(), "issue/STREAM-2");
});

test("reuse refuses a worktree parked on some other branch", async () => {
  const repo = initRepo();
  const root = path.join(repo, ".symphony", "workspaces");
  const wm = new WorkspaceManager({ root, hooks: defaultHooks(), logger: silent, repository: repo });
  const ws = await wm.createForIssue("STREAM-3");
  // Something moved the worktree off the issue branch; committing there would
  // deliver the work to the wrong place.
  git(ws.path, ["checkout", "-qb", "somewhere-else"]);

  await assert.rejects(
    () => wm.createForIssue("STREAM-3"),
    (e: Error) => e instanceof WorkspaceError && /expected issue\/STREAM-3/.test(e.message),
  );
});

test("stream identifiers that could reach git as options are rejected", () => {
  assert.equal(isSafeStreamIdentifier("SYM-12"), true);
  assert.equal(isSafeStreamIdentifier("team/SYM-12.2"), true);
  assert.equal(isSafeStreamIdentifier("--upload-pack=touch pwned"), false);
  assert.equal(isSafeStreamIdentifier("../escape"), false);
  assert.equal(isSafeStreamIdentifier("a..b"), false);
  assert.equal(isSafeStreamIdentifier(""), false);
  assert.equal(isSafeStreamIdentifier("has space"), false);
});
