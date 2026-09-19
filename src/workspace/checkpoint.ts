/** Host checkpoint journal and publication boundary (issue #32). */
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  exportWorkspaceSnapshot, stageWorkspaceSnapshot,
  type WorkspaceSnapshot, type StagedWorkspaceSnapshot,
} from "./snapshot.ts";

const exec = promisify(execFile);
async function git(cwd: string, ...args: string[]): Promise<string> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_")));
  return (await exec("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false",
    "-c", "core.longpaths=true", "-C", cwd, ...args], {
    env: { ...env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null" },
    encoding: "utf8", timeout: 60_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true,
  })).stdout.trimEnd();
}

const SCRATCH = new Set(["SYMPHONY_ISSUE.json", "SYMPHONY_RESULT.json"]);
function checkpointFiles(snapshot: WorkspaceSnapshot): WorkspaceSnapshot {
  return { ...snapshot, entries: snapshot.entries.filter((entry) => !SCRATCH.has(entry.path)) };
}
interface PendingResult {
  version: 1;
  issueId: string;
  result: string | null;
}
interface PendingSnapshot extends PendingResult {
  expected: WorkspaceSnapshot;
  snapshot: WorkspaceSnapshot;
  imported: boolean;
}
type PendingCheckpoint = PendingSnapshot | (PendingResult & { expected: null; snapshot: null; imported: true });

export class CheckpointRecoveryError extends Error {}

function equivalent(a: WorkspaceSnapshot, b: WorkspaceSnapshot): boolean {
  const facts = (s: WorkspaceSnapshot) => JSON.stringify({
    kind: s.kind, head: s.git?.headCommit, branch: s.git?.branch, index: s.git?.indexPatch.sha256,
    entries: checkpointFiles(s).entries.map((e) => e.type === "file"
      ? { ...e, content: { size: e.content.size, sha256: e.content.sha256 } }
      : process.platform === "win32" && e.type === "directory" ? { ...e, mode: 0 } : e)
      .sort((x, y) => x.path.localeCompare(y.path)),
  });
  return facts(a) === facts(b);
}

/** One stream owns this journal; the scheduler already excludes concurrent owners. */
export class WorkspaceCheckpoint {
  readonly workspacePath: string;
  readonly directory: string;
  /** True only after a verified snapshot has been written durably on the host. */
  saved = false;
  private retainStaging = false;
  constructor(workspacePath: string, directory: string) {
    this.workspacePath = workspacePath;
    this.directory = directory;
  }
  private get pendingPath(): string { return path.join(this.directory, "pending.json"); }

  async snapshot(): Promise<WorkspaceSnapshot> {
    return checkpointFiles(await exportWorkspaceSnapshot(this.workspacePath));
  }

  async saveResult(issueId: string, result: string): Promise<void> {
    await fs.mkdir(this.directory, { recursive: true });
    await this.write({ version: 1, issueId, expected: null, snapshot: null, result, imported: true });
  }

  async commit(issueId: string, expected: WorkspaceSnapshot, snapshot: WorkspaceSnapshot, result: string | null, signal?: AbortSignal): Promise<void> {
    await fs.mkdir(this.directory, { recursive: true });
    snapshot = checkpointFiles(snapshot);
    const staged = await stageWorkspaceSnapshot(snapshot, this.directory, { expectedBaseCommit: expected.git?.baseCommit ?? null });
    try {
      const pending: PendingSnapshot = { version: 1, issueId, expected, snapshot, result: signal?.aborted ? null : result, imported: false };
      await this.write(pending);
      this.saved = true;
      await this.publish(pending, staged);
    } finally {
      try { if (signal?.aborted && this.saved) await this.discardResult(); }
      finally { if (!this.retainStaging) await staged.dispose(); }
    }
  }

  async discardResult(): Promise<void> {
    const pending: PendingCheckpoint = JSON.parse(await fs.readFile(this.pendingPath, "utf8"));
    await this.write({ ...pending, result: null });
  }

  /** Replay import before retrying the tracker, never before starting another agent. */
  async recover(issueId: string): Promise<string | null> {
    try {
      const reason = await fs.readFile(path.join(this.directory, "recovery-required.txt"), "utf8");
      throw new CheckpointRecoveryError(reason);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    try {
      const retained = JSON.parse(await fs.readFile(path.join(this.directory, "runtime.json"), "utf8"));
      throw new CheckpointRecoveryError(`recover runtime ${retained.runtimeId ?? "(no provider id)"} (${retained.provider}); see ${this.directory}`);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    let pending: PendingCheckpoint;
    try { pending = JSON.parse(await fs.readFile(this.pendingPath, "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
    if (pending.version !== 1 || pending.issueId !== issueId) throw new Error("checkpoint belongs to another issue or has an unsupported version");
    this.saved = true;
    if (pending.imported && pending.snapshot) {
      const current = await exportWorkspaceSnapshot(this.workspacePath, pending.expected?.git ? { baseCommit: pending.expected.git.baseCommit } : {});
      if (!equivalent(current, pending.snapshot)) throw new Error("imported checkpoint no longer matches host workspace; result remains pending");
    } else if (!pending.imported) {
      const staged = await stageWorkspaceSnapshot(pending.snapshot, this.directory, { expectedBaseCommit: pending.expected.git?.baseCommit ?? null });
      try { await this.publish(pending, staged); }
      finally { if (!this.retainStaging) await staged.dispose(); }
    }
    return pending.result;
  }

  async acknowledge(): Promise<void> {
    try { await fs.rename(this.pendingPath, path.join(this.directory, "last.json")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }

  async hasPending(): Promise<boolean> {
    try { await fs.stat(path.join(this.directory, "runtime.json")); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    try { await fs.stat(this.pendingPath); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
  }

  async retainRuntime(provider: string, runtimeId: string | null): Promise<void> {
    await fs.mkdir(this.directory, { recursive: true });
    await fs.writeFile(path.join(this.directory, "runtime.json"), JSON.stringify({ provider, runtimeId }), { flag: "wx", mode: 0o600 });
  }

  /** Failed/cancelled turns are recoverable artifacts, never the next attempt's baseline. */
  async preserve(snapshot: WorkspaceSnapshot, expectedBaseCommit: string | null): Promise<string> {
    await fs.mkdir(this.directory, { recursive: true });
    const staged = await stageWorkspaceSnapshot(snapshot, this.directory, { expectedBaseCommit });
    try {
      const location = path.join(this.directory, `recovery-${randomUUID()}.json`);
      const handle = await fs.open(location, "wx", 0o600);
      try { await handle.writeFile(JSON.stringify(snapshot)); await handle.sync(); }
      finally { await handle.close(); }
      this.saved = true;
      return location;
    } finally { await staged.dispose(); }
  }

  private async write(pending: PendingCheckpoint): Promise<void> {
    const temp = path.join(this.directory, `${randomUUID()}.tmp`);
    const handle = await fs.open(temp, "wx", 0o600);
    try { await handle.writeFile(JSON.stringify(pending)); await handle.sync(); }
    finally { await handle.close(); }
    try { await fs.rename(temp, this.pendingPath); }
    finally { await fs.rm(temp, { force: true }); }
  }

  private async publish(pending: PendingSnapshot, staged: StagedWorkspaceSnapshot): Promise<void> {
    const current = checkpointFiles(await exportWorkspaceSnapshot(this.workspacePath,
      pending.expected.git ? { baseCommit: pending.expected.git.baseCommit } : {}));
    if (equivalent(current, pending.snapshot)) {
      await this.write({ ...pending, imported: true });
      return;
    }
    if (!equivalent(current, pending.expected)) throw new Error("host workspace changed since dispatch; checkpoint retained for recovery");
    if (current.git) {
      await this.publishGit(pending, staged);
      return;
    }
    const backup = path.join(this.directory, "previous");
    await fs.rename(this.workspacePath, backup);
    try {
      await fs.rename(staged.path, this.workspacePath);
    } catch (error) {
      await fs.rename(backup, this.workspacePath);
      throw error;
    }
    const imported = await this.snapshot();
    if (!equivalent(imported, pending.snapshot)) throw new Error("checkpoint verification failed; previous workspace retained");
    await this.write({ ...pending, imported: true });
    await fs.rm(backup, { recursive: true, force: true });
  }

  private async publishGit(pending: PendingSnapshot, staged: StagedWorkspaceSnapshot): Promise<void> {
    const before = pending.expected.git!;
    const after = pending.snapshot.git!;
    const branch = await git(this.workspacePath, "symbolic-ref", "HEAD");
    if (branch !== `refs/heads/${before.branch}`) throw new Error("host delivery branch changed since dispatch");
    // Include staged-but-uncommitted blobs, which fetching HEAD alone would lose.
    const tree = await git(staged.path, "write-tree");
    const transfer = await git(staged.path, "-c", "user.name=Symphony", "-c", "user.email=symphony@localhost",
      "commit-tree", tree, "-p", after.headCommit, "-m", "checkpoint index");
    await git(this.workspacePath, "-c", "fetch.unpackLimit=1", "fetch", "--no-tags", "--no-write-fetch-head", staged.path, transfer);
    const index = path.resolve(this.workspacePath, await git(this.workspacePath, "rev-parse", "--git-path", "index"));
    const oldIndex = await fs.readFile(index);
    const newIndex = await fs.readFile(path.join(staged.path, ".git", "index"));
    const ignored = (await git(this.workspacePath, "ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"))
      .split("\0").filter(Boolean).map((p) => p.replace(/\/$/, "")).filter((p) => !SCRATCH.has(p));
    for (const name of ignored) {
      if (pending.snapshot.entries.some((e) => e.path === name || e.path.startsWith(`${name}/`) || name.startsWith(`${e.path}/`) && e.type !== "directory")) {
        throw new Error(`checkpoint conflicts with ignored host file: ${name}`);
      }
    }
    const backup = path.join(this.directory, "previous");
    const lock = await fs.open(`${index}.lock`, "wx");
    await lock.close();
    let moved = false;
    let published = false;
    let advanced = false;
    const kept: string[] = [];
    try {
      await fs.writeFile(path.join(this.directory, "index.previous"), oldIndex);
      await fs.rename(this.workspacePath, backup);
      moved = true;
      await fs.rm(path.join(staged.path, ".git"), { recursive: true });
      await fs.rename(path.join(backup, ".git"), path.join(staged.path, ".git"));
      kept.push(".git");
      for (const name of ignored) {
        await fs.mkdir(path.dirname(path.join(staged.path, name)), { recursive: true });
        await fs.rename(path.join(backup, name), path.join(staged.path, name));
        kept.push(name);
      }
      await fs.rename(staged.path, this.workspacePath);
      published = true;
      // Compare-and-swap prevents a concurrent branch move from being overwritten.
      await git(this.workspacePath, "update-ref", branch, after.headCommit, before.headCommit);
      advanced = true;
      await fs.writeFile(index, newIndex);
      const verified = checkpointFiles(await exportWorkspaceSnapshot(this.workspacePath, { baseCommit: before.baseCommit }));
      if (!equivalent(verified, pending.snapshot)) throw new Error("Git checkpoint verification failed");
      await this.write({ ...pending, imported: true });
    } catch (error) {
      // Preserve the original directory and journal if rollback itself fails.
      try {
        if (advanced) await git(this.workspacePath, "update-ref", branch, before.headCommit, after.headCommit);
        if (moved) {
          const source = published ? this.workspacePath : staged.path;
          for (const name of kept.reverse()) {
            await fs.mkdir(path.dirname(path.join(backup, name)), { recursive: true });
            await fs.rename(path.join(source, name), path.join(backup, name));
          }
          if (published) await fs.rename(this.workspacePath, staged.path);
          await fs.rename(backup, this.workspacePath);
          await fs.writeFile(index, oldIndex);
        }
      } catch (rollback) {
        this.retainStaging = true;
        const reason = `checkpoint rollback failed: ${String(rollback)}; recover ${backup}, ${staged.path}, and ${this.workspacePath}; original failure: ${String(error)}`;
        await fs.writeFile(path.join(this.directory, "recovery-required.txt"), reason);
        throw new CheckpointRecoveryError(reason);
      }
      throw error;
    } finally { await fs.rm(`${index}.lock`, { force: true }); }
    await fs.rm(backup, { recursive: true, force: true });
    await fs.rm(path.join(this.directory, "index.previous"), { force: true });
  }
}
