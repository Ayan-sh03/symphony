/**
 * Hermetic tests for the opencode backend. No real `opencode` subprocess is spawned:
 * the JSON-event → AgentUpdate mapping is exercised as a pure function against a sample
 * captured from a real `opencode run --format json` stream (opencode 1.18.3), and the
 * factory registration is asserted via the registry.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mapOpencodeEvent, type OcTokenState } from "../src/agent/opencodeSession.ts";
import { supportedAgentKinds, isSupportedAgentKind } from "../src/agent/registry.ts";

/** Real events captured from `opencode run --format json --auto` (verbatim shapes). */
const SAMPLE = [
  { type: "step_start", timestamp: 1, sessionID: "ses_ABC", part: { type: "step-start", sessionID: "ses_ABC" } },
  {
    type: "tool_use", timestamp: 2, sessionID: "ses_ABC",
    part: { type: "tool", tool: "write", callID: "call_1", state: { status: "completed", input: { content: "hi", filePath: "C:\\ws\\hello.txt" }, output: "Wrote file successfully." } },
  },
  {
    type: "tool_use", timestamp: 3, sessionID: "ses_ABC",
    part: { type: "tool", tool: "bash", callID: "call_2", state: { status: "completed", input: { command: "ls" }, output: "hello.txt\n" } },
  },
  {
    type: "tool_use", timestamp: 4, sessionID: "ses_ABC",
    part: { type: "tool", tool: "read", callID: "call_3", state: { status: "completed", input: { filePath: "C:\\ws\\hello.txt" } } },
  },
  { type: "text", timestamp: 5, sessionID: "ses_ABC", part: { type: "text", text: "Done." } },
  {
    type: "step_finish", timestamp: 6, sessionID: "ses_ABC",
    part: { type: "step-finish", reason: "tool-calls", tokens: { total: 9658, input: 9519, output: 75, reasoning: 0, cache: { write: 0, read: 64 } }, cost: 0.0136 },
  },
  {
    type: "step_finish", timestamp: 7, sessionID: "ses_ABC",
    part: { type: "step-finish", reason: "stop", tokens: { total: 9763, input: 148, output: 85, reasoning: 0, cache: { write: 0, read: 9728 } }, cost: 0.003 },
  },
];

test("mapOpencodeEvent maps a captured opencode stream to the right updates", () => {
  const tokens: OcTokenState = { cumInput: 0, cumOutput: 0 };
  const all: Array<{ event: string; extra: Record<string, unknown> }> = [];
  let sessionId: string | null = null;
  for (const evt of SAMPLE) {
    const r = mapOpencodeEvent(evt as unknown as Record<string, unknown>, tokens);
    if (r.sessionId && !sessionId) sessionId = r.sessionId;
    all.push(...r.updates);
  }

  assert.equal(sessionId, "ses_ABC", "session id is surfaced from the stream");

  const events = all.map((u) => u.event);
  assert.deepEqual(events, [
    "file_change",   // write
    "command",       // bash
    "tool_call",     // read
    "agent_message", // text
    "notification",  // step_finish tokens
    "notification",  // step_finish tokens
  ]);

  // Content of the non-token updates.
  const fileChange = all[0]!;
  assert.match(String(fileChange.extra.message), /hello\.txt/);
  const command = all[1]!;
  assert.equal(command.extra.message, "ls");
  const toolCall = all[2]!;
  assert.match(String(toolCall.extra.message), /^read hello\.txt/);
  const msg = all[3]!;
  assert.equal(msg.extra.message, "Done.");

  // Token accounting: absolute, monotonically increasing, total = input + output.
  const notes = all.filter((u) => u.event === "notification");
  const u0 = notes[0]!.extra.usage as Record<string, number>;
  const u1 = notes[1]!.extra.usage as Record<string, number>;
  assert.equal(notes[0]!.extra.absolute, true);
  assert.equal(u0.input_tokens, 9519);
  assert.equal(u0.output_tokens, 75);
  assert.equal(u0.total_tokens, 9519 + 75);
  assert.equal(u1.input_tokens, 9519 + 148, "input accumulates across steps");
  assert.equal(u1.output_tokens, 75 + 85, "output accumulates across steps");
  assert.ok(u1.total_tokens >= u0.total_tokens, "totals never decrease");
});

test("mapOpencodeEvent handles an error event and ignores step_start noise", () => {
  const tokens: OcTokenState = { cumInput: 0, cumOutput: 0 };
  assert.deepEqual(
    mapOpencodeEvent({ type: "step_start", sessionID: "ses_X", part: {} }, tokens).updates,
    [],
  );
  const err = mapOpencodeEvent({ type: "error", sessionID: "ses_X", part: { message: "boom" } }, tokens);
  assert.equal(err.updates[0]!.event, "turn_ended_with_error");
});

test("opencode factory is registered", () => {
  assert.ok(isSupportedAgentKind("opencode"), "isSupportedAgentKind should recognize opencode");
  assert.ok(supportedAgentKinds().includes("opencode"), "supportedAgentKinds should list opencode");
});
