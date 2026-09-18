/**
 * Local execution provider (issue #34). It preserves Symphony's existing host-shell
 * behavior while presenting the same process/file contract as future remote runtimes.
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { spawnShell } from "../shell.ts";
import { exportWorkspaceSnapshot, importWorkspaceSnapshot } from "../workspace/snapshot.ts";
import type { SnapshotExportOptions, SnapshotImportOptions, WorkspaceSnapshot } from "../workspace/snapshot.ts";
import type {
  ExecutionProviderFactory,
  ExecutionSession,
  ExecutionSessionOptions,
  ProcessExit,
  ProcessHandle,
  ProcessOptions,
  RemoveFileOptions,
} from "./types.ts";

class LocalProcessHandle implements ProcessHandle {
  readonly pid: string | null;
  readonly stdin;
  readonly stdout;
  readonly stderr;
  readonly exit: Promise<ProcessExit>;

  private child: ChildProcessWithoutNullStreams;

  constructor(child: ChildProcessWithoutNullStreams) {
    this.child = child;
    this.pid = child.pid === undefined ? null : String(child.pid);
    this.stdin = child.stdin;
    this.stdout = child.stdout;
    this.stderr = child.stderr;
    this.exit = new Promise((resolve) => {
      let settled = false;
      const settle = (outcome: ProcessExit) => {
        if (settled) return;
        settled = true;
        resolve(outcome);
      };
      child.once("error", (err) => settle({ code: null, signal: null, error: String(err) }));
      child.once("exit", (code, signal) => settle({ code, signal }));
    });
  }

  wait(): Promise<ProcessExit> {
    return this.exit;
  }

  async kill(signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
    if (this.child.exitCode === null && this.child.signalCode === null) {
      this.child.kill(signal);
    }
    await this.exit;
  }
}

class LocalExecutionSession implements ExecutionSession {
  readonly runtimeId = null;

  readonly workspacePath: string;
  private env: NodeJS.ProcessEnv;
  private processes = new Set<LocalProcessHandle>();
  private closed = false;
  private closing: Promise<void> | null = null;
  private snapshotOperation: Promise<unknown> | null = null;
  private fileOperations = 0;

  constructor(opts: ExecutionSessionOptions) {
    this.workspacePath = path.resolve(opts.workspacePath);
    this.env = { ...opts.env };
  }

  async spawn(command: string, options: ProcessOptions = {}): Promise<ProcessHandle> {
    this.assertOpen();
    this.assertNoSnapshot();
    const cwd = this.resolveWorkspacePath(options.cwd ?? ".");
    const env = options.env ? { ...this.env, ...options.env } : this.env;
    const { child } = spawnShell(command, cwd, env);
    const handle = new LocalProcessHandle(child);
    this.processes.add(handle);
    void handle.exit.then(() => this.processes.delete(handle));
    return handle;
  }

  async readFile(filePath: string): Promise<Uint8Array> {
    this.assertOpen();
    return this.withFileOperation(() => fs.readFile(this.resolveWorkspacePath(filePath)));
  }

  async writeFile(filePath: string, data: string | Uint8Array): Promise<void> {
    this.assertOpen();
    await this.withFileOperation(async () => {
      const target = this.resolveWorkspacePath(filePath);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, data);
    });
  }

  async removeFile(filePath: string, options: RemoveFileOptions = {}): Promise<void> {
    this.assertOpen();
    await this.withFileOperation(() => fs.rm(this.resolveWorkspacePath(filePath), {
      recursive: options.recursive ?? false,
      force: options.force ?? false,
    }));
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.closing = (async () => {
      await this.snapshotOperation?.catch(() => {});
      const live = [...this.processes];
      await Promise.all(live.map((handle) => handle.kill("SIGKILL")));
      this.processes.clear();
    })();
    return this.closing;
  }

  async exportSnapshot(options?: SnapshotExportOptions): Promise<WorkspaceSnapshot> {
    return this.withSnapshot(() => exportWorkspaceSnapshot(this.workspacePath, options));
  }

  async importSnapshot(snapshot: unknown, options: SnapshotImportOptions): Promise<void> {
    await this.withSnapshot(() => importWorkspaceSnapshot(this.workspacePath, snapshot, options));
  }

  private assertNoSnapshot(): void {
    if (this.snapshotOperation) throw new Error("execution session has a snapshot in progress");
  }

  private async withFileOperation<T>(operation: () => Promise<T>): Promise<T> {
    this.assertNoSnapshot();
    this.fileOperations++;
    try { return await operation(); }
    finally { this.fileOperations--; }
  }

  private async withSnapshot<T>(operation: () => Promise<T>): Promise<T> {
    this.assertOpen();
    this.assertNoSnapshot();
    if (this.processes.size || this.fileOperations) throw new Error("snapshot requires a quiescent execution session");
    const pending = operation();
    this.snapshotOperation = pending;
    try { return await pending; }
    finally { this.snapshotOperation = null; }
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("execution session is closed");
  }

  /** Keep the provider's file/cwd surface scoped to the session workspace. */
  private resolveWorkspacePath(filePath: string): string {
    const target = path.resolve(this.workspacePath, filePath);
    const relative = path.relative(this.workspacePath, target);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error(`execution path is outside the workspace: ${filePath}`);
    }
    return target;
  }
}

export const localExecutionProvider: ExecutionProviderFactory = {
  kind: "local",
  capabilities: ["process", "filesystem", "host-workspace", "workspace-snapshot"],
  create(opts) {
    return new LocalExecutionSession(opts);
  },
};
