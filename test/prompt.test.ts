import { test } from "node:test";
import assert from "node:assert/strict";
import { renderPrompt, PromptError } from "../src/prompt/render.ts";
import type { Issue } from "../src/domain/types.ts";

function issue(over: Partial<Issue> = {}): Issue {
  return {
    id: "1", native_ref: null, identifier: "ABC-1", title: "Do a thing", description: "details",
    priority: 2, state: "todo", branch_name: null, url: null, assignee_id: null,
    labels: ["bug", "urgent"], blocked_by: [], dispatchable: true, created_at: null, updated_at: null,
    ...over,
  };
}

test("renders issue fields and iterates labels", () => {
  const out = renderPrompt("Title: {{ issue.title }}; labels:{% for l in issue.labels %} {{ l }}{% endfor %}", issue(), null);
  assert.equal(out, "Title: Do a thing; labels: bug urgent");
});

test("attempt is null on first run, integer on retry", () => {
  assert.equal(renderPrompt("{% if attempt %}retry {{ attempt }}{% else %}first{% endif %}", issue(), null), "first");
  assert.equal(renderPrompt("{% if attempt %}retry {{ attempt }}{% else %}first{% endif %}", issue(), 3), "retry 3");
});

test("unknown variable fails rendering (strict)", () => {
  assert.throws(() => renderPrompt("{{ issue.nonexistent_field.deep }}", issue(), null));
});

test("unknown filter fails rendering (strict)", () => {
  assert.throws(() => renderPrompt("{{ issue.title | no_such_filter }}", issue(), null), (e) => e instanceof PromptError);
});
