/**
 * Agent Runner (SPEC §10.7, §16.5). Wraps workspace + prompt + agent session for
 * one worker attempt: prepares the workspace, runs hooks, drives the turn loop with
 * in-worker continuation on the same live thread, refreshes issue state between
 * turns, applies the self-tracking result write-back, and reports the exit outcome.
 *
 * Agent-backend-neutral: it depends only on the {@link AgentSession} interface.
 */
import { createExecutionSession, requireExecutionCapabilities } from "../execution/registry.ts";
import type { ExecutionSession } from "../execution/types.ts";
import type { Issue, AgentUpdate } from "../domain/types.ts";
import type { Logger } from "../logger.ts";
import type { ServiceConfigValues } from "../config/config.ts";
import type { TrackerAdapter } from "../tracker/types.ts";
import type { WorkspaceManager } from "../workspace/manager.ts";
import { renderPrompt, PromptError } from "../prompt/render.ts";
import { createAgentSession } from "./registry.ts";
import type { AgentSession } from "./types.ts";

export interface WorkerExit {
  kind: "normal" | "abnormal";
  reason?: string;
}

export interface RunnerDeps {
  config: ServiceConfigValues;
  /** Resolved agent backend for this run (per-issue override → default → config). */
  agentKind: string;
  /**
   * Work stream this run belongs to (SPEC Appendix B.5): the identifier whose
   * workspace and branch it uses. Equals the issue's own identifier for ordinary
   * issues; a follow-up names the issue it continues.
   */
  stream: string;
  /** True when this issue is a follow-up, so its branch must already exist. */
  isFollowUp: boolean;
  promptTemplate: string;
  adapter: TrackerAdapter;
  workspaceManager: WorkspaceManager;
  logger: Logger;
  /** Child environment with tracker secrets removed (SPEC §15.3). */
  childEnv: NodeJS.ProcessEnv;
  isActiveState: (state: string) => boolean;
  isTerminalState: (state: string) => boolean;
  isRoutable: (issue: Issue) => boolean;
  /** Emit an agent update to the orchestrator, keyed by issue id (SPEC §10.4). */
  onUpdate: (issueId: string, u: AgentUpdate) => void;
  /**
   * Hand the orchestrator a stop handle so reconciliation/stall detection can
   * terminate this live session (SPEC §8.5). Called once, after the session exists.
   */
  onSessionReady: (stop: () => Promise<void>) => void;
}

/** Name of the self-tracking write-back file the agent produces (policy contract). */
export const RESULT_FILE = "SYMPHONY_RESULT.json";

/**
 * Run one full worker attempt (SPEC §16.5). Returns how the worker exited so the
 * orchestrator can schedule a continuation retry (normal) or backoff retry (abnormal).
 */
export async function runAgentAttempt(
  issue0: Issue,
  attempt: number | null,
  deps: RunnerDeps,
): Promise<WorkerExit> {
  let issue = issue0;
  const log = (msg: string, extra: Record<string, unknown> = {}) =>
    deps.logger.info(msg, { issue_id: issue.id, issue_identifier: issue.identifier, ...extra });

  // 1. Workspace (the stream's, which for a follow-up is the parent's worktree)
  let workspace;
  try {
    workspace = await deps.workspaceManager.createForIssue(deps.stream, deps.isFollowUp, deps.agentKind);
  } catch (err) {
    return { kind: "abnormal", reason: `workspace error: ${(err as Error).message}` };
  }
  const wsPath = workspace.path;
  const branch = deps.workspaceManager.deliveryBranchFor(deps.stream);

  let execution: ExecutionSession;
  try {
    requireExecutionCapabilities(deps.config.execution.kind, ["process", "filesystem"]);
    execution = await createExecutionSession(deps.config.execution.kind, deps.config.execution.provider, {
      workspacePath: wsPath, env: deps.childEnv, logger: deps.logger,
    });
  } catch (err) {
    return { kind: "abnormal", reason: `execution startup error: ${String(err)}` };
  }

  let session: AgentSession | undefined;
  let stopped = false;
  let stopping: Promise<void> | undefined;
  let afterRun = false;
  const cancellation = new AbortController();
  let outcome: WorkerExit = { kind: "normal" };
  // One stop operation shared by cancellation and final cleanup. Keep rejection
  // observed here; final cleanup reports it in the worker outcome.
  const stop = (): Promise<void> => {
    stopped = true;
    cancellation.abort();
    stopping ??= Promise.resolve().then(() => session?.stop());
    void stopping.catch(() => {});
    return stopping;
  };
  try {
    for (const method of ["spawn", "readFile", "writeFile", "removeFile"] as const) {
      if (typeof execution[method] !== "function") throw new Error(`execution session lacks ${method}`);
    }
    if (!execution.workspacePath) throw new Error("execution session lacks workspacePath");
    deps.onSessionReady(stop);
    if (stopped) throw new Error("session stopped");
    if (!await deps.workspaceManager.runBeforeRun(wsPath, execution, cancellation.signal)) {
      throw new Error(stopped ? "session stopped" : "before_run hook error");
    }
    afterRun = true;
    if (stopped) throw new Error("session stopped");

    // Scratch paths are relative to the runtime, never interpreted on the host.
    try {
      await execution.writeFile!("SYMPHONY_ISSUE.json", JSON.stringify(issue, null, 2) + "\n");
    } catch (err) {
      deps.logger.warn("failed to write issue context", { issue_id: issue.id, error: String(err) });
    }
    if (stopped) throw new Error("session stopped");
    session = createAgentSession(deps.agentKind, {
      execution, workspacePath: execution.workspacePath, issue, config: deps.config,
      logger: deps.logger, onUpdate: (u) => deps.onUpdate(issue.id, u),
      adapter: deps.adapter, toolSpecs: deps.adapter.agentToolSpecs(), env: deps.childEnv,
      ...(issue.model ? { model: issue.model } : {}),
    });
    await session.start();
    if (stopped) throw new Error("session stopped");
    const maxTurns = deps.config.max_turns;
    let turnNumber = 1;
    while (true) {
      const prompt = turnNumber === 1
        ? renderPrompt(deps.promptTemplate, issue, attempt, branch)
        : continuationPrompt(issue, turnNumber, maxTurns);
      const turnResult = await session.runTurn(prompt, `${issue.identifier}: ${issue.title}`);
      log("turn finished", { turn: turnNumber, status: turnResult.status });
      if (stopped) throw new Error("session stopped");
      if (turnResult.status !== "completed") {
        throw new Error(`agent turn ${turnResult.status}: ${turnResult.error ?? ""}`);
      }
      await applyResultFile(execution, issue, deps, cancellation.signal);
      if (stopped) throw new Error("session stopped");
      const refreshed = await deps.adapter.fetchIssuesByIds([issue.id]);
      if (stopped) throw new Error("session stopped");
      if (refreshed.length === 0) break;
      issue = refreshed[0]!;
      if (!deps.isActiveState(issue.state) || !deps.isRoutable(issue)) break;
      if (turnNumber >= maxTurns) break;
      turnNumber++;
    }
  } catch (err) {
    const reason = err instanceof PromptError ? `${err.errorClass}: ${err.message}` : String(err);
    outcome = { kind: "abnormal", reason };
  } finally {
    const cleanupError = (phase: string, err: unknown) => {
      deps.logger.warn(`${phase} failed`, { issue_id: issue.id, error: String(err) });
      outcome = { kind: "abnormal", reason: [outcome.reason, `${phase}: ${String(err)}`].filter(Boolean).join("; ") };
    };
    let agentStopped = true;
    try { await stop(); }
    catch (err) { agentStopped = false; cleanupError("agent stop", err); }
    // A hook must not race a process whose termination failed.
    if (afterRun && agentStopped) {
      try { await deps.workspaceManager.runAfterRun(wsPath, execution); }
      catch (err) { deps.logger.warn("after_run failed", { issue_id: issue.id, error: String(err) }); }
    }
    try { await execution.close(); }
    catch (err) { cleanupError("execution close", err); }
  }
  return outcome;
}

function continuationPrompt(issue: Issue, turnNumber: number, maxTurns: number): string {
  return [
    `Continuing work on ${issue.identifier} (${issue.title}). This is turn ${turnNumber} of at most ${maxTurns}.`,
    `The issue is still in an active state ("${issue.state}"). Re-check the workspace and continue toward the next handoff.`,
    `When your work reaches a handoff point, record the outcome (see the workflow instructions) and stop.`,
  ].join("\n");
}

/**
 * Apply the agent's self-tracking result file if present, then remove it so it is
 * not reapplied. This is the credible channel by which the coding agent transitions
 * the tracked issue (SPEC §11.5 "ticket writes ... performed by the coding agent").
 */
async function applyResultFile(execution: ExecutionSession, issue: Issue, deps: RunnerDeps, signal: AbortSignal): Promise<void> {
  const file = RESULT_FILE;
  let text: string;
  try {
    text = Buffer.from(await execution.readFile!(file)).toString("utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return; // no result this turn
    throw err;
  }
  if (signal.aborted) throw new Error("session stopped");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    deps.logger.warn("invalid result file ignored", { issue_id: issue.id, issue_identifier: issue.identifier });
    try { await execution.removeFile!(file, { force: true }); } catch { /* ignore */ }
    return;
  }
  const res = await deps.adapter.executeAgentTool("set_issue_result", parsed, { issue });
  if (!res.success) throw new Error(`failed to apply agent result: ${JSON.stringify(res.output)}`);
  deps.logger.info("applied agent result", { issue_id: issue.id, issue_identifier: issue.identifier });
  try { await execution.removeFile!(file, { force: true }); } catch { /* ignore */ }
}
