/**
 * Execution provider registry (issue #34). The orchestrator selects and validates a
 * provider through this module and never imports provider-specific implementations.
 */
import { localExecutionProvider } from "./localProvider.ts";
import type {
  ExecutionCapability,
  ExecutionProviderFactory,
  ExecutionSession,
  ExecutionSessionOptions,
} from "./types.ts";

const FACTORIES = new Map<string, ExecutionProviderFactory>([
  [localExecutionProvider.kind, localExecutionProvider],
]);

function factoryFor(kind: string): ExecutionProviderFactory {
  const factory = FACTORIES.get(kind);
  if (!factory) throw new Error(`unsupported execution.kind: ${kind}`);
  return factory;
}

/** Register an execution backend (built-ins today, trusted plugins in phase 7). */
export function registerExecutionProviderFactory(factory: ExecutionProviderFactory): void {
  if (factory.kind.trim() === "") throw new Error("execution provider kind must not be empty");
  FACTORIES.set(factory.kind, factory);
}

export function isSupportedExecutionKind(kind: string): boolean {
  return FACTORIES.has(kind);
}

export function supportedExecutionKinds(): string[] {
  return [...FACTORIES.keys()];
}

/** Return a copy so callers cannot mutate a factory's declared contract. */
export function executionProviderCapabilities(kind: string): ExecutionCapability[] {
  return [...factoryFor(kind).capabilities];
}

export function supportsExecutionCapability(kind: string, capability: ExecutionCapability): boolean {
  return factoryFor(kind).capabilities.includes(capability);
}

/** Fail before dispatch when a workflow needs operations the selected provider lacks. */
export function requireExecutionCapabilities(
  kind: string,
  capabilities: readonly ExecutionCapability[],
): void {
  const factory = factoryFor(kind);
  const missing = capabilities.filter((capability) => !factory.capabilities.includes(capability));
  if (missing.length > 0) {
    throw new Error(`execution provider ${kind} lacks required capabilities: ${missing.join(", ")}`);
  }
}

/** Validate kind and opaque provider configuration without starting a runtime. */
export function validateExecutionProvider(kind: string, provider: Record<string, unknown>): void {
  factoryFor(kind).validate?.(provider);
}

/** Construct a workspace-bound session without exposing the selected factory. */
export async function createExecutionSession(
  kind: string,
  provider: Record<string, unknown>,
  opts: Omit<ExecutionSessionOptions, "provider">,
): Promise<ExecutionSession> {
  const factory = factoryFor(kind);
  factory.validate?.(provider);
  return factory.create({ ...opts, provider });
}
