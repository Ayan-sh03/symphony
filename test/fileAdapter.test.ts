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

test("createIssue writes a dispatchable file and rejects duplicates", async () => {
  const dir = mkDir({});
  const a = new FileTrackerAdapter({ dir, logger: silent });
  assert.equal(a.supportsCreate(), true);
  const issue = await a.createIssue({ identifier: "NEW-1", title: "do it", state: "todo", priority: 2, labels: ["X", "x"] });
  assert.equal(issue.identifier, "NEW-1");
  assert.equal(issue.dispatchable, true);
  assert.deepEqual(issue.labels, ["x"]);
  const fetched = await a.fetchIssuesByStates(["todo"]);
  assert.equal(fetched.length, 1);
  await assert.rejects(() => a.createIssue({ identifier: "NEW-1", title: "again" }), (e) => e instanceof AdapterError);
});

test("createIssue requires identifier and title", async () => {
  const a = new FileTrackerAdapter({ dir: mkDir({}), logger: silent });
  await assert.rejects(() => a.createIssue({ identifier: "", title: "t" }), (e) => e instanceof AdapterError);
  await assert.rejects(() => a.createIssue({ identifier: "X-1", title: "" }), (e) => e instanceof AdapterError);
});

test("board: listAllIssues returns every state; setIssueState moves an issue", async () => {
  const dir = mkDir({
    "a.json": { id: "A", identifier: "A-1", title: "t", state: "backlog" },
    "b.json": { id: "B", identifier: "B-1", title: "t", state: "done" },
  });
  const a = new FileTrackerAdapter({ dir, logger: silent });
  assert.equal(a.supportsBoard(), true);
  const all = await a.listAllIssues();
  assert.equal(all.length, 2); // includes backlog + done, not filtered by state
  const moved = await a.setIssueState("A", "todo");
  assert.equal(moved.state, "todo");
  const after = await a.fetchIssuesByStates(["todo"]);
  assert.equal(after.length, 1);
  assert.equal(after[0]!.identifier, "A-1");
});

test("edit: updateIssue writes only the patched fields", async () => {
  const dir = mkDir({
    "a.json": { id: "A", identifier: "A-1", title: "old", description: "keep me", state: "todo", priority: 3, labels: ["docs"] },
  });
  const a = new FileTrackerAdapter({ dir, logger: silent });
  assert.equal(a.supportsEdit(), true);

  const titleOnly = await a.updateIssue("A", { title: " new title " });
  assert.equal(titleOnly.title, "new title");
  assert.equal(titleOnly.description, "keep me", "absent keys keep their stored value");
  assert.equal(titleOnly.priority, 3);
  assert.deepEqual(titleOnly.labels, ["docs"]);
  assert.equal(titleOnly.state, "todo", "editing never touches state");

  const full = await a.updateIssue("A", { description: "  ", priority: null, labels: ["BUG", "bug", " urgent "] });
  assert.equal(full.description, null, "a blank description clears it");
  assert.equal(full.priority, null);
  assert.deepEqual(full.labels, ["bug", "urgent"], "labels are normalized like everywhere else");
  assert.equal(full.title, "new title");

  // The identifier keys the record and the workspace: it is never rewritten.
  const raw = JSON.parse(fs.readFileSync(path.join(dir, "a.json"), "utf8"));
  assert.equal(raw.identifier, "A-1");
});

test("edit: updateIssue rejects a blank title and an unknown id", async () => {
  const dir = mkDir({ "a.json": { id: "A", identifier: "A-1", title: "t", state: "todo" } });
  const a = new FileTrackerAdapter({ dir, logger: silent });
  await assert.rejects(() => a.updateIssue("A", { title: "   " }), (e) => e instanceof AdapterError);
  await assert.rejects(
    () => a.updateIssue("NOPE", { title: "x" }),
    (e) => e instanceof AdapterError && e.category === "tracker_response",
  );
});

test("edit: deleteIssue removes the file; unknown id is an error", async () => {
  const dir = mkDir({
    "a.json": { id: "A", identifier: "A-1", title: "t", state: "todo" },
    "b.json": { id: "B", identifier: "B-1", title: "t", state: "todo" },
  });
  const a = new FileTrackerAdapter({ dir, logger: silent });
  await a.deleteIssue("A");
  assert.equal(fs.existsSync(path.join(dir, "a.json")), false);
  assert.equal(fs.existsSync(path.join(dir, "b.json")), true, "only the requested issue goes");
  assert.deepEqual((await a.listAllIssues()).map((i) => i.id), ["B"]);
  await assert.rejects(
    () => a.deleteIssue("A"),
    (e) => e instanceof AdapterError && e.category === "tracker_response",
  );
});

test("secretEnvironmentNames is empty for file adapter", () => {
  const a = new FileTrackerAdapter({ dir: mkDir({}), logger: silent });
  assert.deepEqual(a.secretEnvironmentNames(), []);
});

test("delivery: record, enrich from the result envelope, merge pushed_at", async () => {
  const dir = mkDir({ "a.json": { id: "A", identifier: "A-1", title: "t", state: "done" } });
  const a = new FileTrackerAdapter({ dir, logger: silent });
  const [issue] = await a.fetchIssuesByIds(["A"]);

  // The agent's result envelope supplies summary (its comment) and tests.
  const res = await a.executeAgentTool("set_issue_result", { state: "done", comment: "built the thing", tests: "npm test: 12 passed" }, { issue: issue! });
  assert.equal(res.success, true);

  const delivered = await a.setIssueDelivery("A", {
    branch: "issue/A-1",
    commit_sha: "abc123def456",
    base_branch: "master",
    files_changed: ["src/x.ts"],
    uncommitted: [],
    needs_attention: false,
    attention_reason: null,
    delivered_at: "2026-07-24T10:00:00.000Z",
  });
  const d = delivered.delivery!;
  assert.equal(d.branch, "issue/A-1");
  assert.equal(d.commit_sha, "abc123def456");
  assert.equal(d.files_changed.join(","), "src/x.ts");
  assert.equal(d.summary, "built the thing", "summary falls back to the result comment");
  assert.equal(d.tests, "npm test: 12 passed", "tests fall back to the result envelope");
  assert.equal(d.pushed_at, null);

  // Delivery survives normalization through later reads, and a partial patch merges.
  const [read1] = await a.fetchIssuesByIds(["A"]);
  assert.equal(read1!.delivery!.branch, "issue/A-1");
  const pushed = await a.setIssueDelivery("A", { pushed_at: "2026-07-24T11:00:00.000Z" });
  assert.equal(pushed.delivery!.pushed_at, "2026-07-24T11:00:00.000Z");
  assert.equal(pushed.delivery!.commit_sha, "abc123def456", "merge keeps stored fields");

  // A fresh delivery comments on the issue; the push merge does not.
  const raw = JSON.parse(fs.readFileSync(path.join(dir, "a.json"), "utf8"));
  const comments = (raw.comments as { text: string }[]).map((c) => c.text);
  assert.equal(comments.filter((c) => c.startsWith("Delivery recorded: issue/A-1 @ abc123d")).length, 1);
});

test("delivery: needs_attention with uncommitted paths is preserved verbatim", async () => {
  const dir = mkDir({ "a.json": { id: "A", identifier: "A-1", title: "t", state: "done" } });
  const a = new FileTrackerAdapter({ dir, logger: silent });
  const delivered = await a.setIssueDelivery("A", {
    branch: "issue/A-1",
    commit_sha: "deadbeef",
    uncommitted: ["?? wip.txt"],
    needs_attention: true,
    attention_reason: "uncommitted changes left in workspace: ?? wip.txt",
    delivered_at: "2026-07-24T10:00:00.000Z",
  });
  assert.equal(delivered.delivery!.needs_attention, true);
  assert.deepEqual(delivered.delivery!.uncommitted, ["?? wip.txt"]);
  const raw = JSON.parse(fs.readFileSync(path.join(dir, "a.json"), "utf8"));
  const last = (raw.comments as { text: string }[]).at(-1)!.text;
  assert.match(last, /needs attention: uncommitted changes/);
});

test("delivery: absent or shapeless records normalize to null", async () => {
  const dir = mkDir({
    "a.json": { id: "A", identifier: "A-1", title: "t", state: "done" },
    "b.json": { id: "B", identifier: "B-1", title: "t", state: "done", delivery: { no_branch: true } },
  });
  const a = new FileTrackerAdapter({ dir, logger: silent });
  const all = await a.listAllIssues();
  assert.equal(all.find((i) => i.id === "A")!.delivery, null);
  assert.equal(all.find((i) => i.id === "B")!.delivery, null, "delivery without a branch is invalid");
});

test("model round-trips on create and is absent from the record when unset", async () => {
  const dir = mkDir({});
  const a = new FileTrackerAdapter({ dir, logger: silent });

  const pinned = await a.createIssue({ identifier: "M-1", title: "pinned", model: "  vendor/fast  " });
  assert.equal(pinned.model, "vendor/fast", "the stored id is trimmed, never interpreted");
  const [reloaded] = await a.fetchIssuesByIds(["M-1"]);
  assert.equal(reloaded!.model, "vendor/fast", "it survives a reload, not just the create return");

  const plain = await a.createIssue({ identifier: "M-2", title: "backend default" });
  assert.equal(plain.model, null);
  const raw = JSON.parse(fs.readFileSync(path.join(dir, "M-2.json"), "utf8"));
  assert.equal("model" in raw, false, "an issue on the backend default carries no model field");
});

test("edit: updateIssue sets a model, and clearing it deletes the key from the record", async () => {
  const dir = mkDir({ "a.json": { id: "A", identifier: "A-1", title: "t", state: "todo" } });
  const a = new FileTrackerAdapter({ dir, logger: silent });
  const rawFile = path.join(dir, "a.json");
  const raw = () => JSON.parse(fs.readFileSync(rawFile, "utf8")) as Record<string, unknown>;

  const set = await a.updateIssue("A", { model: " vendor/slow " });
  assert.equal(set.model, "vendor/slow");
  assert.equal(raw().model, "vendor/slow");

  // An unrelated patch must leave the pinned model exactly where it was.
  const renamed = await a.updateIssue("A", { title: "new title" });
  assert.equal(renamed.model, "vendor/slow", "a title edit never touches the model");
  assert.equal(raw().model, "vendor/slow");

  // Clearing drops the key entirely — the record must look like one that never pinned.
  const cleared = await a.updateIssue("A", { model: null });
  assert.equal(cleared.model, null);
  assert.equal("model" in raw(), false, "clearing removes the key, it does not store null");

  // The blank string is how the form's default option comes back; same outcome.
  await a.updateIssue("A", { model: "vendor/slow" });
  assert.equal(raw().model, "vendor/slow");
  const blanked = await a.updateIssue("A", { model: "" });
  assert.equal(blanked.model, null);
  assert.equal("model" in raw(), false, 'an empty string clears it the same way null does');
});

test("follow-up fields round-trip on create and are never rewritten by an edit", async () => {
  const dir = mkDir({ "a.json": { id: "A", identifier: "A-1", title: "parent", state: "todo" } });
  const a = new FileTrackerAdapter({ dir, logger: silent });
  assert.equal(a.supportsFollowUp(), true);

  const parent = (await a.listAllIssues()).find((i) => i.id === "A")!;
  assert.equal(parent.follow_up_for, null, "an ordinary issue leads its own stream");
  assert.equal(parent.stream_identifier, null);

  const child = await a.createIssue({ identifier: "A-1-a", title: "review fixes", follow_up_for: "A-1", stream_identifier: "A-1" });
  assert.equal(child.follow_up_for, "A-1");
  assert.equal(child.stream_identifier, "A-1");

  // The stream picks the branch, so an edit must not be able to move it.
  const edited = await a.updateIssue(child.id, { title: "renamed", labels: ["review"] });
  assert.equal(edited.title, "renamed");
  assert.equal(edited.stream_identifier, "A-1", "the stream survives an edit untouched");
  assert.equal(edited.follow_up_for, "A-1");
});

test("indexed reads refresh hand edits without rereading unchanged issue files", async () => {
  const files: Record<string, unknown> = {};
  for (let i = 0; i < 80; i++) {
    files[`${i}.json`] = { id: `I-${i}`, identifier: `I-${i}`, title: "t", state: "todo" };
  }
  const dir = mkDir(files);
  const a = new FileTrackerAdapter({ dir, logger: silent });

  // Populate the index, then observe filesystem reads performed by steady-state
  // id lookups. Directory metadata may be checked, but unchanged records must not
  // be reparsed one by one.
  await a.fetchIssuesByIds(["I-40"]);
  const fsPromises = fs.promises as unknown as { readFile: typeof fs.promises.readFile };
  const originalReadFile = fsPromises.readFile;
  let reads = 0;
  fsPromises.readFile = async (...args: Parameters<typeof fs.promises.readFile>) => {
    reads++;
    return originalReadFile(...args);
  };
  try {
    const [unchanged] = await a.fetchIssuesByIds(["I-40"]);
    assert.equal(unchanged!.state, "todo");
    assert.equal(reads, 0, "a steady-state ID lookup does not reparse every record");

    fs.writeFileSync(path.join(dir, "40.json"), JSON.stringify({ id: "I-40", identifier: "I-40", title: "t", state: "done" }));
    const [edited] = await a.fetchIssuesByIds(["I-40"]);
    assert.equal(edited!.state, "done", "hand edits are picked up from changed metadata");
    assert.equal(reads, 1, "only the changed record is reread");

    fs.unlinkSync(path.join(dir, "40.json"));
    assert.deepEqual(await a.fetchIssuesByIds(["I-40"]), [], "hand deletions are picked up too");
  } finally {
    fsPromises.readFile = originalReadFile;
  }
});

test("mutations use the index and return their normalized record without a second scan", async () => {
  const files: Record<string, unknown> = {};
  for (let i = 0; i < 80; i++) {
    files[`${i}.json`] = { id: `I-${i}`, identifier: `I-${i}`, title: "t", state: "todo" };
  }
  const dir = mkDir(files);
  const a = new FileTrackerAdapter({ dir, logger: silent });
  await a.fetchIssuesByIds(["I-40"]);

  const fsPromises = fs.promises as unknown as { readFile: typeof fs.promises.readFile };
  const originalReadFile = fsPromises.readFile;
  let reads = 0;
  fsPromises.readFile = async (...args: Parameters<typeof fs.promises.readFile>) => {
    reads++;
    return originalReadFile(...args);
  };
  try {
    const updated = await a.setIssueState("I-40", "done");
    assert.equal(updated.state, "done");
    assert.equal(reads, 0, "the write returns its normalized in-memory record instead of rescanning it");
  } finally {
    fsPromises.readFile = originalReadFile;
  }
});
