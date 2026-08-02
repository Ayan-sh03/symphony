/**
 * opencode model discovery (extension, SPEC Appendix B.7). Asks the CLI what it can
 * run rather than carrying a curated list; see `codexModels.ts` for the same contract
 * on the other backend.
 *
 * Verified against opencode 1.18.10:
 * - `opencode models` prints one `provider/model` per line — 464 entries in ~2.8 s.
 *   That is the interface. There is no JSON: `--format json` merely prints help, and
 *   `--verbose` interleaves each line with a pretty-printed blob, so it is not a
 *   parseable stream. A bare listing of stable identifiers is structured enough; this
 *   is not a `--help` scrape.
 * - The listing is **credential-scoped**, not the raw models.dev catalog: the providers
 *   it returned matched exactly the seven configured credentials (three in `auth.json`,
 *   four from env vars such as `OPENAI_API_KEY`). That is why {@link ModelQuery} carries
 *   the dispatch env — probing with a different environment would advertise models the
 *   runs cannot reach.
 * - opencode marks no default at all, so `default` comes from `opencode.model` in
 *   `WORKFLOW.md`, which is what `opencodeSession.buildCommand` actually passes as `-m`.
 */
import { spawnShell } from "../shell.ts";
import type { AgentModel, ModelQuery } from "./types.ts";

/** Wall-clock budget. The verified listing takes ~2.8 s; this bounds a hung CLI. */
const DISCOVERY_TIMEOUT_MS = 20000;
/** Cap on captured stdout — a runaway CLI must not grow the heap. */
const MAX_OUTPUT = 1024 * 1024;

/** Enumerate the models opencode can run on this host. Never throws; `[]` on failure. */
export async function listOpencodeModels(query: ModelQuery): Promise<AgentModel[]> {
  const configured = query.config.opencode.model;
  try {
    const stdout = await runModelsCommand(query);
    return parseModelLines(stdout, configured);
  } catch (err) {
    query.logger.warn("opencode model discovery failed", { error: String(err) });
    return [];
  }
}

/** Run `<opencode.command> models` and capture stdout, killing it on the deadline. */
function runModelsCommand(query: ModelQuery): Promise<string> {
  return new Promise((resolve, reject) => {
    const command = `${query.config.opencode.command} models`;
    const { child } = spawnShell(command, query.config.workflowDir, query.env);
    let out = "";
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      finish(() => {
        child.kill("SIGKILL"); // a hang must not leak a process
        reject(new Error(`opencode model discovery timed out after ${DISCOVERY_TIMEOUT_MS}ms`));
      });
    }, DISCOVERY_TIMEOUT_MS);

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d: string) => {
      if (out.length < MAX_OUTPUT) out += d;
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (d: string) => {
      const t = d.trim();
      if (t) query.logger.debug("opencode model discovery stderr", { text: t.slice(0, 300) });
    });
    child.on("error", (err) => finish(() => reject(err instanceof Error ? err : new Error(String(err)))));
    child.on("exit", (code) => {
      finish(() => {
        // A non-zero exit with usable lines still beats reporting nothing, but an exit
        // with no lines at all is a failure worth naming in the log.
        if (code !== 0 && out.trim() === "") reject(new Error(`opencode models exited ${code}`));
        else resolve(out);
      });
    });
  });
}

/**
 * Parse `provider/model` lines into {@link AgentModel} (pure, exported for tests).
 *
 * Only lines that look like a model identifier survive: opencode draws a banner on
 * some invocations, and a stray word must not become a selectable model. Ordering is
 * preserved — the CLI groups by provider and that grouping is useful in the dropdown.
 */
export function parseModelLines(stdout: string, configuredDefault: string | null): AgentModel[] {
  const seen = new Set<string>();
  const models: AgentModel[] = [];
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    // provider/model, both segments non-empty, no whitespace anywhere.
    if (!/^[^\s/]+\/[^\s]+$/.test(line)) continue;
    if (seen.has(line)) continue;
    seen.add(line);
    models.push({ id: line });
  }

  if (configuredDefault) {
    const hit = models.find((m) => m.id === configuredDefault);
    if (hit) hit.default = true;
    // Configured but unlisted still runs — `-m` passes it through — so show it.
    else models.unshift({ id: configuredDefault, label: `${configuredDefault} (from WORKFLOW.md)`, default: true });
  }
  return models;
}
