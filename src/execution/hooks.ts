import type { ExecutionSession } from "./types.ts";
import type { HookRunResult } from "../shell.ts";

/** Run a bounded hook through the runtime's process contract. Does not own the session. */
export async function runExecutionHook(
  session: ExecutionSession, script: string, timeoutMs: number,
): Promise<HookRunResult> {
  if (!session.spawn) throw new Error("execution session lacks process capability");
  const child = await session.spawn(script);
  let stdout = "";
  let stderr = "";
  const cap = 64 * 1024;
  child.stdout.on("data", (data) => { stdout = (stdout + data.toString("utf8")).slice(0, cap); });
  child.stderr.on("data", (data) => { stderr = (stderr + data.toString("utf8")).slice(0, cap); });
  child.stdin.on("error", () => {});
  child.stdin.end();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); });
  try {
    const exit = await Promise.race([child.exit, timeout]);
    if (exit === null) {
      await child.kill("SIGKILL");
      return { ok: false, code: null, timedOut: true, stdout, stderr };
    }
    return { ok: exit.code === 0 && !exit.error, code: exit.code, timedOut: false, stdout, stderr: stderr + (exit.error ?? "") };
  } finally { clearTimeout(timer); }
}
