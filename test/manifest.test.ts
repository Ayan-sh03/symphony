import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadManifest, saveManifest, resolveEntryWorkflow, deriveId, ManifestError } from "../src/project/manifest.ts";

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sym-man-"));
}

test("loads a valid manifest and defaults name to id", () => {
  const dir = tmp();
  const mp = path.join(dir, "projects.json");
  fs.writeFileSync(mp, JSON.stringify([
    { id: "a", name: "Alpha", workflow: "./a/WORKFLOW.md" },
    { id: "b", workflow: "./b/WORKFLOW.md" },
  ]));
  const entries = loadManifest(mp);
  assert.equal(entries.length, 2);
  assert.equal(entries[0]!.name, "Alpha");
  assert.equal(entries[1]!.name, "b"); // name defaults to id
});

test("rejects non-array, missing id/workflow, and duplicate ids", () => {
  const dir = tmp();
  const mp = path.join(dir, "projects.json");
  fs.writeFileSync(mp, JSON.stringify({ not: "an array" }));
  assert.throws(() => loadManifest(mp), ManifestError);

  fs.writeFileSync(mp, JSON.stringify([{ workflow: "./x" }]));
  assert.throws(() => loadManifest(mp), ManifestError);

  fs.writeFileSync(mp, JSON.stringify([{ id: "a", workflow: "" }]));
  assert.throws(() => loadManifest(mp), ManifestError);

  fs.writeFileSync(mp, JSON.stringify([
    { id: "a", workflow: "./a" },
    { id: "a", workflow: "./b" },
  ]));
  assert.throws(() => loadManifest(mp), ManifestError);
});

test("save/load round-trips", () => {
  const dir = tmp();
  const mp = path.join(dir, "projects.json");
  const entries = [{ id: "a", name: "Alpha", workflow: "./a/WORKFLOW.md" }];
  saveManifest(mp, entries);
  assert.deepEqual(loadManifest(mp), entries);
});

test("resolveEntryWorkflow resolves relative to the manifest dir; absolute passes through", () => {
  const dir = tmp();
  const mp = path.join(dir, "projects.json");
  const rel = resolveEntryWorkflow(mp, { id: "a", name: "a", workflow: "./a/WORKFLOW.md" });
  assert.equal(rel, path.normalize(path.join(dir, "a", "WORKFLOW.md")));
  const absInput = path.join(dir, "x", "WORKFLOW.md");
  assert.equal(resolveEntryWorkflow(mp, { id: "b", name: "b", workflow: absInput }), path.normalize(absInput));
});

test("deriveId slugifies the workflow's directory and dedups", () => {
  assert.equal(deriveId("/repos/My App/WORKFLOW.md", []), "my-app");
  assert.equal(deriveId("/repos/My App/WORKFLOW.md", ["my-app"]), "my-app-2");
  assert.equal(deriveId("/repos/My App/WORKFLOW.md", ["my-app", "my-app-2"]), "my-app-3");
});
