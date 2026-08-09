/**
 * Host-level agent discovery cache (multi-project extension). It centralizes only
 * expensive host probes; each orchestrator still owns its own displayed state,
 * refresh endpoint, and failure handling.
 */
import { createHash } from "node:crypto";
import type { ServiceConfigValues } from "../config/config.ts";
import type { Logger } from "../logger.ts";
import { agentAvailabilityCacheKey, agentModelDiscoveryCacheKey, detectAgentKinds, listAgentModels } from "./registry.ts";
import type { AgentDetection } from "./detection.ts";
import type { AgentModel, ModelQuery } from "./types.ts";

const AVAILABILITY_TTL_MS = 60000;
const AVAILABILITY_FORCE_MIN_MS = 1000;
const MODELS_TTL_MS = 600000;
const MODELS_FORCE_MIN_MS = 2000;

interface CacheEntry<T> {
  value: T;
  at: number;
}

export interface AgentDiscoveryCacheDeps {
  availabilityKey?: (config: ServiceConfigValues) => string;
  modelKey?: (kind: string, query: ModelQuery) => string;
  detect?: (config: ServiceConfigValues, logger: Logger) => Promise<AgentDetection[]>;
  listModels?: (kind: string, query: ModelQuery) => Promise<AgentModel[]>;
  now?: () => number;
}

/** Shares equivalent probes across all orchestrators owned by one ProjectManager. */
export class AgentDiscoveryCache {
  private availability = new Map<string, CacheEntry<AgentDetection[]>>();
  private availabilityInFlight = new Map<string, Promise<AgentDetection[]>>();
  private models = new Map<string, CacheEntry<AgentModel[]>>();
  private modelsInFlight = new Map<string, Promise<AgentModel[]>>();
  private availabilityKey: (config: ServiceConfigValues) => string;
  private modelKey: (kind: string, query: ModelQuery) => string;
  private detectAgentKinds: (config: ServiceConfigValues, logger: Logger) => Promise<AgentDetection[]>;
  private listAgentModels: (kind: string, query: ModelQuery) => Promise<AgentModel[]>;
  private now: () => number;

  constructor(deps: AgentDiscoveryCacheDeps = {}) {
    this.availabilityKey = deps.availabilityKey ?? agentAvailabilityCacheKey;
    this.modelKey = deps.modelKey ?? agentModelDiscoveryCacheKey;
    this.detectAgentKinds = deps.detect ?? detectAgentKinds;
    this.listAgentModels = deps.listModels ?? listAgentModels;
    this.now = deps.now ?? Date.now;
  }

  async detect(config: ServiceConfigValues, logger: Logger, force = false): Promise<AgentDetection[]> {
    const key = this.availabilityKey(config);
    return this.get(this.availability, this.availabilityInFlight, key, force, AVAILABILITY_TTL_MS, AVAILABILITY_FORCE_MIN_MS, () => this.detectAgentKinds(config, logger));
  }

  async modelsFor(kind: string, query: ModelQuery, force = false): Promise<AgentModel[]> {
    // A digest makes credential/environment differences separate cache entries
    // without retaining their values in memory as map keys.
    const key = `${kind}:${this.modelKey(kind, query)}:${environmentFingerprint(query.env)}`;
    return this.get(this.models, this.modelsInFlight, key, force, MODELS_TTL_MS, MODELS_FORCE_MIN_MS, () => this.listAgentModels(kind, query));
  }

  private get<T>(
    values: Map<string, CacheEntry<T>>,
    inFlight: Map<string, Promise<T>>,
    key: string,
    force: boolean,
    ttlMs: number,
    forceMinMs: number,
    probe: () => Promise<T>,
  ): Promise<T> {
    const hit = values.get(key);
    const age = hit ? this.now() - hit.at : Infinity;
    if (hit && !force && age < ttlMs) return Promise.resolve(hit.value);
    if (hit && force && age < forceMinMs) return Promise.resolve(hit.value);
    if (!force) {
      const active = inFlight.get(key);
      if (active) return active;
    }
    const task = Promise.resolve().then(probe).then((value) => {
      values.set(key, { value, at: this.now() });
      return value;
    }).finally(() => {
      if (inFlight.get(key) === task) inFlight.delete(key);
    });
    inFlight.set(key, task);
    return task;
  }
}

function environmentFingerprint(env: NodeJS.ProcessEnv): string {
  const stable = Object.entries(env)
    .filter(([, value]) => value !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return createHash("sha256").update(JSON.stringify(stable)).digest("hex");
}
