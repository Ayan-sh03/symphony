/**
 * Workspace Manager (SPEC §4.2, §9). Deterministic per-issue workspaces with
 * sanitized, collision-resistant keys; lifecycle hooks; safety invariants;
 * terminal cleanup.
 *
 * Repository mode (extension): when `repository` is set, a workspace is a git
 * worktree of that repository on the issue branch (`branch_template`). Cleanup
 * removes only the disposable worktree — never the branch — and refuses to
 * remove a worktree that still holds uncommitted work or whose branch is gone.
 *
 * Every method here is keyed by a *work stream* identifier, not by an issue id.
 * For an ordinary issue the two are the same string; for a follow-up (SPEC
 * Appendix B.5) the stream is the issue it continues, which is how several issues
 * come to share one branch and one worktree. Resolving an issue to its stream is
 * the orchestrator's job — this class never talks to a tracker.
 *
 * Every git call here is async: the host runs all projects, their agents' stdio
 * and the console on one event loop, so a synchronous `worktree add` (or worse,
 * a network `push`) would freeze the whole service for its duration.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Logger } from "../logger.ts";
import type { HooksConfig } from "../config/config.ts";
import { runScript } from "../shell.ts";
import type { Workspace } from "../domain/types.ts";

const execFileAsync = promisify(execFile);

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

/**
 * Derive the name of the `refs/symphony/*` ref for a work stream (extension).
 *
 * Deliberately *not* `workspaceKey`, which names directories: changing that would
 * move every existing workspace, and a stream whose branch is already checked out
 * somewhere cannot simply be re-added at a new path. Refs are a fresh namespace,
 * so they can be stricter for free.
 *
 * Two hazards it has to close, beyond what `workspaceKey` handles:
 *  - **Case.** NTFS aliases loose refs that differ only in case, so `SYM-10` and
 *    `sym-10` would share one ref file and the second write would silently win.
 *    Any identifier that is not already lower-case gets a hash of the original.
 *  - **Ref grammar.** git rejects a path component that starts or ends with `.`,
 *    contains `..`, or ends with `.lock` — none of which `workspaceKey` filters,
 *    and any one of which would fail the whole delivery transaction.
 *
 * The result is always a single path component (`workspaceKey` collapses `/`), so
 * `refs/…/A` and `refs/…/A/B` can never both exist and shadow each other.
 *
 * Note this fixes the symphony namespace only: `refs/heads/issue/SYM-10` and its
 * workspace directory still alias their lower-case twins exactly as before.
 */
export function refKey(stream: string): string {
  const base = workspaceKey(stream);
  const safe = base.replace(/\.{2,}/g, ".").replace(/^\.+/, "").replace(/\.+$/, "").replace(/\.lock$/i, "");
  if (safe === base && stream.toLowerCase() === stream) return base;
  // The hash is of the *original* stream, so distinct streams stay distinct even
  // when they normalize to the same text.
  const hash = crypto.createHash("sha256").update(stream, "utf8").digest("hex").slice(0, 16);
  return safe === "" ? `ref-${hash}` : `${safe}-${hash}`;
}

/**
 * Whether a string is safe to use as a work stream key (SPEC Appendix B.5). A stream
 * feeds both the branch template and the workspace path, so it is checked before it is
 * ever stored: no leading dash (git would read the branch as an option), no `..`, and
 * nothing outside the characters a branch name and a path can both carry.
 */
export function isSafeStreamIdentifier(value: string): boolean {
  if (value === "" || value.length > 200) return false;
  if (value.startsWith("-") || value.includes("..")) return false;
  return /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value);
}

/** Repository delivery settings (extension); null repository = plain empty workspaces. */
export interface WorkspaceRepoSettings {
  repository: string | null;
  base_branch: string | null;
  branch_template: string;
}

/** Git facts about an issue worktree/branch, gathered at delivery time (extension). */
export interface WorkspaceDeliveryInfo {
  branch: string;
  commit_sha: string | null;
  base_branch: string | null;
  files_changed: string[];
  uncommitted: string[];
  branch_exists: boolean;
}

export interface WorkspaceManagerOptions {
  root: string;
  hooks: HooksConfig;
  logger: Logger;
  repository?: string | null;
  baseBranch?: string | null;
  branchTemplate?: string;
}

const DEFAULT_BRANCH_TEMPLATE = "issue/{identifier}";

/**
 * Runner scratch files written into the workspace (issue snapshot in, result
 * envelope out). In repository mode they live inside the worktree, so git must
 * be told to ignore them: otherwise the agent commits them onto the issue
 * branch, they show up as the delivery's changed files, and deleting one leaves
 * the worktree dirty enough to block cleanup forever.
 */
const SCRATCH_FILES = ["SYMPHONY_ISSUE.json", "SYMPHONY_RESULT.json"];
const EXCLUDE_MARKER = "# symphony runner scratch files (local only)";

/** True for a `git status --porcelain` line about one of the scratch files. */
function isScratchLine(line: string): boolean {
  const p = line.slice(3).trim().replace(/^"|"$/g, "");
  return SCRATCH_FILES.includes(p);
}

export class WorkspaceManager {
  private opts: WorkspaceManagerOptions;
  constructor(opts: WorkspaceManagerOptions) {
    this.opts = opts;
  }

  /** Update effective hooks/root/repo after a config reload (SPEC §6.2). */
  update(root: string, hooks: HooksConfig, repo: WorkspaceRepoSettings): void {
    this.opts.root = root;
    this.opts.hooks = hooks;
    this.opts.repository = repo.repository;
    this.opts.baseBranch = repo.base_branch;
    this.opts.branchTemplate = repo.branch_template;
  }

  /** The branch name for a work stream, from the configured template (extension). */
  branchNameFor(stream: string): string {
    return (this.opts.branchTemplate ?? DEFAULT_BRANCH_TEMPLATE).replaceAll("{identifier}", stream);
  }

  /** The branch a stream delivers on, or null when this project has no repository. */
  deliveryBranchFor(stream: string): string | null {
    return this.opts.repository ? this.branchNameFor(stream) : null;
  }

  workspacePathFor(stream: string): string {
    const key = workspaceKey(stream);
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
   * Ensure the stream's workspace exists, running `after_create` only on fresh
   * creation (SPEC §9.2). Returns the logical Workspace record.
   *
   * `requireExistingBranch` (follow-ups, SPEC Appendix B.5) forbids creating the
   * branch: a follow-up joins work that already exists, so a missing branch means
   * the stream was merged away or renamed. Cutting a fresh one from the base would
   * silently fork the work — the exact divergence follow-ups exist to prevent — so
   * this fails loudly instead and lets an operator decide.
   *
   * `agentKind` names the backend doing the work, so its commits can be authored
   * as Symphony rather than as whoever owns the repository (extension).
   */
  async createForIssue(stream: string, requireExistingBranch = false, agentKind?: string): Promise<Workspace> {
    const key = workspaceKey(stream);
    const wsPath = this.workspacePathFor(stream);
    let created_now = false;

    // Forget registrations whose directory is gone before anything reads the
    // worktree list: without this `worktree add` fails with "already registered"
    // and the issue can never run again. It runs ahead of the checks below —
    // not just on the creation path — so a half-removed worktree left by a
    // failed cleanup self-heals on the next attempt instead of blocking it.
    if (this.opts.repository) await this.git(this.opts.repository, ["worktree", "prune"], true);

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
    if (stat && this.opts.repository) {
      // A directory that is not a worktree (e.g. left by a run from before the
      // project gained a repository) would silently take the agent's work off
      // any branch, so refuse it — unless it is empty and safe to replace. The
      // test is the worktree *root*: a workspace root inside the repository
      // makes every plain directory under it "inside a work tree".
      const top = (await this.git(wsPath, ["rev-parse", "--show-toplevel"], true))?.trim();
      if (!top || path.resolve(top) !== path.resolve(wsPath)) {
        if (fs.readdirSync(wsPath).length > 0) {
          // Usually a worktree whose removal died half-way: git had already
          // deleted the admin files, so nothing here can tell what the contents
          // were for. Name the path — deleting it is the whole recovery, and
          // without it the issue is blocked permanently.
          throw new WorkspaceError(
            `workspace path ${wsPath} exists but is not a git worktree; move or remove it (delete ${wsPath} to unblock this issue)`,
          );
        }
        fs.rmSync(wsPath, { recursive: true, force: true });
        stat = null;
      } else {
        // Reuse is the normal path for a follow-up, so check what we are reusing:
        // a worktree left on some other branch would take the run's commits to the
        // wrong place, and there is no safe way to switch it (it may hold work).
        const expected = this.branchNameFor(stream);
        const actual = (await this.git(wsPath, ["branch", "--show-current"], true))?.trim();
        if (actual !== expected) {
          throw new WorkspaceError(
            `workspace ${wsPath} is checked out on ${actual || "a detached HEAD"}, expected ${expected}; resolve it by hand`,
          );
        }
      }
    }
    if (!stat && this.opts.repository) {
      const repo = this.opts.repository;
      const branch = this.branchNameFor(stream);
      try {
        fs.mkdirSync(path.dirname(wsPath), { recursive: true });
        const existing = await this.git(repo, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], true);
        if (existing === null && requireExistingBranch) {
          throw new WorkspaceError(
            `branch ${branch} no longer exists in the repository; a follow-up continues an existing branch and will not cut a new one`,
          );
        }
        // New branches are cut from the configured base (default: the repo's
        // current branch). The base is recorded now, while it is still true —
        // the repo's HEAD may have moved on by the time the run delivers.
        const base = await this.resolveBase(repo);
        const addArgs = existing === null
          ? ["worktree", "add", "-b", branch, wsPath, ...(base.ref ? [base.ref] : [])]
          : ["worktree", "add", wsPath, branch];
        await this.git(repo, addArgs);
        // A branch we did not create has no recorded base; recover one now, while the
        // reflog that knows where it came from is still likely to be there.
        if (existing === null) await this.recordBase(repo, stream, branch, base);
        else await this.baseFor(repo, stream, branch);
        created_now = true;
      } catch (err) {
        if (err instanceof WorkspaceError) throw err; // already a precise diagnosis
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

    // Idempotent, and applied to reused worktrees too so workspaces created
    // before this rule still get it.
    if (this.opts.repository) {
      await this.excludeScratchFiles(wsPath);
      await this.setCommitIdentity(this.opts.repository, wsPath, agentKind);
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
        throw new WorkspaceError(`after_create hook failed for ${stream}`);
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

  /**
   * Remove a stream's workspace, running `before_remove` first (SPEC §9.4). Used for
   * terminal issues. The caller is responsible for not cleaning a stream that another
   * issue still belongs to (SPEC Appendix B.5) — this class cannot see the tracker.
   */
  async cleanupForIssue(stream: string): Promise<void> {
    const wsPath = this.workspacePathFor(stream);
    if (!fs.existsSync(wsPath)) return;
    if (this.opts.hooks.before_remove) {
      await this.runHook("before_remove", this.opts.hooks.before_remove, wsPath);
    }
    if (this.opts.repository) {
      const branch = this.branchNameFor(stream);
      const dirty = await this.uncommittedPaths(wsPath);
      if (dirty === null || dirty.length > 0) {
        // Hard rule: never delete the only copy of uncommitted work — and when we
        // cannot verify cleanliness, preserve rather than risk it (extension).
        this.opts.logger.warn("workspace preserved because git worktree has uncommitted changes", { stream, path: wsPath, changes: dirty === null ? "(git status failed)" : dirty.join(", ") });
        return;
      }
      if (!(await this.branchExists(branch))) {
        // Without the branch ref, removing the worktree would drop committed work too.
        this.opts.logger.warn("workspace preserved because its issue branch is missing in the repository", { stream, path: wsPath, branch });
        return;
      }
      try {
        // `git worktree remove` refuses worktrees with untracked files. Our own
        // scratch files are excluded from the dirty check above, so drop them here
        // too — anything else untracked would have preserved the worktree already.
        // A scratch file an older run committed is tracked: restore it after the
        // delete so the worktree git sees is clean.
        for (const name of SCRATCH_FILES) {
          try {
            fs.rmSync(path.join(wsPath, name), { force: true });
          } catch {
            /* best effort */
          }
          await this.git(wsPath, ["checkout", "--", name], true);
        }
        await this.git(this.opts.repository, ["worktree", "remove", wsPath]);
        this.opts.logger.info("git worktree cleaned; issue branch retained", { stream, path: wsPath, branch });
      } catch (err) {
        // `worktree remove` deletes the worktree's admin files before its
        // contents, so a single held file handle (an agent subprocess that has
        // not fully exited) leaves a directory that is no longer a worktree —
        // and `createForIssue`'s guard then refuses that path forever. Deleting
        // it ourselves is safe *here specifically*: the checks above already
        // proved the worktree is clean and its branch exists, so every byte in
        // it is reproducible from the branch. Ignored files (node_modules, a
        // local .env) go too — exactly as `worktree remove` would have taken
        // them.
        this.opts.logger.warn("git worktree removal failed; deleting the directory instead", { stream, path: wsPath, error: String(err) });
        try {
          fs.rmSync(wsPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
          await this.git(this.opts.repository, ["worktree", "prune"], true);
          this.opts.logger.info("git worktree cleaned; issue branch retained", { stream, path: wsPath, branch });
        } catch (rmErr) {
          this.opts.logger.warn("stranded worktree directory left behind; delete it to unblock this issue", { stream, path: wsPath, branch, error: String(rmErr) });
        }
      }
      return;
    }
    try {
      fs.rmSync(wsPath, { recursive: true, force: true });
      this.opts.logger.info("workspace cleaned", { stream, path: wsPath });
    } catch (err) {
      this.opts.logger.warn("workspace cleanup failed", { stream, path: wsPath, error: String(err) });
    }
  }

  /**
   * Git facts for delivery recording (extension): branch head, changed files vs
   * the base, and any uncommitted paths still in the worktree. Returns null when
   * this is not a repository project or the worktree is already gone.
   */
  async deliveryInfo(stream: string): Promise<WorkspaceDeliveryInfo | null> {
    if (!this.opts.repository) return null;
    const wsPath = this.workspacePathFor(stream);
    if (!fs.existsSync(wsPath)) return null;
    const repo = this.opts.repository;
    const branch = this.branchNameFor(stream);
    const uncommitted = (await this.uncommittedPaths(wsPath)) ?? [];
    const commitSha = (await this.git(wsPath, ["rev-parse", "HEAD"], true))?.trim() || null;
    const branchExists = await this.branchExists(branch);
    // What the branch was actually cut from: recorded at creation, or recovered from the
    // branch's reflog when it never was. Resolving it live is the last resort, and a poor
    // one — the repo's HEAD may have moved to an unrelated branch since, which is exactly
    // why the base is stored in the first place.
    const stored = await this.baseFor(repo, stream, branch);
    const base = stored.ref ?? stored.sha ?? (await this.resolveBase(repo)).ref;
    // Diffing from the recorded start commit is exact; the ref name is a
    // best-effort stand-in when we only have that.
    const from = stored.sha ?? base;
    let filesChanged: string[] = [];
    if (from && branchExists) {
      // Three-dot: diff from the merge-base, so base may have moved since branching.
      const out = await this.git(repo, ["diff", "--name-only", `${from}...${branch}`], true);
      if (out) filesChanged = out.split(/\r?\n/).filter((l) => l !== "" && !SCRATCH_FILES.includes(l));
    }
    return { branch, commit_sha: commitSha, base_branch: base, files_changed: filesChanged, uncommitted, branch_exists: branchExists };
  }

  /** Push the issue branch to the `origin` remote (extension; delivery_mode push/pr). */
  async pushBranch(branch: string): Promise<void> {
    if (!this.opts.repository) throw new WorkspaceError("no workspace.repository configured");
    // `--` ends option parsing: the branch is read back from tracker data, which
    // must never be able to hand git an option like `--receive-pack`.
    await this.git(this.opts.repository, ["push", "origin", "--", branch]);
  }

  /**
   * The ref an issue branch should be cut from right now: the configured
   * `base_branch`, else the repository's current branch. `ref` is null on a
   * detached HEAD (git then branches from HEAD anyway); `sha` pins the exact
   * commit either way.
   */
  private async resolveBase(repo: string): Promise<{ ref: string | null; sha: string | null }> {
    const configured = this.opts.baseBranch;
    const ref = configured ?? (await this.git(repo, ["branch", "--show-current"], true))?.trim() ?? null;
    const sha = (await this.git(repo, ["rev-parse", "--verify", configured ?? "HEAD"], true))?.trim() ?? null;
    return { ref: ref || null, sha: sha || null };
  }

  /**
   * Remember the branch's base (extension). The commit goes into
   * `refs/symphony/base/<stream>`, which — unlike the local config this used to
   * live in — is a reachability root: git will not garbage-collect a commit a ref
   * points at, so the base survives the branch being merged and deleted and the
   * repository being pruned. The base *ref name* has nowhere to live in a ref, so
   * it stays in local config as a human-readable decoration; the ref is the
   * authority for anything that has to be exact.
   *
   * Best effort by design: the base is a delivery nicety, and a repository that
   * refuses the write must not fail the run that was about to start.
   */
  private async recordBase(repo: string, stream: string, branch: string, base: { ref: string | null; sha: string | null }): Promise<void> {
    if (base.sha) {
      const ok = await this.writeRefs(repo, [{ ref: `refs/symphony/base/${refKey(stream)}`, oid: base.sha }]);
      if (!ok) this.opts.logger.warn("could not record the branch base as a ref", { stream, branch, base_sha: base.sha });
    }
    if (base.ref) await this.git(repo, ["config", "--local", "--replace-all", `symphony.${branch}.base`, base.ref], true);
  }

  /**
   * The stored base: the ref first, then the local config that older builds wrote,
   * so worktrees created before this milestone keep working. Stream-keyed refs and
   * branch-keyed config can disagree after a `branch_template` change — the ref wins,
   * because the stream is immutable and the branch name is not.
   */
  private async storedBase(repo: string, stream: string, branch: string): Promise<{ ref: string | null; sha: string | null }> {
    const ref = (await this.git(repo, ["config", "--local", "--get", `symphony.${branch}.base`], true))?.trim() || null;
    const fromRef = (await this.git(repo, ["rev-parse", "--verify", "--quiet", `refs/symphony/base/${refKey(stream)}^{commit}`], true))?.trim();
    const legacy = (await this.git(repo, ["config", "--local", "--get", `symphony.${branch}.baseSha`], true))?.trim();
    return { ref, sha: fromRef || legacy || null };
  }

  /**
   * The branch's base, recovering it when it was never recorded.
   *
   * `recordBase` only ever fires when Symphony creates the branch, so a branch that
   * already existed — cut by hand, or by a build from before bases were recorded — has
   * none, permanently. Delivery then falls back to whatever ref the repository happens to
   * have checked out, and a diff against an unrelated branch credits that branch's commits
   * to the issue.
   *
   * Git still knows the answer: the oldest entry in the branch's own reflog is the commit
   * it was created at. That is used once, verified to actually be an ancestor of the branch
   * (a force-moved branch's creation entry may no longer be one), and then recorded like
   * any other base so the recovery happens a single time while reflogs are still around.
   */
  private async baseFor(repo: string, stream: string, branch: string): Promise<{ ref: string | null; sha: string | null }> {
    const stored = await this.storedBase(repo, stream, branch);
    if (stored.ref || stored.sha) return stored;
    const sha = await this.branchCreationCommit(repo, branch);
    if (!sha) return stored;
    // No ref name is recoverable — the branch it was cut from may be long gone — so the
    // commit itself becomes the base. It is exact, which the ref name never was.
    await this.recordBase(repo, stream, branch, { ref: null, sha });
    this.opts.logger.info("recovered a missing branch base from the reflog", { branch, base_sha: sha });
    return { ref: null, sha };
  }

  /** The commit a branch was created at, per its reflog; null when unknown or unusable. */
  private async branchCreationCommit(repo: string, branch: string): Promise<string | null> {
    const out = await this.git(repo, ["reflog", "show", "--format=%H", `refs/heads/${branch}`], true);
    if (!out) return null; // no reflog for this ref (expired, or never had one)
    const lines = out.split(/\r?\n/).filter((l) => l.trim() !== "");
    const created = lines.at(-1)?.trim();
    if (!created) return null;
    // The branch must still descend from it; otherwise the branch was reset or force-moved
    // and its creation point says nothing useful about what it contains now.
    const ok = await this.git(repo, ["merge-base", "--is-ancestor", created, branch], true);
    return ok === null ? null : created;
  }

  /**
   * Author this worktree's commits as Symphony (extension). Unattended machine
   * commits are otherwise indistinguishable from hand-written ones in
   * `git blame` and `git log --author`, which are the tools an operator reaches
   * for when reviewing what an agent did.
   *
   * Per-worktree config is the only durable place for this: it applies to every
   * git invocation in the directory, including ones the agent makes itself,
   * where `GIT_AUTHOR_*` environment variables would not survive (an `--amend`
   * in a later shell drops them). It dies with the worktree, which is correct —
   * hence re-setting it on every creation, reuse included.
   *
   * Best effort throughout: a repository that refuses this must not fail a run.
   */
  private async setCommitIdentity(repo: string, wsPath: string, agentKind?: string): Promise<void> {
    // The kind comes from config and lands inside a git identity line, where a
    // stray `<` or `>` would produce a malformed author that git then rejects.
    const kind = (agentKind ?? "agent").replace(/[^A-Za-z0-9._-]/g, "") || "agent";
    // Worktree-scoped config is inert until the repository opts in. Setting it
    // once at repository level keeps the blast radius visible; it is a no-op for
    // the non-bare repositories `workspace.repository` can usefully point at.
    await this.git(repo, ["config", "--local", "extensions.worktreeConfig", "true"], true);
    await this.git(wsPath, ["config", "--worktree", "user.name", `Symphony (${kind})`], true);
    await this.git(wsPath, ["config", "--worktree", "user.email", `symphony+${kind}@localhost`], true);
  }

  /**
   * Teach git to ignore the runner's scratch files, via the worktree's exclude
   * file (`info/exclude` — repository-local, never committed). Best effort: an
   * unwritable exclude file only costs us the tidiness, so it must not fail a run.
   */
  private async excludeScratchFiles(wsPath: string): Promise<void> {
    const rel = (await this.git(wsPath, ["rev-parse", "--git-path", "info/exclude"], true))?.trim();
    if (!rel) return;
    const file = path.resolve(wsPath, rel);
    try {
      let text = "";
      try {
        text = fs.readFileSync(file, "utf8");
      } catch {
        /* no exclude file yet */
      }
      const lines = text.split(/\r?\n/);
      const missing = SCRATCH_FILES.filter((name) => !lines.includes(`/${name}`));
      if (missing.length === 0) return;
      const body = (text && !text.endsWith("\n") ? "\n" : "") + `${EXCLUDE_MARKER}\n` + missing.map((n) => `/${n}\n`).join("");
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, body, "utf8");
    } catch (err) {
      this.opts.logger.debug("could not update git exclude for scratch files", { path: file, error: String(err) });
    }
  }

  private async branchExists(branch: string): Promise<boolean> {
    if (!this.opts.repository) return false;
    return (await this.git(this.opts.repository, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], true)) !== null;
  }

  /**
   * Porcelain status of the worktree, excluding the runner's own scratch files.
   * Null when git itself fails (callers must treat that as "unknown", not "clean").
   */
  private async uncommittedPaths(wsPath: string): Promise<string[] | null> {
    const out = await this.git(wsPath, ["status", "--porcelain"], true);
    if (out === null) return null;
    return out.split(/\r?\n/).filter((line) => line !== "" && !isScratchLine(line));
  }

  private async git(cwd: string, args: string[], allowFailure = false): Promise<string | null> {
    try {
      const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], { encoding: "utf8" });
      return stdout;
    } catch (err) {
      if (allowFailure) return null;
      const detail = err instanceof Error ? err.message : String(err);
      throw new WorkspaceError(`git ${args.join(" ")} failed: ${detail}`);
    }
  }

  /**
   * `git()` for a command that reads stdin. `execFileAsync` gives no hook for
   * writing to the child, so this drops to raw `execFile` and closes stdin with
   * the payload. Written as an explicit Buffer: the payloads here are NUL- and
   * LF-delimited, and anything that CRLF-normalizes them corrupts the grammar.
   */
  private gitIn(cwd: string, args: string[], payload: string, allowFailure = false): Promise<string | null> {
    return new Promise((resolve, reject) => {
      const child = execFile("git", ["-C", cwd, ...args], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
        if (!err) return resolve(stdout);
        if (allowFailure) return resolve(null);
        reject(new WorkspaceError(`git ${args.join(" ")} failed: ${err.message}`));
      });
      // git exits before draining stdin when it dislikes the payload; without this
      // the resulting EPIPE is an unhandled stream error and takes the host down
      // instead of rejecting the promise.
      child.stdin?.on("error", () => {});
      child.stdin?.end(Buffer.from(payload, "utf8"));
    });
  }

  /**
   * Point `refs/symphony/*` refs at commits in one all-or-nothing transaction
   * (extension). Either every ref moves or none does, so a delivery can never be
   * recorded half-way — the tag and the base it is meaningful against always agree.
   *
   * `update` with an empty old-oid, not `create`: a stream re-delivers every time
   * a follow-up lands on it (SPEC Appendix B.5), and `create` fails on a ref that
   * already exists — which, the transaction being atomic, would silently discard
   * the whole record from the second delivery onwards.
   */
  private async writeRefs(repo: string, updates: Array<{ ref: string; oid: string }>): Promise<boolean> {
    if (updates.length === 0) return true;
    const payload = ["start\0", ...updates.map((u) => `update ${u.ref}\0${u.oid}\0\0`), "prepare\0", "commit\0"].join("");
    return (await this.gitIn(repo, ["update-ref", "--stdin", "-z"], payload, true)) !== null;
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
