/** New-issue, edit-issue and add-project forms. Inputs are uncontrolled — lit binds
 * only `defaultValue`/`defaultSelected`, so a repaint can never clobber what the user
 * is typing (a dirtied field ignores its default). */
import { html } from "../vendor/lit-html/lit-html.js";
import { store, apiBase, rerender } from "../store.js";
import { hashFor, goBoard, navigate, switchProject } from "../router.js";
import { fetchState, fetchBoard } from "../api.js";
import { toast } from "../toast.js";
import { pageHead } from "./page.js";

export function createPage() {
  const m = (store.state && store.state.meta) || {};
  // Offer backlog states first (new work parks in backlog by default) then active.
  let states = (m.backlog_states || []).concat(m.active_states || ["todo"]);
  if (!states.length) states = ["todo"];
  return html`${pageHead("New issue", "")}<div class="page"><form class="form page-form" id="newform" autocomplete="off" @submit=${submitCreate}>
    <div class="field"><label for="f-id">Identifier <span class="req">*</span></label>
      <input class="input" id="f-id" name="identifier" placeholder="SYM-3" required></div>
    <div class="field"><label for="f-title">Title <span class="req">*</span></label>
      <input class="input" id="f-title" name="title" placeholder="Short summary of the work" required></div>
    <div class="field"><label for="f-desc">Description</label>
      <textarea class="textarea" id="f-desc" name="description" placeholder="Tell the agent exactly what to do. It works in an isolated workspace, so include everything it needs, and how to know it is done."></textarea>
      <span class="hint">This becomes the agent prompt via {{ issue.description }}.</span></div>
    ${agentHidden(m)}
    <div class="row2"><div class="field"><label for="f-state">State</label>
      <select class="select" id="f-state" name="state">${states.map((s) => html`<option value=${s}>${s}</option>`)}</select>
      <span class="hint">Backlog waits; an active state runs now.</span></div>
    <div class="field"><label for="f-prio">Priority</label>
      <select class="select" id="f-prio" name="priority"><option value="">None</option><option>1</option><option>2</option><option>3</option><option>4</option></select></div>
    ${agentField(m)}</div>
    <div class="field"><label for="f-labels">Labels</label>
      <input class="input" id="f-labels" name="labels" placeholder="docs, backend"><span class="hint">Comma-separated.</span></div>
    <div class="field-err" id="f-err" hidden></div>
    <div class="form-actions"><button type="button" class="btn" data-nav=${hashFor("board")}>Cancel</button>
      <button type="submit" class="btn primary">Create &amp; dispatch</button></div>
  </form></div>`;
}

// Hidden input keeps the `agent` form field present (empty) when only one
// backend is registered; rendered outside the grid so it never claims a column.
function agentHidden(m) {
  const kinds = m.agent_kinds || [m.default_agent];
  if (kinds.length < 2) return html`<input type="hidden" id="f-agent" name="agent" value="">`;
  return null;
}

function agentField(m) {
  const kinds = m.agent_kinds || [m.default_agent];
  // Only worth choosing when more than one backend is registered.
  if (kinds.length < 2) return null;
  return html`<div class="field"><label for="f-agent">Agent</label>
    <select class="select" id="f-agent" name="agent">
      <option value="">Default (${m.default_agent})</option>
      ${kinds.map((k) => html`<option value=${k}>${k}</option>`)}
    </select>
    <span class="hint">Which coding agent runs this task.</span></div>`;
}

function submitCreate(e) {
  e.preventDefault();
  const f = e.target, err = document.getElementById("f-err");
  err.hidden = true;
  const payload = {
    identifier: f.identifier.value.trim(),
    title: f.title.value.trim(),
    description: f.description.value.trim() || null,
    state: f.state.value || null,
    priority: f.priority.value ? Number(f.priority.value) : null,
    agent: f.agent && f.agent.value ? f.agent.value : null,
    labels: f.labels.value.split(",").map((s) => s.trim()).filter(Boolean),
  };
  if (!payload.identifier || !payload.title) { err.textContent = "Identifier and title are required."; err.hidden = false; return; }
  const btn = f.querySelector("button[type=submit]");
  btn.classList.add("busy"); btn.dataset.label = btn.innerHTML; btn.innerHTML = '<span class="spin"></span> Creating';
  fetch(apiBase() + "/issues", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) })
    .then((r) => r.json().then((j) => ({ ok: r.ok, j })))
    .then((res) => {
      if (!res.ok) throw new Error((res.j.error && res.j.error.message) || "create failed");
      toast("Created " + payload.identifier + " · dispatching", "ok");
      goBoard();
      return Promise.all([fetchState(), fetchBoard()]);
    })
    .catch((ex) => { err.textContent = String(ex.message || ex); err.hidden = false;
      btn.classList.remove("busy"); btn.innerHTML = btn.dataset.label; });
}

/**
 * Edit an existing issue: the create form's editable fields, prefilled from the
 * detail payload (loaded once on route entry). Identifier and state are absent on
 * purpose — the identifier keys the record, and state has its own board actions.
 */
export function editPage(d) {
  const labels = (d.labels || []).join(", ");
  const prio = d.priority == null ? "" : String(d.priority);
  return html`${pageHead("Edit " + d.issue_identifier, d.title || "")}
    <div class="page"><form class="form page-form" id="editform" autocomplete="off"
      data-issue-id=${d.issue_id} data-issue-identifier=${d.issue_identifier} @submit=${submitEdit}>
    <div class="field"><label for="e-title">Title <span class="req">*</span></label>
      <input class="input" id="e-title" name="title" .defaultValue=${d.title || ""} required></div>
    <div class="field"><label for="e-desc">Description</label>
      <textarea class="textarea" id="e-desc" name="description" .defaultValue=${d.description || ""}></textarea>
      <span class="hint">This becomes the agent prompt via {{ issue.description }} on the next run.</span></div>
    <div class="row2"><div class="field"><label for="e-prio">Priority</label>
      <select class="select" id="e-prio" name="priority">
        ${["", "1", "2", "3", "4"].map((p) => html`<option value=${p} ?selected=${p === prio}>${p === "" ? "None" : p}</option>`)}
      </select></div>
    <div class="field"><label for="e-labels">Labels</label>
      <input class="input" id="e-labels" name="labels" .defaultValue=${labels}><span class="hint">Comma-separated.</span></div></div>
    <div class="field-err" id="e-err" hidden></div>
    <div class="form-actions"><button type="button" class="btn" data-nav=${hashFor("detail", d.issue_identifier)}>Cancel</button>
      <button type="submit" class="btn primary">Save changes</button></div>
  </form></div>`;
}

function submitEdit(e) {
  e.preventDefault();
  const f = e.target, err = document.getElementById("e-err");
  err.hidden = true;
  const id = f.getAttribute("data-issue-id"), identifier = f.getAttribute("data-issue-identifier");
  const payload = {
    title: f.title.value.trim(),
    description: f.description.value.trim() || null,
    priority: f.priority.value ? Number(f.priority.value) : null,
    labels: f.labels.value.split(",").map((s) => s.trim()).filter(Boolean),
  };
  if (!payload.title) { err.textContent = "Title is required."; err.hidden = false; return; }
  const btn = f.querySelector("button[type=submit]");
  btn.classList.add("busy"); btn.dataset.label = btn.innerHTML; btn.innerHTML = '<span class="spin"></span> Saving';
  fetch(apiBase() + "/issues/" + encodeURIComponent(id), {
    method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
  })
    .then((r) => r.json().then((j) => ({ ok: r.ok, j })))
    .then((res) => {
      if (!res.ok) throw new Error((res.j.error && res.j.error.message) || "update failed");
      toast("Saved " + identifier, "ok");
      navigate(hashFor("detail", identifier)); // route entry reloads the detail payload
      return Promise.all([fetchState(), fetchBoard()]);
    })
    .catch((ex) => { err.textContent = String(ex.message || ex); err.hidden = false;
      btn.classList.remove("busy"); btn.innerHTML = btn.dataset.label; });
}

/**
 * Open a follow-up on an existing issue: the same fields as a new issue, but the work
 * lands on the branch this issue already delivered to instead of a fresh one — which is
 * what makes it usable for review feedback. The parent rides in the URL, not the form.
 */
export function followUpPage(d) {
  const m = (store.state && store.state.meta) || {};
  const stream = d.stream || d.issue_identifier;
  const branch = deliveryBranch(d, stream);
  // Active by default: a follow-up is normally written to be worked on now.
  let states = (m.active_states || ["todo"]).concat(m.backlog_states || []);
  if (!states.length) states = ["todo"];
  return html`${pageHead("Follow-up on " + d.issue_identifier, d.title || "")}
    <div class="page"><form class="form page-form" id="followupform" autocomplete="off"
      data-parent-id=${d.issue_id} data-parent=${d.issue_identifier} @submit=${submitFollowUp}>
    <div class="aside-card" style="margin-bottom:14px">
      <div class="log-head" style="margin-top:0">Continues ${d.issue_identifier}</div>
      <p class="sub">This issue joins the same work stream: it reuses the workspace and commits to
      ${branch ? html`<span class="mono">${branch}</span>` : html`the same branch`}, on top of the work already there —
      no second branch, nothing to reconcile later. It runs after any sibling still working that branch.</p>
    </div>
    <div class="field"><label for="u-id">Identifier <span class="req">*</span></label>
      <input class="input" id="u-id" name="identifier" .defaultValue=${suggestIdentifier(stream)} required></div>
    <div class="field"><label for="u-title">Title <span class="req">*</span></label>
      <input class="input" id="u-title" name="title" placeholder="Address review comments" required></div>
    <div class="field"><label for="u-desc">Description</label>
      <textarea class="textarea" id="u-desc" name="description" placeholder="Paste the review feedback. Be specific about what to change — the agent picks up the branch as it stands and reads its history, but it cannot see the review thread."></textarea>
      <span class="hint">This becomes the agent prompt via {{ issue.description }}.</span></div>
    ${agentHidden(m)}
    <div class="row2"><div class="field"><label for="u-state">State</label>
      <select class="select" id="u-state" name="state">${states.map((s) => html`<option value=${s}>${s}</option>`)}</select>
      <span class="hint">An active state runs it now; backlog waits.</span></div>
    <div class="field"><label for="u-prio">Priority</label>
      <select class="select" id="u-prio" name="priority"><option value="">None</option><option>1</option><option>2</option><option>3</option><option>4</option></select></div>
    ${agentField(m)}</div>
    <div class="field"><label for="u-labels">Labels</label>
      <input class="input" id="u-labels" name="labels" placeholder="review"><span class="hint">Comma-separated.</span></div>
    <div class="field-err" id="u-err" hidden></div>
    <div class="form-actions"><button type="button" class="btn" data-nav=${hashFor("detail", d.issue_identifier)}>Cancel</button>
      <button type="submit" class="btn primary">Create follow-up</button></div>
  </form></div>`;
}

/** The branch the stream delivers on, from whichever member already recorded a delivery. */
function deliveryBranch(d, stream) {
  if (d.delivery && d.delivery.branch) return d.delivery.branch;
  const issues = (store.board && store.board.issues) || [];
  const sibling = issues.find((i) => i.stream === stream && i.delivery_branch);
  return sibling ? sibling.delivery_branch : null;
}

/** Next free `<stream>-N`, counting the stream members the board already knows about. */
function suggestIdentifier(stream) {
  const issues = (store.board && store.board.issues) || [];
  const taken = new Set(issues.map((i) => i.identifier));
  for (let n = 2; n < 100; n++) {
    const candidate = `${stream}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  return "";
}

function submitFollowUp(e) {
  e.preventDefault();
  const f = e.target, err = document.getElementById("u-err");
  err.hidden = true;
  const parentId = f.getAttribute("data-parent-id"), parent = f.getAttribute("data-parent");
  const payload = {
    identifier: f.identifier.value.trim(),
    title: f.title.value.trim(),
    description: f.description.value.trim() || null,
    state: f.state.value || null,
    priority: f.priority.value ? Number(f.priority.value) : null,
    agent: f.agent && f.agent.value ? f.agent.value : null,
    labels: f.labels.value.split(",").map((s) => s.trim()).filter(Boolean),
  };
  if (!payload.identifier || !payload.title) { err.textContent = "Identifier and title are required."; err.hidden = false; return; }
  const btn = f.querySelector("button[type=submit]");
  btn.classList.add("busy"); btn.dataset.label = btn.innerHTML; btn.innerHTML = '<span class="spin"></span> Creating';
  fetch(apiBase() + "/issues/" + encodeURIComponent(parentId) + "/follow-up", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
  })
    .then((r) => r.json().then((j) => ({ ok: r.ok, j })))
    .then((res) => {
      if (!res.ok) throw new Error((res.j.error && res.j.error.message) || "create failed");
      toast("Created " + payload.identifier + " · continues " + parent, "ok");
      navigate(hashFor("detail", payload.identifier));
      return Promise.all([fetchState(), fetchBoard()]);
    })
    .catch((ex) => { err.textContent = String(ex.message || ex); err.hidden = false;
      btn.classList.remove("busy"); btn.innerHTML = btn.dataset.label; });
}

export function addProjectPage() {
  return html`${pageHead("Add project", "")}<div class="page"><form class="form page-form" id="addprojform" autocomplete="off" @submit=${submitAddProject}>
    <div class="field"><label for="f-wf">Workflow path <span class="req">*</span></label>
      <input class="input" id="f-wf" name="workflow" placeholder="../my-app/WORKFLOW.md" required>
      <span class="hint">Path to a WORKFLOW.md — or a project directory containing one — resolved where Symphony runs. Its issues + workspace stay isolated under that directory.</span></div>
    <div class="field"><label for="f-name">Name</label>
      <input class="input" id="f-name" name="name" placeholder="My App"><span class="hint">Optional display name; defaults to the folder name.</span></div>
    <div class="field-err" id="ap-err" hidden></div>
    <div class="form-actions"><button type="button" class="btn" data-nav=${hashFor("board")}>Cancel</button>
      <button type="submit" class="btn primary">Add project</button></div>
  </form></div>`;
}

function submitAddProject(e) {
  e.preventDefault();
  const f = e.target, err = document.getElementById("ap-err");
  err.hidden = true;
  const payload = { workflow: f.workflow.value.trim(), name: f.name.value.trim() || null };
  if (!payload.workflow) { err.textContent = "Workflow path is required."; err.hidden = false; return; }
  const btn = f.querySelector("button[type=submit]");
  btn.classList.add("busy"); btn.dataset.label = btn.innerHTML; btn.innerHTML = '<span class="spin"></span> Adding';
  fetch("/api/v1/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) })
    .then((r) => r.json().then((j) => ({ ok: r.ok, j })))
    .then((res) => {
      if (!res.ok) throw new Error((res.j.error && res.j.error.message) || "add failed");
      const np = res.j.project;
      store.projects.push(np);
      toast("Added " + np.name, "ok");
      switchProject(np.id);
      rerender();
    })
    .catch((ex) => { err.textContent = String(ex.message || ex); err.hidden = false;
      btn.classList.remove("busy"); btn.innerHTML = btn.dataset.label; });
}
