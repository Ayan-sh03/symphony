/**
 * Tracker adapter registry (SPEC §5.3.1, §6.3). Selects a supported adapter by
 * `tracker.kind` and validates its provider config for dispatch preflight.
 */
import type { Logger } from "../logger.ts";
import { AdapterError, type TrackerAdapter } from "./types.ts";
import { FileTrackerAdapter } from "./fileAdapter.ts";
import { GitHubTrackerAdapter } from "./githubAdapter.ts";

export const SUPPORTED_KINDS = ["file", "github"] as const;

export function isSupportedKind(kind: string): boolean {
  return (SUPPORTED_KINDS as readonly string[]).includes(kind);
}

/** Validate tracker.kind + provider without constructing side effects (SPEC §6.3). */
export function validateTracker(kind: string, provider: Record<string, unknown>): void {
  if (!kind || kind.trim() === "") {
    throw new AdapterError("invalid_tracker_config", "tracker.kind is required");
  }
  if (!isSupportedKind(kind)) {
    throw new AdapterError("unsupported_tracker_kind", `unsupported tracker.kind: ${kind}`);
  }
  if (kind === "file") FileTrackerAdapter.validate(provider);
  if (kind === "github") GitHubTrackerAdapter.validate(provider);
}

/** Construct the adapter for the effective config (SPEC §11.2 construction). */
export function createAdapter(
  kind: string,
  provider: Record<string, unknown>,
  workflowDir: string,
  logger: Logger,
): TrackerAdapter {
  validateTracker(kind, provider);
  if (kind === "file") return FileTrackerAdapter.create(provider, workflowDir, logger);
  if (kind === "github") return GitHubTrackerAdapter.create(provider, workflowDir, logger);
  throw new AdapterError("unsupported_tracker_kind", `unsupported tracker.kind: ${kind}`);
}
