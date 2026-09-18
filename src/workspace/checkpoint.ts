/** Host checkpoint journal and publication boundary (issue #32; SPEC §9 safety). */
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  exportWorkspaceSnapshot, stageWorkspaceSnapshot,
  type WorkspaceSnapshot, type StagedWorkspaceSnapshot,
} from "./snapshot.ts";

const SCRATCH = new Set(["SYMPHONY_ISSUE.json", "SYMPHONY_RESULT.json"]);
export function checkpointFiles(snapshot: WorkspaceSnapshot): WorkspaceSnapshot {
  return { ...snapshot, entries: snapshot.entries.filter((entry) => !SCRATCH.has(entry.path)) };
}
interface PendingCheckpoint {
  version: 1;
  issueId: string;
  expected: WorkspaceSnapshot;
  snapshot: WorkspaceSnapshot;
  result: string | null;
  imported: boolean;
}

function equivalent(a: WorkspaceSnapshot, b: WorkspaceSnapshot): boolean {
  const facts = (s: WorkspaceSnapshot) => JSON.stringify({
    kind: s.kind, head: s.git?.headCommit, index: s.git?.indexPatch.sha256,
    entries: checkpointFiles(s).entries.map((e) => process.platform === "win32" && e.type === "directory"
      ? { ...e, mode: 0 } : e).sort((x, y) => x.path.localeCompare(y.path)),
  });
  return facts(a) === facts(b);
}

/** One stream owns this journal; the scheduler already excludes concurrent owners. */
export class WorkspaceCheckpoint {
  readonly workspacePath: string;
  readonly directory: string;
  /** True only after a verified snapshot has been written durably on the host. */
  saved = false;
  constructor(workspacePath: string, directory: string) {
    this.workspacePath = workspacePath;
    this.directory = directory;
  }
  private get pendingPath(): string { return path.join(this.directory, "pending.json"); }

  async snapshot(): Promise<WorkspaceSnapshot> {
    return checkpointFiles(await exportWorkspaceSnapshot(this.workspacePath));
  }

  async commit(issueId: string, expected: WorkspaceSnapshot, snapshot: WorkspaceSnapshot, result: string | null): Promise<void> {
    await fs.mkdir(this.directory, { recursive: true });
    snapshot = checkpointFiles(snapshot);
    const staged = await stageWorkspaceSnapshot(snapshot, this.directory, { expectedBaseCommit: expected.git?.baseCommit ?? null });
    try {
      const pending: PendingCheckpoint = { version: 1, issueId, expected, snapshot, result, imported: false };
      await this.write(pending);
      this.saved = true;
      await this.publish(pending, staged);
    } finally { await staged.dispose(); }
  }

  /** Replay import before retrying the tracker, never before starting another agent. */
  async recover(issueId: string): Promise<string | null> {
    let pending: PendingCheckpoint;
    try { pending = JSON.parse(await fs.readFile(this.pendingPath, "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
    if (pending.version !== 1 || pending.issueId !== issueId) throw new Error("checkpoint belongs to another issue or has an unsupported version");
    this.saved = true;
    if (!pending.imported) {
      const staged = await stageWorkspaceSnapshot(pending.snapshot, this.directory, { expectedBaseCommit: pending.expected.git?.baseCommit ?? null });
      try { await this.publish(pending, staged); }
      finally { await staged.dispose(); }
    }
    return pending.result;
  }

  async acknowledge(): Promise<void> {
    try { await fs.rename(this.pendingPath, path.join(this.directory, "last.json")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }

  async hasPending(): Promise<boolean> {
    try { await fs.stat(this.pendingPath); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
  }

  private async write(pending: PendingCheckpoint): Promise<void> {
    const temp = path.join(this.directory, `${randomUUID()}.tmp`);
    const handle = await fs.open(temp, "wx", 0o600);
    try { await handle.writeFile(JSON.stringify(pending)); await handle.sync(); }
    finally { await handle.close(); }
    try { await fs.rename(temp, this.pendingPath); }
    finally { await fs.rm(temp, { force: true }); }
  }

  private async publish(pending: PendingCheckpoint, staged: StagedWorkspaceSnapshot): Promise<void> {
    const current = checkpointFiles(await exportWorkspaceSnapshot(this.workspacePath,
      pending.expected.git ? { baseCommit: pending.expected.git.baseCommit } : {}));
    if (equivalent(current, pending.snapshot)) {
      await this.write({ ...pending, imported: true });
      return;
    }
    if (!equivalent(current, pending.expected)) throw new Error("host workspace changed since dispatch; checkpoint retained for recovery");
    if (current.git) throw new Error("Git checkpoint publication is not implemented");
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
}
