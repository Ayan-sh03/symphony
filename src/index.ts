#!/usr/bin/env node
/**
 * Symphony CLI / host lifecycle (SPEC §5.1, §17.7). Usage:
 *   symphony [path-to-WORKFLOW.md] [--port N]
 * Defaults to ./WORKFLOW.md. Exits nonzero on startup failure.
 */
import process from "node:process";
import fs from "node:fs";
import { Logger, StderrSink, type LogLevel } from "./logger.ts";
import { resolveWorkflowPath, loadWorkflow, WorkflowError } from "./workflow/loader.ts";
import { buildConfig, ConfigError } from "./config/config.ts";
import { Orchestrator } from "./orchestrator/orchestrator.ts";
import { WorkflowWatcher } from "./workflow/watcher.ts";
import { SymphonyHttpServer } from "./server/httpServer.ts";

interface CliArgs {
  workflowPath: string | null;
  port: number | null;
}

function parseArgs(argv: string[]): CliArgs {
  let workflowPath: string | null = null;
  let port: number | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--port") {
      const v = argv[++i];
      if (v === undefined || Number.isNaN(Number(v))) throw new Error("--port requires a numeric value");
      port = Math.trunc(Number(v));
    } else if (a.startsWith("--port=")) {
      port = Math.trunc(Number(a.slice("--port=".length)));
    } else if (a === "-h" || a === "--help") {
      process.stdout.write("Usage: symphony [path-to-WORKFLOW.md] [--port N]\n");
      process.exit(0);
    } else if (!a.startsWith("-")) {
      workflowPath = a;
    }
  }
  return { workflowPath, port };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const level = (process.env.SYMPHONY_LOG_LEVEL as LogLevel) || "info";
  const logger = new Logger([new StderrSink()], level);

  // Resolve workflow path (SPEC §5.1). Explicit path must exist; default ./WORKFLOW.md must exist.
  const workflowPath = resolveWorkflowPath(args.workflowPath);
  if (!fs.existsSync(workflowPath)) {
    logger.error("workflow file not found", { path: workflowPath });
    process.exit(1);
  }

  let workflow;
  let config;
  try {
    workflow = loadWorkflow(workflowPath);
    config = buildConfig(workflow, workflowPath);
  } catch (err) {
    const cls = err instanceof WorkflowError ? err.errorClass : err instanceof ConfigError ? "config_error" : "startup_error";
    logger.error("startup failed loading workflow/config", { error_class: cls, error: String(err) });
    process.exit(1);
  }

  logger.info("symphony starting", {
    workflow: workflowPath,
    tracker_kind: config.tracker.kind,
    agent_kind: config.agent_kind,
    workspace_root: config.workspace_root,
    poll_interval_ms: config.poll_interval_ms,
  });

  const orchestrator = new Orchestrator({ config, workflow, workflowPath, logger });

  try {
    await orchestrator.start();
  } catch (err) {
    logger.error("orchestrator startup failed", { error: String(err) });
    process.exit(1);
  }

  // Dynamic reload (SPEC §6.2).
  const watcher = new WorkflowWatcher({
    path: workflowPath,
    logger,
    onReload: (def) => orchestrator.reload(def),
  });
  watcher.start();

  // OPTIONAL HTTP server: CLI --port overrides server.port (SPEC §13.7).
  const effectivePort = args.port ?? config.server_port;
  let httpServer: SymphonyHttpServer | null = null;
  if (effectivePort !== null && effectivePort !== undefined) {
    httpServer = new SymphonyHttpServer({ orchestrator, logger, port: effectivePort });
    try {
      await httpServer.listen();
    } catch (err) {
      logger.error("http server failed to bind", { port: effectivePort, error: String(err) });
    }
  }

  const shutdown = (signal: string) => {
    logger.info("shutting down", { signal });
    watcher.stop();
    httpServer?.close();
    orchestrator.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  process.stderr.write(`fatal: ${String(err)}\n`);
  process.exit(1);
});
