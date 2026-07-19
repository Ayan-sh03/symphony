/**
 * Workspace Manager (SPEC §4.2, §9). Deterministic per-issue workspaces with
 * sanitized, collision-resistant keys; lifecycle hooks; safety invariants;
 * terminal cleanup.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import type { Logger } from "../logger.ts";
import type { HooksConfig } from "../config/config.ts";
import { runScript } from "../shell.ts";
import type { Workspace } from "../domain/types.ts";

export class WorkspaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceError";
  }
}

const ALLOWED = /[^A-Za-z0-9._-]/g;

/**
 * Derive a collision-resistant workspace key (SPEC §4.2, Invariant 3). If
 * sanitization changes the identifier, append a stable hash of the *original*
 * identifier (>=64 bits, allowed chars) so distinct identifiers that sanitize to
 * the same text get distinct keys.
 */
export function workspaceKey(identifier: string): string {
  const sanitized = identifier.replace(ALLOWED, "_");
  if (sanitized === identifier) return sanitized;
  const hash = crypto.createHash("sha256").update(identifier, "utf8").digest("hex").slice(0, 16); // 64 bits
  return `${sanitized}-${hash}`;
}

export interface WorkspaceManagerOptions {
  root: string;
  hooks: HooksConfig;
  logger: Logger;
  repository?: string | null;
}

export class WorkspaceManager {
  private opts: WorkspaceManagerOptions;
  constructor(opts: WorkspaceManagerOptions) {
    this.opts = opts;
  }

  /** Update effective hooks/root after a config reload (SPEC §6.2). */
  update(root: string, hooks: HooksConfig, repository: string | null): void {
    this.opts.root = root;
    this.opts.hooks = hooks;
    this.opts.repository = repository;
  }

  workspacePathFor(identifier: string): string {
    const key = workspaceKey(identifier);
    const p = path.normalize(path.join(this.opts.root, key));
    this.assertInsideRoot(p);
    return p;
  }

  /** Invariant 2 (SPEC §9.5): workspace path MUST stay inside workspace root. */
  private assertInsideRoot(p: string): void {
    const root = path.resolve(this.opts.root);
    const abs = path.resolve(p);
    const rel = path.relative(root, abs);
    if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new WorkspaceError(`workspace path ${abs} escapes workspace root ${root}`);
    }
  }

  /**
   * Ensure the per-issue workspace exists, running `after_create` only on fresh
   * creation (SPEC §9.2). Returns the logical Workspace record.
   */
  async createForIssue(identifier: string): Promise<Workspace> {
    const key = workspaceKey(identifier);
    const wsPath = this.workspacePathFor(identifier);
    let created_now = false;

    let stat: fs.Stats | null = null;
    try {
      stat = fs.statSync(wsPath);
    } catch {
      stat = null;
    }
    if (stat && !stat.isDirectory()) {
      // Existing non-directory at the workspace location: fail safely (SPEC §17.2).
      throw new WorkspaceError(`workspace path ${wsPath} exists but is not a directory`);
    }
    if (!stat && this.opts.repository) {
      try {
        fs.mkdirSync(path.dirname(wsPath), { recursive: true });
        const branch = `issue/${identifier}`;
        const existing = this.git(this.opts.repository, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], true);
        this.git(this.opts.repository, existing === null ? ["worktree", "add", "-b", branch, wsPath] : ["worktree", "add", wsPath, branch]);
        created_now = true;
      } catch (err) {
        throw new WorkspaceError(`failed to create git worktree ${wsPath}: ${(err as Error).message}`);
      }
    } else if (!stat) {
      try {
        fs.mkdirSync(wsPath, { recursive: true });
        created_now = true;
      } catch (err) {
        throw new WorkspaceError(`failed to create workspace ${wsPath}: ${(err as Error).message}`);
      }
    }

    if (created_now && this.opts.hooks.after_create) {
      const res = await this.runHook("after_create", this.opts.hooks.after_create, wsPath);
      if (!res.ok) {
        // after_create failure is fatal to creation: remove the partial dir (SPEC §9.3, §9.4).
        try {
          fs.rmSync(wsPath, { recursive: true, force: true });
        } catch {
          /* best effort */
        }
        throw new WorkspaceError(`after_create hook failed for ${identifier}`);
      }
    }

    return { path: wsPath, workspace_key: key, created_now };
  }

  /** `before_run`: fatal to the attempt on failure/timeout (SPEC §9.4). */
  async runBeforeRun(wsPath: string): Promise<boolean> {
    if (!this.opts.hooks.before_run) return true;
    const res = await this.runHook("before_run", this.opts.hooks.before_run, wsPath);
    return res.ok;
  }

  /** `after_run`: logged and ignored on failure/timeout (SPEC §9.4). */
  async runAfterRun(wsPath: string): Promise<void> {
    if (!this.opts.hooks.after_run) return;
    if (!fs.existsSync(wsPath)) return;
    await this.runHook("after_run", this.opts.hooks.after_run, wsPath);
  }

  /** Remove a workspace, running `before_remove` first (SPEC §9.4). Used for terminal issues. */
  async cleanupForIssue(identifier: string): Promise<void> {
    const wsPath = this.workspacePathFor(identifier);
    if (!fs.existsSync(wsPath)) return;
    if (this.opts.hooks.before_remove) {
      await this.runHook("before_remove", this.opts.hooks.before_remove, wsPath);
    }
    if (this.opts.repository) {
      const dirty = this.git(wsPath, ["status", "--porcelain"])!
        .split(/\r?\n/)
        .filter((line) => line !== "" && !line.endsWith(" SYMPHONY_ISSUE.json"));
      if (dirty.length > 0) {
        this.opts.logger.warn("workspace preserved because git worktree has uncommitted changes", { issue_identifier: identifier, path: wsPath, changes: dirty.join(", ") });
        return;
      }
      try {
        this.git(this.opts.repository, ["worktree", "remove", wsPath]);
        this.opts.logger.info("git worktree cleaned; issue branch retained", { issue_identifier: identifier, path: wsPath, branch: `issue/${identifier}` });
      } catch (err) {
        this.opts.logger.warn("git worktree cleanup failed", { issue_identifier: identifier, path: wsPath, error: String(err) });
      }
      return;
    }
    try {
      fs.rmSync(wsPath, { recursive: true, force: true });
      this.opts.logger.info("workspace cleaned", { issue_identifier: identifier, path: wsPath });
    } catch (err) {
      this.opts.logger.warn("workspace cleanup failed", { issue_identifier: identifier, path: wsPath, error: String(err) });
    }
  }

  private git(cwd: string, args: string[], allowFailure = false): string | null {
    try {
      return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      if (allowFailure) return null;
      const detail = err instanceof Error ? err.message : String(err);
      throw new WorkspaceError(`git ${args.join(" ")} failed: ${detail}`);
    }
  }

  private async runHook(name: string, script: string, cwd: string) {
    this.opts.logger.info("hook start", { hook: name, cwd });
    const res = await runScript(script, cwd, this.opts.hooks.timeout_ms);
    if (res.timedOut) {
      this.opts.logger.warn("hook timed out", { hook: name, cwd, timeout_ms: this.opts.hooks.timeout_ms });
    } else if (!res.ok) {
      this.opts.logger.warn("hook failed", { hook: name, cwd, code: res.code, stderr: res.stderr.slice(0, 500) });
    }
    return res;
  }
}
