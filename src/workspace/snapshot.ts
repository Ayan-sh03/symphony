/**
 * Portable workspace snapshots (SPEC §9 safety; extension, issue #35).
 * A JSON manifest carries file bytes and a self-contained Git bundle, never a
 * worktree's .git pointer, config, hooks, credentials, or object alternates.
 * Imports are validated in a private staging directory before publication.
 */
import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
export interface SnapshotContent { size: number; sha256: string; data: string }
export type SnapshotEntry =
  | { path: string; type: "file"; mode: number; content: SnapshotContent }
  | { path: string; type: "directory"; mode: number }
  | { path: string; type: "symlink"; target: string };
export interface SnapshotGit {
  headCommit: string;
  baseCommit: string;
  branch: string | null;
  bundle: SnapshotContent;
  /** Binary diff of HEAD to the index; working files are separate manifest entries. */
  indexPatch: SnapshotContent;
}
export type WorkspaceSnapshot = {
  version: 1;
  entries: SnapshotEntry[];
} & ({ kind: "directory"; git: null } | { kind: "git"; git: SnapshotGit });
export interface SnapshotLimits {
  maxEntries: number;
  maxFileBytes: number;
  maxTotalBytes: number;
  maxSnapshotBytes: number;
}
export interface SnapshotExportOptions {
  /** Full commit id. Defaults to HEAD; must be an ancestor of HEAD. */
  baseCommit?: string;
  limits?: Partial<SnapshotLimits>;
}
export interface SnapshotImportOptions {
  /** Trusted caller's base, never inferred from an incoming manifest. Null for plain directories. */
  expectedBaseCommit: string | null;
  limits?: Partial<SnapshotLimits>;
}
export interface StagedWorkspaceSnapshot {
  readonly path: string;
  readonly snapshot: WorkspaceSnapshot;
  /** Discards only this staging directory; safe to call repeatedly. */
  dispose(): Promise<void>;
}
export class WorkspaceSnapshotError extends Error {
  constructor(message: string) { super(message); this.name = "WorkspaceSnapshotError"; }
}
export const DEFAULT_SNAPSHOT_LIMITS: Readonly<SnapshotLimits> = Object.freeze({
  maxEntries: 100_000,
  maxFileBytes: 64 * 1024 * 1024,
  maxTotalBytes: 256 * 1024 * 1024,
  maxSnapshotBytes: 384 * 1024 * 1024,
});
function fail(message: string): never { throw new WorkspaceSnapshotError(message); }
function limitsFor(overrides?: Partial<SnapshotLimits>): SnapshotLimits {
  const limits = { ...DEFAULT_SNAPSHOT_LIMITS, ...overrides };
  for (const value of Object.values(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) fail("snapshot limits must be positive safe integers");
  }
  return limits;
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("invalid snapshot object");
  return value as Record<string, unknown>;
}
function oid(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value)) fail("invalid Git commit id");
}
function portablePath(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value || Buffer.byteLength(value) > 4096 || Buffer.from(value).toString("utf8") !== value) fail("invalid snapshot path");
  for (const part of value.split("/")) {
    if (!part || part === "." || part === ".." || /[\\\x00-\x1f\x7f:<>"|?*]/.test(part)
      || /[. ]$/.test(part) || Buffer.byteLength(part) > 255
      || /^(?:\.git|git~[0-9]+)$/i.test(part)
      || /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/i.test(part)
      || part.normalize("NFC") !== part || /[\u200c-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/.test(part)) {
      fail(`unsafe snapshot path: ${value}`);
    }
  }
}
function mode(value: unknown): asserts value is number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 0o777) fail("invalid snapshot mode");
}
function digest(data: Uint8Array): string { return createHash("sha256").update(data).digest("hex"); }
function content(data: Uint8Array): SnapshotContent {
  return { size: data.byteLength, sha256: digest(data), data: Buffer.from(data).toString("base64") };
}
function bytes(value: unknown, limit: number): Buffer {
  const item = record(value);
  if (typeof item.size !== "number" || !Number.isSafeInteger(item.size) || item.size < 0 || item.size > limit) fail("snapshot content size exceeds limit");
  if (typeof item.data !== "string" || item.data.length !== 4 * Math.ceil(item.size / 3)) fail("snapshot content size mismatch");
  const data = Buffer.from(item.data, "base64");
  if (data.toString("base64") !== item.data) fail("invalid snapshot content base64");
  if (data.length !== item.size) fail("snapshot content size mismatch");
  if (typeof item.sha256 !== "string" || digest(data) !== item.sha256) fail("snapshot content hash mismatch");
  return data;
}

/** Validate the whole tree before creating even a single archive-controlled path. */
function validatePaths(entries: Array<{ path: string; type: string; target?: string }>, maxEntries: number): void {
  const nodes = new Map<string, { path: string; type: string; target?: string }>();
  const aliases = new Map<string, string>();
  for (const entry of entries) {
    portablePath(entry.path);
    if (nodes.has(entry.path)) fail(`duplicate snapshot path: ${entry.path}`);
    nodes.set(entry.path, entry);
    const parts = entry.path.split("/");
    for (let i = 1; i <= parts.length; i++) {
      const prefix = parts.slice(0, i).join("/");
      const folded = prefix.normalize("NFC").toLowerCase();
      if (aliases.has(folded) && aliases.get(folded) !== prefix) fail(`snapshot path case collision: ${prefix}`);
      aliases.set(folded, prefix);
      if (aliases.size > maxEntries) fail("snapshot path count including implicit directories exceeds limit");
    }
  }
  for (const entry of entries) {
    let parent = path.posix.dirname(entry.path);
    while (parent !== ".") {
      if (nodes.has(parent) && nodes.get(parent)!.type !== "directory") fail(`snapshot path has a non-directory parent: ${entry.path}`);
      parent = path.posix.dirname(parent);
    }
    if (entry.type !== "symlink") continue;
    const target = entry.target;
    if (typeof target !== "string" || !target || target.length > 4096 || /[\\\x00-\x1f]/.test(target) || path.posix.isAbsolute(target)) fail(`unsafe snapshot link: ${entry.path}`);
    // Validate before normalization so `.git/../file` cannot hide a forbidden
    // component. Only a leading sequence of ../ may traverse toward the root.
    portablePath(target.replace(/^(?:\.\.\/)+/, ""));
    const resolved = path.posix.join(path.posix.dirname(entry.path), target);
    portablePath(resolved);
    // Only direct relative links to included regular files. Directory links,
    // dangling links, and chains cannot be used to redirect later extraction.
    if (nodes.get(resolved)?.type !== "file") fail(`unsafe snapshot link target (missing, directory, or link cycle): ${entry.path}`);
  }
}

/** Accept untrusted JSON objects; return a detached, validated copy. */
export function validateWorkspaceSnapshot(value: unknown, options: SnapshotImportOptions): WorkspaceSnapshot {
  const limits = limitsFor(options.limits);
  let serialized: string;
  try { serialized = JSON.stringify(value); } catch { return fail("snapshot is not JSON serializable"); }
  if (!serialized || Buffer.byteLength(serialized) > limits.maxSnapshotBytes) fail("snapshot serialized size exceeds limit");
  const snapshot = record(JSON.parse(serialized));
  if (snapshot.version !== 1 || !["directory", "git"].includes(String(snapshot.kind))) fail("unsupported snapshot version or kind");
  if (!Array.isArray(snapshot.entries) || snapshot.entries.length > limits.maxEntries) fail("snapshot entry count exceeds limit");
  let total = 0;
  const add = (value: unknown, limit = limits.maxFileBytes) => {
    const data = bytes(value, limit);
    total += data.length;
    if (total > limits.maxTotalBytes) fail("snapshot total size exceeds limit");
  };
  for (const item of snapshot.entries) {
    const entry = record(item);
    portablePath(entry.path);
    if (entry.type === "file") { mode(entry.mode); add(entry.content); }
    else if (entry.type === "directory") mode(entry.mode);
    else if (entry.type !== "symlink") fail("unsupported snapshot entry type");
  }
  validatePaths(snapshot.entries, limits.maxEntries);
  if (snapshot.kind === "directory") {
    if (snapshot.git !== null || options.expectedBaseCommit !== null) fail("plain snapshot requires a null expected base commit");
  } else {
    const git = record(snapshot.git);
    oid(git.headCommit); oid(git.baseCommit); oid(options.expectedBaseCommit);
    if (git.baseCommit !== options.expectedBaseCommit) fail("snapshot base commit does not match expected base commit");
    if (git.branch !== null) {
      portablePath(git.branch);
      if ((git.branch as string).startsWith("-") || /[~^@\[\s]/.test(git.branch as string)) fail("invalid snapshot Git branch");
    }
    add(git.bundle, limits.maxTotalBytes);
    add(git.indexPatch);
  }
  return snapshot as WorkspaceSnapshot;
}

/** Never inherit GIT_DIR, alternate object stores, global hooks, or external filters. */
async function git(cwd: string, args: string[], limit: number, honorAutocrlf = false): Promise<Buffer> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_")));
  // Git for Windows understands /dev/null, but not Node's \\.\nul spelling.
  Object.assign(env, { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_NO_REPLACE_OBJECTS: "1", GIT_OPTIONAL_LOCKS: "0" });
  // Forcing core.autocrlf=false keeps every explicit Git operation host-independent,
  // but interpreting existing working bytes must honor the repository's own setting.
  const config = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false",
    ...(honorAutocrlf ? [] : ["-c", "core.autocrlf=false"]),
    "-c", "core.protectNTFS=true", "-c", "core.protectHFS=true"];
  try {
    const result = await exec("git", [...config, "-C", cwd, ...args], {
      env, encoding: "buffer", maxBuffer: limit, timeout: 60_000, windowsHide: true,
    });
    return result.stdout;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") fail("snapshot git output size exceeds limit");
    fail(`snapshot git ${args[0]} failed: ${String(error).slice(0, 2000)}`);
  }
}
async function gitText(cwd: string, args: string[], limits: SnapshotLimits): Promise<string> {
  return (await git(cwd, args, limits.maxTotalBytes)).toString("utf8").trimEnd();
}
/**
 * Tracked text files whose checked-out bytes differ from the committed blob only
 * by an end-of-line conversion (`i/lf w/crlf`). With `core.autocrlf=true` every
 * text file is smudged on Windows, so raw working bytes are not the blob bytes.
 */
async function smudgedPaths(cwd: string, limits: SnapshotLimits): Promise<Set<string>> {
  const raw = (await git(cwd, ["ls-files", "--eol", "-z"], limits.maxTotalBytes, true)).toString("utf8");
  const paths = new Set<string>();
  for (const entry of raw.split("\0")) {
    if (!entry) continue;
    const tab = entry.indexOf("\t");
    const state = tab < 0 ? null : /^i\/(\S*)\s+w\/(\S*)\s+attr\//.exec(entry.slice(0, tab));
    if (!state) fail("snapshot could not parse Git end-of-line state");
    if (state[1] === "lf" && state[2] === "crlf") paths.add(entry.slice(tab + 1));
  }
  return paths;
}
/**
 * Tracked paths whose working bytes differ from the index under the repository's
 * own configuration. `git diff-files` is stat-based and over-reports merely
 * touched files, so use `git status`, which compares content and honors
 * core.autocrlf without rewriting the index while GIT_OPTIONAL_LOCKS=0 is set.
 */
async function modifiedPaths(cwd: string, limits: SnapshotLimits): Promise<Set<string>> {
  const raw = (await git(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=no", "--no-renames"], limits.maxTotalBytes, true)).toString("utf8");
  const paths = new Set<string>();
  for (const entry of raw.split("\0")) {
    if (!entry) continue;
    if (entry.length < 4 || entry[2] !== " ") fail("snapshot could not parse Git status");
    if (entry[1] !== " ") paths.add(entry.slice(3));
  }
  return paths;
}
/** Replace CRLF with LF one byte at a time; latin1 keeps arbitrary bytes intact. */
function stripCrlf(data: Buffer): Buffer {
  return Buffer.from(data.toString("latin1").replace(/\r\n/g, "\n"), "latin1");
}
function sameSet(left: Set<string>, right: Set<string>): boolean {
  if (left.size !== right.size) return false;
  for (const value of left) if (!right.has(value)) return false;
  return true;
}
async function lstatMaybe(location: string) {
  try { return await fs.lstat(location); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}
/** Reject linked ancestors as well as linked roots (including Windows junctions). */
async function safeDirectory(location: string): Promise<string> {
  const absolute = path.resolve(location);
  let cursor = absolute;
  while (true) {
    const stat = await fs.lstat(cursor);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail(`snapshot directory path is not a real directory: ${cursor}`);
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return absolute;
}
async function readRegular(location: string, limit: number): Promise<Buffer> {
  const before = await fs.lstat(location);
  if (!before.isFile() || before.nlink !== 1) fail(`snapshot rejects special files and hard links: ${location}`);
  if (before.size > limit) fail("snapshot file size exceeds limit");
  const handle = await fs.open(location, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (opened.ino !== before.ino || opened.dev !== before.dev || !opened.isFile() || opened.nlink !== 1) fail("snapshot file changed during export");
    // A bounded read also handles a concurrently growing file without unbounded allocation.
    const data = Buffer.alloc(before.size + 1);
    let used = 0;
    while (used < data.length) {
      const { bytesRead } = await handle.read(data, used, data.length - used, null);
      if (!bytesRead) break;
      used += bytesRead;
    }
    const after = await handle.stat();
    if (used !== before.size || after.mtimeMs !== before.mtimeMs || after.size !== before.size) fail("snapshot file changed during export");
    return data.subarray(0, used);
  } finally { await handle.close(); }
}

async function indexEntries(cwd: string, limits: SnapshotLimits) {
  const raw = await gitText(cwd, ["ls-files", "--stage", "-z"], limits);
  const entries = raw.split("\0").filter(Boolean).map((line) => {
    const match = /^(\d+) ([a-f0-9]+) (\d)\t([\s\S]+)$/.exec(line);
    if (!match || match[3] !== "0") return fail("snapshot does not support an unmerged Git index");
    if (!["100644", "100755", "120000"].includes(match[1])) fail("snapshot does not support Git submodules or special modes");
    return { path: match[4], mode: match[1], oid: match[2] };
  });
  if (entries.length > limits.maxEntries) fail("Git index entry count exceeds limit");
  const paths = [];
  for (const entry of entries) {
    paths.push({ path: entry.path, type: entry.mode === "120000" ? "symlink" : "file", ...(entry.mode === "120000" ? { target: (await git(cwd, ["cat-file", "blob", entry.oid], 4096)).toString("utf8") } : {}) });
  }
  validatePaths(paths, limits.maxEntries);
  return entries;
}

/** Export a quiescent workspace. Ignored Git files are intentionally not transferred. */
export async function exportWorkspaceSnapshot(workspacePath: string, options: SnapshotExportOptions = {}): Promise<WorkspaceSnapshot> {
  const root = await safeDirectory(workspacePath);
  const limits = limitsFor(options.limits);
  const metadata = await lstatMaybe(path.join(root, ".git"));
  const entries: SnapshotEntry[] = [];
  let gitState: SnapshotGit | null = null;
  let selected: Set<string> | null = null;
  let indexModes = new Map<string, string>();
  let symlinkPlaceholders = false;
  let smudged = new Set<string>();
  let modified = new Set<string>();
  let total = 0;
  if (metadata) {
    if (metadata.isSymbolicLink()) fail("snapshot rejects linked Git metadata");
    const top = await gitText(root, ["rev-parse", "--show-toplevel"], limits);
    if (path.resolve(top) !== root) fail("snapshot requires a Git workspace root");
    const head = await gitText(root, ["rev-parse", "--verify", "HEAD^{commit}"], limits);
    const base = options.baseCommit ?? head;
    oid(base);
    await git(root, ["merge-base", "--is-ancestor", base, head], limits.maxTotalBytes);
    const index = await indexEntries(root, limits);
    indexModes = new Map(index.map((entry) => [entry.path, entry.mode]));
    smudged = await smudgedPaths(root, limits);
    if (smudged.size) modified = await modifiedPaths(root, limits);
    symlinkPlaceholders = await gitText(root, ["config", "--type=bool", "--default=true", "--get", "core.symlinks"], limits) === "false";
    const files = (await gitText(root, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], limits)).split("\0").filter(Boolean);
    selected = new Set();
    for (const file of files) {
      portablePath(file);
      selected.add(file);
      let parent = path.posix.dirname(file);
      while (parent !== ".") { selected.add(parent); parent = path.posix.dirname(parent); }
    }
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), "sym-snapshot-export-"));
    try {
      const bundleFile = path.join(temp, "history.bundle");
      await git(root, ["bundle", "create", bundleFile, "HEAD"], limits.maxTotalBytes);
      const bundle = await readRegular(bundleFile, limits.maxTotalBytes);
      const patch = await git(root, ["diff", "--cached", "--binary", "--full-index", "--no-ext-diff", "--no-textconv", head, "--"], limits.maxFileBytes);
      const visibleIntent = await git(root, ["diff", "--cached", "--binary", "--full-index", "--no-ext-diff", "--no-textconv", "--ita-visible-in-index", head, "--"], limits.maxFileBytes);
      if (!patch.equals(visibleIntent)) fail("snapshot does not support intent-to-add index entries; stage or unstage them first");
      const branch = await gitText(root, ["branch", "--show-current"], limits);
      gitState = { headCommit: head, baseCommit: base, branch: branch || null, bundle: content(bundle), indexPatch: content(patch) };
      total = bundle.length + patch.length;
    } finally { await fs.rm(temp, { recursive: true, force: true }); }
  } else if (options.baseCommit !== undefined) fail("plain workspace has no Git base commit");

  async function walk(relative: string): Promise<void> {
    const directory = path.join(root, relative);
    await safeDirectory(directory);
    for (const item of (await fs.readdir(directory)).sort()) {
      if (!relative && item === ".git" && metadata) continue;
      const name = relative ? `${relative}/${item}` : item;
      if (selected && !selected.has(name)) continue;
      portablePath(name);
      if (entries.length >= limits.maxEntries) fail("snapshot entry count exceeds limit");
      const location = path.join(root, name);
      const stat = await fs.lstat(location);
      if (stat.isSymbolicLink()) {
        entries.push({ path: name, type: "symlink", target: await fs.readlink(location) });
      } else if (stat.isDirectory()) {
        entries.push({ path: name, type: "directory", mode: stat.mode & 0o777 });
        await walk(name);
      } else {
        let data = await readRegular(location, Math.min(limits.maxFileBytes, limits.maxTotalBytes - total));
        // Store canonical bytes for clean, smudged text files so an import with
        // core.autocrlf=false does not report every converted file as modified.
        // Genuinely dirty working bytes are preserved verbatim.
        if (smudged.has(name) && !modified.has(name)) data = stripCrlf(data);
        total += data.length;
        if (total > limits.maxTotalBytes) fail("snapshot total size exceeds limit");
        if (symlinkPlaceholders && indexModes.get(name) === "120000") {
          entries.push({ path: name, type: "symlink", target: data.toString("utf8") });
          continue;
        }
        const fileMode = process.platform === "win32" && indexModes.has(name) ? (indexModes.get(name) === "100755" ? 0o755 : 0o644) : stat.mode & 0o777;
        entries.push({ path: name, type: "file", mode: fileMode, content: content(data) });
      }
    }
  }
  await walk("");
  if (gitState) {
    if (await gitText(root, ["rev-parse", "HEAD"], limits) !== gitState.headCommit) fail("Git HEAD changed during snapshot export");
    const patch = await git(root, ["diff", "--cached", "--binary", "--full-index", "--no-ext-diff", "--no-textconv", gitState.headCommit, "--"], limits.maxFileBytes);
    if (digest(patch) !== gitState.indexPatch.sha256) fail("Git index changed during snapshot export");
    if (smudged.size) {
      const currentSmudged = await smudgedPaths(root, limits);
      const currentModified = await modifiedPaths(root, limits);
      if (!sameSet(currentSmudged, smudged) || !sameSet(currentModified, modified)) fail("Git working tree changed during snapshot export");
    }
  }
  return validateWorkspaceSnapshot({ version: 1, kind: gitState ? "git" : "directory", git: gitState, entries }, { expectedBaseCommit: gitState?.baseCommit ?? null, limits });
}

async function restoreGit(root: string, scratch: string, state: SnapshotGit, limits: SnapshotLimits): Promise<void> {
  await git(root, ["init", "-q", "--template=", `--object-format=${state.headCommit.length === 64 ? "sha256" : "sha1"}`], limits.maxTotalBytes);
  const bundle = path.join(scratch, "history.bundle");
  await fs.writeFile(bundle, bytes(state.bundle, limits.maxTotalBytes), { flag: "wx" });
  await git(root, ["bundle", "verify", bundle], limits.maxTotalBytes);
  const heads = await gitText(root, ["bundle", "list-heads", bundle], limits);
  if (heads !== `${state.headCommit} HEAD`) fail("snapshot bundle must contain exactly the declared HEAD");
  // Keep history packed: do not expand an archive's object data into loose files.
  await git(root, ["-c", "fetch.unpackLimit=1", "-c", "fetch.fsckObjects=true", "fetch", "--no-tags", "--no-write-fetch-head", bundle, "HEAD:refs/symphony/snapshot"], limits.maxTotalBytes);
  let objectBytes = 0;
  const report = await gitText(root, ["cat-file", "--batch-all-objects", "--batch-check=%(objecttype) %(objectsize)"], limits);
  for (const line of report.split("\n")) {
    const match = /^(blob|tree|commit|tag) (\d+)$/.exec(line);
    if (!match) fail("invalid Git object size report");
    const size = Number(match[2]);
    objectBytes += size;
    if (!Number.isSafeInteger(size) || size > limits.maxFileBytes || objectBytes > limits.maxTotalBytes) fail("Git history object size exceeds snapshot limit");
  }
  await git(root, ["cat-file", "-e", `${state.headCommit}^{commit}`], limits.maxTotalBytes);
  await git(root, ["merge-base", "--is-ancestor", state.baseCommit, state.headCommit], limits.maxTotalBytes);
  await git(root, ["read-tree", state.headCommit], limits.maxTotalBytes);
  await indexEntries(root, limits); // validate HEAD paths and links without checking out anything
  if (state.indexPatch.size) {
    const patch = path.join(scratch, "index.patch");
    await fs.writeFile(patch, bytes(state.indexPatch, limits.maxFileBytes), { flag: "wx" });
    await git(root, ["apply", "--cached", "--binary", "--whitespace=nowarn", patch], limits.maxTotalBytes);
    await indexEntries(root, limits);
  }
  if (state.branch) {
    await git(root, ["check-ref-format", `refs/heads/${state.branch}`], limits.maxTotalBytes);
    await git(root, ["update-ref", `refs/heads/${state.branch}`, state.headCommit], limits.maxTotalBytes);
    await git(root, ["symbolic-ref", "HEAD", `refs/heads/${state.branch}`], limits.maxTotalBytes);
  } else await git(root, ["update-ref", "--no-deref", "HEAD", state.headCommit], limits.maxTotalBytes);
  await git(root, ["update-ref", "-d", "refs/symphony/snapshot"], limits.maxTotalBytes);
  await git(root, ["config", "core.autocrlf", "false"], limits.maxTotalBytes);
  await git(root, ["fsck", "--strict", "--no-reflogs"], limits.maxTotalBytes);
}

/** Materialize only into a newly owned directory, leaving the local workspace untouched. */
export async function stageWorkspaceSnapshot(value: unknown, stagingParent: string, options: SnapshotImportOptions): Promise<StagedWorkspaceSnapshot> {
  const snapshot = validateWorkspaceSnapshot(value, options);
  const limits = limitsFor(options.limits);
  const parent = await safeDirectory(stagingParent);
  const container = await fs.mkdtemp(path.join(parent, ".symphony-snapshot-"));
  const root = path.join(container, "workspace");
  const dispose = async () => {
    // We own this directory. Restore traversal/write permissions before removal,
    // without following imported links, even when the snapshot had mode 000 dirs.
    async function writable(directory: string): Promise<void> {
      const stat = await lstatMaybe(directory);
      if (!stat?.isDirectory() || stat.isSymbolicLink()) return;
      await fs.chmod(directory, 0o700);
      for (const item of await fs.readdir(directory)) await writable(path.join(directory, item));
    }
    if (process.platform !== "win32") await writable(container);
    await fs.rm(container, { recursive: true, force: true });
  };
  try {
    await fs.mkdir(root);
    if (snapshot.git) await restoreGit(root, container, snapshot.git, limits);
    // Directories first, links last. Nothing can redirect writes out of staging.
    for (const entry of snapshot.entries) {
      if (entry.type === "directory") await fs.mkdir(path.join(root, entry.path), { recursive: true });
      else await fs.mkdir(path.dirname(path.join(root, entry.path)), { recursive: true });
    }
    for (const entry of snapshot.entries) {
      if (entry.type !== "file") continue;
      const location = path.join(root, entry.path);
      const data = bytes(entry.content, limits.maxFileBytes);
      await fs.writeFile(location, data, { flag: "wx", mode: 0o600 });
      if (digest(await fs.readFile(location)) !== entry.content.sha256) fail("staged file hash mismatch");
      if (process.platform !== "win32") await fs.chmod(location, entry.mode);
    }
    for (const entry of snapshot.entries) {
      if (entry.type === "symlink") await fs.symlink(entry.target, path.join(root, entry.path), "file");
    }
    // Apply directory permissions after writing children (read-only trees are valid).
    if (process.platform !== "win32") {
      for (const entry of [...snapshot.entries].sort((a, b) => b.path.length - a.path.length)) {
        if (entry.type === "directory") await fs.chmod(path.join(root, entry.path), entry.mode);
      }
    }
    return { path: root, snapshot, dispose };
  } catch (error) { await dispose(); throw error; }
}

/**
 * Publish to an absent or empty destination only. Existing work requires a staged
 * import and the caller's checkpoint transaction; never destroy its only copy.
 */
export async function importWorkspaceSnapshot(destination: string, value: unknown, options: SnapshotImportOptions): Promise<void> {
  const target = path.resolve(destination);
  const parent = await safeDirectory(path.dirname(target));
  const assertEmpty = async () => {
    const stat = await lstatMaybe(target);
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink() || (await fs.readdir(target)).length)) fail("snapshot destination must be absent or an empty directory");
    return stat;
  };
  await assertEmpty();
  const staged = await stageWorkspaceSnapshot(value, parent, options);
  try {
    // Recheck after slow Git verification; an operator may have created local work.
    const existing = await assertEmpty();
    if (existing) await fs.rmdir(target); // non-recursive, refuses newly added work
    try { await fs.rename(staged.path, target); }
    catch (error) {
      if (existing) await fs.mkdir(target).catch(() => {});
      throw error;
    }
  } finally { await staged.dispose(); }
}
