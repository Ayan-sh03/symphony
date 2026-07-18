import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FileTrackerAdapter } from "../src/tracker/fileAdapter.ts";
import { AdapterError } from "../src/tracker/types.ts";
import { Logger } from "../src/logger.ts";

const silent = new Logger([{ name: "null", write() {} }], "error");

function mkDir(files: Record<string, unknown>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sym-tr-"));
  for (const [name, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), typeof body === "string" ? body : JSON.stringify(body));
  }
  return dir;
}

test("empty state list returns empty without touching provider", async () => {
  const a = new FileTrackerAdapter({ dir: "/nonexistent-should-not-be-read", logger: silent });
  assert.deepEqual(await a.fetchIssuesByStates([]), []);
  assert.deepEqual(await a.fetchIssuesByIds([]), []);
});

test("fetch by states filters case-insensitively and lowercases labels", async () => {
  const dir = mkDir({
    "a.json": { identifier: "A-1", title: "t", state: "In Progress", labels: ["BUG", " Urgent ", "bug"] },
    "b.json": { identifier: "B-1", title: "t", state: "done" },
  });
  const a = new FileTrackerAdapter({ dir, logger: silent });
  const res = await a.fetchIssuesByStates(["in progress"]);
  assert.equal(res.length, 1);
  assert.equal(res[0]!.identifier, "A-1");
  assert.deepEqual(res[0]!.labels, ["bug", "urgent"]); // trimmed, lowercased, deduped
});

test("dispatchable defaults true, id defaults to identifier", async () => {
  const dir = mkDir({ "a.json": { identifier: "A-1", title: "t", state: "todo" } });
  const a = new FileTrackerAdapter({ dir, logger: silent });
  const [issue] = await a.fetchIssuesByStates(["todo"]);
  assert.equal(issue!.dispatchable, true);
  assert.equal(issue!.id, "A-1");
});

test("state-list omits malformed record; id-refresh fails on it", async () => {
  const dir = mkDir({
    "good.json": { id: "G", identifier: "G-1", title: "t", state: "todo" },
    "bad.json": { identifier: "", title: "", state: "" }, // missing required
  });
  const a = new FileTrackerAdapter({ dir, logger: silent });
  const listed = await a.fetchIssuesByStates(["todo"]);
  assert.equal(listed.length, 1);

  // Requesting the good id works; requesting a malformed record's file by making it requested fails.
  const badDir = mkDir({ "bad.json": { id: "B", identifier: "B-1", title: "", state: "todo" } });
  const a2 = new FileTrackerAdapter({ dir: badDir, logger: silent });
  await assert.rejects(() => a2.fetchIssuesByIds(["B"]), (e) => e instanceof AdapterError && e.category === "tracker_response");
});

test("refresh by id returns full normalized snapshot", async () => {
  const dir = mkDir({ "a.json": { id: "X1", identifier: "A-1", title: "t", state: "todo", priority: 2 } });
  const a = new FileTrackerAdapter({ dir, logger: silent });
  const res = await a.fetchIssuesByIds(["X1"]);
  assert.equal(res.length, 1);
  assert.equal(res[0]!.priority, 2);
  assert.equal(res[0]!.native_ref, null);
});

test("native_ref preserved when object, nulled otherwise", async () => {
  const dir = mkDir({
    "a.json": { id: "X1", identifier: "A-1", title: "t", state: "todo", native_ref: { projectItemId: "z" } },
    "b.json": { id: "X2", identifier: "B-1", title: "t", state: "todo", native_ref: "not-an-object" },
  });
  const a = new FileTrackerAdapter({ dir, logger: silent });
  const res = await a.fetchIssuesByIds(["X1", "X2"]);
  const x1 = res.find((r) => r.id === "X1")!;
  const x2 = res.find((r) => r.id === "X2")!;
  assert.deepEqual(x1.native_ref, { projectItemId: "z" });
  assert.equal(x2.native_ref, null);
});

test("agent tool update_issue_state mutates the file", async () => {
  const dir = mkDir({ "a.json": { id: "X1", identifier: "A-1", title: "t", state: "todo" } });
  const a = new FileTrackerAdapter({ dir, logger: silent });
  const [issue] = await a.fetchIssuesByIds(["X1"]);
  const res = await a.executeAgentTool("update_issue_state", { state: "done", comment: "finished" }, { issue: issue! });
  assert.equal(res.success, true);
  const after = await a.fetchIssuesByIds(["X1"]);
  assert.equal(after[0]!.state, "done");
});

test("unsupported tool returns structured failure, not throw", async () => {
  const dir = mkDir({ "a.json": { id: "X1", identifier: "A-1", title: "t", state: "todo" } });
  const a = new FileTrackerAdapter({ dir, logger: silent });
  const [issue] = await a.fetchIssuesByIds(["X1"]);
  const res = await a.executeAgentTool("no_such_tool", {}, { issue: issue! });
  assert.equal(res.success, false);
});

test("secretEnvironmentNames is empty for file adapter", () => {
  const a = new FileTrackerAdapter({ dir: mkDir({}), logger: silent });
  assert.deepEqual(a.secretEnvironmentNames(), []);
});
