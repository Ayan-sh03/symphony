/**
 * Read opencode's own persisted transcript (the `readTranscript` capability for the
 * opencode backend). opencode stores each session under its data dir as
 * `storage/session/<project>/<sessionID>.json` (whose `directory` is our per-issue
 * workspace), with messages in `storage/message/<sessionID>/*.json` and their content
 * in `storage/part/<messageID>/*.json`. We resolve the session for a workspace/session
 * and map its parts onto the console's activity-log vocabulary. Best-effort, never throws.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TranscriptEvent, TranscriptQuery } from "./types.ts";

function opencodeStorage(): string {
  if (process.env.OPENCODE_DATA_DIR && process.env.OPENCODE_DATA_DIR.trim()) {
    return path.join(process.env.OPENCODE_DATA_DIR, "storage");
  }
  const dataHome = process.env.XDG_DATA_HOME && process.env.XDG_DATA_HOME.trim()
    ? process.env.XDG_DATA_HOME
    : path.join(os.homedir(), ".local", "share");
  return path.join(dataHome, "opencode", "storage");
}

function samePath(a: string, b: string): boolean {
  const norm = (p: string) => {
    let r = path.resolve(p).replace(/[\\/]+$/, "");
    if (process.platform === "win32") r = r.toLowerCase();
    return r;
  };
  return norm(a) === norm(b);
}

async function readJson(file: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function listFiles(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isFile() && e.name.endsWith(".json")).map((e) => path.join(dir, e.name));
  } catch {
    return [];
  }
}

/** Resolve the sessionID whose session record points at this workspace. */
async function resolveSessionId(storage: string, query: TranscriptQuery): Promise<string | null> {
  const sessionRoot = path.join(storage, "session");
  let projects: import("node:fs").Dirent[];
  try {
    projects = await fs.readdir(sessionRoot, { withFileTypes: true });
  } catch {
    return null;
  }
  const matches: { id: string; updated: number }[] = [];
  for (const proj of projects) {
    if (!proj.isDirectory()) continue;
    for (const file of await listFiles(path.join(sessionRoot, proj.name))) {
      const rec = await readJson(file);
      if (!rec) continue;
      const id = typeof rec.id === "string" ? rec.id : null;
      if (!id) continue;
      if (query.sessionId && id === query.sessionId) return id;
      const dir = typeof rec.directory === "string" ? rec.directory : "";
      if (dir && samePath(dir, query.workspacePath)) {
        const time = (rec.time ?? {}) as Record<string, unknown>;
        matches.push({ id, updated: typeof time.updated === "number" ? time.updated : 0 });
      }
    }
  }
  if (!matches.length) return null;
  matches.sort((a, b) => b.updated - a.updated); // newest run for the workspace
  return matches[0]!.id;
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

export async function readOpencodeTranscript(query: TranscriptQuery): Promise<TranscriptEvent[]> {
  const storage = opencodeStorage();
  const sessionId = await resolveSessionId(storage, query);
  if (!sessionId) return [];

  const msgFiles = await listFiles(path.join(storage, "message", sessionId));
  if (!msgFiles.length) return [];

  const messages: { id: string; role: string; created: number }[] = [];
  for (const f of msgFiles) {
    const rec = await readJson(f);
    if (!rec || typeof rec.id !== "string") continue;
    const time = (rec.time ?? {}) as Record<string, unknown>;
    messages.push({
      id: rec.id,
      role: typeof rec.role === "string" ? rec.role : "",
      created: typeof time.created === "number" ? time.created : 0,
    });
  }
  messages.sort((a, b) => a.created - b.created);

  const events: TranscriptEvent[] = [];
  if (messages.length) events.push({ at: new Date(messages[0]!.created).toISOString(), event: "session_started", message: "" });

  for (const msg of messages) {
    if (msg.role !== "assistant") continue; // the user role carries the prompt, not activity
    const at = new Date(msg.created).toISOString();
    const partFiles = (await listFiles(path.join(storage, "part", msg.id))).sort(); // ids are time-ordered
    for (const pf of partFiles) {
      const part = await readJson(pf);
      if (!part) continue;
      const mapped = mapPart(part);
      if (mapped) events.push({ at, event: mapped.event, message: mapped.message });
    }
  }
  return events;
}
