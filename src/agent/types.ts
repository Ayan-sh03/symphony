/**
 * Agent abstraction (generalizes SPEC §10). Symphony's Execution Layer talks to a
 * coding agent only through `AgentSession`; Codex is one backend behind this
 * interface. Adding another agent means implementing `AgentSession` + `AgentFactory`
 * and registering it (see agent/registry.ts) — the orchestrator, runner, workspace,
 * and tracker layers are unchanged.
 */
import type { AgentUpdate, Issue } from "../domain/types.ts";
import type { Logger } from "../logger.ts";
import type { ServiceConfigValues } from "../config/config.ts";
import type { ToolSpec, TrackerAdapter } from "../tracker/types.ts";

/** Terminal outcome of one agent turn (SPEC §10.3 completion conditions). */
export interface AgentTurnResult {
  status: "completed" | "failed" | "cancelled" | "timeout";
  error?: string;
}

/** Session identity exposed after start (SPEC §10.2). */
export interface AgentSessionIdentity {
  /** Stable per-run thread identity reused across continuation turns. */
  threadId: string;
}

/**
 * A live agent session bound to one workspace + issue snapshot. Implementations own
 * their transport/protocol; Symphony only drives start → runTurn* → stop and consumes
 * emitted `AgentUpdate`s.
 */
export interface AgentSession {
  /** Launch the backend and prepare a thread. Emits `session_started`/`startup_failed`. */
  start(): Promise<AgentSessionIdentity>;
  /**
   * Run one turn to termination. `input` is the full rendered prompt on the first
   * turn and continuation guidance thereafter; `summary` is an optional turn title.
   */
  runTurn(input: string, summary?: string): Promise<AgentTurnResult>;
  /** Stop the backend at the end of a worker run. Idempotent. */
  stop(): void;
  /** Backend thread id, once known. */
  readonly threadId: string | null;
  /** Backend process id, if the backend is a subprocess. */
  readonly pid: string | null;
}

/** Everything an agent backend needs to run one worker attempt. */
export interface AgentSessionOptions {
  workspacePath: string;
  issue: Issue;
  config: ServiceConfigValues;
  logger: Logger;
  onUpdate: (u: AgentUpdate) => void;
  /**
   * Tracker adapter bound to this session snapshot (SPEC §10.5). Used to execute
   * advertised provider-native tools host-side. A reload MUST NOT swap it mid-session.
   */
  adapter: TrackerAdapter;
  /** Provider-native tool specs advertised for this session, bound to the snapshot. */
  toolSpecs: ToolSpec[];
  /** Child environment (tracker secrets already stripped — SPEC §15.3). */
  env: NodeJS.ProcessEnv;
}

/** One persisted activity event, shaped like the console's `recent_events` rows. */
export interface TranscriptEvent {
  at: string;
  event: string;
  message: string;
}

/** Lookup for reading a backend's own on-disk transcript after the fact. */
export interface TranscriptQuery {
  /** Absolute per-issue workspace the run executed in (backends stamp this on disk). */
  workspacePath: string;
  /** Backend session/thread id, when Symphony recorded one; helps disambiguate. */
  sessionId?: string | null;
  config: ServiceConfigValues;
  logger: Logger;
}

/** Factory for one agent backend, selected by `agent.kind`. */
export interface AgentFactory {
  readonly kind: string;
  create(opts: AgentSessionOptions): AgentSession;
  /**
   * Optional capability (SPEC §13.7.2): read the backend's own persisted transcript
   * for a finished run, so the console can show activity after Symphony's in-memory
   * history is gone (e.g. a restart). Best-effort — these are internal on-disk formats;
   * return `[]` (never throw) when nothing is found. Newest-last ordering.
   */
  readTranscript?(query: TranscriptQuery): Promise<TranscriptEvent[]>;
}
