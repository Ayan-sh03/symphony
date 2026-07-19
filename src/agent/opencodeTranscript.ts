/**
 * Read opencode's own persisted transcript (the `readTranscript` capability for the
 * opencode backend). Recent opencode versions store everything in a single SQLite
 * database at `<dataDir>/opencode.db` (the older `storage/*.json` tree is abandoned
 * after the `migration` marker flips). Sessions live in the `session` table (whose
 * `directory` column is our per-issue workspace), messages in `message.data`, and
 * their content in `part.data` — each a JSON blob matching the old on-disk shapes.
 * We resolve the session for a workspace/session id and map its parts onto the
 * console's activity-log vocabulary. Best-effort, never throws.
 */
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import type { TranscriptEvent, TranscriptQuery } from "./types.ts";

/** The opencode data dir; its `opencode.db` holds the migrated transcript store. */
function opencodeDataDir(): string {
  if (process.env.OPENCODE_DATA_DIR && process.env.OPENCODE_DATA_DIR.trim()) {
    return process.env.OPENCODE_DATA_DIR;
  }
  const dataHome = process.env.XDG_DATA_HOME && process.env.XDG_DATA_HOME.trim()
    ? process.env.XDG_DATA_HOME
    : path.join(os.homedir(), ".local", "share");
  return path.join(dataHome, "opencode");
}

function samePath(a: string, b: string): boolean {
  const norm = (p: string) => {
    let r = path.resolve(p).replace(/[\\/]+$/, "");
    if (process.platform === "win32") r = r.toLowerCase();
    return r;
  };
  return norm(a) === norm(b);
}

function parseJson(v: unknown): Record<string, unknown> | null {
  if (typeof v !== "string") return null;
  try {
    const o = JSON.parse(v);
    return o && typeof o === "object" ? (o as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function basename(v: unknown): string {
  return typeof v === "string" ? path.basename(v) : "";
}

/** Map one opencode message part onto an activity-log event, or null to skip. */
function mapPart(part: Record<string, unknown>): { event: string; message: string } | null {
  const type = part.type;
  if (type === "text") return { event: "agent_message", message: typeof part.text === "string" ? part.text : "" };
  if (type === "reasoning") return { event: "reasoning", message: typeof part.text === "string" ? part.text : "" };
  if (type === "tool") {
    const tool = typeof part.tool === "string" ? part.tool : "tool";
    const state = (part.state ?? {}) as Record<string, unknown>;
    const input = (state.input ?? {}) as Record<string, unknown>;
    if (tool === "bash") return { event: "command", message: typeof input.command === "string" ? input.command : "" };
    if (tool === "write" || tool === "edit") return { event: "file_change", message: basename(input.filePath) };
    const target = basename(input.filePath) || (typeof input.pattern === "string" ? input.pattern : "");
    return { event: "tool_call", message: (tool + (target ? " " + target : "")).trim() };
  }
  return null; // step-start, step-finish (tokens)
}

/** Resolve the session id whose record points at this workspace (newest run wins). */
function resolveSessionId(db: DatabaseSync, query: TranscriptQuery): string | null {
  if (query.sessionId) {
    const row = db.prepare("SELECT id FROM session WHERE id = ?").get(query.sessionId) as { id?: string } | undefined;
    if (row && typeof row.id === "string") return row.id;
  }
  const rows = db
    .prepare("SELECT id, directory FROM session WHERE directory IS NOT NULL ORDER BY time_updated DESC")
    .all() as { id: string; directory: string }[];
  for (const r of rows) {
    if (samePath(r.directory, query.workspacePath)) return r.id;
  }
  return null;
}

export async function readOpencodeTranscript(query: TranscriptQuery): Promise<TranscriptEvent[]> {
  const dbPath = path.join(opencodeDataDir(), "opencode.db");
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch {
    return []; // no db yet (fresh install or still on the file-based layout)
  }
  try {
    const sessionId = resolveSessionId(db, query);
    if (!sessionId) return [];

    const messages = db
      .prepare("SELECT id, time_created, data FROM message WHERE session_id = ? ORDER BY time_created")
      .all(sessionId) as { id: string; time_created: number; data: string }[];
    if (!messages.length) return [];

    const events: TranscriptEvent[] = [];
    events.push({ at: new Date(messages[0]!.time_created).toISOString(), event: "session_started", message: "" });

    const partsFor = db.prepare("SELECT data FROM part WHERE message_id = ? ORDER BY time_created, id");
    for (const msg of messages) {
      const rec = parseJson(msg.data);
      if (!rec || rec.role !== "assistant") continue; // the user role carries the prompt, not activity
      const at = new Date(msg.time_created).toISOString();
      const parts = partsFor.all(msg.id) as { data: string }[];
      for (const p of parts) {
        const part = parseJson(p.data);
        if (!part) continue;
        const mapped = mapPart(part);
        if (mapped) events.push({ at, event: mapped.event, message: mapped.message });
      }
    }
    return events;
  } catch {
    return [];
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }
}
