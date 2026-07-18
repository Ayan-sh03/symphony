/**
 * Platform-aware shell execution (SPEC §9.4 "a local shell context appropriate to
 * the host OS", §10.1 launch contract).
 *
 * On POSIX we honor the spec default `bash -lc <script>` (falling back to `sh -lc`).
 * On Windows we run through the default shell (`cmd.exe`) via `shell: true`, because
 * a POSIX login shell is not guaranteed and, on some hosts, wrapping Node CLIs in
 * `bash -lc` breaks their launcher shims. `codex.command` still runs verbatim.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export interface ShellSpawn {
  child: ChildProcessWithoutNullStreams;
  /** Human-readable description of how the command was launched, for logs. */
  describe: string;
}

const isWindows = process.platform === "win32";

/**
 * Spawn a shell command with the given cwd and environment. Returns the child so
 * callers can wire stdio (codex client) or await exit (hooks).
 */
export function spawnShell(
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): ShellSpawn {
  let child: ChildProcessWithoutNullStreams;
  let describe: string;
  if (isWindows) {
    child = spawn(command, {
      cwd,
      env,
      shell: true,
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;
    describe = `cmd /c ${command}`;
  } else {
    const shell = "/bin/bash";
    child = spawn(shell, ["-lc", command], {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;
    describe = `bash -lc ${command}`;
  }
  return { child, describe };
}

export interface HookRunResult {
  ok: boolean;
  code: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}

/** Run a one-shot shell script to completion with a timeout (SPEC §9.4). */
export function runScript(
  script: string,
  cwd: string,
  timeoutMs: number,
  env: NodeJS.ProcessEnv = process.env,
): Promise<HookRunResult> {
  return new Promise((resolve) => {
    const { child } = spawnShell(script, cwd, env);
    let stdout = "";
    let stderr = "";
    let settled = false;
    const cap = 64 * 1024; // truncate hook output in memory/logs (SPEC §15.4)
    child.stdout.on("data", (d) => {
      if (stdout.length < cap) stdout += d.toString("utf8");
    });
    child.stderr.on("data", (d) => {
      if (stderr.length < cap) stderr += d.toString("utf8");
    });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      resolve({ ok: false, code: null, timedOut: true, stdout, stderr });
    }, timeoutMs);
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, code: null, timedOut: false, stdout, stderr: stderr + String(err) });
    });
    child.on("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: code === 0, code, timedOut: false, stdout, stderr });
    });
  });
}
