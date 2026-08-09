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
import type { AgentDetection, AgentDetectDeps } from "./detection.ts";

export type { AgentDetection, AgentDetectDeps };

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
  /**
   * OPTIONAL per-run model (extension, SPEC Appendix B.7), taken from `issue.model`.
   * Passed to the backend verbatim — Symphony never validates it, because the CLI is
   * the authority and reports a bad id better than we can. A backend free to ignore
   * this runs on its own default, which is also what absent means.
   */
  model?: string;
}

/** One persisted activity event, shaped like the console's `recent_events` rows. */
export interface TranscriptEvent {
  at: string;
  event: string;
  message: string;
}

/**
 * One model a backend reports it can run (extension, SPEC Appendix B.7). `id` is the
 * string handed back to the backend verbatim — Symphony never interprets it.
 *
 * `default` means the model this backend would *actually* use for a run with no
 * per-issue override, resolved against the host's own config. It deliberately does
 * not mean the vendor's flagship: codex's `model/list` marks `isDefault` on the
 * newest model while `config/read` may name an entirely different one, and reporting
 * the former would show a default that dispatch does not use. Omit the flag rather
 * than guess (see M12's `2d9274d` for the same bug on agent kinds).
 */
export interface AgentModel {
  id: string;
  /** Human-readable name for the console, when the backend offers one. */
  label?: string;
  /** True only for the effective default — see above. */
  default?: boolean;
}

/** One backend's model listing as one console/API payload (extension). */
export interface AgentModelsView {
  kind: string;
  models: AgentModel[];
  /** When the listing was last successfully fetched; null when never. */
  fetched_at: string | null;
  /** No probe has completed yet — an empty `models` here means unknown, not none. */
  stale: boolean;
}

/** Everything a backend needs to enumerate its models. */
export interface ModelQuery {
  config: ServiceConfigValues;
  logger: Logger;
  /**
   * Child environment discovery must spawn with. This is the *dispatch* env: opencode
   * scopes its listing to configured credentials and several providers arrive via env
   * vars, so probing with a different environment would advertise models the runs
   * cannot actually reach.
   */
  env: NodeJS.ProcessEnv;
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
  /**
   * Optional capability (extension): report whether this backend is actually
   * runnable on this host. Advisory — a backend without it is assumed available,
   * and its own startup failure remains the final authority. Must be cheap and
   * side-effect free: no sessions, no tokens, no real app-server.
   */
  detect?(config: ServiceConfigValues, logger: Logger, deps?: AgentDetectDeps): Promise<AgentDetection>;
  /**
   * Stable, non-secret input that affects availability detection. Supplying it lets
   * multi-project hosts share a host probe; omitting it deliberately keeps custom
   * backends isolated until they define their own equivalence contract.
   */
  availabilityCacheKey?(config: ServiceConfigValues): string;
  /**
   * Optional capability (extension, SPEC Appendix B.7): enumerate the models this
   * backend can run on this host. Symphony is not the source of truth for model
   * inventory — the CLI is — so every model name in the console originates here.
   *
   * Best-effort and advisory: return `[]` (never throw) when the backend cannot
   * answer. Callers must never put this on the dispatch path, and an unknown model
   * is never rejected on the strength of an absent entry — the backend validates.
   * Implementations own their own timeout and MUST kill any child they spawn: the
   * verified failure mode is a hang, not a rejection.
   */
  listModels?(query: ModelQuery): Promise<AgentModel[]>;
  /** Stable, non-secret configuration that affects this backend's model listing. */
  modelDiscoveryCacheKey?(query: ModelQuery): string;
}
