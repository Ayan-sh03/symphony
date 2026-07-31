import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { GitHubTrackerAdapter } from "../src/tracker/githubAdapter.ts";
import { AdapterError } from "../src/tracker/types.ts";
import { createAdapter, isSupportedKind, validateTracker, SUPPORTED_KINDS } from "../src/tracker/registry.ts";
import { Logger } from "../src/logger.ts";

const silent = new Logger([{ name: "null", write() {} }], "error");
const TOKEN_ENV = "SYM_TEST_GH_TOKEN";
process.env[TOKEN_ENV] = "test-token";

interface RawIssue {
  number: number;
  node_id?: string;
  title?: unknown;
  body?: string | null;
  state?: string;
  labels?: unknown;
  html_url?: string;
  assignee?: { login: string } | null;
  pull_request?: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
}

interface Call {
  method: string;
  path: string;
  body: Record<string, unknown> | null;
}

interface Fake {
  base: string;
  calls: Call[];
  issues: RawIssue[];
  close: () => Promise<void>;
}

/** A local stand-in for the GitHub REST API. No network, no credentials. */
async function startFake(
  issues: RawIssue[],
  opts: {
    fail?: { status: number; headers?: Record<string, string>; body?: string };
    pageSize?: number;
    /** Serve the listing from a snapshot taken at startup, as real GitHub's index lags writes. */
    staleList?: boolean;
  } = {},
): Promise<Fake> {
  const calls: Call[] = [];
  const store = issues;
  const snapshot: RawIssue[] = structuredClone(issues);

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body: Record<string, unknown> | null = null;
      if (raw.trim() !== "") {
        try {
          body = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          body = null;
        }
      }
      const url = new URL(req.url ?? "/", "http://localhost");
      calls.push({ method: req.method ?? "GET", path: decodeURIComponent(url.pathname), body });

      const send = (status: number, payload: unknown, headers: Record<string, string> = {}): void => {
        res.writeHead(status, { "content-type": "application/json", ...headers });
        res.end(typeof payload === "string" ? payload : JSON.stringify(payload));
      };

      if (opts.fail) {
        res.writeHead(opts.fail.status, { "content-type": "application/json", ...(opts.fail.headers ?? {}) });
        res.end(opts.fail.body ?? JSON.stringify({ message: "boom" }));
        return;
      }

      const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
      // /repos/:owner/:repo/issues[/:number[/comments|labels[/:name]]]
      const rest = parts.slice(3); // drop repos/:owner/:repo
      const method = req.method ?? "GET";

      if (rest[0] !== "issues") return send(404, { message: "not found" });

      if (rest.length === 1 && method === "GET") {
        const listed = opts.staleList ? snapshot : store;
        const size = opts.pageSize ?? Math.max(listed.length, 1);
        const page = Number(url.searchParams.get("page") ?? "1");
        const slice = listed.slice((page - 1) * size, page * size);
        const headers: Record<string, string> = {};
        if (page * size < listed.length) {
          headers.link = `<${base()}/repos/o/r/issues?state=all&per_page=100&page=${page + 1}>; rel="next"`;
        }
        return send(200, slice, headers);
      }

      if (rest.length === 1 && method === "POST") {
        const created: RawIssue = {
          number: 99,
          node_id: "NODE99",
          title: String(body?.title ?? ""),
          body: (body?.body as string | undefined) ?? null,
          state: "open",
          labels: ((body?.labels as string[] | undefined) ?? []).map((name) => ({ name })),
          html_url: "https://github.com/o/r/issues/99",
        };
        store.push(created);
        return send(201, created);
      }

      const number = Number(rest[1]);
      const target = store.find((i) => i.number === number);
      if (!target) return send(404, { message: `no issue ${number}` });

      if (rest.length === 2 && method === "GET") return send(200, target);
      if (rest.length === 2 && method === "PATCH") {
        if (typeof body?.state === "string") target.state = body.state;
        return send(200, target);
      }
      if (rest[2] === "comments" && method === "POST") return send(201, { id: 1, body: body?.body });
      if (rest[2] === "labels" && method === "POST") {
        const names = ((body?.labels as string[] | undefined) ?? []).map((name) => ({ name }));
        target.labels = [...((target.labels as { name: string }[] | undefined) ?? []), ...names];
        return send(200, target.labels);
      }
      if (rest[2] === "labels" && method === "DELETE") {
        const name = rest[3] ?? "";
        target.labels = ((target.labels as { name: string }[] | undefined) ?? []).filter((l) => l.name !== name);
        return send(200, target.labels);
      }
      return send(404, { message: "not found" });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const base = (): string => `http://127.0.0.1:${port}`;

  return {
    base: base(),
    calls,
    issues: store,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function adapterFor(fake: Fake): GitHubTrackerAdapter {
  return GitHubTrackerAdapter.create(
    { owner: "o", repo: "r", token_env: TOKEN_ENV, api_base: fake.base },
    process.cwd(),
    silent,
  );
}

function openIssue(over: Partial<RawIssue> = {}): RawIssue {
  return {
    number: 1,
    node_id: "NODE1",
    title: "Fix the thing",
    body: "details",
    state: "open",
    labels: [{ name: "sym:todo" }, { name: "Bug" }],
    html_url: "https://github.com/o/r/issues/1",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-02T00:00:00Z",
    ...over,
  };
}

// ---- config + registry ----

test("registry supports github and validates required provider config", () => {
  assert.ok(isSupportedKind("github"));
  assert.deepEqual([...SUPPORTED_KINDS], ["file", "github"]);
  assert.throws(() => validateTracker("github", { repo: "r", token_env: "T" }), (e: AdapterError) => {
    assert.equal(e.category, "invalid_tracker_config");
    assert.match(e.message, /owner/);
    return true;
  });
  assert.throws(() => validateTracker("github", { owner: "o", token_env: "T" }), /repo/);
  assert.throws(() => validateTracker("github", { owner: "o", repo: "r" }), /token_env/);
  assert.throws(() => validateTracker("github", { owner: "o", repo: "r", token_env: "T", api_base: 5 }), /api_base/);
  validateTracker("github", { owner: "o", repo: "r", token_env: "T" });
  const built = createAdapter("github", { owner: "o", repo: "r", token_env: "T" }, process.cwd(), silent);
  assert.equal(built.kind, "github");
});

test("secretEnvironmentNames returns the configured token env var", () => {
  const a = GitHubTrackerAdapter.create({ owner: "o", repo: "r", token_env: "MY_PAT" }, process.cwd(), silent);
  assert.deepEqual(a.secretEnvironmentNames(), ["MY_PAT"]);
});

test("empty input returns empty without touching the provider", async () => {
  const a = GitHubTrackerAdapter.create(
    { owner: "o", repo: "r", token_env: TOKEN_ENV, api_base: "http://127.0.0.1:1" },
    process.cwd(),
    silent,
  );
  assert.deepEqual(await a.fetchIssuesByStates([]), []);
  assert.deepEqual(await a.fetchIssuesByIds([]), []);
});

test("a missing token env var is missing_tracker_secret", async () => {
  const fake = await startFake([openIssue()]);
  const a = GitHubTrackerAdapter.create(
    { owner: "o", repo: "r", token_env: "SYM_TEST_ABSENT_TOKEN", api_base: fake.base },
    process.cwd(),
    silent,
  );
  await assert.rejects(a.listAllIssues(), (e: AdapterError) => e.category === "missing_tracker_secret");
  await fake.close();
});

// ---- normalization ----

test("fetchIssuesByStates normalizes an open sym:todo issue", async () => {
  const fake = await startFake([openIssue()]);
  const a = adapterFor(fake);

  assert.deepEqual(await a.fetchIssuesByStates(["review"]), []);
  const issues = await a.fetchIssuesByStates(["todo"]);
  assert.equal(issues.length, 1);
  const issue = issues[0]!;
  assert.equal(issue.id, "NODE1");
  assert.equal(issue.identifier, "GH-1");
  assert.equal(issue.title, "Fix the thing");
  assert.equal(issue.description, "details");
  assert.equal(issue.state, "todo");
  assert.equal(issue.url, "https://github.com/o/r/issues/1");
  assert.equal(issue.dispatchable, true);
  assert.deepEqual(issue.labels, ["bug"]); // lowercased; the sym:* state label is not a label
  assert.deepEqual(issue.native_ref, {
    owner: "o",
    repo: "r",
    number: 1,
    node_id: "NODE1",
    html_url: "https://github.com/o/r/issues/1",
    state_labels: ["sym:todo"],
  });
  await fake.close();
});

test("open issues with no sym:* label normalize to backlog, not an active state", async () => {
  const fake = await startFake([openIssue({ labels: [{ name: "enhancement" }] })]);
  const issues = await adapterFor(fake).listAllIssues();
  assert.equal(issues[0]!.state, "backlog");
  assert.deepEqual(issues[0]!.labels, ["enhancement"]);
  await fake.close();
});

test("closed issues are terminal: default done, explicit terminal label preserved", async () => {
  const fake = await startFake([
    openIssue({ number: 1, node_id: "N1", state: "closed", labels: [{ name: "sym:in progress" }] }),
    openIssue({ number: 2, node_id: "N2", state: "closed", labels: [] }),
    openIssue({ number: 3, node_id: "N3", state: "closed", labels: [{ name: "sym:canceled" }] }),
  ]);
  const byId = new Map((await adapterFor(fake).listAllIssues()).map((i) => [i.id, i.state]));
  assert.equal(byId.get("N1"), "done"); // non-terminal label on a closed issue
  assert.equal(byId.get("N2"), "done"); // no label at all
  assert.equal(byId.get("N3"), "canceled"); // terminal label survives
  await fake.close();
});

test("pull requests are ignored", async () => {
  const fake = await startFake([
    openIssue({ number: 1, node_id: "N1" }),
    openIssue({ number: 2, node_id: "N2", pull_request: { url: "https://api/pulls/2" } }),
  ]);
  const issues = await adapterFor(fake).listAllIssues();
  assert.deepEqual(issues.map((i) => i.id), ["N1"]);
  await fake.close();
});

test("fetchIssuesByIds matches node_id and falls back to the number", async () => {
  const fake = await startFake([
    openIssue({ number: 1, node_id: "NODE1" }),
    openIssue({ number: 7, node_id: undefined }),
  ]);
  const a = adapterFor(fake);
  assert.deepEqual((await a.fetchIssuesByIds(["NODE1"])).map((i) => i.identifier), ["GH-1"]);
  assert.deepEqual((await a.fetchIssuesByIds(["7"])).map((i) => i.identifier), ["GH-7"]);
  assert.deepEqual(await a.fetchIssuesByIds(["nope"]), []);
  await fake.close();
});

test("paginated listings follow the Link rel=next header", async () => {
  const fake = await startFake(
    [1, 2, 3, 4, 5].map((n) => openIssue({ number: n, node_id: `N${n}` })),
    { pageSize: 2 },
  );
  const issues = await adapterFor(fake).listAllIssues();
  assert.deepEqual(issues.map((i) => i.identifier), ["GH-1", "GH-2", "GH-3", "GH-4", "GH-5"]);
  assert.equal(fake.calls.filter((c) => c.method === "GET").length, 3);
  await fake.close();
});

test("malformed provider payloads raise tracker_response", async () => {
  const missingTitle = await startFake([openIssue({ title: undefined })]);
  await assert.rejects(adapterFor(missingTitle).listAllIssues(), (e: AdapterError) => {
    assert.equal(e.category, "tracker_response");
    assert.match(e.message, /title/);
    return true;
  });
  await missingTitle.close();

  const badLabels = await startFake([openIssue({ labels: "bug" })]);
  await assert.rejects(adapterFor(badLabels).listAllIssues(), (e: AdapterError) => e.category === "tracker_response");
  await badLabels.close();

  const badState = await startFake([openIssue({ state: "weird" })]);
  await assert.rejects(adapterFor(badState).listAllIssues(), (e: AdapterError) => e.category === "tracker_response");
  await badState.close();

  const notAnArray = await startFake([], { fail: { status: 200, body: JSON.stringify({ message: "nope" }) } });
  await assert.rejects(adapterFor(notAnArray).listAllIssues(), (e: AdapterError) => e.category === "tracker_response");
  await notAnArray.close();
});

// ---- error mapping ----

test("401 and 403 map to tracker_request", async () => {
  for (const status of [401, 403]) {
    const fake = await startFake([], { fail: { status, body: JSON.stringify({ message: "Bad credentials" }) } });
    await assert.rejects(adapterFor(fake).listAllIssues(), (e: AdapterError) => {
      assert.equal(e.category, "tracker_request");
      assert.match(e.message, new RegExp(String(status)));
      assert.match(e.message, new RegExp(TOKEN_ENV));
      return true;
    });
    await fake.close();
  }
});

test("403 with Retry-After maps to a retryable tracker_request naming the delay", async () => {
  const fake = await startFake([], {
    fail: { status: 403, headers: { "retry-after": "60" }, body: JSON.stringify({ message: "secondary rate limit" }) },
  });
  await assert.rejects(adapterFor(fake).listAllIssues(), (e: AdapterError) => {
    assert.equal(e.category, "tracker_request");
    assert.equal(e.retryable, true);
    assert.match(e.message, /retry-after=60s/);
    return true;
  });
  await fake.close();
});

test("network failures map to a retryable tracker_request", async () => {
  const a = GitHubTrackerAdapter.create(
    { owner: "o", repo: "r", token_env: TOKEN_ENV, api_base: "http://127.0.0.1:1" },
    process.cwd(),
    silent,
  );
  await assert.rejects(a.listAllIssues(), (e: AdapterError) => {
    assert.equal(e.category, "tracker_request");
    assert.equal(e.retryable, true);
    return true;
  });
});

// ---- writes ----

test("setIssueState swaps the sym:* label and reopens/closes to match", async () => {
  const fake = await startFake([openIssue()]);
  const a = adapterFor(fake);

  const moved = await a.setIssueState("NODE1", "review");
  assert.equal(moved.state, "review");
  const del = fake.calls.find((c) => c.method === "DELETE");
  assert.equal(del?.path, "/repos/o/r/issues/1/labels/sym:todo");
  const add = fake.calls.find((c) => c.method === "POST" && c.path.endsWith("/labels"));
  assert.deepEqual(add?.body, { labels: ["sym:review"] });
  assert.deepEqual(fake.calls.find((c) => c.method === "PATCH")?.body, { state: "open" });
  assert.deepEqual(fake.issues[0]!.labels, [{ name: "Bug" }, { name: "sym:review" }]);

  fake.calls.length = 0;
  const done = await a.setIssueState("NODE1", "done");
  assert.equal(done.state, "done");
  assert.equal(fake.calls.find((c) => c.method === "DELETE")?.path, "/repos/o/r/issues/1/labels/sym:review");
  assert.deepEqual(fake.calls.find((c) => c.method === "PATCH")?.body, { state: "closed" });
  assert.equal(fake.issues[0]!.state, "closed");
  await fake.close();
});

test("setIssueState on a closed issue deletes the label it really has, not its normalized state", async () => {
  // The issue normalizes to `done`, but its label is sym:review — a transition must
  // address the literal label or the stale one is left behind.
  const fake = await startFake([openIssue({ state: "closed", labels: [{ name: "sym:review" }] })]);
  await adapterFor(fake).setIssueState("NODE1", "todo");
  assert.equal(fake.calls.find((c) => c.method === "DELETE")?.path, "/repos/o/r/issues/1/labels/sym:review");
  assert.deepEqual(fake.issues[0]!.labels, [{ name: "sym:todo" }]);
  assert.equal(fake.issues[0]!.state, "open"); // reopened for a non-terminal state
  await fake.close();
});

test("read-back after a write goes by number, so a lagging listing cannot stale it", async () => {
  // Real GitHub serves the issues *list* from an index that trails a write by a
  // second or so; the by-number endpoint is immediately consistent.
  const fake = await startFake([openIssue()], { staleList: true });
  const a = adapterFor(fake);

  const moved = await a.setIssueState("NODE1", "review");
  assert.equal(moved.state, "review"); // fresh, despite the listing still saying todo
  assert.ok(fake.calls.some((c) => c.method === "GET" && c.path === "/repos/o/r/issues/1"));
  assert.equal((await a.listAllIssues())[0]!.state, "todo"); // the listing really is stale
  await fake.close();
});

test("createIssue opens an issue carrying the state label", async () => {
  const fake = await startFake([]);
  const a = adapterFor(fake);
  assert.equal(a.supportsCreate(), true);

  const created = await a.createIssue({ identifier: "ignored", title: "New work", description: "why", labels: ["Chore"] });
  assert.equal(created.identifier, "GH-99"); // GitHub assigns the number, not the caller
  assert.equal(created.state, "todo");
  assert.deepEqual(created.labels, ["chore"]);
  const post = fake.calls.find((c) => c.method === "POST")!;
  assert.deepEqual(post.body, { title: "New work", body: "why", labels: ["chore", "sym:todo"] });

  await assert.rejects(a.createIssue({ identifier: "x", title: "  " }), (e: AdapterError) => e.category === "invalid_tracker_config");
  await fake.close();
});

// ---- agent tools ----

test("agent tools comment, transition and record results", async () => {
  const fake = await startFake([openIssue()]);
  const a = adapterFor(fake);
  const issue = (await a.fetchIssuesByStates(["todo"]))[0]!;

  assert.deepEqual(a.agentToolSpecs().map((t) => t.name).sort(), [
    "add_issue_comment",
    "set_issue_result",
    "update_issue_state",
  ]);

  fake.calls.length = 0;
  const commented = await a.executeAgentTool("add_issue_comment", { comment: "working on it" }, { issue });
  assert.equal(commented.success, true);
  assert.deepEqual(fake.calls[0], { method: "POST", path: "/repos/o/r/issues/1/comments", body: { body: "working on it" } });

  fake.calls.length = 0;
  const moved = await a.executeAgentTool("update_issue_state", { state: "in progress", comment: "starting" }, { issue });
  assert.equal(moved.success, true);
  assert.equal(fake.calls.filter((c) => c.path.endsWith("/comments")).length, 1);
  assert.deepEqual(fake.calls.find((c) => c.path.endsWith("/labels"))?.body, { labels: ["sym:in progress"] });

  fake.calls.length = 0;
  const result = await a.executeAgentTool(
    "set_issue_result",
    { state: "review", comment: "done here", pr_url: "https://github.com/o/r/pull/5", tests: "npm test: 70 passed" },
    { issue },
  );
  assert.equal(result.success, true);
  const comments = fake.calls.filter((c) => c.path.endsWith("/comments")).map((c) => String(c.body?.body));
  assert.equal(comments.length, 2);
  assert.match(comments[0]!, /done here/);
  assert.match(comments[0]!, /Tests: npm test: 70 passed/);
  assert.equal(comments[1], "PR: https://github.com/o/r/pull/5");
  assert.deepEqual(fake.calls.find((c) => c.path.endsWith("/labels") && c.method === "POST")?.body, { labels: ["sym:review"] });
  await fake.close();
});

test("agent tools fail structurally instead of throwing", async () => {
  const fake = await startFake([openIssue()]);
  const a = adapterFor(fake);
  const issue = (await a.fetchIssuesByStates(["todo"]))[0]!;

  const unknown = await a.executeAgentTool("delete_everything", {}, { issue });
  assert.equal(unknown.success, false);
  assert.match(String((unknown.output as { error: string }).error), /unsupported tool/);

  const blank = await a.executeAgentTool("update_issue_state", { state: "  " }, { issue });
  assert.equal(blank.success, false);
  const noComment = await a.executeAgentTool("add_issue_comment", {}, { issue });
  assert.equal(noComment.success, false);
  await fake.close();

  // Provider faults surface as a failed tool result, not an exception that kills the run.
  const dead = await a.executeAgentTool("add_issue_comment", { comment: "hi" }, { issue });
  assert.equal(dead.success, false);
});
