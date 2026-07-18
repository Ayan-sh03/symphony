/**
 * Agent backend registry. Selects an {@link AgentFactory} by `agent.kind`
 * (default "codex"). To add a new agent backend: implement AgentSession +
 * AgentFactory and register it here — no other layer changes.
 */
import type { AgentFactory, AgentSession, AgentSessionOptions, TranscriptEvent, TranscriptQuery } from "./types.ts";
import { CodexAppServerClient } from "./appServerClient.ts";
import { OpencodeSession } from "./opencodeSession.ts";
import { readCodexTranscript } from "./codexTranscript.ts";
import { readOpencodeTranscript } from "./opencodeTranscript.ts";

const codexFactory: AgentFactory = {
  kind: "codex",
  create(opts: AgentSessionOptions): AgentSession {
    return new CodexAppServerClient(opts);
  },
  readTranscript(query: TranscriptQuery): Promise<TranscriptEvent[]> {
    return readCodexTranscript(query);
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
