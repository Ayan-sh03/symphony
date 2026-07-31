/**
 * Agent Runner (SPEC §10.7, §16.5). Wraps workspace + prompt + agent session for
 * one worker attempt: prepares the workspace, runs hooks, drives the turn loop with
 * in-worker continuation on the same live thread, refreshes issue state between
 * turns, applies the self-tracking result write-back, and reports the exit outcome.
 *
 * Agent-backend-neutral: it depends only on the {@link AgentSession} interface.
 */
import fs from "node:fs";
import path from "node:path";
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
  onSessionReady: (stop: () => void) => void;
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

  // 2. before_run hook (fatal to attempt)
  const beforeOk = await deps.workspaceManager.runBeforeRun(wsPath);
  if (!beforeOk) {
    return { kind: "abnormal", reason: "before_run hook error" };
  }

  // Write the current issue snapshot into the workspace for agent context.
  try {
    fs.writeFileSync(path.join(wsPath, "SYMPHONY_ISSUE.json"), JSON.stringify(issue, null, 2) + "\n", "utf8");
  } catch {
    /* non-fatal */
  }

  // 3. Start agent session (fatal on failure)
  const toolSpecs = deps.adapter.agentToolSpecs();
  let session: AgentSession;
  try {
    session = createAgentSession(deps.agentKind, {
      workspacePath: wsPath,
      issue,
      config: deps.config,
      logger: deps.logger,
      onUpdate: (u) => deps.onUpdate(issue.id, u),
      adapter: deps.adapter,
      toolSpecs,
      env: deps.childEnv,
    });
  } catch (err) {
    await deps.workspaceManager.runAfterRun(wsPath);
    return { kind: "abnormal", reason: `agent init error: ${(err as Error).message}` };
  }
  deps.onSessionReady(() => session.stop());

  try {
    await session.start();
  } catch (err) {
    session.stop();
    await deps.workspaceManager.runAfterRun(wsPath);
    return { kind: "abnormal", reason: `agent session startup error: ${(err as Error).message}` };
  }

  const maxTurns = deps.config.max_turns;
  let turnNumber = 1;

  try {
    while (true) {
      // Build prompt: full render on the first turn, continuation guidance after.
      let prompt: string;
      try {
        prompt = turnNumber === 1
          ? renderPrompt(deps.promptTemplate, issue, attempt, branch)
          : continuationPrompt(issue, turnNumber, maxTurns);
      } catch (err) {
        const reason = err instanceof PromptError ? `${err.errorClass}: ${err.message}` : `prompt error: ${String(err)}`;
        session.stop();
        await deps.workspaceManager.runAfterRun(wsPath);
        return { kind: "abnormal", reason };
      }

      const summary = `${issue.identifier}: ${issue.title}`;
      const turnResult = await session.runTurn(prompt, summary);
      log("turn finished", { turn: turnNumber, status: turnResult.status });

      if (turnResult.status !== "completed") {
        session.stop();
        await deps.workspaceManager.runAfterRun(wsPath);
        return { kind: "abnormal", reason: `agent turn ${turnResult.status}: ${turnResult.error ?? ""}` };
      }

      // Apply the agent's self-tracking write-back before re-checking state.
      await applyResultFile(wsPath, issue, deps);

      // Re-check tracker state for continuation (SPEC §7.1, §16.5).
      let refreshed: Issue[];
      try {
        refreshed = await deps.adapter.fetchIssuesByIds([issue.id]);
      } catch (err) {
        session.stop();
        await deps.workspaceManager.runAfterRun(wsPath);
        return { kind: "abnormal", reason: `issue state refresh error: ${(err as Error).message}` };
      }

      if (refreshed.length === 0) break; // issue gone
      issue = refreshed[0]!;

      if (!deps.isActiveState(issue.state) || !deps.isRoutable(issue)) break;
      if (turnNumber >= maxTurns) break;
      turnNumber += 1;
    }
  } catch (err) {
    session.stop();
    await deps.workspaceManager.runAfterRun(wsPath);
    return { kind: "abnormal", reason: `worker error: ${(err as Error).message}` };
  }

  session.stop();
  await deps.workspaceManager.runAfterRun(wsPath);
  return { kind: "normal" };
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
async function applyResultFile(wsPath: string, issue: Issue, deps: RunnerDeps): Promise<void> {
  const file = path.join(wsPath, RESULT_FILE);
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return; // no result file this turn
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    deps.logger.warn("invalid result file ignored", { issue_id: issue.id, issue_identifier: issue.identifier });
    try { fs.rmSync(file, { force: true }); } catch { /* ignore */ }
    return;
  }
  try {
    const res = await deps.adapter.executeAgentTool("set_issue_result", parsed, { issue });
    deps.logger.info("applied agent result", {
      issue_id: issue.id,
      issue_identifier: issue.identifier,
      success: res.success,
    });
  } catch (err) {
    deps.logger.warn("failed to apply agent result", { issue_id: issue.id, error: String(err) });
  }
  try { fs.rmSync(file, { force: true }); } catch { /* ignore */ }
}
