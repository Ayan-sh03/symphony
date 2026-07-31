/**
 * Orchestrator (SPEC §7, §8, §16). The single authority that mutates scheduling
 * state. Node's single-threaded event loop serializes these mutations; all worker
 * outcomes are reported back here and converted into explicit transitions.
 */
import type { Issue, AgentUpdate, LiveSession, IssueDelivery } from "../domain/types.ts";
import type { Logger } from "../logger.ts";
import type { ServiceConfigValues } from "../config/config.ts";
import type { WorkflowDefinition } from "../domain/types.ts";
import type { TrackerAdapter, IssuePatch } from "../tracker/types.ts";
import { WorkspaceManager, isSafeStreamIdentifier } from "../workspace/manager.ts";
import { createAdapter, validateTracker, SUPPORTED_KINDS as TRACKER_KINDS } from "../tracker/registry.ts";
import { isSupportedAgentKind, supportedAgentKinds, readAgentTranscript } from "../agent/registry.ts";
import { runAgentAttempt, type WorkerExit } from "../agent/runner.ts";
import { buildConfig } from "../config/config.ts";

/**
 * Failure of an operator action, carrying enough classification for the HTTP
 * layer to answer with the right status instead of flattening everything to 400.
 */
export type OrchestratorErrorCode = "not_supported" | "not_found" | "conflict" | "upstream_failed";

export class OrchestratorError extends Error {
  code: OrchestratorErrorCode;
  constructor(code: OrchestratorErrorCode, message: string) {
    super(message);
    this.name = "OrchestratorError";
    this.code = code;
  }
}

/** One entry in an agent's activity log (SPEC §13.7.2 recent_events). */
interface LogEvent {
  at: string;
  event: string;
  message: string;
}

interface RunningEntry {
  identifier: string;
  /** Work stream (SPEC Appendix B.5): the identifier owning this run's workspace/branch. */
  stream: string;
  issue: Issue;
  session: LiveSession;
  retry_attempt: number | null;
  started_at: string;
  started_ms: number;
  last_event_ms: number | null;
  stopSession: (() => void) | null;
  /**
   * Set once the run is being wound down. `grace_until_ms` (terminal-state
   * termination only) lets the live turn settle on its own instead of being
   * killed mid-turn; past the deadline the session is stopped anyway.
   */
  terminating: { cleanupWorkspace: boolean; grace_until_ms: number | null } | null;
  workerDone: Promise<void>;
  events: LogEvent[];
  agent: string;
}

/** Retained activity log for a finished/terminated run, so logs survive the run. */
interface FinishedLog {
  identifier: string;
  stream: string;
  url: string | null;
  events: LogEvent[];
  ended_at: string;
  last_error: string | null;
  outcome: string;
}

const MAX_EVENTS = 80;
const MAX_HISTORY = 40;

/**
 * How long a live turn may keep running after its issue reached a terminal state
 * (extension). The agent usually moves the issue itself, mid-turn, and is still
 * finishing up (committing, verifying) when reconciliation notices; killing it
 * there turned every successful run into a cancelled one.
 */
const TERMINAL_GRACE_MS = 120000;

interface RetryEntry {
  issue_id: string;
  identifier: string;
  stream: string;
  attempt: number;
  due_at_ms: number;
  timer: NodeJS.Timeout;
  error: string | null;
}

/**
 * A halted issue: retries stopped (limit reached, or operator pressed Stop). The
 * claim is kept so the poll loop cannot re-dispatch it; it is released when the
 * issue's state changes (console/API) or the issue leaves the active states.
 */
export interface HaltedEntry {
  identifier: string;
  stream: string;
  reason: string;
  attempts: number;
  halted_at: string;
}

interface CodexTotals {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  seconds_running: number;
}

function freshSession(): LiveSession {
  return {
    session_id: null,
    thread_id: null,
    turn_id: null,
    codex_app_server_pid: null,
    last_codex_event: null,
    last_codex_timestamp: null,
    last_codex_message: null,
    codex_input_tokens: 0,
    codex_output_tokens: 0,
    codex_total_tokens: 0,
    last_reported_input_tokens: 0,
    last_reported_output_tokens: 0,
    last_reported_total_tokens: 0,
    turn_count: 0,
  };
}

export interface OrchestratorDeps {
  config: ServiceConfigValues;
  workflow: WorkflowDefinition;
  workflowPath: string;
  logger: Logger;
}

export interface ValidationResult {
  ok: boolean;
  error?: string;
}

export class Orchestrator {
  private config: ServiceConfigValues;
  private promptTemplate: string;
  private workflowPath: string;
  private logger: Logger;

  private adapter: TrackerAdapter;
  private workspaceManager: WorkspaceManager;

  // Runtime state (SPEC §4.1.8).
  private running = new Map<string, RunningEntry>();
  private claimed = new Set<string>();
  private retry_attempts = new Map<string, RetryEntry>();
  private halted = new Map<string, HaltedEntry>();
  private completed = new Set<string>();
  /** Streams whose delivery/cleanup is still in flight — busy, though nothing is running. */
  private finalizing = new Set<string>();
  private defaultAgentOverride: string | null = null; // runtime default set via console/API
  private history = new Map<string, FinishedLog>(); // issue_id -> retained log
  private codex_totals: CodexTotals = { input_tokens: 0, output_tokens: 0, total_tokens: 0, seconds_running: 0 };

  private tickTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  private refreshQueued = false;
  private observers: Array<() => void> = [];

  constructor(deps: OrchestratorDeps) {
    this.config = deps.config;
    this.promptTemplate = deps.workflow.prompt_template;
    this.workflowPath = deps.workflowPath;
    this.logger = deps.logger;
    this.adapter = createAdapter(this.config.tracker.kind, this.config.tracker.provider, this.config.workflowDir, this.logger);
    this.workspaceManager = new WorkspaceManager({
      root: this.config.workspace_root,
      hooks: this.config.hooks,
      logger: this.logger,
      repository: this.config.workspace_repository,
      baseBranch: this.config.workspace_base_branch,
      branchTemplate: this.config.workspace_branch_template,
    });
  }

  onChange(cb: () => void): void {
    this.observers.push(cb);
  }
  private notify(): void {
    for (const cb of this.observers) {
      try {
        cb();
      } catch {
        /* observer must never break orchestration */
      }
    }
  }

  // ---- state predicates ----

  private normState(s: string): string {
    return s.trim().toLowerCase();
  }
  private isActiveState(state: string): boolean {
    const n = this.normState(state);
    return this.config.tracker.active_states.some((s) => this.normState(s) === n);
  }
  private isTerminalState(state: string): boolean {
    const n = this.normState(state);
    return this.config.tracker.terminal_states.some((s) => this.normState(s) === n);
  }
  /** SPEC §8.2: dispatchable + all required labels present (state/claims checked separately). */
  private isRoutable(issue: Issue): boolean {
    if (!issue.dispatchable) return false;
    const want = this.config.tracker.required_labels.map((l) => this.normState(l));
    for (const l of want) {
      if (l === "") return false; // a blank configured label matches no issue
      if (!issue.labels.includes(l)) return false;
    }
    return true;
  }

  // ---- work streams (SPEC Appendix B.5) ----

  /**
   * The work stream an issue belongs to: the identifier whose workspace and branch it
   * uses. An ordinary issue is its own stream; a follow-up carries the stream it joined,
   * frozen at creation, so several issues deliver onto one branch instead of forking it.
   */
  private streamOf(issue: Issue): string {
    const s = issue.stream_identifier?.trim();
    // A stream that would not have been accepted at creation (hand-edited record) is
    // ignored rather than fed to git: the issue falls back to being its own stream.
    if (s && isSafeStreamIdentifier(s)) return s;
    return issue.identifier;
  }

  /**
   * Streams that already have an owner. One workspace and one branch per stream means at
   * most one member of a stream may be in flight — they are a queue, not parallel work.
   *
   * Ownership deliberately outlives the running set, because so does the workspace:
   * - `running` — a live turn is in the worktree.
   * - `finalizing` — the run ended, but its delivery is still being read out of the
   *   worktree, and the worktree may still be being removed.
   * - `retry_attempts` — a finished turn's outcome is not resolved yet. This is the gap
   *   that matters most: a normal exit schedules a continuation retry, and the issue's
   *   delivery is only recorded when that timer fires. A sibling let in beforehand runs
   *   in a worktree that is about to be measured and cleaned for someone else.
   * - `halted` — a stopped run can leave half-finished work in the worktree; mixing a
   *   sibling into it would put both on the branch. The hold ends when the operator
   *   changes the halted issue's state, which is the same thing that frees its claim.
   */
  private busyStreams(): Set<string> {
    const out = new Set<string>(this.finalizing);
    for (const [, e] of this.running) out.add(e.stream);
    for (const [, r] of this.retry_attempts) out.add(r.stream);
    for (const [, h] of this.halted) out.add(h.stream);
    return out;
  }

  /**
   * Run the post-run delivery/cleanup for a stream with that stream held busy, so nothing
   * is dispatched into the worktree while it is being measured and removed.
   */
  private async windDownStream(identifier: string, issueId: string, stream: string): Promise<void> {
    this.finalizing.add(stream);
    try {
      await this.finalizeDelivery(identifier, issueId, stream);
      await this.cleanupStream(stream, issueId);
    } finally {
      this.finalizing.delete(stream);
      // The stream is free now; let a queued sibling go without waiting for the next tick.
      this.scheduleTick(0);
    }
  }

  // ---- config validation (SPEC §6.3) ----

  validateDispatchConfig(): ValidationResult {
    try {
      validateTracker(this.config.tracker.kind, this.config.tracker.provider);
    } catch (err) {
      return { ok: false, error: `tracker config invalid: ${(err as Error).message}` };
    }
    if (!isSupportedAgentKind(this.config.agent_kind)) {
      return { ok: false, error: `unsupported agent.kind: ${this.config.agent_kind}` };
    }
    if (!this.config.codex.command || this.config.codex.command.trim() === "") {
      return { ok: false, error: "codex.command is empty" };
    }
    return { ok: true };
  }

  // ---- lifecycle ----

  /** Startup: validate, startup cleanup, immediate tick, then repeat (SPEC §8.1, §16.1). */
  async start(): Promise<void> {
    const v = this.validateDispatchConfig();
    if (!v.ok) throw new Error(`startup validation failed: ${v.error}`);
    await this.startupTerminalCleanup();
    this.scheduleTick(0);
  }

  stop(): void {
    this.stopped = true;
    if (this.tickTimer) clearTimeout(this.tickTimer);
    for (const [, r] of this.retry_attempts) clearTimeout(r.timer);
    for (const [, e] of this.running) e.stopSession?.();
  }

  private scheduleTick(delayMs: number): void {
    if (this.stopped) return;
    if (this.tickTimer) clearTimeout(this.tickTimer);
    this.tickTimer = setTimeout(() => {
      void this.tick();
    }, delayMs);
  }

  /** Whether the active adapter supports creating issues (console Add-issue CTA). */
  canCreateIssues(): boolean {
    return typeof this.adapter.supportsCreate === "function" && this.adapter.supportsCreate();
  }

  /** Create a work item via the adapter, then poll promptly so it dispatches. */
  async createIssue(input: import("../tracker/types.ts").NewIssueInput): Promise<Issue> {
    if (!this.canCreateIssues() || !this.adapter.createIssue) {
      throw new Error("the active tracker does not support creating issues");
    }
    if (input.agent && !isSupportedAgentKind(input.agent)) throw new Error(`unknown agent.kind: ${input.agent}`);
    const resolved = await this.resolveFollowUp(input);
    const issue = await this.adapter.createIssue(resolved);
    this.logger.info("issue created", {
      issue_id: issue.id,
      issue_identifier: issue.identifier,
      follow_up_for: issue.follow_up_for ?? "",
      stream: this.streamOf(issue),
    });
    this.scheduleTick(0);
    this.notify();
    return issue;
  }

  /** Whether follow-up issues can be created on this project (adapter capability + create). */
  canFollowUp(): boolean {
    return this.canCreateIssues() && typeof this.adapter.supportsFollowUp === "function" && this.adapter.supportsFollowUp();
  }

  /**
   * Resolve a create request's follow-up link into a frozen work stream (SPEC Appendix
   * B.5). The parent must exist now, and the stream stored is the parent's *own* stream,
   * so a chain of follow-ups all name the branch the first issue opened. Requests without
   * `follow_up_for` pass through untouched — including the stream field, which callers
   * never set directly: it is derived here or not at all.
   */
  private async resolveFollowUp(
    input: import("../tracker/types.ts").NewIssueInput,
  ): Promise<import("../tracker/types.ts").NewIssueInput> {
    const parentRef = input.follow_up_for?.trim();
    if (!parentRef) return { ...input, follow_up_for: null, stream_identifier: null };
    if (!this.canFollowUp()) {
      throw new OrchestratorError("not_supported", "the active tracker does not support follow-up issues");
    }
    if (parentRef === input.identifier.trim()) {
      throw new OrchestratorError("conflict", "an issue cannot follow up on itself");
    }
    const parent = await this.findByRef(parentRef);
    if (!parent) throw new OrchestratorError("not_found", `unknown issue ${parentRef}`);
    const stream = this.streamOf(parent);
    if (!isSafeStreamIdentifier(stream)) {
      throw new OrchestratorError("conflict", `issue ${parent.identifier} cannot back a branch: unsafe identifier`);
    }
    return { ...input, follow_up_for: parent.identifier, stream_identifier: stream };
  }

  /** Find an issue by dispatch id or by identifier — the console sends either. */
  private async findByRef(ref: string): Promise<Issue | null> {
    try {
      const byId = (await this.adapter.fetchIssuesByIds([ref]))[0];
      if (byId) return byId;
    } catch {
      /* fall through to the identifier lookup */
    }
    if (!this.adapter.listAllIssues) return null;
    try {
      return (await this.adapter.listAllIssues()).find((i) => i.identifier === ref) ?? null;
    } catch {
      return null;
    }
  }

  /** Whether the active adapter supports editing/removing issues (console Edit/Delete). */
  canEditIssues(): boolean {
    return typeof this.adapter.supportsEdit === "function" && this.adapter.supportsEdit();
  }

  /** Amend an issue's editable fields, then poll promptly so the board reflects it. */
  async updateIssue(id: string, patch: IssuePatch): Promise<Issue> {
    if (!this.canEditIssues() || !this.adapter.updateIssue) {
      throw new OrchestratorError("not_supported", "the active tracker does not support editing issues");
    }
    const issue = await this.adapter.updateIssue(id, patch);
    // A live run keeps the issue it was dispatched with (its prompt is already
    // rendered), but the detail view reads that snapshot — refresh the editable
    // fields on a fresh object so the console stops showing pre-edit values.
    const live = this.running.get(id);
    if (live) {
      live.issue = { ...live.issue, title: issue.title, description: issue.description, priority: issue.priority, labels: issue.labels };
    }
    this.logger.info("issue updated", { issue_id: id, issue_identifier: issue.identifier });
    this.scheduleTick(0);
    this.notify();
    return issue;
  }

  /**
   * Remove an issue from the tracker. Refused while it is running or has a pending
   * retry — the operator must Stop it first, same rule as the halt flow — so a live
   * worker is never left writing back to a record that no longer exists. A halted
   * entry is cleared so the hold and its claim are released. The in-memory run
   * history survives on purpose: the detail log stays readable after the issue is gone.
   * The workspace goes with the record, under the usual cleanup rules — a dirty or
   * unverifiable worktree is preserved, the issue branch is never deleted, and a
   * workspace shared with the issue's follow-ups stays put.
   */
  async deleteIssue(id: string): Promise<{ issue_id: string; issue_identifier: string }> {
    if (!this.canEditIssues() || !this.adapter.deleteIssue) {
      throw new OrchestratorError("not_supported", "the active tracker does not support deleting issues");
    }
    this.assertDeletable(id);
    let identifier = this.halted.get(id)?.identifier ?? id;
    let stream = this.halted.get(id)?.stream ?? identifier;
    let known = false;
    try {
      const issue = (await this.adapter.fetchIssuesByIds([id]))[0];
      if (issue) {
        identifier = issue.identifier;
        stream = this.streamOf(issue);
        known = true;
      }
    } catch (err) {
      throw new OrchestratorError("upstream_failed", String((err as Error).message ?? err));
    }
    if (!known) throw new OrchestratorError("not_found", `unknown issue ${id}`);
    // The lookup above yields the loop, and a tick can dispatch in that window:
    // re-check before the record goes, so a live worker never loses its issue.
    this.assertDeletable(id);
    await this.adapter.deleteIssue(id);
    this.releaseHalt(id); // a deleted issue holds nothing
    this.claimed.delete(id);
    // Deleting one member of a work stream must not take the shared workspace with
    // it — its siblings still deliver onto that branch (SPEC Appendix B.5).
    await this.cleanupStream(stream, id);
    this.logger.info("issue deleted", { issue_id: id, issue_identifier: identifier });
    this.scheduleTick(0);
    this.notify();
    return { issue_id: id, issue_identifier: identifier };
  }

  /** A live issue is never deleted out from under its worker — Stop it first (same rule as the halt flow). */
  private assertDeletable(id: string): void {
    const run = this.running.get(id);
    if (run) {
      throw new OrchestratorError("conflict", `issue ${run.identifier} is running; stop it before deleting it`);
    }
    const retry = this.retry_attempts.get(id);
    if (retry) {
      throw new OrchestratorError("conflict", `issue ${retry.identifier} has a pending retry; stop it before deleting it`);
    }
  }

  // ---- agent selection ----

  /** This project's configured server.port (SPEC §13.7), or null. Used only for the host's default bind. */
  serverPort(): number | null {
    return this.config.server_port;
  }

  /** The effective default agent backend (runtime override wins over WORKFLOW.md). */
  effectiveDefaultAgent(): string {
    if (this.defaultAgentOverride && isSupportedAgentKind(this.defaultAgentOverride)) return this.defaultAgentOverride;
    return this.config.agent_kind;
  }

  /** Resolve the backend for one issue: valid per-task override → effective default. */
  private resolveAgentKind(issue: Issue): string {
    if (issue.agent && isSupportedAgentKind(issue.agent)) return issue.agent;
    return this.effectiveDefaultAgent();
  }

  /** Set the runtime default agent backend (console/API). Must be a registered kind. */
  setDefaultAgent(kind: string): void {
    if (!isSupportedAgentKind(kind)) throw new Error(`unknown agent.kind: ${kind}`);
    this.defaultAgentOverride = kind;
    this.logger.info("default agent changed", { agent: kind });
    this.notify();
  }

  /** Assign/clear an issue's per-task agent, then poll so a pending dispatch uses it. */
  async setIssueAgent(id: string, agent: string): Promise<Issue> {
    if (!this.adapter.setIssueAgent) throw new Error("the active tracker does not support assigning agents");
    if (agent && !isSupportedAgentKind(agent)) throw new Error(`unknown agent.kind: ${agent}`);
    const issue = await this.adapter.setIssueAgent(id, agent);
    this.logger.info("issue agent changed", { issue_id: id, issue_identifier: issue.identifier, agent: agent || "(default)" });
    this.scheduleTick(0);
    this.notify();
    return issue;
  }

  /** Whether the active adapter can persist a per-issue agent assignment. */
  canSetAgent(): boolean {
    return typeof this.adapter.setIssueAgent === "function";
  }

  /** Whether the active adapter can list all issues + move them between states. */
  canBoard(): boolean {
    return typeof this.adapter.supportsBoard === "function" && this.adapter.supportsBoard();
  }

  /** Full board view: every issue with its live runtime status, plus state ordering. */
  async board(): Promise<BoardView> {
    if (!this.canBoard() || !this.adapter.listAllIssues) {
      throw new Error("the active tracker does not support a board view");
    }
    const all = await this.adapter.listAllIssues();
    // One git process for the whole board, not one per issue.
    const divergence = await this.workspaceManager.branchAheadBehind();
    const order = orderedStates(
      this.config.tracker.backlog_states,
      this.config.tracker.active_states,
      // Delivered work waiting on a human sits between "being worked on" and
      // "closed", which is also where the operator's attention should land.
      this.deliveryEnabled() ? [this.config.tracker.review_state] : [],
      this.config.tracker.terminal_states,
      all.map((i) => i.state),
    );
    const issues = all.map((i) => {
      const run = this.running.get(i.id);
      const halt = this.halted.get(i.id) ?? null;
      const runtime: BoardIssueView["runtime"] = run ? "running" : this.retry_attempts.has(i.id) ? "retrying" : halt ? "halted" : "idle";
      // Keyed by the stream's branch rather than the delivery's, so a stream that
      // has not delivered yet still shows how far it has come.
      const branch = this.workspaceManager.deliveryBranchFor(this.streamOf(i));
      const counts = branch ? divergence.get(branch) ?? null : null;
      // "Merged" is a hint for a human to act on, never an automatic transition,
      // and it has one verified false positive to keep out: a branch with no
      // commits of its own is trivially an ancestor of the base and would read as
      // merged forever. So it must have delivered something first.
      const delivered = (i.delivery?.files_changed?.length ?? 0) > 0;
      return {
        id: i.id,
        identifier: i.identifier,
        title: i.title,
        state: i.state,
        priority: i.priority,
        labels: i.labels,
        url: i.url,
        runtime,
        halt_reason: halt ? halt.reason : null,
        turn_count: run ? run.session.turn_count : null,
        is_active: this.isActiveState(i.state),
        is_terminal: this.isTerminalState(i.state),
        agent: this.resolveAgentKind(i), // effective backend
        agent_override: i.agent,          // explicit per-task choice, or null
        needs_attention: i.delivery?.needs_attention === true,
        follow_up_for: i.follow_up_for,
        // Always concrete, so the console can group a stream without re-deriving it.
        stream: this.streamOf(i),
        delivery_branch: i.delivery?.branch ?? null,
        ahead: counts?.ahead ?? null,
        behind: counts?.behind ?? null,
        merged_hint: delivered && counts !== null && counts.ahead === 0,
      };
    });
    return {
      generated_at: new Date().toISOString(),
      order,
      active_states: this.config.tracker.active_states,
      terminal_states: this.config.tracker.terminal_states,
      backlog_states: this.config.tracker.backlog_states,
      review_state: this.deliveryEnabled() ? this.config.tracker.review_state : null,
      start_state: this.config.tracker.active_states[0] ?? "todo",
      issues,
    };
  }

  /** Move an issue to a new state, then poll promptly so dispatch reflects it. */
  async setIssueState(id: string, state: string): Promise<Issue> {
    if (!this.canBoard() || !this.adapter.setIssueState) {
      throw new Error("the active tracker does not support changing issue state");
    }
    const issue = await this.adapter.setIssueState(id, state);
    this.logger.info("issue state changed", { issue_id: id, issue_identifier: issue.identifier, state: issue.state });
    this.releaseHalt(id); // a manual state change ends the operator hold
    // If it left an active state while running, reconciliation will stop it; poll now.
    this.scheduleTick(0);
    this.notify();
    return issue;
  }

  /** Force an out-of-band poll+reconcile cycle (SPEC §13.7.2 /refresh). */
  requestRefresh(): { queued: boolean; coalesced: boolean } {
    if (this.refreshQueued) return { queued: true, coalesced: true };
    this.refreshQueued = true;
    this.scheduleTick(0);
    return { queued: true, coalesced: false };
  }

  /** Poll-and-dispatch tick (SPEC §8.1, §16.2). */
  async tick(): Promise<void> {
    if (this.stopped) return;
    this.refreshQueued = false;
    try {
      await this.reconcile();

      const v = this.validateDispatchConfig();
      if (!v.ok) {
        this.logger.error("dispatch validation failed", { error: v.error });
        this.notify();
        return;
      }

      let issues: Issue[];
      try {
        issues = await this.adapter.fetchIssuesByStates(this.config.tracker.active_states);
      } catch (err) {
        this.logger.error("candidate fetch failed; skipping dispatch this tick", { error: String(err) });
        this.notify();
        return;
      }

      // A halted issue that left the active states (edited out-of-band) no longer
      // needs the operator hold; release its claim.
      if (this.halted.size > 0) {
        const activeIds = new Set(issues.map((i) => i.id));
        for (const id of [...this.halted.keys()]) {
          if (!activeIds.has(id)) this.releaseHalt(id);
        }
      }

      // Recomputed as we go: dispatching one member of a stream must block its
      // siblings for the rest of this tick, not just the ones already running.
      const busy = this.busyStreams();
      for (const issue of this.sortForDispatch(issues)) {
        if (this.availableSlots() <= 0) break;
        if (!this.shouldDispatch(issue, busy)) continue;
        busy.add(this.streamOf(issue));
        this.dispatch(issue, null);
      }
      this.notify();
    } finally {
      this.scheduleTick(this.config.poll_interval_ms);
    }
  }

  // ---- candidate selection (SPEC §8.2) ----

  private shouldDispatch(issue: Issue, busy: Set<string>): boolean {
    if (!issue.id || !issue.identifier || !issue.title || !issue.state) return false;
    if (!this.isActiveState(issue.state) || this.isTerminalState(issue.state)) return false;
    if (!issue.dispatchable) return false;
    if (!this.isRoutable(issue)) return false; // required labels
    if (this.running.has(issue.id)) return false;
    if (this.claimed.has(issue.id)) return false;
    if (this.availableSlots() <= 0) return false;
    if (!this.perStateSlotAvailable(issue.state)) return false;
    // One workspace and one branch per stream: a sibling follow-up runs next tick,
    // not concurrently (SPEC Appendix B.5). No claim is taken — the issue stays a
    // plain candidate, so whichever member is ready first simply goes first.
    if (busy.has(this.streamOf(issue))) return false;
    return true;
  }

  private sortForDispatch(issues: Issue[]): Issue[] {
    const rank = (p: number | null): number => (p !== null && p >= 1 && p <= 4 ? p : 999);
    return [...issues].sort((a, b) => {
      const pr = rank(a.priority) - rank(b.priority);
      if (pr !== 0) return pr;
      const at = a.created_at ? Date.parse(a.created_at) : Number.POSITIVE_INFINITY;
      const bt = b.created_at ? Date.parse(b.created_at) : Number.POSITIVE_INFINITY;
      const aVal = Number.isNaN(at) ? Number.POSITIVE_INFINITY : at;
      const bVal = Number.isNaN(bt) ? Number.POSITIVE_INFINITY : bt;
      if (aVal !== bVal) return aVal - bVal;
      return a.identifier.localeCompare(b.identifier);
    });
  }

  // ---- concurrency (SPEC §8.3) ----

  private availableSlots(): number {
    return Math.max(this.config.max_concurrent_agents - this.running.size, 0);
  }
  private runningCountByState(state: string): number {
    const n = this.normState(state);
    let count = 0;
    for (const [, e] of this.running) if (this.normState(e.issue.state) === n) count++;
    return count;
  }
  private perStateSlotAvailable(state: string): boolean {
    const n = this.normState(state);
    const limit = this.config.max_concurrent_agents_by_state[n] ?? this.config.max_concurrent_agents;
    return this.runningCountByState(state) < limit;
  }

  // ---- dispatch (SPEC §16.4) ----

  private dispatch(issue: Issue, attempt: number | null): void {
    const agentKind = this.resolveAgentKind(issue);
    const stream = this.streamOf(issue);
    const entry: RunningEntry = {
      identifier: issue.identifier,
      stream,
      issue,
      session: freshSession(),
      retry_attempt: attempt,
      started_at: new Date().toISOString(),
      started_ms: Date.now(),
      last_event_ms: null,
      stopSession: null,
      terminating: null,
      workerDone: Promise.resolve(),
      events: [],
      agent: agentKind,
    };
    this.running.set(issue.id, entry);
    this.claimed.add(issue.id);
    this.cancelRetry(issue.id);

    this.logger.info("dispatch", { issue_id: issue.id, issue_identifier: issue.identifier, agent: agentKind, stream, attempt: attempt ?? "" });

    const childEnv = this.buildChildEnv();
    entry.workerDone = (async () => {
      let exit: WorkerExit;
      try {
        exit = await runAgentAttempt(issue, attempt, {
          config: this.config,
          agentKind,
          stream,
          isFollowUp: stream !== issue.identifier,
          promptTemplate: this.promptTemplate,
          adapter: this.adapter,
          workspaceManager: this.workspaceManager,
          logger: this.logger,
          childEnv,
          isActiveState: (s) => this.isActiveState(s),
          isTerminalState: (s) => this.isTerminalState(s),
          isRoutable: (i) => this.isRoutable(i),
          onUpdate: (id, u) => this.onAgentUpdate(id, u),
          onSessionReady: (stop) => {
            const e = this.running.get(issue.id);
            if (e) e.stopSession = stop;
          },
        });
      } catch (err) {
        exit = { kind: "abnormal", reason: `worker crashed: ${String(err)}` };
      }
      this.onWorkerExit(issue.id, exit);
    })();
  }

  /** Build child env with tracker secrets removed (SPEC §15.3, §10.5). */
  private buildChildEnv(): NodeJS.ProcessEnv {
    const env = { ...process.env };
    for (const name of this.adapter.secretEnvironmentNames()) delete env[name];
    return env;
  }

  // ---- agent updates (SPEC §7.3, §13.5) ----

  private onAgentUpdate(issueId: string, u: AgentUpdate): void {
    const entry = this.running.get(issueId);
    if (!entry) return;
    const s = entry.session;
    entry.last_event_ms = Date.now();
    s.last_codex_event = u.event;
    s.last_codex_timestamp = u.timestamp;
    if (typeof u.message === "string") s.last_codex_message = u.message;
    if (u.codex_app_server_pid) s.codex_app_server_pid = u.codex_app_server_pid;
    if (u.thread_id) s.thread_id = u.thread_id;
    if (u.turn_id) s.turn_id = u.turn_id;
    if (s.thread_id && s.turn_id) s.session_id = `${s.thread_id}-${s.turn_id}`;
    if (u.event === "turn_started") s.turn_count += 1;

    // Append meaningful events to the activity log (skip pure token pings).
    const isMetricPing =
      u.event === "notification" && (u as { kind?: string }).kind === "token_usage";
    if (!isMetricPing) {
      entry.events.push({ at: u.timestamp, event: u.event, message: typeof u.message === "string" ? u.message : "" });
      if (entry.events.length > MAX_EVENTS) entry.events.splice(0, entry.events.length - MAX_EVENTS);
    }

    // Token accounting: absolute totals, dedup via deltas (SPEC §13.5).
    if (u.usage && (u as { absolute?: boolean }).absolute) {
      const inp = u.usage.input_tokens ?? 0;
      const out = u.usage.output_tokens ?? 0;
      const tot = u.usage.total_tokens ?? 0;
      const dInp = Math.max(inp - s.last_reported_input_tokens, 0);
      const dOut = Math.max(out - s.last_reported_output_tokens, 0);
      const dTot = Math.max(tot - s.last_reported_total_tokens, 0);
      s.codex_input_tokens += dInp;
      s.codex_output_tokens += dOut;
      s.codex_total_tokens += dTot;
      s.last_reported_input_tokens = inp;
      s.last_reported_output_tokens = out;
      s.last_reported_total_tokens = tot;
      this.codex_totals.input_tokens += dInp;
      this.codex_totals.output_tokens += dOut;
      this.codex_totals.total_tokens += dTot;
    }
  }

  // ---- worker exit + retry (SPEC §7.3, §16.6) ----

  private onWorkerExit(issueId: string, exit: WorkerExit): void {
    const entry = this.running.get(issueId);
    if (!entry) return;
    this.running.delete(issueId);
    this.addRuntimeSeconds(entry);

    // A terminated run is not a failed one: reaching the terminal state IS the
    // success path, and a turn we stopped ourselves reports "cancelled" purely
    // because we stopped it — neither belongs in the log as a worker failure.
    const term = entry.terminating;
    const stoppedByUs = exit.kind === "abnormal" && /session stopped/.test(exit.reason ?? "");
    const outcome = term
      ? term.cleanupWorkspace ? "delivered" : "canceled"
      : exit.kind === "normal" ? "completed" : "failed";
    const lastError = exit.kind === "abnormal" && !(term && stoppedByUs) ? exit.reason ?? "worker failed" : null;
    if (lastError) entry.events.push({ at: new Date().toISOString(), event: "worker_failed", message: lastError });
    this.archiveLog(issueId, entry, outcome, lastError);

    // Terminated: optional cleanup, no retry. An operator Stop halted the issue
    // before terminating — keep its claim so it waits for a manual state change;
    // a reconciliation terminate releases the claim as before.
    if (term) {
      if (term.cleanupWorkspace) {
        // Record the deliverable (branch/commit/files) before the worktree goes. The
        // entry has already left `running`, so the stream is held busy for the duration.
        void this.windDownStream(entry.identifier, issueId, entry.stream);
      }
      if (this.halted.has(issueId)) {
        this.logger.info("run stopped by operator; holding issue", { issue_id: issueId, issue_identifier: entry.identifier });
      } else {
        this.claimed.delete(issueId);
        this.logger.info(term.cleanupWorkspace ? "run finished in a terminal state" : "run canceled by reconciliation", {
          issue_id: issueId,
          issue_identifier: entry.identifier,
        });
      }
      this.notify();
      return;
    }

    if (exit.kind === "normal") {
      this.completed.add(issueId); // bookkeeping only (SPEC §7.1)
      // Short continuation retry to re-check activity (SPEC §7.1, §8.4).
      this.scheduleRetry(issueId, 1, entry.identifier, entry.stream, null, /*continuation*/ true);
      this.logger.info("worker completed", { issue_id: issueId, issue_identifier: entry.identifier });
    } else {
      const nextAttempt = (entry.retry_attempt ?? 0) + 1;
      this.scheduleRetry(issueId, nextAttempt, entry.identifier, entry.stream, exit.reason ?? "worker failed", false);
      this.logger.warn("worker failed; retrying", { issue_id: issueId, issue_identifier: entry.identifier, attempt: nextAttempt, reason: exit.reason });
    }
    this.notify();
  }

  /** SPEC §8.4 backoff. Continuation = fixed 1s; failure = 10s * 2^(attempt-1) capped. */
  private scheduleRetry(issueId: string, attempt: number, identifier: string, stream: string, error: string | null, continuation: boolean): void {
    // Failure-retry cap (extension): past the limit, halt instead of rescheduling.
    const cap = this.config.max_retry_attempts;
    if (!continuation && cap > 0 && attempt > cap) {
      this.halt(issueId, identifier, stream, `retry limit reached (${cap}): ${error ?? "worker failed"}`, attempt - 1);
      return;
    }
    this.cancelRetry(issueId);
    const delay = continuation
      ? 1000
      : Math.min(10000 * Math.pow(2, Math.max(attempt - 1, 0)), this.config.max_retry_backoff_ms);
    const timer = setTimeout(() => {
      void this.onRetryTimer(issueId);
    }, delay);
    this.retry_attempts.set(issueId, {
      issue_id: issueId,
      identifier,
      stream,
      attempt,
      due_at_ms: Date.now() + delay,
      timer,
      error,
    });
    this.claimed.add(issueId); // remains claimed while retry pending (SPEC §7.1)
  }

  private cancelRetry(issueId: string): void {
    const r = this.retry_attempts.get(issueId);
    if (r) {
      clearTimeout(r.timer);
      this.retry_attempts.delete(issueId);
    }
  }

  /** Stop retrying an issue but keep its claim so ticks cannot re-dispatch it. */
  private halt(issueId: string, identifier: string, stream: string, reason: string, attempts: number): void {
    this.cancelRetry(issueId);
    this.halted.set(issueId, { identifier, stream, reason, attempts, halted_at: new Date().toISOString() });
    this.claimed.add(issueId);
    this.logger.warn("retries halted; waiting for operator", { issue_id: issueId, issue_identifier: identifier, reason, attempts });
    this.notify();
  }

  /**
   * Operator Stop (console/API): terminate a running session or cancel a pending
   * retry, then hold the issue for a manual state change.
   */
  stopIssue(issueId: string): HaltedEntry | null {
    const existing = this.halted.get(issueId);
    if (existing) return existing; // idempotent
    const run = this.running.get(issueId);
    if (run) {
      // Halt before terminating so onWorkerExit sees the hold and keeps the claim.
      this.halt(issueId, run.identifier, run.stream, "stopped by operator", run.retry_attempt ?? 0);
      this.terminateRunning(issueId, false);
      return this.halted.get(issueId) ?? null;
    }
    const r = this.retry_attempts.get(issueId);
    if (!r) return null;
    this.halt(issueId, r.identifier, r.stream, "stopped by operator", r.attempt);
    return this.halted.get(issueId) ?? null;
  }

  /** Forget a halt (issue state changed or issue left the active states). */
  private releaseHalt(issueId: string): void {
    if (!this.halted.delete(issueId)) return;
    this.claimed.delete(issueId);
    this.notify();
  }

  // ---- delivery (extension: repository-backed workspaces) ----

  /** True when this project delivers work as repository branches. */
  private deliveryEnabled(): boolean {
    return this.config.workspace_repository !== null;
  }

  /**
   * Clean a stream's workspace, unless another issue still belongs to that stream
   * (SPEC Appendix B.5). Follow-ups share one worktree, so one member finishing must
   * not delete the workspace its siblings are queued to work in. `finishedId` is the
   * issue that just ended — it is excluded from the check whatever state it is in.
   *
   * A tracker that cannot list its issues cannot answer the question. Streams only
   * exist where issues can be created with a parent, which needs the same board
   * capability, so in practice that case has no follow-ups; a plain issue is its own
   * stream and cleans up as before.
   */
  private async cleanupStream(stream: string, finishedId: string): Promise<void> {
    if (this.adapter.listAllIssues) {
      try {
        const all = await this.adapter.listAllIssues();
        const sibling = all.find((i) => i.id !== finishedId && this.streamOf(i) === stream && !this.isTerminalState(i.state));
        if (sibling) {
          this.logger.info("workspace kept; another issue still belongs to this work stream", {
            stream,
            issue_identifier: sibling.identifier,
          });
          return;
        }
      } catch (err) {
        // Unknown membership: keeping a workspace costs disk, deleting one a sibling
        // still needs costs its work. Same trade-off as the manager's dirty check.
        this.logger.warn("stream membership unknown; keeping workspace", { stream, error: String(err) });
        return;
      }
    }
    await this.workspaceManager.cleanupForIssue(stream);
  }

  /**
   * Record the deliverable for an issue that just reached the success terminal
   * state (the first configured terminal state), then move it to the review
   * state instead of leaving it done: the operator inspects/merges the branch
   * and only then marks the issue done. Unsafe deliveries (uncommitted work in
   * the worktree, or a missing branch ref) are flagged needs_attention and the
   * worktree is preserved by the workspace manager's own guards. No-op for
   * scratch projects and for other terminal states (e.g. canceled).
   */
  private async finalizeDelivery(identifier: string, issueId: string, stream: string): Promise<void> {
    if (!this.deliveryEnabled()) return;
    let fresh: Issue | undefined;
    try {
      fresh = (await this.adapter.fetchIssuesByIds([issueId]))[0];
    } catch {
      return; // tracker hiccup: leave state as-is; cleanup guards still apply
    }
    if (!fresh) return;
    const doneState = this.config.tracker.terminal_states[0];
    if (!doneState || this.normState(fresh.state) !== this.normState(doneState)) return;
    // Keyed by stream: a follow-up delivers the branch it continued, and the base
    // recorded when that branch was cut still applies, so the diff stays cumulative.
    const info = await this.workspaceManager.deliveryInfo(stream);
    if (!info) return; // worktree already gone: nothing to record from

    const reasons: string[] = [];
    if (info.uncommitted.length > 0) reasons.push(`uncommitted changes left in workspace: ${info.uncommitted.join(", ")}`);
    if (!info.branch_exists) reasons.push(`issue branch ${info.branch} is missing in the repository`);
    // Only when git actually said so: `history_rewritten` is null when it could not
    // be established, and an unproven accusation would send an operator hunting
    // for work that was never lost.
    if (info.history_rewritten === true) {
      reasons.push(
        `branch history was rewritten: the previous delivery ${(info.parent_delivery_sha ?? "").slice(0, 7)} is no longer an ancestor of ${info.branch}`,
      );
    }
    // Anchor the delivery in git before the tracker hears about it and before
    // cleanup can remove the worktree: a record the tracker holds but git cannot
    // corroborate is exactly the failure this prevents. It never throws — but a
    // failure has to reach the operator, because the thing that failed is the
    // guarantee that the commit will still be there tomorrow.
    let anchored = false;
    try {
      anchored = await this.workspaceManager.recordDelivery(stream, {
        branch: info.branch,
        commit_sha: info.commit_sha,
        base_branch: info.base_branch,
        files_changed: info.files_changed,
      });
    } catch (err) {
      this.logger.warn("could not anchor delivery in git", { issue_id: issueId, issue_identifier: identifier, error: String(err) });
    }
    if (!anchored && info.commit_sha) {
      reasons.push(`delivered commit ${info.commit_sha.slice(0, 7)} could not be anchored in git; do not delete ${info.branch}`);
    }
    // `tests` and `summary` are deliberately absent, not null: the adapter fills
    // them from the agent's own result envelope, and an explicit null would be a
    // value that overwrites what it knows.
    const delivery: Partial<IssueDelivery> = {
      branch: info.branch,
      commit_sha: info.commit_sha,
      base_branch: info.base_branch,
      parent_delivery_sha: info.parent_delivery_sha,
      history_rewritten: info.history_rewritten === true,
      files_changed: info.files_changed,
      uncommitted: info.uncommitted,
      needs_attention: reasons.length > 0,
      attention_reason: reasons.length > 0 ? reasons.join("; ") : null,
      delivered_at: new Date().toISOString(),
      pushed_at: null,
    };
    try {
      if (this.adapter.setIssueDelivery) {
        await this.adapter.setIssueDelivery(issueId, delivery);
      } else {
        this.logger.warn("tracker cannot record delivery; skipping", { issue_id: issueId, issue_identifier: identifier });
      }
    } catch (err) {
      this.logger.warn("delivery record failed", { issue_id: issueId, issue_identifier: identifier, error: String(err) });
    }
    if (this.adapter.setIssueState) {
      try {
        await this.adapter.setIssueState(issueId, this.config.tracker.review_state);
        this.logger.info("issue delivered for review", {
          issue_id: issueId,
          issue_identifier: identifier,
          branch: delivery.branch,
          commit_sha: delivery.commit_sha ?? "",
          needs_attention: delivery.needs_attention,
        });
      } catch (err) {
        this.logger.warn("review-state transition failed", { issue_id: issueId, issue_identifier: identifier, error: String(err) });
      }
    }
  }

  /**
   * Push the recorded issue branch to the origin remote (delivery_mode push/pr).
   * Manual operator action from the console — never automatic.
   */
  async pushIssueBranch(id: string): Promise<{ branch: string; pushed_at: string }> {
    if (!this.deliveryEnabled()) throw new OrchestratorError("not_supported", "this project has no workspace.repository configured");
    if (!this.adapter.setIssueDelivery) throw new OrchestratorError("not_supported", "the active tracker does not support delivery records");
    const issue = (await this.adapter.fetchIssuesByIds([id]))[0];
    if (!issue) throw new OrchestratorError("not_found", `unknown issue ${id}`);
    const branch = issue.delivery?.branch;
    if (!branch) throw new OrchestratorError("conflict", `issue ${issue.identifier} has no recorded delivery to push`);
    try {
      await this.workspaceManager.pushBranch(branch);
    } catch (err) {
      // The push itself failed (no remote, rejected, network) — an upstream
      // problem, not a bad request.
      throw new OrchestratorError("upstream_failed", String((err as Error).message ?? err));
    }
    const pushed_at = new Date().toISOString();
    await this.adapter.setIssueDelivery(id, { pushed_at });
    this.logger.info("issue branch pushed", { issue_id: id, issue_identifier: issue.identifier, branch });
    this.notify();
    return { branch, pushed_at };
  }

  /** SPEC §16.6 on_retry_timer. */
  private async onRetryTimer(issueId: string): Promise<void> {
    const retry = this.retry_attempts.get(issueId);
    if (!retry) return;
    this.retry_attempts.delete(issueId);

    let refreshed: Issue[];
    try {
      refreshed = await this.adapter.fetchIssuesByIds([issueId]);
    } catch {
      this.scheduleRetry(issueId, retry.attempt + 1, retry.identifier, retry.stream, "retry refresh failed", false);
      return;
    }

    const issue = refreshed.find((i) => i.id === issueId) ?? null;
    if (!issue) {
      this.claimed.delete(issueId);
      this.notify();
      return;
    }
    const stream = this.streamOf(issue);
    if (this.isTerminalState(issue.state)) {
      // Record the deliverable (branch/commit/files) before the worktree goes, with the
      // stream held so a sibling cannot be dispatched into the worktree meanwhile.
      void this.windDownStream(issue.identifier, issue.id, stream);
      this.claimed.delete(issueId);
      this.notify();
      return;
    }
    if (!this.isActiveState(issue.state) || !this.isRoutable(issue)) {
      this.claimed.delete(issueId);
      this.notify();
      return;
    }
    if (this.availableSlots() <= 0 || !this.perStateSlotAvailable(issue.state)) {
      this.scheduleRetry(issueId, retry.attempt + 1, issue.identifier, stream, "no available orchestrator slots", false);
      this.notify();
      return;
    }
    // This path bypasses shouldDispatch, so it repeats the one-run-per-stream rule
    // (SPEC Appendix B.5). Waiting on a sibling is not a failure, so it does not
    // become another backoff attempt: the claim is released and the ordinary poll
    // loop re-dispatches this issue once the stream is free.
    if (this.busyStreams().has(stream)) {
      this.logger.info("retry deferred; work stream is busy", { issue_id: issueId, issue_identifier: issue.identifier, stream });
      this.claimed.delete(issueId);
      this.notify();
      return;
    }
    this.dispatch(issue, retry.attempt);
    this.notify();
  }

  // ---- reconciliation (SPEC §8.5, §16.3) ----

  private async reconcile(): Promise<void> {
    this.reconcileStalled();

    const runningIds = [...this.running.keys()];
    if (runningIds.length === 0) return;

    let refreshed: Issue[];
    try {
      refreshed = await this.adapter.fetchIssuesByIds(runningIds);
    } catch {
      this.logger.debug("reconcile refresh failed; keeping workers running");
      return;
    }

    const returned = new Set<string>();
    for (const issue of refreshed) {
      returned.add(issue.id);
      const entry = this.running.get(issue.id);
      if (!entry) continue;
      if (this.isTerminalState(issue.state)) {
        this.terminateRunning(issue.id, true);
      } else if (this.isActiveState(issue.state) && this.isRoutable(issue)) {
        entry.issue = issue; // update snapshot
      } else {
        this.terminateRunning(issue.id, false);
      }
    }
    for (const id of runningIds) {
      if (!returned.has(id)) this.terminateRunning(id, false);
    }
  }

  private reconcileStalled(): void {
    const stall = this.config.codex.stall_timeout_ms;
    if (stall <= 0) return; // disabled
    const now = Date.now();
    for (const [id, entry] of this.running) {
      if (entry.terminating) continue;
      const since = entry.last_event_ms ?? entry.started_ms;
      if (now - since > stall) {
        this.logger.warn("stall detected; terminating worker", { issue_id: id, issue_identifier: entry.identifier, elapsed_ms: now - since });
        // Stall → terminate + retry (not reconciliation release).
        entry.terminating = null;
        entry.stopSession?.();
      }
    }
  }

  /**
   * Terminate a running worker (SPEC §8.5). cleanupWorkspace only for terminal state.
   *
   * A terminal state is normally the agent's own doing (it moved the issue mid-turn
   * and is still committing/verifying), so that case is given a grace window: the
   * run is marked terminating but the live turn is left to settle on its own, and
   * only a run still going past {@link TERMINAL_GRACE_MS} is stopped outright.
   * Every other reason to terminate stops the session immediately, as before.
   */
  private terminateRunning(issueId: string, cleanupWorkspace: boolean): void {
    const entry = this.running.get(issueId);
    if (!entry) return;
    if (entry.terminating) {
      // Already winding down; enforce the grace deadline rather than re-arming it.
      this.enforceTerminalGrace(issueId, entry);
      return;
    }
    entry.terminating = { cleanupWorkspace, grace_until_ms: cleanupWorkspace ? Date.now() + TERMINAL_GRACE_MS : null };
    this.logger.info("terminating running issue", {
      issue_id: issueId,
      issue_identifier: entry.identifier,
      cleanup: cleanupWorkspace,
      grace: cleanupWorkspace ? TERMINAL_GRACE_MS : 0,
    });
    if (!cleanupWorkspace) entry.stopSession?.();
  }

  /** Stop a terminal-state run whose turn outstayed the grace window. */
  private enforceTerminalGrace(issueId: string, entry: RunningEntry): void {
    const until = entry.terminating?.grace_until_ms ?? null;
    if (until === null || Date.now() <= until) return;
    entry.terminating!.grace_until_ms = null;
    this.logger.warn("terminal-state grace expired; stopping session", { issue_id: issueId, issue_identifier: entry.identifier });
    entry.stopSession?.();
  }

  private addRuntimeSeconds(entry: RunningEntry): void {
    const secs = (Date.now() - entry.started_ms) / 1000;
    this.codex_totals.seconds_running += secs;
  }

  /** Retain a finished run's activity log so operators can review it after the fact. */
  private archiveLog(issueId: string, entry: RunningEntry, outcome: string, lastError: string | null): void {
    this.history.set(issueId, {
      identifier: entry.identifier,
      stream: entry.stream,
      url: entry.issue.url,
      events: entry.events.slice(-MAX_EVENTS),
      ended_at: new Date().toISOString(),
      last_error: lastError,
      outcome,
    });
    // Bound the history map to the most recent runs.
    while (this.history.size > MAX_HISTORY) {
      const oldest = this.history.keys().next().value;
      if (oldest === undefined) break;
      this.history.delete(oldest);
    }
  }

  // ---- startup cleanup (SPEC §8.6) ----

  private async startupTerminalCleanup(): Promise<void> {
    try {
      const terminal = await this.adapter.fetchIssuesByStates(this.config.tracker.terminal_states);
      // Deduplicated by stream: several terminal follow-ups name one workspace, and
      // cleanupStream still refuses any stream with a live member (Appendix B.5).
      const streams = new Set(terminal.map((i) => this.streamOf(i)));
      for (const stream of streams) {
        await this.cleanupStream(stream, "");
      }
    } catch (err) {
      this.logger.warn("startup terminal cleanup failed; continuing", { error: String(err) });
    }
  }

  // ---- dynamic reload (SPEC §6.2) ----

  /** Re-apply a reloaded workflow to future behavior. Never throws on bad input. */
  reload(def: WorkflowDefinition): void {
    let next: ServiceConfigValues;
    try {
      next = buildConfig(def, this.workflowPath);
      validateTracker(next.tracker.kind, next.tracker.provider);
      if (!isSupportedAgentKind(next.agent_kind)) throw new Error(`unsupported agent.kind: ${next.agent_kind}`);
    } catch (err) {
      this.logger.error("workflow reload rejected; keeping last good config", { error: String(err) });
      return;
    }
    const kindChanged = next.tracker.kind !== this.config.tracker.kind;
    const providerChanged = JSON.stringify(next.tracker.provider) !== JSON.stringify(this.config.tracker.provider);

    this.config = next;
    this.promptTemplate = def.prompt_template;
    this.workspaceManager.update(next.workspace_root, next.hooks, {
      repository: next.workspace_repository,
      base_branch: next.workspace_base_branch,
      branch_template: next.workspace_branch_template,
    });
    if (kindChanged || providerChanged) {
      try {
        this.adapter = createAdapter(next.tracker.kind, next.tracker.provider, next.workflowDir, this.logger);
      } catch (err) {
        this.logger.error("adapter rebuild failed on reload", { error: String(err) });
      }
    }
    this.logger.info("workflow reloaded", {
      poll_interval_ms: next.poll_interval_ms,
      max_concurrent_agents: next.max_concurrent_agents,
      tracker_kind: next.tracker.kind,
    });
    this.scheduleTick(0); // apply new cadence promptly
    this.notify();
  }

  // ---- snapshot (SPEC §13.3, §13.7.2) ----

  snapshot(): SnapshotView {
    const now = Date.now();
    let activeSeconds = 0;
    const running = [...this.running.entries()].map(([id, e]) => {
      activeSeconds += (now - e.started_ms) / 1000;
      return {
        issue_id: id,
        issue_identifier: e.identifier,
        issue_url: e.issue.url,
        state: e.issue.state,
        agent: e.agent,
        session_id: e.session.session_id,
        turn_count: e.session.turn_count,
        last_event: e.session.last_codex_event,
        last_message: e.session.last_codex_message ?? "",
        started_at: e.started_at,
        last_event_at: e.session.last_codex_timestamp,
        tokens: {
          input_tokens: e.session.codex_input_tokens,
          output_tokens: e.session.codex_output_tokens,
          total_tokens: e.session.codex_total_tokens,
        },
      };
    });
    const retrying = [...this.retry_attempts.values()].map((r) => ({
      issue_id: r.issue_id,
      issue_identifier: r.identifier,
      issue_url: this.running.get(r.issue_id)?.issue.url ?? null,
      attempt: r.attempt,
      due_at: new Date(r.due_at_ms).toISOString(),
      error: r.error,
    }));
    const halted = [...this.halted.entries()].map(([id, h]) => ({
      issue_id: id,
      issue_identifier: h.identifier,
      attempts: h.attempts,
      reason: h.reason,
      halted_at: h.halted_at,
    }));
    return {
      generated_at: new Date().toISOString(),
      counts: { running: running.length, retrying: retrying.length, halted: halted.length },
      running,
      retrying,
      halted,
      codex_totals: {
        input_tokens: this.codex_totals.input_tokens,
        output_tokens: this.codex_totals.output_tokens,
        total_tokens: this.codex_totals.total_tokens,
        seconds_running: round1(this.codex_totals.seconds_running + activeSeconds),
      },
      meta: {
        tracker_kind: this.config.tracker.kind,
        tracker_kinds: [...TRACKER_KINDS],
        agent_kind: this.config.agent_kind,
        agent_kinds: supportedAgentKinds(),
        default_agent: this.effectiveDefaultAgent(),
        poll_interval_ms: this.config.poll_interval_ms,
        max_concurrent_agents: this.config.max_concurrent_agents,
        active_states: this.config.tracker.active_states,
        backlog_states: this.config.tracker.backlog_states,
        terminal_states: this.config.tracker.terminal_states,
        workspace_root: this.config.workspace_root,
        repository: this.config.workspace_repository,
        delivery_mode: this.config.workspace_delivery_mode,
        review_state: this.deliveryEnabled() ? this.config.tracker.review_state : null,
        can_create: this.canCreateIssues(),
        can_edit: this.canEditIssues(),
        can_board: this.canBoard(),
        can_set_agent: this.canSetAgent(),
        can_follow_up: this.canFollowUp(),
      },
    };
  }

  /**
   * Per-issue detail for GET /api/v1/<identifier> (SPEC §13.7.2). Tries the live/
   * retrying/finished views synchronously; for an issue that has never run (e.g. one
   * sitting in backlog) it falls back to the tracker so the console shows an idle
   * detail instead of a spurious 404. Returns null only when the tracker has no such issue.
   * Retrying/halted/finished views carry no tracker state of their own, so those are
   * enriched with the issue's current tracker state via the same lookup.
   */
  async issueDetailFor(identifier: string): Promise<IssueDetailView | null> {
    const known = this.issueDetail(identifier);
    if (known && (known.running || known.state)) return this.withPersistedTranscript(known);
    if (known) {
      // A known run already carries the issue id, so enrich it with a targeted
      // fetch — the console polls this route, and listing every issue each time
      // would re-read the whole tracker for one row.
      let issue: Issue | undefined;
      let lookedUp = false;
      try {
        issue = (await this.adapter.fetchIssuesByIds([known.issue_id]))[0];
        lookedUp = true;
      } catch {
        issue = undefined;
      }
      if (issue) {
        known.state = issue.state;
        known.delivery = issue.delivery ?? null;
        applyEditableFields(known, issue);
      } else if (lookedUp) {
        // The record is gone (deleted): the retained log still renders, but there
        // is nothing left to edit or remove. A failed lookup is not proof of that.
        known.tracked = false;
      }
      return this.withPersistedTranscript(known);
    }
    if (!this.canBoard() || !this.adapter.listAllIssues) return null;
    let all: Issue[];
    try {
      all = await this.adapter.listAllIssues();
    } catch {
      return null;
    }
    const issue = all.find((i) => i.identifier === identifier);
    if (!issue) return null;
    return this.withPersistedTranscript({
      issue_identifier: identifier,
      issue_id: issue.id,
      status: this.isTerminalState(issue.state) ? "idle" : this.isActiveState(issue.state) ? "queued" : "idle",
      state: issue.state,
      title: issue.title,
      description: issue.description,
      priority: issue.priority,
      labels: issue.labels,
      agent: this.resolveAgentKind(issue),
      delivery: issue.delivery ?? null,
      follow_up_for: issue.follow_up_for,
      stream: this.streamOf(issue),
      workspace: { path: this.workspaceManager.workspacePathFor(this.streamOf(issue)) },
      running: null,
      retry: null,
      last_error: null,
      recent_events: this.history.get(issue.id)?.events ?? [],
    });
  }

  /**
   * When a finished run has no in-memory activity (Symphony restarted, or the run
   * predates this process), fall back to the agent backend's own persisted transcript
   * so the console can still show what happened. Live runs are left untouched.
   */
  private async withPersistedTranscript(view: IssueDetailView): Promise<IssueDetailView> {
    if (view.running) return view;
    if (view.recent_events && view.recent_events.length) return view;
    const kind = view.agent ?? this.effectiveDefaultAgent();
    const workspacePath = view.workspace?.path;
    if (!kind || !workspacePath) return view;
    try {
      const events = await readAgentTranscript(kind, {
        workspacePath,
        sessionId: null,
        config: this.config,
        logger: this.logger,
      });
      if (events.length) view.recent_events = events;
    } catch (err) {
      this.logger.warn("persisted transcript read failed", { issue: view.issue_identifier, agent: kind, error: String(err) });
    }
    return view;
  }

  /** Per-issue detail for GET /api/v1/<identifier> (SPEC §13.7.2). Returns null if unknown. */
  issueDetail(identifier: string): IssueDetailView | null {
    for (const [id, e] of this.running) {
      if (e.identifier === identifier) {
        return {
          issue_identifier: identifier,
          issue_id: id,
          status: "running",
          title: e.issue.title,
          description: e.issue.description,
          priority: e.issue.priority,
          labels: e.issue.labels,
          follow_up_for: e.issue.follow_up_for,
          stream: e.stream,
          workspace: { path: this.workspaceManager.workspacePathFor(e.stream) },
          running: {
            session_id: e.session.session_id,
            turn_count: e.session.turn_count,
            state: e.issue.state,
            agent: e.agent,
            started_at: e.started_at,
            last_event: e.session.last_codex_event,
            last_message: e.session.last_codex_message ?? "",
            last_event_at: e.session.last_codex_timestamp,
            tokens: {
              input_tokens: e.session.codex_input_tokens,
              output_tokens: e.session.codex_output_tokens,
              total_tokens: e.session.codex_total_tokens,
            },
          },
          retry: null,
          last_error: null,
          recent_events: e.events.slice(-MAX_EVENTS),
        };
      }
    }
    for (const [id, r] of this.retry_attempts) {
      if (r.identifier === identifier) {
        return {
          issue_identifier: identifier,
          issue_id: id,
          status: "retrying",
          stream: r.stream,
          workspace: { path: this.workspaceManager.workspacePathFor(r.stream) },
          running: null,
          retry: { attempt: r.attempt, due_at: new Date(r.due_at_ms).toISOString(), error: r.error },
          last_error: r.error,
          recent_events: this.history.get(id)?.events ?? [],
        };
      }
    }
    for (const [id, h] of this.halted) {
      if (h.identifier === identifier) {
        return {
          issue_identifier: identifier,
          issue_id: id,
          status: "halted",
          stream: h.stream,
          workspace: { path: this.workspaceManager.workspacePathFor(h.stream) },
          running: null,
          retry: null,
          last_error: h.reason,
          recent_events: this.history.get(id)?.events ?? [],
        };
      }
    }
    // Finished/terminated runs: serve the retained log so operators can review it.
    for (const [id, h] of this.history) {
      if (h.identifier === identifier) {
        return {
          issue_identifier: identifier,
          issue_id: id,
          status: h.outcome,
          stream: h.stream,
          workspace: { path: this.workspaceManager.workspacePathFor(h.stream) },
          running: null,
          retry: null,
          last_error: h.last_error,
          recent_events: h.events,
          ended_at: h.ended_at,
        };
      }
    }
    return null;
  }
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** Copy the tracker's editable fields onto a detail view so the console can prefill Edit. */
function applyEditableFields(view: IssueDetailView, issue: Issue): void {
  view.title = issue.title;
  view.description = issue.description;
  view.priority = issue.priority;
  view.labels = issue.labels;
  // Not editable, but only the tracker record carries it: the runtime views are
  // built from entries that predate the lookup.
  view.follow_up_for = issue.follow_up_for;
}

export interface SnapshotView {
  generated_at: string;
  counts: { running: number; retrying: number; halted: number };
  running: unknown[];
  retrying: unknown[];
  halted: unknown[];
  codex_totals: { input_tokens: number; output_tokens: number; total_tokens: number; seconds_running: number };
  meta: {
    tracker_kind: string;
    tracker_kinds: string[];
    agent_kind: string;
    agent_kinds: string[];
    default_agent: string;
    poll_interval_ms: number;
    max_concurrent_agents: number;
    active_states: string[];
    backlog_states: string[];
    terminal_states: string[];
    workspace_root: string;
    /** Repository path for branch-delivering projects, null for scratch projects. */
    repository: string | null;
    delivery_mode: string;
    /** State delivered issues wait in (null on scratch projects). */
    review_state: string | null;
    can_create: boolean;
    can_edit: boolean;
    can_board: boolean;
    can_set_agent: boolean;
    /** Whether this project can open follow-up issues on an existing branch. */
    can_follow_up: boolean;
  };
}

export interface BoardIssueView {
  id: string;
  identifier: string;
  title: string;
  state: string;
  priority: number | null;
  labels: string[];
  url: string | null;
  runtime: "running" | "retrying" | "halted" | "idle";
  /** Why retries stopped, when runtime is "halted". */
  halt_reason: string | null;
  turn_count: number | null;
  is_active: boolean;
  is_terminal: boolean;
  agent: string;
  agent_override: string | null;
  /** Delivery was recorded but flagged unsafe (uncommitted work / missing branch). */
  needs_attention: boolean;
  /** Issue this one follows up on, or null (SPEC Appendix B.5). */
  follow_up_for: string | null;
  /** Work stream owning this issue's branch/workspace; its own identifier when it leads one. */
  stream: string;
  /** Branch of the recorded delivery, or null — lets the console name a stream's branch. */
  delivery_branch: string | null;
  /**
   * Commits the stream's branch has that the configured base does not, and how far
   * behind the base it has fallen. Null when the project has no repository, or the
   * branch does not exist yet (extension).
   */
  ahead: number | null;
  behind: number | null;
  /**
   * The base already contains everything this branch delivered — it looks merged.
   * A prompt for the operator, never an automatic state change: git cannot tell a
   * merge from a branch that never had commits of its own, so this additionally
   * requires that the issue actually delivered files.
   */
  merged_hint: boolean;
}

export interface BoardView {
  generated_at: string;
  order: string[];
  active_states: string[];
  terminal_states: string[];
  backlog_states: string[];
  /** State delivered issues wait in for operator review (null on scratch projects). */
  review_state: string | null;
  start_state: string;
  issues: BoardIssueView[];
}

/** Order states for the board: backlog, then active, then terminal, then any others seen. */
function orderedStates(backlog: string[], active: string[], review: string[], terminal: string[], seen: string[]): string[] {
  const out: string[] = [];
  const push = (s: string) => { if (s && !out.some((x) => x.toLowerCase() === s.toLowerCase())) out.push(s); };
  backlog.forEach(push);
  active.forEach(push);
  review.forEach(push);
  terminal.forEach(push);
  seen.forEach(push);
  return out;
}

export interface IssueDetailView {
  issue_identifier: string;
  issue_id: string;
  status: string;
  /** Tracker state, present when the issue is not live (live runs carry it under `running`). */
  state?: string;
  /** False once the tracker record is gone (deleted) and only the retained log remains. */
  tracked?: boolean;
  /** Editable tracker fields, so the console can prefill the edit form (extension). */
  title?: string;
  description?: string | null;
  priority?: number | null;
  labels?: string[];
  /** Effective agent backend that would run this issue. */
  agent?: string;
  /** Issue this one follows up on (SPEC Appendix B.5), when the tracker record is available. */
  follow_up_for?: string | null;
  /** Work stream owning the workspace/branch shown here. Absent on views built before it is known. */
  stream?: string;
  /** Recorded deliverable (repository projects), enriched from the tracker. */
  delivery?: IssueDelivery | null;
  workspace: { path: string };
  running: unknown;
  retry: unknown;
  last_error: string | null;
  recent_events: { at: string; event: string; message: string }[];
  ended_at?: string;
}
