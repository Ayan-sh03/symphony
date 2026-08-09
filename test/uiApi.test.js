import { test } from "node:test";
import assert from "node:assert/strict";

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function response(etag, identifier) {
  return {
    status: 200,
    ok: true,
    headers: { get: (name) => name === "etag" ? etag : null },
    json: async () => ({ issues: [{ identifier }] }),
  };
}

test("overlapping board reads cannot commit out of order or across projects", async () => {
  globalThis.window = { __SYMPHONY__: { projects: [{ id: "a" }, { id: "b" }], selected: "a", snapshot: { meta: { can_board: true } } } };
  globalThis.localStorage = { getItem: () => null, setItem() {} };
  const requests = [];
  globalThis.fetch = () => {
    const request = deferred();
    requests.push(request);
    return request.promise;
  };

  const { store } = await import("../src/server/ui/store.js");
  const { fetchBoard } = await import("../src/server/ui/api.js");
  store.state = { meta: { can_board: true } };

  const older = fetchBoard();
  const newer = fetchBoard();
  requests[1].resolve(response('"new"', "newer"));
  await newer;
  requests[0].resolve(response('"old"', "older"));
  await older;
  assert.equal(store.board.issues[0].identifier, "newer");
  assert.equal(store.boardEtag, '"new"');

  const oldProject = fetchBoard();
  store.pid = "b";
  store.board = null;
  store.boardEtag = null;
  const newProject = fetchBoard();
  requests[3].resolve(response('"b"', "project-b"));
  await newProject;
  requests[2].resolve(response('"a-late"', "project-a"));
  await oldProject;
  assert.equal(store.board.issues[0].identifier, "project-b");
  assert.equal(store.boardEtag, '"b"');
});
