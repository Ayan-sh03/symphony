/**
 * opencode backend (SPEC §10, generalized per INTEGRATION.md §1–3). opencode has no
 * long-lived JSON-RPC protocol like the Codex app-server; instead each Symphony turn
 * maps to exactly one `opencode run --format json` invocation that runs to completion
 * and streams newline-delimited JSON events on stdout. Symphony-specific
 * responsibilities mirror the Codex client: launch (via {@link spawnShell}) in the
 * per-issue workspace, run the first turn with the rendered prompt and continuation
 * turns on the same opencode session, surface structured {@link AgentUpdate}s, and
 * enforce a per-turn timeout.
 *
 * Session model (verified against opencode 1.18.3):
 *  - The prompt is fed on the child's **stdin** (no CLI arg), so arbitrarily large /
 *    multi-line / quote-bearing prompts never touch shell quoting.
 *  - The first `run` creates the session; every event carries the `sessionID`. We
 *    capture it, emit `session_started`, and reuse it on later turns via `-s <id>`.
 *  - `--auto` auto-approves permissions (the opencode analogue of Codex
 *    approvalPolicy="never"); there are no approval round-trips to service.
 *  - The turn ends when the process exits: exit 0 → completed, non-zero → failed.
 */
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { spawnShell } from "../shell.ts";
import type { OpencodeConfig } from "../config/config.ts";
import type { AgentUpdate } from "../domain/types.ts";
import type {
  AgentSession,
  AgentSessionIdentity,
  AgentSessionOptions,
  AgentTurnResult,
} from "./types.ts";

const MAX_LINE = 10 * 1024 * 1024; // 10 MB safe buffering, matches the Codex client.

/** Running per-session token accumulator; totals only ever increase (SPEC §13.5). */
export interface OcTokenState {
  cumInput: number;
  cumOutput: number;
}

/** A mapped update: an event name plus fields to attach (timestamp/ids added on emit). */
export interface OcMapped {
  event: string;
  extra: Record<string, unknown>;
}

/** Result of mapping one raw opencode event. */
export interface OcMapResult {
  /** Session id observed on the event (present on essentially every event). */
  sessionId: string | null;
  /** Zero or more orchestrator updates to emit for this event. */
  updates: OcMapped[];
}

/**
 * Pure map from one parsed `opencode run --format json` event to Symphony updates.
 * Kept side-effect-free (except mutating the passed token accumulator) so it can be
 * unit-tested against a captured event sample without any subprocess. See
 * test/opencodeSession.test.ts.
 */
export function mapOpencodeEvent(evt: Record<string, unknown>, tokens: OcTokenState): OcMapResult {
  const type = typeof evt.type === "string" ? evt.type : "";
  const sessionId = typeof evt.sessionID === "string" ? evt.sessionID : null;
  const part = (evt.part ?? {}) as Record<string, unknown>;
  const updates: OcMapped[] = [];

  switch (type) {
    case "tool_use": {
      const tool = typeof part.tool === "string" ? part.tool : "tool";
      const state = (part.state ?? {}) as Record<string, unknown>;
      const input = (state.input ?? {}) as Record<string, unknown>;
      if (tool === "bash") {
        const cmd = typeof input.command === "string" ? input.command : "";
        updates.push({ event: "command", extra: { message: cmd ? cleanCommand(cmd).slice(0, 200) : "command executed" } });
      } else if (tool === "write" || tool === "edit" || tool === "patch" || tool === "multiedit") {
        updates.push({ event: "file_change", extra: { message: summarizeFileChange(tool, input) } });
      } else {
        // read / list / glob / grep / webfetch / mcp tools: low-value activity.
        const target = typeof input.filePath === "string" ? basename(input.filePath) : typeof input.pattern === "string" ? input.pattern : "";
        updates.push({ event: "tool_call", extra: { message: (target ? `${tool} ${target}` : tool).slice(0, 120) } });
      }
      break;
    }
    case "text": {
      const text = typeof part.text === "string" ? part.text : "";
      if (text.trim()) updates.push({ event: "agent_message", extra: { message: text.trim().slice(0, 800) } });
      break;
    }
    case "reasoning": {
      const text = typeof part.text === "string" ? part.text : "";
      if (text.trim()) updates.push({ event: "reasoning", extra: { message: text.trim().slice(0, 300) } });
      break;
    }
    case "step_finish": {
      const tok = (part.tokens ?? {}) as Record<string, unknown>;
      // opencode reports per-step input/output; accumulate into monotonic totals so
      // the orchestrator's max()-based delta de-dup stays correct (SPEC §13.5).
      tokens.cumInput += num(tok.input);
      tokens.cumOutput += num(tok.output);
      updates.push({
        event: "notification",
        extra: {
          kind: "token_usage",
          usage: {
            input_tokens: tokens.cumInput,
            output_tokens: tokens.cumOutput,
            total_tokens: tokens.cumInput + tokens.cumOutput,
          },
          absolute: true,
        },
      });
      break;
    }
    case "error": {
      updates.push({ event: "turn_ended_with_error", extra: { message: JSON.stringify(part).slice(0, 500) } });
      break;
    }
    default:
      break; // step_start and any unknown lifecycle noise
  }

  return { sessionId, updates };
}

/** opencode backend implementing the generic {@link AgentSession}. */
export class OpencodeSession implements AgentSession {
  private child: ChildProcessWithoutNullStreams | null = null;
  private buf = "";
  private _threadId: string | null = null;
  private _pid: string | null = null;
  private stopped = false;
  private started = false;
  private tokens: OcTokenState = { cumInput: 0, cumOutput: 0 };

  private activeTurn: {
    settle: (r: AgentTurnResult) => void;
    timer: NodeJS.Timeout;
    settled: boolean;
    errorMessage: string | null;
  } | null = null;

  private opts: AgentSessionOptions;
  constructor(opts: AgentSessionOptions) {
    this.opts = opts;
  }

  /** opencode-specific config subsection. */
  private get oc(): OpencodeConfig {
    return this.opts.config.opencode;
  }

  get threadId(): string | null {
    return this._threadId;
  }
  get pid(): string | null {
    return this._pid;
  }

  /**
   * opencode has no persistent server to launch: the session is created lazily by the
   * first `opencode run` (which mints the `ses_…` id). Per INTEGRATION.md §1 we defer
   * `session_started` to the first turn once the id is known. Returns a placeholder
   * identity (the runner ignores the return; identity is surfaced via emitted updates).
   */
  async start(): Promise<AgentSessionIdentity> {
    if (this.stopped) throw new Error("session stopped");
    this.started = true;
    return { threadId: this._threadId ?? "" };
  }

  /**
   * Run exactly one `opencode run` turn to completion (SPEC §10.3). `input` is the
   * rendered prompt (first turn) or continuation guidance (later turns); it is written
   * to the child's stdin to avoid shell quoting. `title` names the session on the first
   * turn only (best-effort metadata).
   */
  async runTurn(input: string, title?: string): Promise<AgentTurnResult> {
    if (this.stopped) return { status: "failed", error: "session stopped" };
    if (this.activeTurn) return { status: "failed", error: "turn already in progress" };

    const command = this.buildCommand(title);
    const { child } = spawnShell(command, this.opts.workspacePath, this.opts.env);
    this.child = child;
    this._pid = child.pid !== undefined ? String(child.pid) : null;

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d: string) => this.onData(d));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (d: string) => {
      const t = d.trim();
      if (t) this.opts.logger.debug("opencode stderr", { pid: this._pid, text: t.slice(0, 500) });
    });
    child.on("exit", (code) => this.onExit(code));
    child.on("error", (err) => this.onExit(null, err));

    return new Promise<AgentTurnResult>((resolve) => {
      const timer = setTimeout(() => {
        this.emit("turn_failed", { message: "turn_timeout" });
        this.killChild();
        this.settleTurn({ status: "timeout", error: "turn_timeout" });
      }, this.oc.turn_timeout_ms);

      this.activeTurn = { settle: resolve, timer, settled: false, errorMessage: null };
      this.emit("turn_started", {});

      // Feed the prompt on stdin, then close it so opencode begins the turn.
      try {
        child.stdin.write(input);
        child.stdin.end();
      } catch (err) {
        this.emit("turn_failed", { message: String(err) });
        this.killChild();
        this.settleTurn({ status: "failed", error: String(err) });
      }
    });
  }

  /** Kill any in-flight `opencode run` and settle its turn (SPEC §10.3). Idempotent. */
  stop(): void {
    this.stopped = true;
    this.killChild();
    if (this.activeTurn && !this.activeTurn.settled) {
      this.settleTurn({ status: "cancelled", error: "session stopped" });
    }
  }

  // ---- internals ----

  /** Assemble the `opencode run …` command line (prompt is passed via stdin). */
  private buildCommand(title?: string): string {
    const parts = [this.oc.command, "run", "--format", "json", "--auto"];
    parts.push("--dir", quote(this.opts.workspacePath));
    if (this.oc.model) parts.push("-m", quote(this.oc.model));
    if (this._threadId) parts.push("-s", quote(this._threadId));
    else if (title) {
      const t = sanitizeTitle(title);
      if (t) parts.push("--title", quote(t));
    }
    return parts.join(" ");
  }

  private onData(chunk: string): void {
    this.buf += chunk;
    if (this.buf.length > MAX_LINE * 4) this.buf = this.buf.slice(-MAX_LINE); // guard runaway
    let idx: number;
    while ((idx = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      if (!line) continue;
      let evt: Record<string, unknown>;
      try {
        evt = JSON.parse(line);
      } catch {
        this.emit("malformed", { text: line.slice(0, 300) });
        continue;
      }
      this.handleEvent(evt);
    }
  }

  private handleEvent(evt: Record<string, unknown>): void {
    const { sessionId, updates } = mapOpencodeEvent(evt, this.tokens);
    // First time we learn the opencode session id: adopt it as the thread and
    // announce the live session (INTEGRATION.md §1 lazy-id path).
    if (sessionId && !this._threadId) {
      this._threadId = sessionId;
      this.emit("session_started", { thread_id: sessionId });
    }
    for (const u of updates) {
      if (u.event === "turn_ended_with_error" && this.activeTurn) {
        this.activeTurn.errorMessage = typeof u.extra.message === "string" ? u.extra.message : "opencode error";
      }
      this.emit(u.event, u.extra);
    }
  }

  private onExit(code: number | null, err?: Error): void {
    if (err) this.opts.logger.debug("opencode process error", { error: String(err) });
    const child = this.child;
    this.child = null;
    this._pid = null;
    if (!this.activeTurn || this.activeTurn.settled) return;
    const stalledErr = this.activeTurn.errorMessage;
    if (err) {
      this.emit("turn_failed", { message: String(err) });
      this.settleTurn({ status: "failed", error: String(err) });
    } else if (code === 0) {
      this.emit("turn_completed", {});
      this.settleTurn({ status: "completed" });
    } else {
      const reason = stalledErr ?? `opencode exit code=${code}`;
      this.emit("turn_failed", { message: reason });
      this.settleTurn({ status: "failed", error: reason });
    }
    void child; // reference retained only for clarity
  }

  private killChild(): void {
    const c = this.child;
    if (c && c.exitCode === null) {
      try {
        c.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    }
  }

  private settleTurn(r: AgentTurnResult): void {
    const t = this.activeTurn;
    if (!t || t.settled) return;
    t.settled = true;
    clearTimeout(t.timer);
    this.activeTurn = null;
    t.settle(r);
  }

  private emit(event: string, extra: Record<string, unknown> = {}): void {
    const update: AgentUpdate = {
      event,
      timestamp: new Date().toISOString(),
      codex_app_server_pid: this._pid,
      thread_id: this._threadId,
      turn_id: null,
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

function basename(p: string): string {
  return p.split(/[\\/]/).pop() || p;
}

/**
 * Trim a raw command string down to the meaningful part for the activity log (adapted
 * from the Codex client): unwrap a `<shell> -Command/-c/-lc '<payload>'` wrapper, or
 * reduce a leading quoted executable path to its basename. opencode bash inputs are
 * usually already clean, so this is mostly a safety net.
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

function summarizeFileChange(tool: string, input: Record<string, unknown>): string {
  const fp = typeof input.filePath === "string" ? basename(input.filePath) : null;
  if (fp) return `${tool === "write" ? "wrote" : "edited"} ${fp}`;
  return "applied file changes";
}

/** Double-quote a shell argument, escaping embedded double-quotes. */
function quote(arg: string): string {
  return `"${arg.replace(/"/g, '\\"')}"`;
}

/** Sanitize a session title so it is safe as a single quoted CLI argument. */
function sanitizeTitle(title: string): string {
  return title.replace(/["`$\\\r\n]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
}
