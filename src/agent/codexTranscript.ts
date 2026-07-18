/**
 * Read Codex's own persisted session transcript (the `readTranscript` capability for
 * the codex backend). Codex writes one JSONL "rollout" per session under
 * `$CODEX_HOME/sessions/<YYYY>/<MM>/<DD>/rollout-<ts>-<session_id>.jsonl`; the header
 * `session_meta` line stamps the `cwd` (our per-issue workspace) and `originator`.
 * We locate the rollout for a workspace/session and map its events onto the console's
 * activity-log vocabulary. Best-effort: never throws, returns [] when nothing matches.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TranscriptEvent, TranscriptQuery } from "./types.ts";

function codexHome(): string {
  return process.env.CODEX_HOME && process.env.CODEX_HOME.trim()
    ? process.env.CODEX_HOME
    : path.join(os.homedir(), ".codex");
}

/** Path comparison that tolerates Windows case/separator differences. */
function samePath(a: string, b: string): boolean {
  const norm = (p: string) => {
    let r = path.resolve(p).replace(/[\\/]+$/, "");
    if (process.platform === "win32") r = r.toLowerCase();
    return r;
  };
  return norm(a) === norm(b);
}

/** Pull a JSON string field out of a (possibly truncated) rollout header buffer. */
function headerField(buf: string, key: string): string | null {
  const m = buf.match(new RegExp('"' + key + '":"((?:[^"\\\\]|\\\\.)*)"'));
  if (!m) return null;
  try {
    return JSON.parse('"' + m[1] + '"') as string;
  } catch {
    return null;
  }
}

async function listRollouts(sessionsDir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.isFile() && /^rollout-.*\.jsonl$/.test(e.name)) out.push(full);
    }
  }
  await walk(sessionsDir);
  return out;
}

/** Read the header region of a rollout (first line may be large — base instructions). */
async function readHeader(file: string): Promise<string> {
  const fh = await fs.open(file, "r");
  try {
    const buf = Buffer.alloc(131072);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    return buf.toString("utf8", 0, bytesRead);
  } finally {
    await fh.close();
  }
}

function toMessage(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** Map one parsed rollout line onto an activity-log event, or null to skip it. */
function mapLine(line: Record<string, unknown>): { event: string; message: string } | null {
  const type = line.type;
  const payload = (line.payload ?? {}) as Record<string, unknown>;
  const pt = payload.type;

  if (type === "event_msg") {
    if (pt === "task_started") return { event: "turn_started", message: "" };
    if (pt === "agent_message") return { event: "agent_message", message: toMessage(payload.message) };
    if (pt === "task_complete") return { event: "turn_completed", message: toMessage(payload.last_agent_message) };
    if (pt === "patch_apply_end") {
      const changes = (payload.changes ?? {}) as Record<string, unknown>;
      const files = Object.keys(changes).map((p) => path.basename(p));
      const msg = files.length ? files.join(", ") : toMessage(payload.stdout).split("\n").filter(Boolean).slice(-1)[0] || "";
      return { event: "file_change", message: msg };
    }
    return null; // token_count, user_message, thread_settings_applied, etc.
  }

  if (type === "response_item" && pt === "function_call") {
    const name = toMessage(payload.name);
    if (name === "shell_command" || name === "shell") {
      let cmd = "";
      try {
        const args = JSON.parse(toMessage(payload.arguments)) as Record<string, unknown>;
        cmd = toMessage(args.command);
      } catch {
        cmd = toMessage(payload.arguments);
      }
      return { event: "command", message: cmd };
    }
    return { event: "tool_call", message: name };
  }

  return null; // reasoning (encrypted), response_item messages/outputs, world_state, turn_context
}

export async function readCodexTranscript(query: TranscriptQuery): Promise<TranscriptEvent[]> {
  const sessionsDir = path.join(codexHome(), "sessions");
  let files: string[];
  try {
    files = await listRollouts(sessionsDir);
  } catch {
    return [];
  }
  if (!files.length) return [];

  // Newest first, so the latest run for a workspace wins when no session id is given.
  const withStat = await Promise.all(
    files.map(async (f) => ({ f, mtime: await fs.stat(f).then((s) => s.mtimeMs).catch(() => 0) })),
  );
  withStat.sort((a, b) => b.mtime - a.mtime);

  let chosen: string | null = null;
  for (const { f } of withStat) {
    let head: string;
    try {
      head = await readHeader(f);
    } catch {
      continue;
    }
    const cwd = headerField(head, "cwd");
    if (!cwd || !samePath(cwd, query.workspacePath)) continue;
    if (query.sessionId) {
      const sid = headerField(head, "session_id");
      if (sid === query.sessionId) {
        chosen = f;
        break;
      }
      // keep the first workspace match as a fallback if the exact session isn't found
      if (!chosen) chosen = f;
      continue;
    }
    chosen = f;
    break;
  }
  if (!chosen) return [];

  let content: string;
  try {
    content = await fs.readFile(chosen, "utf8");
  } catch {
    return [];
  }

  const events: TranscriptEvent[] = [];
  let fallbackAt = new Date().toISOString();
  for (const raw of content.split("\n")) {
    const s = raw.trim();
    if (!s) continue;
    let line: Record<string, unknown>;
    try {
      line = JSON.parse(s) as Record<string, unknown>;
    } catch {
      continue;
    }
    const at = typeof line.timestamp === "string" ? line.timestamp : fallbackAt;
    if (line.type === "session_meta") {
      fallbackAt = at;
      events.push({ at, event: "session_started", message: "" });
      continue;
    }
    const mapped = mapLine(line);
    if (mapped) events.push({ at, event: mapped.event, message: mapped.message });
  }
  return events;
}
