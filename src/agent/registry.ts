/**
 * Agent backend registry. Selects an {@link AgentFactory} by `agent.kind`
 * (default "codex"). To add a new agent backend: implement AgentSession +
 * AgentFactory and register it here — no other layer changes.
 */
import type { AgentFactory, AgentSession, AgentSessionOptions } from "./types.ts";
import { CodexAppServerClient } from "./appServerClient.ts";

const codexFactory: AgentFactory = {
  kind: "codex",
  create(opts: AgentSessionOptions): AgentSession {
    return new CodexAppServerClient(opts);
  },
};

const FACTORIES = new Map<string, AgentFactory>([[codexFactory.kind, codexFactory]]);

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
