/**
 * Generic execution provider contract (issue #34). Execution is deliberately
 * independent from agent protocols: a session owns one workspace's processes and
 * files whether they live on this host or in a remote runtime.
 */
import type { Readable, Writable } from "node:stream";
import type { Logger } from "../logger.ts";
import type { SnapshotExportOptions, SnapshotImportOptions, WorkspaceSnapshot } from "../workspace/snapshot.ts";

/** Operations a provider can advertise before a runtime is created. */
export type ExecutionCapability =
  | "process"
  | "filesystem"
  /** Files are already in the host workspace; no snapshot transfer is necessary. */
  | "host-workspace"
  | "workspace-snapshot"
  | "reconnect";

/** Provider-neutral terminal state of a process. The promise always resolves. */
export interface ProcessExit {
  code: number | null;
  signal: string | null;
  /** Spawn/transport failure, distinct from a process returning a non-zero code. */
  error?: string;
}

/** Options for a command started inside an execution session. */
export interface ProcessOptions {
  /** Workspace-relative working directory. Omit for the workspace root. */
  cwd?: string;
  /** Additions or overrides to the environment captured when the session was made. */
  env?: NodeJS.ProcessEnv;
}

/**
 * A live interactive process. Node streams are the transport boundary: a remote
 * provider can adapt its SDK streams without leaking provider-native handles upward.
 */
export interface ProcessHandle {
  /** Host pid or provider process id, when one is available. */
  readonly pid: string | null;
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  /** Stable terminal outcome; resolves once and never rejects. */
  readonly exit: Promise<ProcessExit>;
  wait(): Promise<ProcessExit>;
  /** Idempotently request termination, then wait until the process has settled. */
  kill(signal?: NodeJS.Signals): Promise<void>;
}

export interface RemoveFileOptions {
  recursive?: boolean;
  force?: boolean;
}

/**
 * One workspace-bound runtime. Capability-gated methods are optional so providers
 * can implement only what they advertise; callers must check before using them.
 */
export interface ExecutionSession {
  /** Absolute workspace path inside this runtime (may differ from the host path). */
  readonly workspacePath: string;
  /** Persistent provider runtime id, or null for an ephemeral/local session. */
  readonly runtimeId: string | null;
  spawn?(command: string, options?: ProcessOptions): Promise<ProcessHandle>;
  readFile?(filePath: string): Promise<Uint8Array>;
  writeFile?(filePath: string, data: string | Uint8Array): Promise<void>;
  removeFile?(filePath: string, options?: RemoveFileOptions): Promise<void>;
  /** Portable transfer, gated by workspace-snapshot. Import requires an empty workspace. */
  exportSnapshot?(options?: SnapshotExportOptions): Promise<WorkspaceSnapshot>;
  importSnapshot?(snapshot: unknown, options: SnapshotImportOptions): Promise<void>;
  /** Idempotently stop owned work and release provider resources. */
  close(): Promise<void>;
}

/** Inputs common to every provider runtime. Provider-specific values stay opaque. */
export interface ExecutionSessionOptions {
  workspacePath: string;
  env: NodeJS.ProcessEnv;
  logger: Logger;
  provider: Record<string, unknown>;
}

/** Factory registered under `execution.kind`. */
export interface ExecutionProviderFactory {
  readonly kind: string;
  readonly capabilities: readonly ExecutionCapability[];
  /** Validate opaque `execution.provider` values without creating a runtime. */
  validate?(provider: Record<string, unknown>): void;
  create(opts: ExecutionSessionOptions): ExecutionSession | Promise<ExecutionSession>;
}
