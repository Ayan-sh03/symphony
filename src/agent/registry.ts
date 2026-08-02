/**
 * Agent backend registry. Selects an {@link AgentFactory} by `agent.kind`
 * (default "codex"). To add a new agent backend: implement AgentSession +
 * AgentFactory and register it here — no other layer changes.
 */
import type { AgentFactory, AgentModel, AgentSession, AgentSessionOptions, ModelQuery, TranscriptEvent, TranscriptQuery } from "./types.ts";
import type { ServiceConfigValues } from "../config/config.ts";
import type { Logger } from "../logger.ts";
import { CodexAppServerClient } from "./appServerClient.ts";
import { OpencodeSession } from "./opencodeSession.ts";
import { readCodexTranscript } from "./codexTranscript.ts";
import { readOpencodeTranscript } from "./opencodeTranscript.ts";
import { listCodexModels } from "./codexModels.ts";
import { listOpencodeModels } from "./opencodeModels.ts";
import { detectCommand, type AgentDetectDeps, type AgentDetection } from "./detection.ts";

const codexFactory: AgentFactory = {
  kind: "codex",
  create(opts: AgentSessionOptions): AgentSession {
    return new CodexAppServerClient(opts);
  },
  readTranscript(query: TranscriptQuery): Promise<TranscriptEvent[]> {
    return readCodexTranscript(query);
  },
  // Resolve the executable only. Starting a real app-server would be a side effect
  // (and a process we would then have to tear down), so discovery stops at PATH.
  detect(config: ServiceConfigValues, _logger: Logger, deps?: AgentDetectDeps): Promise<AgentDetection> {
    return detectCommand("codex", config.codex.command, "codex.command", deps);
  },
  listModels(query: ModelQuery): Promise<AgentModel[]> {
    return listCodexModels(query);
  },
};

const opencodeFactory: AgentFactory = {
  kind: "opencode",
  create(opts: AgentSessionOptions): AgentSession {
    return new OpencodeSession(opts);
  },
  readTranscript(query: TranscriptQuery): Promise<TranscriptEvent[]> {
    return readOpencodeTranscript(query);
  },
  // `opencode run` would create a session and spend tokens; `--version` does not.
  detect(config: ServiceConfigValues, _logger: Logger, deps?: AgentDetectDeps): Promise<AgentDetection> {
    return detectCommand("opencode", config.opencode.command, "opencode.command", deps);
  },
  listModels(query: ModelQuery): Promise<AgentModel[]> {
    return listOpencodeModels(query);
  },
};

const FACTORIES = new Map<string, AgentFactory>([
  [codexFactory.kind, codexFactory],
  [opencodeFactory.kind, opencodeFactory],
]);

/** Register an additional agent backend (e.g. from an extension). */
export function registerAgentFactory(factory: AgentFactory): void {
  FACTORIES.set(factory.kind, factory);
}

export function isSupportedAgentKind(kind: string): boolean {
  return FACTORIES.has(kind);
}

export function supportedAgentKinds(): string[] {
  return [...FACTORIES.keys()];
}

/** Create an agent session for the configured kind. */
export function createAgentSession(kind: string, opts: AgentSessionOptions): AgentSession {
  const factory = FACTORIES.get(kind);
  if (!factory) throw new Error(`unsupported agent.kind: ${kind}`);
  return factory.create(opts);
}

/**
 * Read a finished run's transcript from the backend's own on-disk store, when the
 * backend supports it. Returns [] for unknown kinds or backends without the capability.
 */
export function readAgentTranscript(kind: string, query: TranscriptQuery): Promise<TranscriptEvent[]> {
  const factory = FACTORIES.get(kind);
  if (!factory || !factory.readTranscript) return Promise.resolve([]);
  return factory.readTranscript(query);
}

/**
 * Enumerate the models a backend can run (extension). Returns [] for unknown kinds or
 * backends without the capability — mirrors {@link readAgentTranscript}. A backend that
 * throws is downgraded to [] rather than propagated: a model list is console garnish and
 * must never become an orchestration error.
 */
export async function listAgentModels(kind: string, query: ModelQuery): Promise<AgentModel[]> {
  const factory = FACTORIES.get(kind);
  if (!factory || !factory.listModels) return [];
  try {
    return await factory.listModels(query);
  } catch (err) {
    query.logger.warn("model discovery failed", { agent: kind, error: String(err) });
    return [];
  }
}

/**
 * Probe every registered backend for host availability (extension). Backends without
 * the `detect` capability report as installed — we have no evidence either way, and
 * discovery must never be the thing that stops a working backend from running.
 * A detector that throws is downgraded to "unusable", never propagated.
 */
export async function detectAgentKinds(
  config: ServiceConfigValues,
  logger: Logger,
  deps?: AgentDetectDeps,
): Promise<AgentDetection[]> {
  const checked_at = new Date().toISOString();
  return Promise.all(
    [...FACTORIES.values()].map(async (factory): Promise<AgentDetection> => {
      if (!factory.detect) {
        return { kind: factory.kind, registered: true, installed: true, command: "", command_field: "", usable: true, reason: "backend does not report availability", checked_at };
      }
      try {
        return await factory.detect(config, logger, deps);
      } catch (err) {
        logger.warn("agent detection failed", { agent: factory.kind, error: String(err) });
        return { kind: factory.kind, registered: true, installed: false, command: "", command_field: "", usable: false, reason: `detection failed: ${String(err)}`, checked_at };
      }
    }),
  );
}
