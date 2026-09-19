/**
 * Process-tree termination (issue #39).
 *
 * A single `child.kill()` only reaches the process Node spawned. On Windows the
 * command runs behind a `cmd.exe` wrapper (`shell: true` in `shell.ts`), so killing
 * the wrapper orphans the agent (opencode/codex) and any tool processes it launched.
 * On POSIX the same is true of the `bash -lc` wrapper unless we signal its process
 * group. This module owns the platform-specific way to reach the whole tree so every
 * caller terminates identically; it is best-effort and never throws, because callers
 * still await the process's own exit for the authoritative outcome.
 */
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const isWindows = process.platform === "win32";

/** Bound platform cleanup waits, including taskkill and POSIX process reaping. */
const TERMINATION_TIMEOUT_MS = 5000;

/**
 * Force-terminate `pid` and every descendant it owns.
 *
 * Windows has no process groups, so we delegate to `taskkill /T`, which walks the
 * parent/child tree. It must run while the wrapper is still alive: once the root has
 * exited, Windows keeps the parent id on survivors but `taskkill` can no longer anchor
 * the walk to it. POSIX children are spawned `detached` (own process group), so the
 * negative pid reaches the whole group, with a per-process fallback when it is not a
 * group leader.
 */
export async function terminateProcessTree(
  pid: number | null | undefined,
  signal: NodeJS.Signals = "SIGTERM",
): Promise<void> {
  if (pid === null || pid === undefined || !Number.isInteger(pid) || pid <= 0) return;
  if (isWindows) {
    await runTaskkill(pid);
    return;
  }
  let target = -pid;
  try {
    process.kill(target, signal);
  } catch {
    target = pid;
    try { process.kill(target, signal); } catch { return; }
  }
  // kill(2) only queues a signal. Even SIGKILL can leave descendants running until
  // the scheduler delivers it; awaiting the wrapper's exit alone is insufficient.
  // Bound the wait because an orphaned zombie can remain until its parent reaps it.
  const deadline = Date.now() + TERMINATION_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try { process.kill(target, 0); } catch { return; }
    await delay(10);
  }
}

/** Run `taskkill /PID <pid> /T /F`, resolving on exit/error/timeout. Never rejects. */
function runTaskkill(pid: number): Promise<void> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
    } catch {
      resolve();
      return;
    }
    let settled = false;
    const done = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* already gone */ }
      done();
    }, TERMINATION_TIMEOUT_MS);
    child.once("error", done);
    child.once("exit", done);
  });
}
