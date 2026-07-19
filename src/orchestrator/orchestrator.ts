/**
 * Orchestrator (SPEC §7, §8, §16). The single authority that mutates scheduling
 * state. Node's single-threaded event loop serializes these mutations; all worker
 * outcomes are reported back here and converted into explicit transitions.
 */
import type { Issue, AgentUpdate, LiveSession } from "../domain/types.ts";
import type { Logger } from "../logger.ts";
import type { ServiceConfigValues } from "../config/config.ts";
import type { WorkflowDefinition } from "../domain/types.ts";
import type { TrackerAdapter } from "../tracker/types.ts";
import { WorkspaceManager } from "../workspace/manager.ts";
import { createAdapter, validateTracker, SUPPORTED_KINDS as TRACKER_KINDS } from "../tracker/registry.ts";
import { isSupportedAgentKind, supportedAgentKinds, readAgentTranscript } from "../agent/registry.ts";
import { runAgentAttempt, type WorkerExit } from "../agent/runner.ts";
import { buildConfig } from "../config/config.ts";

/** One entry in an agent's activity log (SPEC §13.7.2 recent_events). */
interface LogEvent {
  at: string;
  event: string;
  message: string;
}

interface RunningEntry {
  identifier: string;
  issue: Issue;
  session: LiveSession;
  retry_attempt: number | null;
  started_at: string;
  started_ms: number;
  last_event_ms: number | null;
  stopSession: (() => void) | null;
  terminating: { cleanupWorkspace: boolean } | null;
  workerDone: Promise<void>;
  events: LogEvent[];
  agent: string;
}

/** Retained activity log for a finished/terminated run, so logs survive the run. */
interface FinishedLog {
  identifier: string;
  url: string | null;
  events: LogEvent[];
  ended_at: string;
  last_error: string | null;
  outcome: string;
}

const MAX_EVENTS = 80;
const MAX_HISTORY = 40;

interface RetryEntry {
  issue_id: string;
  identifier: string;
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
    const issue = await this.adapter.createIssue(input);
    this.logger.info("issue created", { issue_id: issue.id, issue_identifier: issue.identifier });
    this.scheduleTick(0);
    this.notify();
    return issue;
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
    const order = orderedStates(
      this.config.tracker.backlog_states,
      this.config.tracker.active_states,
      this.config.tracker.terminal_states,
      all.map((i) => i.state),
    );
    const issues = all.map((i) => {
      const run = this.running.get(i.id);
      const halt = this.halted.get(i.id) ?? null;
      const runtime: BoardIssueView["runtime"] = run ? "running" : this.retry_attempts.has(i.id) ? "retrying" : halt ? "halted" : "idle";
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
      };
    });
    return {
      generated_at: new Date().toISOString(),
      order,
      active_states: this.config.tracker.active_states,
      terminal_states: this.config.tracker.terminal_states,
      backlog_states: this.config.tracker.backlog_states,
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

      for (const issue of this.sortForDispatch(issues)) {
        if (this.availableSlots() <= 0) break;
        if (this.shouldDispatch(issue)) this.dispatch(issue, null);
      }
      this.notify();
    } finally {
      this.scheduleTick(this.config.poll_interval_ms);
    }
  }

  // ---- candidate selection (SPEC §8.2) ----

  private shouldDispatch(issue: Issue): boolean {
    if (!issue.id || !issue.identifier || !issue.title || !issue.state) return false;
    if (!this.isActiveState(issue.state) || this.isTerminalState(issue.state)) return false;
    if (!issue.dispatchable) return false;
    if (!this.isRoutable(issue)) return false; // required labels
    if (this.running.has(issue.id)) return false;
    if (this.claimed.has(issue.id)) return false;
    if (this.availableSlots() <= 0) return false;
    if (!this.perStateSlotAvailable(issue.state)) return false;
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
    const entry: RunningEntry = {
      identifier: issue.identifier,
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

    this.logger.info("dispatch", { issue_id: issue.id, issue_identifier: issue.identifier, agent: agentKind, attempt: attempt ?? "" });

    const childEnv = this.buildChildEnv();
    entry.workerDone = (async () => {
      let exit: WorkerExit;
      try {
        exit = await runAgentAttempt(issue, attempt, {
          config: this.config,
          agentKind,
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

    const outcome = entry.terminating ? "canceled" : exit.kind === "normal" ? "completed" : "failed";
    const lastError = exit.kind === "abnormal" ? exit.reason ?? "worker failed" : null;
    if (lastError) entry.events.push({ at: new Date().toISOString(), event: "worker_failed", message: lastError });
    this.archiveLog(issueId, entry, outcome, lastError);

    // Terminated by reconciliation: release claim, optional cleanup, no retry.
    if (entry.terminating) {
      if (entry.terminating.cleanupWorkspace) void this.workspaceManager.cleanupForIssue(entry.identifier);
      this.claimed.delete(issueId);
      this.logger.info("run canceled by reconciliation", { issue_id: issueId, issue_identifier: entry.identifier });
      this.notify();
      return;
    }

    if (exit.kind === "normal") {
      this.completed.add(issueId); // bookkeeping only (SPEC §7.1)
      // Short continuation retry to re-check activity (SPEC §7.1, §8.4).
      this.scheduleRetry(issueId, 1, entry.identifier, null, /*continuation*/ true);
      this.logger.info("worker completed", { issue_id: issueId, issue_identifier: entry.identifier });
    } else {
      const nextAttempt = (entry.retry_attempt ?? 0) + 1;
      this.scheduleRetry(issueId, nextAttempt, entry.identifier, exit.reason ?? "worker failed", false);
      this.logger.warn("worker failed; retrying", { issue_id: issueId, issue_identifier: entry.identifier, attempt: nextAttempt, reason: exit.reason });
    }
    this.notify();
  }

  /** SPEC §8.4 backoff. Continuation = fixed 1s; failure = 10s * 2^(attempt-1) capped. */
  private scheduleRetry(issueId: string, attempt: number, identifier: string, error: string | null, continuation: boolean): void {
    // Failure-retry cap (extension): past the limit, halt instead of rescheduling.
    const cap = this.config.max_retry_attempts;
    if (!continuation && cap > 0 && attempt > cap) {
      this.halt(issueId, identifier, `retry limit reached (${cap}): ${error ?? "worker failed"}`, attempt - 1);
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
  private halt(issueId: string, identifier: string, reason: string, attempts: number): void {
    this.cancelRetry(issueId);
    this.halted.set(issueId, { identifier, reason, attempts, halted_at: new Date().toISOString() });
    this.claimed.add(issueId);
    this.logger.warn("retries halted; waiting for operator", { issue_id: issueId, issue_identifier: identifier, reason, attempts });
    this.notify();
  }

  /** Operator Stop (console/API): cancel a pending retry and hold the issue for a manual state change. */
  stopRetry(issueId: string): HaltedEntry | null {
    const existing = this.halted.get(issueId);
    if (existing) return existing; // idempotent
    const r = this.retry_attempts.get(issueId);
    if (!r) return null;
    this.halt(issueId, r.identifier, "stopped by operator", r.attempt);
    return this.halted.get(issueId) ?? null;
  }

  /** Forget a halt (issue state changed or issue left the active states). */
  private releaseHalt(issueId: string): void {
    if (!this.halted.delete(issueId)) return;
    this.claimed.delete(issueId);
    this.notify();
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
      this.scheduleRetry(issueId, retry.attempt + 1, retry.identifier, "retry refresh failed", false);
      return;
    }

    const issue = refreshed.find((i) => i.id === issueId) ?? null;
    if (!issue) {
      this.claimed.delete(issueId);
      this.notify();
      return;
    }
    if (this.isTerminalState(issue.state)) {
      void this.workspaceManager.cleanupForIssue(issue.identifier);
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
      this.scheduleRetry(issueId, retry.attempt + 1, issue.identifier, "no available orchestrator slots", false);
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

  /** Terminate a running worker (SPEC §8.5). cleanupWorkspace only for terminal state. */
  private terminateRunning(issueId: string, cleanupWorkspace: boolean): void {
    const entry = this.running.get(issueId);
    if (!entry) return;
    entry.terminating = { cleanupWorkspace };
    this.logger.info("terminating running issue", { issue_id: issueId, issue_identifier: entry.identifier, cleanup: cleanupWorkspace });
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
      for (const issue of terminal) {
        await this.workspaceManager.cleanupForIssue(issue.identifier);
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
    this.workspaceManager.update(next.workspace_root, next.hooks);
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
        can_create: this.canCreateIssues(),
        can_board: this.canBoard(),
        can_set_agent: this.canSetAgent(),
      },
    };
  }

  /**
   * Per-issue detail for GET /api/v1/<identifier> (SPEC §13.7.2). Tries the live/
   * retrying/finished views synchronously; for an issue that has never run (e.g. one
   * sitting in backlog) it falls back to the tracker so the console shows an idle
   * detail instead of a spurious 404. Returns null only when the tracker has no such issue.
   */
  async issueDetailFor(identifier: string): Promise<IssueDetailView | null> {
    const known = this.issueDetail(identifier);
    if (known) return this.withPersistedTranscript(known);
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
      agent: this.resolveAgentKind(issue),
      workspace: { path: this.workspaceManager.workspacePathFor(identifier) },
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
          workspace: { path: this.workspaceManager.workspacePathFor(identifier) },
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
          workspace: { path: this.workspaceManager.workspacePathFor(identifier) },
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
          workspace: { path: this.workspaceManager.workspacePathFor(identifier) },
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
          workspace: { path: this.workspaceManager.workspacePathFor(identifier) },
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
    can_create: boolean;
    can_board: boolean;
    can_set_agent: boolean;
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
}

export interface BoardView {
  generated_at: string;
  order: string[];
  active_states: string[];
  terminal_states: string[];
  backlog_states: string[];
  start_state: string;
  issues: BoardIssueView[];
}

/** Order states for the board: backlog, then active, then terminal, then any others seen. */
function orderedStates(backlog: string[], active: string[], terminal: string[], seen: string[]): string[] {
  const out: string[] = [];
  const push = (s: string) => { if (s && !out.some((x) => x.toLowerCase() === s.toLowerCase())) out.push(s); };
  backlog.forEach(push);
  active.forEach(push);
  terminal.forEach(push);
  seen.forEach(push);
  return out;
}

export interface IssueDetailView {
  issue_identifier: string;
  issue_id: string;
  status: string;
  /** Tracker state, present for idle/queued issues that are not live. */
  state?: string;
  /** Effective agent backend that would run this issue. */
  agent?: string;
  workspace: { path: string };
  running: unknown;
  retry: unknown;
  last_error: string | null;
  recent_events: { at: string; event: string; message: string }[];
  ended_at?: string;
}
