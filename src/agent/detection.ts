/**
 * Installed-agent discovery (extension, generalizes SPEC §10). Registered backends
 * say what they *can* run; this module answers whether the machine can actually run
 * them — i.e. whether the executable named by `codex.command` / `opencode.command`
 * exists on this host's PATH.
 *
 * Two rules keep discovery safe:
 * - Only the executable token of a command string is ever touched. The rest
 *   (` app-server`, ` run --flag`) is never executed and never handed to a shell,
 *   so an operator's config fragment cannot become a command injection here.
 * - Resolution alone decides `installed`/`usable` — the host PATH, and on POSIX the
 *   login shell's own lookup, because that is the shell that runs it. The version probe is
 *   advisory enrichment: a `.cmd` shim that `execFile` refuses to run, or a slow
 *   binary that blows the timeout, must not make a working backend look broken.
 */
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

/** How long a version probe may take before we give up on it (advisory only). */
const PROBE_TIMEOUT_MS = 3000;

/**
 * The executable portion of a command string, with surrounding quotes removed.
 * `codex app-server` → `codex`; `"C:/Program Files/Codex/codex.exe" app-server`
 * → `C:/Program Files/Codex/codex.exe`. Returns null for an empty command.
 */
export function commandExecutableToken(command: string): string | null {
  const s = (command ?? "").trim();
  if (s === "") return null;
  const quote = s[0];
  if (quote === '"' || quote === "'") {
    const end = s.indexOf(quote, 1);
    // An unterminated quote is a malformed command, not an executable named after
    // the whole line. Report nothing rather than go looking for a path that has a
    // space and a flag in it.
    if (end < 0) return null;
    const inner = s.slice(1, end).trim();
    return inner === "" ? null : inner;
  }
  const m = s.match(/^\S+/);
  return m ? m[0] : null;
}

/**
 * Ask the shell that will actually run the command whether it can find it. On POSIX
 * `spawnShell` launches `bash -lc`, and a *login* shell sources profile files that
 * add to PATH (nvm, asdf, `~/.local/bin`) — so a backend can be perfectly runnable
 * while absent from this process's own PATH, which is all `resolveExecutable` sees.
 * Consulted only when the plain lookup misses, so the common case stays spawn-free.
 *
 * The executable travels as an argv element (`$1`), never as script text, so this
 * keeps the file header's promise: an operator's command cannot become shell syntax.
 * Windows needs none of this — `spawnShell` there inherits our PATH via `shell: true`.
 */
export function resolveViaLoginShell(exe: string, env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  if (process.platform === "win32") return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      execFile("/bin/bash", ["-lc", 'command -v -- "$1"', "_", exe], { timeout: PROBE_TIMEOUT_MS, env }, (err, stdout) => {
        if (err) return resolve(null);
        const line = stdout.split(/\r?\n/).map((l) => l.trim()).find((l) => l !== "");
        // `command -v` answers with a bare name for builtins/aliases; only a real path counts.
        resolve(line && path.isAbsolute(line) ? line : null);
      });
    } catch {
      resolve(null);
    }
  });
}

/** Whether this host would actually execute the file at `p` (POSIX needs the x bit). */
async function isExecutableFile(p: string): Promise<boolean> {
  try {
    const stat = await fs.stat(p);
    if (!stat.isFile()) return false;
    if (process.platform === "win32") return true; // no x bit; PATHEXT already decided
    await fs.access(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve an executable against the host PATH (PATHEXT on Windows), or against the
 * filesystem directly when the token already carries a path separator. Falls back to
 * the login shell's own lookup on POSIX. Returns the absolute path of the first
 * match, or null.
 */
export async function resolveExecutable(exe: string, env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  const hasSeparator = exe.includes("/") || exe.includes("\\");
  const dirs = hasSeparator ? [""] : (env.PATH ?? "").split(path.delimiter).filter((d) => d !== "");
  const exts = process.platform === "win32"
    ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter((e) => e !== "")
    : [];

  for (const dir of dirs) {
    const base = hasSeparator ? path.resolve(exe) : path.join(dir, exe);
    // Windows commands are usually written without their extension (`codex` is
    // really `codex.cmd` from an npm shim), so try each PATHEXT in turn — and try
    // them *first*, because npm also drops an extensionless bash shim next to the
    // .cmd that Windows will never execute. Reporting that one is misleading.
    const candidates = path.extname(base) === "" ? [...exts.map((ext) => base + ext.toLowerCase()), base] : [base];
    for (const candidate of candidates) {
      if (await isExecutableFile(candidate)) return candidate;
    }
  }
  // A path we were handed is a path — the login shell would not resolve it differently.
  return hasSeparator ? null : resolveViaLoginShell(exe, env);
}

/**
 * Best-effort `<exe> --version`. Returns the first non-empty output line, or null
 * when the probe fails for any reason — see the file header on why a failure here
 * never downgrades `usable`.
 */
export function probeVersion(exePath: string, args: string[] = ["--version"]): Promise<string | null> {
  // Windows batch shims (`codex.cmd` from npm) cannot be spawned without a shell,
  // and we will not hand a shell an operator-supplied path. Node signals this by
  // throwing EINVAL *synchronously* out of execFile, so this needs both the skip
  // and the try/catch — the version string is not worth a rejected promise.
  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(exePath)) return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      execFile(exePath, args, { timeout: PROBE_TIMEOUT_MS, windowsHide: true }, (err, stdout, stderr) => {
        if (err) return resolve(null);
        const line = `${stdout}\n${stderr}`.split(/\r?\n/).map((l) => l.trim()).find((l) => l !== "");
        resolve(line ?? null);
      });
    } catch {
      resolve(null);
    }
  });
}

/** What discovery knows about one registered backend at a point in time. */
export interface AgentDetection {
  kind: string;
  /** Always true here — discovery only ever runs over registered factories. */
  registered: boolean;
  installed: boolean;
  /** The full configured command, echoed so the console can name what was looked for. */
  command: string;
  /** The config key the command came from (`codex.command`, …), for the halt reason. */
  command_field: string;
  path?: string;
  version?: string;
  usable: boolean;
  reason?: string;
  checked_at: string;
}

/** Discovery plus what it implies for dispatch, as one console/API payload. */
export interface AgentAvailability {
  agents: AgentDetection[];
  /** `agent.kind` from WORKFLOW.md. */
  configured_default: string;
  /** What a task with no per-task agent will actually run on. */
  effective_default: string;
  /** Operator-chosen runtime default, if any (console/API). */
  runtime_override: string | null;
  /** Default picked by discovery because the configured one is missing. */
  auto_default: string | null;
  /** Dispatch is parked: nothing sensible to fall back to, operator must choose. */
  blocked: boolean;
  reason: string | null;
  checked_at: string | null;
  /** No probe has completed yet — treat every verdict here as provisional. */
  stale: boolean;
}

/**
 * Decide the effective default backend from a detection set (pure).
 *
 * The ordering is deliberate: an operator's explicit runtime choice outranks
 * discovery, discovery only steps in when the configured default cannot run, and
 * when more than one backend could serve as the replacement we refuse to guess —
 * silently running an issue on a different agent than the workflow asked for is
 * worse than parking and saying so.
 *
 * `effective_default` is the single answer to "what would a task without its own
 * agent run on" — `Orchestrator.effectiveDefaultAgent()` returns exactly this, so
 * the console banner, the dispatch gate and the process we actually spawn can never
 * disagree about which backend is in play.
 */
export function resolveAgentAvailability(
  agents: AgentDetection[],
  configuredDefault: string,
  runtimeOverride: string | null,
): AgentAvailability {
  const base: AgentAvailability = {
    agents,
    configured_default: configuredDefault,
    effective_default: runtimeOverride ?? configuredDefault,
    runtime_override: runtimeOverride,
    auto_default: null,
    blocked: false,
    reason: null,
    checked_at: agents.reduce<string | null>((max, a) => (max === null || a.checked_at > max ? a.checked_at : max), null),
    stale: agents.length === 0,
  };
  // Nothing probed yet: report the configured intent and let the run decide.
  if (agents.length === 0) return base;

  const byKind = new Map(agents.map((a) => [a.kind, a]));
  const usable = agents.filter((a) => a.usable);

  if (runtimeOverride && byKind.get(runtimeOverride)?.usable) return base;
  // An override that cannot run stays the effective default rather than quietly
  // reverting to WORKFLOW.md: the operator chose it, dispatch honors it, and the
  // only honest thing left is to block and say the choice is unrunnable. Falling
  // back here would report one backend while spawning another.
  if (runtimeOverride) {
    const why = byKind.get(runtimeOverride)?.reason ?? `${runtimeOverride} is not installed`;
    return { ...base, blocked: true, reason: `the runtime default ${runtimeOverride} cannot run: ${why}` };
  }
  if (byKind.get(configuredDefault)?.usable) return { ...base, effective_default: configuredDefault, runtime_override: runtimeOverride };

  const missing = byKind.get(configuredDefault);
  const why = missing?.reason ?? `agent.kind: ${configuredDefault} is not usable`;

  if (usable.length === 1) {
    const only = usable[0]!;
    return { ...base, effective_default: only.kind, auto_default: only.kind, reason: `${why} — falling back to ${only.kind}, the only installed backend` };
  }
  if (usable.length === 0) {
    return { ...base, blocked: true, reason: `no runnable agent found: ${agents.map((a) => a.reason ?? `${a.kind} unusable`).join("; ")}` };
  }
  return {
    ...base,
    blocked: true,
    reason: `${why} — more than one backend is installed (${usable.map((a) => a.kind).join(", ")}); choose a runtime default on the Integrate page`,
  };
}

/** Injection seam so discovery can be exercised without a real PATH. */
export interface AgentDetectDeps {
  resolveExecutable?: (exe: string, env?: NodeJS.ProcessEnv) => Promise<string | null>;
  probeVersion?: (exePath: string) => Promise<string | null>;
}

/**
 * Shared detector for the "resolve a command string on PATH" shape both built-in
 * backends have. A backend whose availability means something else entirely is free
 * to implement `AgentFactory.detect` from scratch instead.
 */
export async function detectCommand(
  kind: string,
  command: string,
  commandField: string,
  deps: AgentDetectDeps = {},
): Promise<AgentDetection> {
  const resolve = deps.resolveExecutable ?? resolveExecutable;
  const probe = deps.probeVersion ?? probeVersion;
  const checked_at = new Date().toISOString();
  const exe = commandExecutableToken(command);
  if (!exe) {
    return { kind, registered: true, installed: false, command, command_field: commandField, usable: false, reason: `${commandField} is empty`, checked_at };
  }
  const resolved = await resolve(exe);
  if (!resolved) {
    return {
      kind,
      registered: true,
      installed: false,
      command,
      command_field: commandField,
      usable: false,
      reason: `${exe} not found on PATH (${commandField}: ${command})`,
      checked_at,
    };
  }
  const version = await probe(resolved);
  const out: AgentDetection = { kind, registered: true, installed: true, command, command_field: commandField, path: resolved, usable: true, checked_at };
  if (version) out.version = version;
  return out;
}
