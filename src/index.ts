#!/usr/bin/env node
/**
 * Symphony CLI / host lifecycle. Usage:
 *   symphony [path-to-WORKFLOW.md] [--port N]
 *   symphony --projects <manifest.json> [--port N]   # multi-project (host extension)
 * With no --projects flag it uses ./symphony.projects.json if present, else falls
 * back to a single "default" project at ./WORKFLOW.md. Exits nonzero on startup failure.
 */
import process from "node:process";
import path from "node:path";
import fs from "node:fs";
import { Logger, StderrSink, type LogLevel } from "./logger.ts";
import { resolveWorkflowPath } from "./workflow/loader.ts";
import { ProjectManager } from "./project/manager.ts";
import { SymphonyHttpServer } from "./server/httpServer.ts";

const DEFAULT_MANIFEST = "symphony.projects.json";

interface CliArgs {
  workflowPath: string | null;
  manifestPath: string | null;
  port: number | null;
  host: string | null;
}

function parseArgs(argv: string[]): CliArgs {
  let workflowPath: string | null = null;
  let manifestPath: string | null = null;
  let port: number | null = null;
  let host: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--port") {
      const v = argv[++i];
      if (v === undefined || Number.isNaN(Number(v))) throw new Error("--port requires a numeric value");
      port = Math.trunc(Number(v));
    } else if (a.startsWith("--port=")) {
      port = Math.trunc(Number(a.slice("--port=".length)));
    } else if (a === "--host") {
      const v = argv[++i];
      if (v === undefined) throw new Error("--host requires a value");
      host = v;
    } else if (a.startsWith("--host=")) {
      host = a.slice("--host=".length);
    } else if (a === "--projects") {
      const v = argv[++i];
      if (v === undefined) throw new Error("--projects requires a path to a manifest JSON file");
      manifestPath = v;
    } else if (a.startsWith("--projects=")) {
      manifestPath = a.slice("--projects=".length);
    } else if (a === "-h" || a === "--help") {
      process.stdout.write("Usage: symphony [path-to-WORKFLOW.md] [--projects <manifest.json>] [--port N] [--host <addr>]\n");
      process.exit(0);
    } else if (!a.startsWith("-")) {
      workflowPath = a;
    }
  }
  return { workflowPath, manifestPath, port, host };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const level = (process.env.SYMPHONY_LOG_LEVEL as LogLevel) || "info";
  const logger = new Logger([new StderrSink()], level);

  // Choose the project source (extended for multi-project):
  //   1. --projects <manifest>  2. ./symphony.projects.json if present  3. single WORKFLOW.md.
  const explicitManifest = args.manifestPath ? path.resolve(args.manifestPath) : null;
  const defaultManifest = path.resolve(process.cwd(), DEFAULT_MANIFEST);
  const manifestPath = explicitManifest ?? (fs.existsSync(defaultManifest) ? defaultManifest : null);

  let manager: ProjectManager;
  try {
    if (manifestPath) {
      if (!fs.existsSync(manifestPath)) throw new Error(`projects manifest not found at ${manifestPath}`);
      manager = ProjectManager.fromManifest(manifestPath, logger);
    } else {
      const workflowPath = resolveWorkflowPath(args.workflowPath);
      if (!fs.existsSync(workflowPath)) throw new Error(`workflow file not found at ${workflowPath}`);
      manager = ProjectManager.fromSingleWorkflow(workflowPath, logger);
    }
  } catch (err) {
    logger.error("startup failed building projects", { error: String(err) });
    process.exit(1);
  }

  logger.info("symphony starting", {
    mode: manifestPath ? "multi" : "single",
    manifest: manifestPath ?? "",
    projects: manager.list().length,
  });

  try {
    await manager.startAll();
  } catch (err) {
    logger.error("project startup failed", { error: String(err) });
    process.exit(1);
  }

  // OPTIONAL HTTP server: CLI --port overrides per-project server.port.
  const effectivePort = args.port ?? manager.get(manager.firstId())?.orchestrator.serverPort() ?? null;
  let httpServer: SymphonyHttpServer | null = null;
  if (effectivePort !== null && effectivePort !== undefined) {
    // Bind address: --host flag overrides SYMPHONY_HOST env, default loopback
    // A blank/whitespace-only value is treated as unset so that
    // `SYMPHONY_HOST=` in an env file can't silently widen the bind to `::`.
    const hostFlag = args.host != null ? args.host.trim() : "";
    const hostEnv = process.env.SYMPHONY_HOST != null ? process.env.SYMPHONY_HOST.trim() : "";
    const effectiveHost = hostFlag || hostEnv || null;
    httpServer = new SymphonyHttpServer({ manager, logger, port: effectivePort, host: effectiveHost ?? undefined });
    try {
      await httpServer.listen();
    } catch (err) {
      logger.error("http server failed to bind", { port: effectivePort, error: String(err) });
    }
  }

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("shutting down", { signal });
    httpServer?.close();
    await manager.stopAll();
    process.exit(0);
  };
  const onSignal = (signal: string) => {
    void shutdown(signal).catch((err) => {
      logger.error("shutdown failed", { error: String(err) });
      process.exitCode = 1;
    });
  };
  process.on("SIGINT", () => onSignal("SIGINT"));
  process.on("SIGTERM", () => onSignal("SIGTERM"));
}

main().catch((err) => {
  process.stderr.write(`fatal: ${String(err)}\n`);
  process.exit(1);
});
