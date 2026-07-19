/**
 * Project manifest (multi-project host extension; not part of the single-workflow
 * SPEC). A manifest is a JSON array of `{ id, name, workflow }` entries, each naming
 * one WORKFLOW.md that becomes an independent, SPEC-conformant orchestrator. The set
 * is stable across restarts; the console can append to it at runtime. `workflow`
 * paths are resolved relative to the manifest file's own directory.
 */
import fs from "node:fs";
import path from "node:path";

export interface ProjectEntry {
  id: string;
  name: string;
  /** Path to this project's WORKFLOW.md, as stored (relative to the manifest dir, or absolute). */
  workflow: string;
}

export class ManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManifestError";
  }
}

/** Read + validate a projects manifest. Throws ManifestError on read/parse/shape failures. */
export function loadManifest(manifestPath: string): ProjectEntry[] {
  let raw: string;
  try {
    raw = fs.readFileSync(manifestPath, "utf8");
  } catch (err) {
    throw new ManifestError(`cannot read projects manifest at ${manifestPath}: ${(err as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ManifestError(`invalid JSON in projects manifest: ${(err as Error).message}`);
  }
  if (!Array.isArray(parsed)) {
    throw new ManifestError("projects manifest must be a JSON array of { id, name, workflow }");
  }
  const entries: ProjectEntry[] = [];
  const seen = new Set<string>();
  for (const item of parsed) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new ManifestError("each manifest entry must be an object");
    }
    const obj = item as Record<string, unknown>;
    const id = typeof obj.id === "string" ? obj.id.trim() : "";
    const workflow = typeof obj.workflow === "string" ? obj.workflow.trim() : "";
    if (id === "") throw new ManifestError("manifest entry is missing a non-empty `id`");
    if (workflow === "") throw new ManifestError(`manifest entry ${id} is missing a non-empty \`workflow\``);
    if (seen.has(id)) throw new ManifestError(`duplicate project id in manifest: ${id}`);
    seen.add(id);
    const name = typeof obj.name === "string" && obj.name.trim() !== "" ? obj.name.trim() : id;
    entries.push({ id, name, workflow });
  }
  return entries;
}

/** Write a manifest back to disk as pretty JSON (used by console-driven add). */
export function saveManifest(manifestPath: string, entries: ProjectEntry[]): void {
  fs.writeFileSync(manifestPath, JSON.stringify(entries, null, 2) + "\n", "utf8");
}

/** Resolve an entry's `workflow` to an absolute path, relative to the manifest dir. */
export function resolveEntryWorkflow(manifestPath: string, entry: ProjectEntry): string {
  if (path.isAbsolute(entry.workflow)) return path.normalize(entry.workflow);
  return path.normalize(path.join(path.dirname(path.resolve(manifestPath)), entry.workflow));
}

/**
 * Derive a stable, URL-safe project id from a workflow path's containing directory
 * name, deduped against existing ids with a numeric suffix. An explicit manifest
 * `id` always wins; this only runs when the console adds a new project.
 */
export function deriveId(workflowPath: string, existingIds: Iterable<string>): string {
  const dir = path.basename(path.dirname(path.resolve(workflowPath)));
  let slug = dir
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  if (slug === "") slug = "project";
  const taken = new Set(existingIds);
  if (!taken.has(slug)) return slug;
  for (let n = 2; ; n++) {
    const candidate = `${slug}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}
