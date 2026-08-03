/**
 * Codex app-server client (SPEC §10). Speaks newline-delimited JSON-RPC 2.0 over
 * the subprocess stdio, per the codex app-server v2 protocol (verified against
 * codex-cli 0.144.5). Symphony-specific responsibilities: launch in the per-issue
 * workspace, run the first turn with the rendered prompt and continuation turns on
 * the same live thread, surface structured events, and enforce timeouts.
 *
 * Approval/sandbox posture (documented): high-trust — approvalPolicy defaults to
 * "never" with a danger-full-access sandbox, so no approval round-trips occur.
 * Approval and dynamic-tool server requests are still handled defensively.
 */
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { spawnShell } from "../shell.ts";
import type { CodexConfig } from "../config/config.ts";
import type { AgentUpdate } from "../domain/types.ts";
import type {
  AgentSession,
  AgentSessionIdentity,
  AgentSessionOptions,
  AgentTurnResult,
} from "./types.ts";

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

const MAX_LINE = 10 * 1024 * 1024; // 10 MB safe buffering (SPEC §10.1)

/** Codex app-server backend implementing the generic {@link AgentSession}. */
export class CodexAppServerClient implements AgentSession {
  private child: ChildProcessWithoutNullStreams | null = null;
  private buf = "";
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private _threadId: string | null = null;
  private _pid: string | null = null;
  private stopped = false;
  private namedThread = false;

  private activeTurn: {
    turnId: string | null;
    settle: (r: AgentTurnResult) => void;
    timer: NodeJS.Timeout;
    settled: boolean;
  } | null = null;

  private opts: AgentSessionOptions;
  constructor(opts: AgentSessionOptions) {
    this.opts = opts;
  }

  /** Codex-specific config subsection. */
  private get codex(): CodexConfig {
    return this.opts.config.codex;
  }

  get threadId(): string | null {
    return this._threadId;
  }
  get pid(): string | null {
    return this._pid;
  }

  /** Launch subprocess, initialize, and start a thread. */
  async start(): Promise<AgentSessionIdentity> {
    const { child } = spawnShell(this.codex.command, this.opts.workspacePath, this.opts.env);
    this.child = child;
    this._pid = child.pid !== undefined ? String(child.pid) : null;

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d: string) => this.onData(d));
    // Keep diagnostic stderr separate from the protocol stream (SPEC §10.3).
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (d: string) => {
      const t = d.trim();
      if (t) this.opts.logger.debug("codex stderr", { pid: this._pid, text: t.slice(0, 500) });
    });
    child.on("exit", (code) => this.onExit(code));
    child.on("error", (err) => this.onExit(null, err));

    try {
      await this.request("initialize", {
        clientInfo: { name: "symphony", version: "1.0.0", title: "Symphony" },
      });
      const threadStart: Record<string, unknown> = {
        cwd: this.opts.workspacePath,
        approvalPolicy: this.codex.approval_policy,
        sandbox: this.codex.thread_sandbox,
      };
      // Per-run model override (extension, Appendix B.7). `ThreadStartParams.model` is
      // `string|null` in the v2 protocol; omitted entirely when unset so codex applies
      // its own configured default exactly as before.
      //
      // Verified: codex accepts an unknown model id here without complaint and only
      // fails once a turn runs. So a typo surfaces as a failed turn, not a failed
      // start — which is the intended division of labour (the CLI validates, we do
      // not), but it does mean the operator learns about it from the run, not the form.
      if (this.opts.model) threadStart.model = this.opts.model;
      const threadRes = (await this.request("thread/start", threadStart)) as { thread?: { id?: string } };
      const tid = threadRes?.thread?.id;
      if (!tid) throw new Error("thread/start returned no thread id");
      this._threadId = tid;
      this.emit("session_started", { thread_id: tid });
      return { threadId: tid };
    } catch (err) {
      this.emit("startup_failed", { message: String(err) });
      throw err;
    }
  }

  /**
   * Run one turn on the live thread and resolve when it terminates (SPEC §10.3).
   * @param input rendered prompt (first turn) or continuation guidance (later turns)
   * @param title optional issue-identifying thread title (SPEC §10.2). Set once,
   *   best-effort, via `thread/name/set`; codex's `summary` field is a summary MODE
   *   enum, not a free-text title, so it is deliberately not used for this.
   */
  async runTurn(input: string, title?: string): Promise<AgentTurnResult> {
    if (!this._threadId) return { status: "failed", error: "no active thread" };
    if (this.stopped) return { status: "failed", error: "session stopped" };

    // Best-effort thread title (issue-identifying metadata). Ignore failures.
    if (title && !this.namedThread) {
      this.namedThread = true;
      this.request("thread/name/set", { threadId: this._threadId, name: title }).catch(() => {});
    }

    return new Promise<AgentTurnResult>((resolve) => {
      const timer = setTimeout(() => {
        this.emit("turn_failed", { message: "turn_timeout" });
        this.settleTurn({ status: "timeout", error: "turn_timeout" });
      }, this.codex.turn_timeout_ms);

      this.activeTurn = { turnId: null, settle: resolve, timer, settled: false };

      this.request(
        "turn/start",
        {
          threadId: this._threadId,
          cwd: this.opts.workspacePath,
          approvalPolicy: this.codex.approval_policy,
          sandboxPolicy: this.codex.turn_sandbox_policy,
          input: [{ type: "text", text: input }],
        },
        this.codex.turn_timeout_ms,
      )
        .then((res) => {
          const turnId = (res as { turn?: { id?: string } })?.turn?.id ?? null;
          if (this.activeTurn) this.activeTurn.turnId = turnId;
        })
        .catch((err) => {
          this.emit("turn_failed", { message: String(err) });
          this.settleTurn({ status: "failed", error: String(err) });
        });
    });
  }

  /** Stop the app-server subprocess at the end of a worker run (SPEC §10.3). */
  stop(): void {
    this.stopped = true;
    if (this.activeTurn && !this.activeTurn.settled) {
      this.settleTurn({ status: "cancelled", error: "session stopped" });
    }
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error("session stopped"));
    }
    this.pending.clear();
    if (this.child && this.child.exitCode === null) {
      try {
        this.child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    }
  }

  // ---- internals ----

  private settleTurn(r: AgentTurnResult): void {
    const t = this.activeTurn;
    if (!t || t.settled) return;
    t.settled = true;
    clearTimeout(t.timer);
    this.activeTurn = null;
    t.settle(r);
  }

  private onExit(code: number | null, err?: Error): void {
    if (err) this.opts.logger.debug("codex process error", { error: String(err) });
    const wasStopped = this.stopped;
    this.stopped = true;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(`codex process exited (code=${code})`));
    }
    this.pending.clear();
    if (!wasStopped && this.activeTurn && !this.activeTurn.settled) {
      this.emit("turn_failed", { message: `port_exit code=${code}` });
      this.settleTurn({ status: "failed", error: `subprocess exit (code=${code})` });
    }
  }

  private request(method: string, params: unknown, timeoutMs?: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.child || this.stopped) {
        reject(new Error("codex process not running"));
        return;
      }
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`response_timeout for ${method}`));
      }, timeoutMs ?? this.codex.read_timeout_ms);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  private respond(id: number | string, result: unknown): void {
    this.write({ jsonrpc: "2.0", id, result });
  }

  private write(obj: unknown): void {
    if (!this.child) return;
    try {
      this.child.stdin.write(JSON.stringify(obj) + "\n");
    } catch (err) {
      this.opts.logger.debug("codex write failed", { error: String(err) });
    }
  }

  private onData(chunk: string): void {
    this.buf += chunk;
    if (this.buf.length > MAX_LINE * 4) this.buf = this.buf.slice(-MAX_LINE); // guard runaway
    let idx: number;
    while ((idx = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      if (!line) continue;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line);
      } catch {
        this.emit("malformed", { text: line.slice(0, 300) });
        continue;
      }
      this.route(msg);
    }
  }

  private route(msg: Record<string, unknown>): void {
    const hasId = msg.id !== undefined && msg.id !== null;
    const method = typeof msg.method === "string" ? msg.method : null;

    if (hasId && method) {
      // Server -> client request (approvals, tool calls, user input) (SPEC §10.5).
      this.handleServerRequest(msg.id as number | string, method, msg.params);
      return;
    }
    if (method) {
      this.handleNotification(method, (msg.params ?? {}) as Record<string, unknown>);
      return;
    }
    if (hasId) {
      // Response to one of our requests.
      const id = msg.id as number;
      const p = this.pending.get(id);
      if (!p) return;
      this.pending.delete(id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(`response_error: ${JSON.stringify(msg.error)}`));
      else p.resolve(msg.result);
    }
  }

  private handleServerRequest(id: number | string, method: string, params: unknown): void {
    switch (method) {
      case "execCommandApproval":
      case "item/commandExecution/requestApproval":
      case "applyPatchApproval": // ReviewDecision-shaped
      case "item/permissions/requestApproval":
        this.emit("approval_auto_approved", { method });
        this.respond(id, { decision: "approved" });
        return;
      case "item/fileChange/requestApproval":
        // FileChangeApprovalDecision uses a different enum (SPEC §10.5 documented policy).
        this.emit("approval_auto_approved", { method });
        this.respond(id, { decision: "accept" });
        return;
      case "item/tool/requestUserInput":
        // High-trust policy: user-input-required is a hard failure, but we must
        // respond so the protocol does not stall (SPEC §10.5).
        this.emit("turn_input_required", { method });
        this.respond(id, { answers: {} });
        if (this.activeTurn && !this.activeTurn.settled) {
          this.settleTurn({ status: "failed", error: "turn_input_required" });
        }
        return;
      case "item/tool/call":
        void this.handleToolCall(id, params as Record<string, unknown>);
        return;
      default:
        // Unknown server request: respond generically to avoid stalling.
        this.emit("other_message", { method });
        this.respond(id, {});
        return;
    }
  }

  private async handleToolCall(id: number | string, params: Record<string, unknown>): Promise<void> {
    const toolName = typeof params.tool === "string" ? params.tool : "";
    const known = this.opts.toolSpecs.some((t) => t.name === toolName);
    if (!known) {
      // Unsupported dynamic tool call: structured failure, continue session (SPEC §10.5).
      this.emit("unsupported_tool_call", { tool: toolName });
      this.respond(id, {
        success: false,
        contentItems: [{ type: "inputText", text: `unsupported tool: ${toolName}` }],
      });
      return;
    }
    try {
      const result = await this.opts.adapter.executeAgentTool(toolName, params.arguments, {
        issue: this.opts.issue,
      });
      this.emit("notification", { tool: toolName, success: result.success });
      this.respond(id, {
        success: result.success,
        contentItems: [{ type: "inputText", text: JSON.stringify(result.output) }],
      });
    } catch (err) {
      this.respond(id, {
        success: false,
        contentItems: [{ type: "inputText", text: `tool error: ${String(err)}` }],
      });
    }
  }

  private handleNotification(method: string, params: Record<string, unknown>): void {
    switch (method) {
      case "thread/started": {
        const thread = params.thread as { id?: string } | undefined;
        if (thread?.id) this._threadId = thread.id;
        return;
      }
      case "turn/started": {
        const turn = params.turn as { id?: string } | undefined;
        if (this.activeTurn && turn?.id) this.activeTurn.turnId = turn.id;
        this.emit("turn_started", { turn_id: turn?.id ?? null });
        return;
      }
      case "turn/completed": {
        const turn = params.turn as { id?: string; status?: string; error?: unknown } | undefined;
        const status = turn?.status;
        if (status === "completed") {
          this.emit("turn_completed", { turn_id: turn?.id ?? null });
          this.settleTurn({ status: "completed" });
        } else if (status === "cancelled") {
          this.emit("turn_cancelled", { turn_id: turn?.id ?? null });
          this.settleTurn({ status: "cancelled", error: "turn_cancelled" });
        } else {
          this.emit("turn_failed", { turn_id: turn?.id ?? null, error: turn?.error });
          this.settleTurn({ status: "failed", error: `turn ${status}` });
        }
        return;
      }
      case "thread/tokenUsage/updated": {
        const usage = (params.tokenUsage as Record<string, unknown> | undefined)?.total as
          | Record<string, unknown>
          | undefined;
        if (usage) {
          this.emit("notification", {
            kind: "token_usage",
            usage: {
              input_tokens: num(usage.inputTokens),
              output_tokens: num(usage.outputTokens),
              total_tokens: num(usage.totalTokens),
            },
            absolute: true,
          });
        }
        return;
      }
      case "account/rateLimits/updated":
        return; // account metering noise; not part of run observability
      case "error": {
        this.emit("turn_ended_with_error", { message: JSON.stringify(params).slice(0, 500) });
        return;
      }
      case "item/completed": {
        // Turn item output into readable activity-log events (SPEC §13.6).
        const item = params.item as Record<string, unknown> | undefined;
        const type = typeof item?.type === "string" ? item.type : "";
        if (type === "agentMessage") {
          const text = typeof item?.text === "string" ? item.text : "";
          if (text.trim()) this.emit("agent_message", { message: text.trim().slice(0, 800) });
        } else if (type === "commandExecution") {
          const cmd = typeof item?.command === "string" ? item.command : (item?.parsedCmd as string) || "";
          this.emit("command", { message: cmd ? cleanCommand(cmd).slice(0, 200) : "command executed" });
        } else if (type === "fileChange") {
          this.emit("file_change", { message: summarizeFileChange(item) });
        } else if (type === "reasoning") {
          const text = typeof item?.text === "string" ? item.text : "";
          if (text.trim()) this.emit("reasoning", { message: text.trim().slice(0, 300) });
        } else if (type === "mcpToolCall") {
          const name = typeof item?.toolName === "string" ? item.toolName : "tool";
          this.emit("tool_call", { message: String(name).slice(0, 120) });
        }
        return;
      }
      case "item/started":
        return; // low-value item lifecycle noise
      default:
        return;
    }
  }

  private emit(event: string, extra: Record<string, unknown> = {}): void {
    const update: AgentUpdate = {
      event,
      timestamp: new Date().toISOString(),
      codex_app_server_pid: this._pid,
      thread_id: this._threadId,
      turn_id: this.activeTurn?.turnId ?? null,
      ...extra,
    };
    try {
      this.opts.onUpdate(update);
    } catch (err) {
      this.opts.logger.debug("onUpdate threw", { error: String(err) });
    }
  }
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/**
 * Trim a raw command string down to the meaningful part for the activity log:
 * unwrap a `<shell> -Command/-c/-lc '<payload>'` invocation, or reduce a leading
 * quoted executable path to its basename (e.g. the full pwsh.exe path).
 */
function cleanCommand(raw: string): string {
  const s = raw.trim();
  const wrapped = s.match(/-(?:Command|lc|c)\s+(['"])([\s\S]+?)\1\s*$/i);
  if (wrapped) return wrapped[2]!.trim();
  const leadingQuoted = s.match(/^"([^"]+)"(.*)$/);
  if (leadingQuoted) {
    const base = leadingQuoted[1]!.split(/[\\/]/).pop() || leadingQuoted[1]!;
    return (base + leadingQuoted[2]!).trim();
  }
  return s;
}

function summarizeFileChange(item: Record<string, unknown> | undefined): string {
  const changes = item?.changes;
  if (Array.isArray(changes)) {
    const names = changes
      .map((c) => (c && typeof c === "object" ? (c as Record<string, unknown>).path : null))
      .filter((p): p is string => typeof p === "string")
      .map((p) => p.split(/[\\/]/).pop());
    if (names.length) return `edited ${names.slice(0, 4).join(", ")}${names.length > 4 ? " …" : ""}`;
  }
  return "applied file changes";
}
