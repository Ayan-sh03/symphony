/**
 * Project manager (multi-project host extension; not part of the single-workflow
 * SPEC). Owns one independent, SPEC-conformant Orchestrator + WorkflowWatcher per
 * registered project. All projects poll and run agents concurrently in the
 * background; selecting a project in the console changes only the view. The set is
 * loaded from a persistent manifest and can be appended to at runtime.
 */
import fs from "node:fs";
import path from "node:path";
import type { Logger } from "../logger.ts";
import { Orchestrator } from "../orchestrator/orchestrator.ts";
import { AgentDiscoveryCache } from "../agent/discoveryCache.ts";
import { WorkflowWatcher } from "../workflow/watcher.ts";
import { loadWorkflow } from "../workflow/loader.ts";
import { buildConfig } from "../config/config.ts";
import {
  loadManifest,
  saveManifest,
  resolveEntryWorkflow,
  deriveId,
  type ProjectEntry,
} from "./manifest.ts";

export interface Project {
  id: string;
  name: string;
  workflowPath: string;
  orchestrator: Orchestrator;
  watcher: WorkflowWatcher;
}

/** One row in the project switcher: identity plus a lightweight activity badge. */
export interface ProjectSummary {
  id: string;
  name: string;
  workflow: string;
  running: number;
  retrying: number;
}

export class ProjectManager {
  private projects = new Map<string, Project>();
  private logger: Logger;
  /** Manifest to persist runtime additions to; null in single-project mode (no persistence). */
  private manifestPath: string | null;
  /** One host cache prevents equivalent projects from repeatedly spawning probes. */
  private agentDiscoveryCache = new AgentDiscoveryCache();

  constructor(logger: Logger, manifestPath: string | null) {
    this.logger = logger;
    this.manifestPath = manifestPath;
  }

  /** Build a manager from a manifest, skipping (not failing on) broken entries. */
  static fromManifest(manifestPath: string, logger: Logger): ProjectManager {
    const mgr = new ProjectManager(logger, path.resolve(manifestPath));
    const entries = loadManifest(manifestPath);
    for (const entry of entries) {
      const workflowPath = resolveEntryWorkflow(manifestPath, entry);
      try {
        mgr.instantiate(entry.id, entry.name, workflowPath);
      } catch (err) {
        logger.error("skipping broken project", { project: entry.id, workflow: workflowPath, error: String(err) });
      }
    }
    if (mgr.projects.size === 0) throw new Error("no usable projects in manifest");
    return mgr;
  }

  /** Build a single-project manager (back-compat with `symphony [WORKFLOW.md]`). */
  static fromSingleWorkflow(workflowPath: string, logger: Logger): ProjectManager {
    const mgr = new ProjectManager(logger, null);
    mgr.instantiate("default", "Default", path.resolve(workflowPath));
    return mgr;
  }

  /** Load + configure one project's orchestrator and watcher. Throws on bad workflow/config. */
  private instantiate(id: string, name: string, workflowPath: string): Project {
    const def = loadWorkflow(workflowPath);
    const config = buildConfig(def, workflowPath);
    const plog = this.logger.child({ project: id });
    const orchestrator = new Orchestrator({ config, workflow: def, workflowPath, logger: plog, agentDiscoveryCache: this.agentDiscoveryCache });
    const watcher = new WorkflowWatcher({
      path: workflowPath,
      logger: plog,
      onReload: (next) => orchestrator.reload(next),
    });
    const project: Project = { id, name, workflowPath, orchestrator, watcher };
    this.projects.set(id, project);
    return project;
  }

  /** Start every project's poll loop + workflow watcher. */
  async startAll(): Promise<void> {
    const pending = [...this.projects.values()];
    // Startup has I/O-heavy validation and cleanup. Four concurrent projects keep
    // large manifests responsive without serializing unrelated backends.
    const workers = Array.from({ length: Math.min(4, pending.length) }, async () => {
      for (;;) {
        const p = pending.shift();
        if (!p) return;
        try {
          await p.orchestrator.start();
          p.watcher.start();
          this.logger.info("project started", { project: p.id, workflow: p.workflowPath });
        } catch (err) {
          this.logger.error("project failed to start", { project: p.id, workflow: p.workflowPath, error: String(err) });
        }
      }
    });
    await Promise.all(workers);
  }

  get(id: string): Project | null {
    return this.projects.get(id) ?? null;
  }

  /** The id the console selects by default (first registered project). */
  firstId(): string {
    return this.projects.keys().next().value ?? "default";
  }

  /** Whether runtime add-project is available (requires a persistent manifest). */
  canAdd(): boolean {
    return this.manifestPath !== null;
  }

  list(): ProjectSummary[] {
    return [...this.projects.values()].map((p) => {
      const snap = p.orchestrator.snapshot();
      return {
        id: p.id,
        name: p.name,
        workflow: p.workflowPath,
        running: snap.counts.running,
        retrying: snap.counts.retrying,
      };
    });
  }

  /**
   * Register a new project at runtime: resolve + validate its WORKFLOW.md, assign a
   * stable id, start it, and append it to the manifest so it survives restart.
   */
  async add(input: { name?: string; workflow: string }): Promise<ProjectSummary> {
    if (!this.manifestPath) throw new Error("adding projects requires a projects manifest");
    const workflowPath = resolveWorkflowFile(input.workflow);
    if (!fs.existsSync(workflowPath)) throw new Error(`no WORKFLOW.md found at ${workflowPath}`);
    for (const p of this.projects.values()) {
      if (path.resolve(p.workflowPath) === path.resolve(workflowPath)) {
        throw new Error(`project already registered for ${workflowPath}`);
      }
    }
    const id = deriveId(workflowPath, this.projects.keys());
    const name = input.name && input.name.trim() !== "" ? input.name.trim() : id;

    const project = this.instantiate(id, name, workflowPath); // throws on bad workflow/config
    try {
      await project.orchestrator.start();
      project.watcher.start();
    } catch (err) {
      // Roll back a half-registered project so the manager stays consistent.
      project.watcher.stop();
      project.orchestrator.stop();
      this.projects.delete(id);
      throw err;
    }

    const entries = loadManifestSafe(this.manifestPath);
    entries.push({ id, name, workflow: workflowPath });
    saveManifest(this.manifestPath, entries);
    this.logger.info("project added", { project: id, workflow: workflowPath });

    const snap = project.orchestrator.snapshot();
    return { id, name, workflow: workflowPath, running: snap.counts.running, retrying: snap.counts.retrying };
  }

  stopAll(): void {
    for (const p of this.projects.values()) {
      p.watcher.stop();
      p.orchestrator.stop();
    }
  }
}

/** Accept either a WORKFLOW.md file or a project directory (cwd) and resolve to the file. */
function resolveWorkflowFile(input: string): string {
  const abs = path.resolve(input);
  try {
    if (fs.statSync(abs).isDirectory()) return path.join(abs, "WORKFLOW.md");
  } catch {
    /* fall through: treat as a file path that may not exist yet */
  }
  return abs;
}

/** Load the manifest for appending; treat a missing/broken file as empty rather than aborting the add. */
function loadManifestSafe(manifestPath: string): ProjectEntry[] {
  try {
    return loadManifest(manifestPath);
  } catch {
    return [];
  }
}
