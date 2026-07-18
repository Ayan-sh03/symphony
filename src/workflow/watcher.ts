/**
 * Workflow watch/reload (SPEC §6.2). Detects WORKFLOW.md changes and re-applies
 * without restart. Uses polling (fs.watchFile) for cross-platform reliability;
 * the orchestrator also re-validates defensively each tick in case an event is
 * missed. Invalid reloads never crash the service — they keep the last good config.
 */
import fs from "node:fs";
import type { Logger } from "../logger.ts";
import { loadWorkflow, WorkflowError } from "./loader.ts";
import type { WorkflowDefinition } from "../domain/types.ts";

export interface WatcherOptions {
  path: string;
  logger: Logger;
  onReload: (def: WorkflowDefinition) => void;
  intervalMs?: number;
}

export class WorkflowWatcher {
  private watcher: fs.StatWatcher | null = null;
  private lastMtime = 0;

  private opts: WatcherOptions;
  constructor(opts: WatcherOptions) {
    this.opts = opts;
  }

  start(): void {
    try {
      this.lastMtime = fs.statSync(this.opts.path).mtimeMs;
    } catch {
      this.lastMtime = 0;
    }
    const interval = this.opts.intervalMs ?? 1000;
    this.watcher = fs.watchFile(this.opts.path, { interval }, (curr) => {
      if (curr.mtimeMs === this.lastMtime) return;
      this.lastMtime = curr.mtimeMs;
      this.reload();
    });
  }

  private reload(): void {
    let def: WorkflowDefinition;
    try {
      def = loadWorkflow(this.opts.path);
    } catch (err) {
      const cls = err instanceof WorkflowError ? err.errorClass : "workflow_parse_error";
      this.opts.logger.error("workflow reload failed; keeping last good config", { error_class: cls, error: String(err) });
      return;
    }
    this.opts.logger.info("workflow change detected; reapplying", { path: this.opts.path });
    try {
      this.opts.onReload(def);
    } catch (err) {
      this.opts.logger.error("workflow reapply failed", { error: String(err) });
    }
  }

  stop(): void {
    fs.unwatchFile(this.opts.path);
    this.watcher = null;
  }
}
