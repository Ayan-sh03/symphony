/**
 * Structured logging (SPEC §13.1, §13.2). Emits stable `key=value` lines to one
 * or more sinks. A failing sink never crashes orchestration (SPEC §13.2, §14.2);
 * remaining sinks still receive the record and a warning is surfaced once.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export type LogFields = Record<string, unknown>;

export interface Sink {
  name: string;
  write(line: string, level: LogLevel): void;
}

/** Default sink: stderr, so operators see failures without a debugger (SPEC §13.2). */
export class StderrSink implements Sink {
  name = "stderr";
  write(line: string): void {
    process.stderr.write(line + "\n");
  }
}

function formatValue(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") {
    return /[\s="]/.test(v) ? JSON.stringify(v) : v;
  }
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v);
}

/** Redact obvious secret-bearing keys so tokens never reach a sink (SPEC §15.3). */
const SECRET_KEY_RE = /(token|secret|password|api[_-]?key|authorization)/i;

export class Logger {
  private minLevel: number;
  private failedSinks = new Set<string>();

  private sinks: Sink[];
  constructor(sinks: Sink[] = [new StderrSink()], minLevel: LogLevel = "info") {
    this.sinks = sinks;
    this.minLevel = LEVEL_ORDER[minLevel];
  }

  private emit(level: LogLevel, msg: string, fields: LogFields): void {
    if (LEVEL_ORDER[level] < this.minLevel) return;
    const ts = new Date().toISOString();
    const parts = [`ts=${ts}`, `level=${level}`, `msg=${formatValue(msg)}`];
    for (const [k, v] of Object.entries(fields)) {
      if (v === undefined) continue;
      const safe = SECRET_KEY_RE.test(k) ? "[redacted]" : formatValue(v);
      parts.push(`${k}=${safe}`);
    }
    const line = parts.join(" ");
    for (const sink of this.sinks) {
      try {
        sink.write(line, level);
      } catch (err) {
        if (!this.failedSinks.has(sink.name)) {
          this.failedSinks.add(sink.name);
          // Surface once through any remaining sink (SPEC §13.2).
          const warn = `ts=${ts} level=warn msg="log sink failed" sink=${sink.name} error=${formatValue(String(err))}`;
          for (const other of this.sinks) {
            if (other === sink) continue;
            try {
              other.write(warn, "warn");
            } catch {
              /* give up on this sink too */
            }
          }
        }
      }
    }
  }

  debug(msg: string, fields: LogFields = {}): void {
    this.emit("debug", msg, fields);
  }
  info(msg: string, fields: LogFields = {}): void {
    this.emit("info", msg, fields);
  }
  warn(msg: string, fields: LogFields = {}): void {
    this.emit("warn", msg, fields);
  }
  error(msg: string, fields: LogFields = {}): void {
    this.emit("error", msg, fields);
  }
}

export const defaultLogger = new Logger();
