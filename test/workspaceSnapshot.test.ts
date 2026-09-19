/** Portable workspace snapshots (extension, issue #35). */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import {
  exportWorkspaceSnapshot,
  importWorkspaceSnapshot,
  stageWorkspaceSnapshot,
  validateWorkspaceSnapshot,
} from "../src/workspace/snapshot.ts";
import { createExecutionSession, supportsExecutionCapability } from "../src/execution/registry.ts";
import { Logger } from "../src/logger.ts";

const exec = promisify(execFile);
const silent = new Logger([{ name: "null", write() {} }], "error");
async function git(cwd: string, ...args: string[]) {
  return (await exec("git", ["-C", cwd, ...args], { encoding: "utf8" })).stdout.trimEnd();
}
async function root(t: TestContext) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sym-snapshot-test-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}
async function repo(dir: string) {
  await fs.mkdir(dir);
  await git(dir, "init", "-q", "-b", "main");
  await git(dir, "config", "user.name", "snapshot test");
  await git(dir, "config", "user.email", "snapshot@example.com");
  await git(dir, "config", "core.autocrlf", "false");
  await fs.writeFile(path.join(dir, "tracked.txt"), "base\n");
  await fs.writeFile(path.join(dir, "deleted.txt"), "delete me\n");
  await fs.writeFile(path.join(dir, ".gitignore"), "ignored/\n.env\n");
  await git(dir, "add", ".");
  await git(dir, "commit", "-qm", "base");
  return git(dir, "rev-parse", "HEAD");
}
function blob(text: string) {
  const data = Buffer.from(text);
  return { size: data.length, sha256: createHash("sha256").update(data).digest("hex"), data: data.toString("base64") };
}
function plain(entries: unknown[] = []) {
  return { version: 1, kind: "directory", entries, git: null };
}
function file(name = "file.txt", text = "content") {
  return { path: name, type: "file", mode: 0o644, content: blob(text) };
}

test("plain directories round-trip binary files, empty directories, and modes", async (t) => {
  const dir = await root(t);
  const source = path.join(dir, "source");
  await fs.mkdir(path.join(source, "empty"), { recursive: true });
  await fs.writeFile(path.join(source, "binary"), Buffer.from([0, 255, 13, 10]));
  await fs.writeFile(path.join(source, "run.sh"), "#!/bin/sh\n", { mode: 0o755 });
  const snapshot = await exportWorkspaceSnapshot(source);
  assert.equal(snapshot.version, 1);
  assert.equal(snapshot.kind, "directory");
  const destination = path.join(dir, "imported");
  await importWorkspaceSnapshot(destination, JSON.parse(JSON.stringify(snapshot)), { expectedBaseCommit: null });
  assert.deepEqual(await fs.readFile(path.join(destination, "binary")), Buffer.from([0, 255, 13, 10]));
  assert.deepEqual(await fs.readdir(path.join(destination, "empty")), []);
  if (process.platform !== "win32") assert.equal((await fs.stat(path.join(destination, "run.sh"))).mode & 0o777, 0o755);
});

test("Git worktrees round-trip history, the index, dirty files, deletions, and safe untracked files", async (t) => {
  const dir = await root(t);
  const sourceRepo = path.join(dir, "repo");
  const base = await repo(sourceRepo);
  const source = path.join(dir, "worktree");
  await git(sourceRepo, "worktree", "add", "-qb", "issue/snapshot", source);
  await fs.writeFile(path.join(source, "committed.txt"), "committed work\n");
  await git(source, "add", ".");
  await git(source, "commit", "-qm", "agent work");
  const head = await git(source, "rev-parse", "HEAD");
  await fs.writeFile(path.join(source, "tracked.txt"), "staged\n");
  await git(source, "add", "tracked.txt");
  await fs.writeFile(path.join(source, "tracked.txt"), "unstaged\n");
  await fs.rm(path.join(source, "deleted.txt"));
  await fs.writeFile(path.join(source, "new file.txt"), "untracked\n");
  await fs.writeFile(path.join(source, "staged new.bin"), Buffer.from([0, 255, 42]));
  await git(source, "add", "staged new.bin");
  await git(source, "update-index", "--chmod=+x", "committed.txt");
  await fs.mkdir(path.join(source, "ignored"));
  await fs.writeFile(path.join(source, "ignored", "secret"), "excluded");
  await fs.writeFile(path.join(source, ".env"), "secret");
  const before = await git(source, "status", "--porcelain=v1", "-z");
  const snapshot = await exportWorkspaceSnapshot(source, { baseCommit: base });
  assert.equal(snapshot.kind, "git");
  assert.equal(snapshot.git!.headCommit, head);
  assert.equal(snapshot.git!.baseCommit, base);
  assert.ok(snapshot.entries.every((entry) => !entry.path.split("/").includes(".git")));
  assert.ok(snapshot.entries.every((entry) => entry.path !== ".env" && !entry.path.startsWith("ignored")));
  assert.equal(await git(source, "status", "--porcelain=v1", "-z"), before, "export leaves the index and worktree intact");
  const destination = path.join(dir, "imported");
  await importWorkspaceSnapshot(destination, snapshot, { expectedBaseCommit: base });
  assert.ok((await fs.lstat(path.join(destination, ".git"))).isDirectory(), "no host .git pointer copied");
  assert.equal(await git(destination, "rev-parse", "HEAD"), head);
  assert.equal(await git(destination, "rev-parse", "HEAD~1"), base);
  assert.equal(await git(destination, "branch", "--show-current"), "issue/snapshot");
  assert.equal(await git(destination, "show", ":tracked.txt"), "staged");
  assert.equal(await fs.readFile(path.join(destination, "tracked.txt"), "utf8"), "unstaged\n");
  assert.equal(await git(destination, "diff", "--cached", "--binary"), await git(source, "diff", "--cached", "--binary"));
  assert.equal(await git(destination, "diff", "--binary"), await git(source, "diff", "--binary"));
  assert.equal(await fs.readFile(path.join(destination, "new file.txt"), "utf8"), "untracked\n");
  await assert.rejects(fs.stat(path.join(destination, "deleted.txt")), /ENOENT/);
  await git(destination, "fsck", "--strict");
});

test("Git snapshots normalize clean autocrlf files while preserving dirty working bytes", async (t) => {
  const dir = await root(t);
  const source = path.join(dir, "repo");
  const base = await repo(source);
  await git(source, "config", "core.autocrlf", "true");
  // `reset --hard` does not re-smudge files the index already considers
  // up-to-date, so remove them and re-checkout to get CRLF working bytes.
  for (const name of ["tracked.txt", "deleted.txt", ".gitignore"]) await fs.rm(path.join(source, name));
  await git(source, "checkout", "--", ".");
  assert.deepEqual(await fs.readFile(path.join(source, "tracked.txt")), Buffer.from("base\r\n"));
  assert.equal(await git(source, "status", "--porcelain"), "");

  await fs.writeFile(path.join(source, "tracked.txt"), Buffer.from("staged\r\n"));
  await git(source, "add", "tracked.txt");
  await fs.writeFile(path.join(source, "tracked.txt"), Buffer.from("unstaged\r\n"));
  await fs.writeFile(path.join(source, "untracked.txt"), Buffer.from("untracked\r\n"));
  const snapshot = await exportWorkspaceSnapshot(source);
  const destination = path.join(dir, "imported");
  await importWorkspaceSnapshot(destination, snapshot, { expectedBaseCommit: base });

  assert.deepEqual(await fs.readFile(path.join(destination, "tracked.txt")), Buffer.from("unstaged\r\n"));
  assert.deepEqual(await fs.readFile(path.join(destination, "untracked.txt")), Buffer.from("untracked\r\n"));
  assert.equal(await git(destination, "show", ":tracked.txt"), "staged");
  assert.equal(await git(destination, "status", "--porcelain"), "MM tracked.txt\n?? untracked.txt");
  assert.deepEqual(await fs.readFile(path.join(destination, "deleted.txt")), Buffer.from("delete me\n"));
});

test("staging is independent and imports refuse to overwrite the only local copy", async (t) => {
  const dir = await root(t);
  const local = path.join(dir, "local");
  await fs.mkdir(local);
  await fs.writeFile(path.join(local, "keep"), "local work");
  const staged = await stageWorkspaceSnapshot(plain([file()]), dir, { expectedBaseCommit: null });
  assert.equal(await fs.readFile(path.join(staged.path, "file.txt"), "utf8"), "content");
  assert.equal(await fs.readFile(path.join(local, "keep"), "utf8"), "local work");
  await assert.rejects(importWorkspaceSnapshot(local, plain([file()]), { expectedBaseCommit: null }), /empty|exists/);
  await staged.dispose();
  await staged.dispose();
  await assert.rejects(fs.stat(staged.path), /ENOENT/);
});

test("imports into empty directories and local execution sessions support snapshot transfer", async (t) => {
  const dir = await root(t);
  const destination = path.join(dir, "empty");
  await fs.mkdir(destination);
  const session = await createExecutionSession("local", {}, { workspacePath: destination, env: process.env, logger: silent });
  assert.equal(supportsExecutionCapability("local", "workspace-snapshot"), true);
  await session.importSnapshot!(plain([file()]), { expectedBaseCommit: null });
  assert.equal(Buffer.from(await session.readFile!("file.txt")).toString(), "content");
  const snapshot = await session.exportSnapshot!();
  assert.equal(snapshot.entries.length, 1);
  await session.close();
  await assert.rejects(() => session.exportSnapshot!(), /closed/);
  await assert.rejects(() => session.importSnapshot!(snapshot, { expectedBaseCommit: null }), /closed/);
});

test("archive paths reject traversal, metadata, Windows aliases, and ambiguous trees", () => {
  for (const name of ["../escape", "/absolute", "C:/escape", "a\\b", "a//b", "a/./b", "a/../b", ".git/config", "a/.GIT/hooks", "git~1/config", "file:ads", "NUL", "COM1.txt", "LPT9", "trailing.", "trailing ", "a\u0000b", "bad\ud800"] ) {
    assert.throws(() => validateWorkspaceSnapshot(plain([file(name)]), { expectedBaseCommit: null }), /path/i, name);
  }
  for (const entries of [[file("a"), file("a")], [file("A"), file("a")], [file("a"), file("a/b")], [file("A/x"), file("a/y")]]) {
    assert.throws(() => validateWorkspaceSnapshot(plain(entries), { expectedBaseCommit: null }), /path|duplicate|collision|parent/i);
  }
});

test("links cannot escape, cycle, alias metadata, or serve as extraction parents", () => {
  const link = (name: string, target: string) => ({ path: name, type: "symlink", target });
  for (const target of ["../../escape", "/etc/passwd", "C:/secret", "..\\escape", ".git/config"]) {
    assert.throws(() => validateWorkspaceSnapshot(plain([link("link", target)]), { expectedBaseCommit: null }), /link|path/i);
  }
  assert.throws(() => validateWorkspaceSnapshot(plain([link("a", "b"), link("b", "a")]), { expectedBaseCommit: null }), /link|cycle/i);
  assert.throws(() => validateWorkspaceSnapshot(plain([link("a", "file"), file("a/child")]), { expectedBaseCommit: null }), /parent|path|link/i);
  assert.doesNotThrow(() => validateWorkspaceSnapshot(plain([file("file"), link("nested/link", "../file")]), { expectedBaseCommit: null }));
  assert.throws(() => validateWorkspaceSnapshot(plain([file("file"), link("link", ".git/../file")]), { expectedBaseCommit: null }), /link|path/i);
});

test("content hashes, sizes, modes, schema, and resource limits fail closed", () => {
  const validate = (snapshot: unknown, limits = {}) => validateWorkspaceSnapshot(snapshot, { expectedBaseCommit: null, limits });
  for (const value of [null, {}, { ...plain(), version: 2 }, { ...plain(), kind: "tar" }, plain([{ ...file(), type: "hardlink" }]), plain([{ ...file(), mode: 0o4755 }])]) {
    assert.throws(() => validate(value));
  }
  assert.throws(() => validate(plain([{ ...file(), content: { ...blob("content"), sha256: "0".repeat(64) } }])), /hash/i);
  assert.throws(() => validate(plain([{ ...file(), content: { ...blob("content"), size: 1 } }])), /size/i);
  assert.throws(() => validate(plain([{ ...file(), content: { ...blob("content"), data: "!!!!" } }])), /base64|content/i);
  assert.throws(() => validate(plain([file()]), { maxFileBytes: 2 }), /limit|size/i);
  assert.throws(() => validate(plain([file("a"), file("b")]), { maxEntries: 1 }), /limit/i);
  assert.throws(() => validate(plain([file("a/b/c")]), { maxEntries: 2 }), /limit/i);
  assert.throws(() => validate(plain([file("a"), file("b")]), { maxTotalBytes: 8 }), /limit/i);
  assert.throws(() => validate(plain([file()]), { maxSnapshotBytes: 8 }), /limit/i);
  assert.throws(() => validate(plain(), { maxEntries: -1 }), /limit/i);
});

test("wrong base, corrupt bundles, and malformed index patches leave destinations unchanged", async (t) => {
  const dir = await root(t);
  const source = path.join(dir, "repo");
  const base = await repo(source);
  const snapshot = await exportWorkspaceSnapshot(source, { baseCommit: base });
  const destination = path.join(dir, "destination");
  await fs.mkdir(destination);
  await assert.rejects(importWorkspaceSnapshot(destination, snapshot, { expectedBaseCommit: "0".repeat(40) }), /base/i);
  const badBundle = structuredClone(snapshot);
  badBundle.git!.bundle = blob("not a git bundle");
  await assert.rejects(importWorkspaceSnapshot(destination, badBundle, { expectedBaseCommit: base }), /bundle|git/i);
  const badPatch = structuredClone(snapshot);
  badPatch.git!.indexPatch = blob("not a patch");
  await assert.rejects(importWorkspaceSnapshot(destination, badPatch, { expectedBaseCommit: base }), /patch|git/i);
  assert.deepEqual(await fs.readdir(destination), []);
  assert.deepEqual((await fs.readdir(dir)).sort(), ["destination", "repo"], "failed staging is removed");
  await assert.rejects(exportWorkspaceSnapshot(source, { baseCommit: "0".repeat(40) }), /base|git/i);
});

test("export rejects nested repositories, hard links, and uncommitted Git repositories", async (t) => {
  const dir = await root(t);
  const source = path.join(dir, "plain");
  await fs.mkdir(source);
  await fs.writeFile(path.join(source, "original"), "work");
  await fs.link(path.join(source, "original"), path.join(source, "alias"));
  await assert.rejects(exportWorkspaceSnapshot(source), /link/i);
  await fs.rm(path.join(source, "alias"));
  await fs.mkdir(path.join(source, "nested", ".git"), { recursive: true });
  await assert.rejects(exportWorkspaceSnapshot(source), /git|metadata|path/i);
  const unborn = path.join(dir, "unborn");
  await fs.mkdir(unborn);
  await git(unborn, "init", "-q");
  await assert.rejects(exportWorkspaceSnapshot(unborn), /commit|HEAD|git/i);
});

test("safe relative symlinks round-trip and escaping source links are never followed", { skip: process.platform === "win32" }, async (t) => {
  const dir = await root(t);
  const source = path.join(dir, "source");
  await fs.mkdir(path.join(source, "nested"), { recursive: true });
  await fs.writeFile(path.join(source, "target"), "kept");
  await fs.symlink("../target", path.join(source, "nested", "link"));
  const snapshot = await exportWorkspaceSnapshot(source);
  const destination = path.join(dir, "destination");
  await importWorkspaceSnapshot(destination, snapshot, { expectedBaseCommit: null });
  assert.equal(await fs.readlink(path.join(destination, "nested", "link")), "../target");
  await fs.symlink("../../outside", path.join(source, "escape"));
  await assert.rejects(exportWorkspaceSnapshot(source), /link|path/i);
});

test("read-only modes can be staged, verified, and disposed", { skip: process.platform === "win32" }, async (t) => {
  const dir = await root(t);
  const staged = await stageWorkspaceSnapshot(plain([
    { path: "readonly", type: "directory", mode: 0o500 },
    { ...file("readonly/no-access"), mode: 0o000 },
  ]), dir, { expectedBaseCommit: null });
  assert.equal((await fs.stat(path.join(staged.path, "readonly", "no-access"))).mode & 0o777, 0);
  await staged.dispose();
  await assert.rejects(fs.stat(staged.path), /ENOENT/);
});

test("snapshot operations exclude concurrent mutations and close waits for an import", async (t) => {
  const dir = await root(t);
  const destination = path.join(dir, "session");
  await fs.mkdir(destination);
  const session = await createExecutionSession("local", {}, { workspacePath: destination, env: process.env, logger: silent });
  const pending = session.importSnapshot!(plain([file()]), { expectedBaseCommit: null });
  // Attach handlers immediately: no unhandled rejection if an assertion fails.
  const settled = pending.catch((error) => error);
  try {
    await assert.rejects(() => session.writeFile!("racing-write", "no"), /snapshot/);
    await assert.rejects(() => session.removeFile!("file.txt"), /snapshot/);
    await assert.rejects(() => session.spawn!("node --version"), /snapshot/);
    await assert.rejects(() => session.exportSnapshot!(), /snapshot/);
    await session.close();
    assert.equal(await settled, undefined);
    assert.equal(await fs.readFile(path.join(destination, "file.txt"), "utf8"), "content");
  } finally { await settled; await session.close(); }
});

test("detached Git HEAD, staged deletion, and binary index changes survive a round-trip", async (t) => {
  const dir = await root(t);
  const source = path.join(dir, "repo");
  const base = await repo(source);
  await git(source, "checkout", "--detach", "-q");
  await git(source, "rm", "-q", "deleted.txt");
  await fs.writeFile(path.join(source, "tracked.txt"), Buffer.from([0, 255, 27]));
  await git(source, "add", "tracked.txt");
  const snapshot = await exportWorkspaceSnapshot(source);
  const dest = path.join(dir, "dest");
  await importWorkspaceSnapshot(dest, snapshot, { expectedBaseCommit: base });
  assert.equal(await git(dest, "branch", "--show-current"), "");
  assert.equal(await git(dest, "diff", "--cached", "--binary"), await git(source, "diff", "--cached", "--binary"));
  await assert.rejects(exportWorkspaceSnapshot(source, { limits: { maxEntries: 1 } }), /limit/);
  await assert.rejects(exportWorkspaceSnapshot(source, { limits: { maxFileBytes: 2 } }), /limit/);
});

test("Git validation checks bundle HEAD and actual ancestry rather than trusting labels", async (t) => {
  const dir = await root(t);
  const source = path.join(dir, "repo");
  const base = await repo(source);
  const snapshot = await exportWorkspaceSnapshot(source);
  const wrongHead = structuredClone(snapshot);
  wrongHead.git!.headCommit = "0".repeat(40);
  await assert.rejects(stageWorkspaceSnapshot(wrongHead, dir, { expectedBaseCommit: base }), /HEAD/);
  const wrongBase = structuredClone(snapshot);
  wrongBase.git!.baseCommit = "0".repeat(40);
  await assert.rejects(stageWorkspaceSnapshot(wrongBase, dir, { expectedBaseCommit: "0".repeat(40) }), /git|base/);
  // Historical bytes also count, even if no large file remains in the workspace.
  await fs.writeFile(path.join(source, "large"), "x".repeat(100_000));
  await git(source, "add", "large");
  await git(source, "commit", "-qm", "large historical blob");
  await git(source, "rm", "large");
  await git(source, "commit", "-qm", "remove large blob");
  const history = await exportWorkspaceSnapshot(source);
  await assert.rejects(stageWorkspaceSnapshot(history, dir, { expectedBaseCommit: history.git!.baseCommit, limits: { maxFileBytes: 4096 } }), /object size|limit/);
});

test("export rejects intent-to-add instead of silently losing its index state", async (t) => {
  const dir = await root(t);
  const source = path.join(dir, "repo");
  await repo(source);
  await fs.writeFile(path.join(source, "intent"), "new work");
  await git(source, "add", "-N", "intent");
  await assert.rejects(exportWorkspaceSnapshot(source), /intent-to-add/);
});

test("Git symlink placeholders export as portable links when core.symlinks is false", async (t) => {
  const dir = await root(t);
  const source = path.join(dir, "repo");
  await repo(source);
  await git(source, "config", "core.symlinks", "false");
  await fs.writeFile(path.join(source, "link"), "tracked.txt");
  const hash = await git(source, "hash-object", "-w", "link");
  await git(source, "update-index", "--add", "--cacheinfo", `120000,${hash},link`);
  await git(source, "commit", "-qm", "portable symlink");
  assert.equal(await git(source, "status", "--porcelain"), "");
  const snapshot = await exportWorkspaceSnapshot(source);
  assert.deepEqual(snapshot.entries.find((entry) => entry.path === "link"), { path: "link", type: "symlink", target: "tracked.txt" });
  if (process.platform !== "win32") {
    const dest = path.join(dir, "dest");
    await importWorkspaceSnapshot(dest, snapshot, { expectedBaseCommit: snapshot.git!.baseCommit });
    assert.equal(await fs.readlink(path.join(dest, "link")), "tracked.txt");
    assert.equal(await git(dest, "status", "--porcelain"), "");
  }
});

test("Git roots with unmerged indexes and submodules fail explicitly", async (t) => {
  const dir = await root(t);
  const source = path.join(dir, "repo");
  const base = await repo(source);
  await git(source, "update-index", "--add", "--cacheinfo", `160000,${base},submodule`);
  await assert.rejects(exportWorkspaceSnapshot(source), /submodule/);
  await git(source, "reset", "--hard", "-q", base);
  await git(source, "checkout", "-qb", "side");
  await fs.writeFile(path.join(source, "tracked.txt"), "side\n");
  await git(source, "commit", "-qam", "side");
  await git(source, "checkout", "-q", "main");
  await fs.writeFile(path.join(source, "tracked.txt"), "main\n");
  await git(source, "commit", "-qam", "main");
  await assert.rejects(git(source, "merge", "side"));
  await assert.rejects(exportWorkspaceSnapshot(source), /unmerged/);
});

test("snapshot transfer refuses live processes and in-flight file writes", async (t) => {
  const dir = await root(t);
  const session = await createExecutionSession("local", {}, { workspacePath: dir, env: process.env, logger: silent });
  try {
    const write = session.writeFile!("busy", "work");
    await assert.rejects(() => session.exportSnapshot!(), /quiescent/);
    await write;
    const proc = await session.spawn!(process.platform === "win32" ? "ping -n 2 127.0.0.1 > NUL" : "exec sleep 1");
    await assert.rejects(() => session.exportSnapshot!(), /quiescent/);
    await proc.kill("SIGKILL");
  } finally { await session.close(); }
});
