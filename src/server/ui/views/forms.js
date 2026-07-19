/** New-issue and add-project forms. Inputs are uncontrolled — lit never binds their
 * values, so background repaints cannot clobber what the user is typing. */
import { html } from "../vendor/lit-html/lit-html.js";
import { store, apiBase, rerender } from "../store.js";
import { hashFor, goBoard, switchProject } from "../router.js";
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
    <div class="row2"><div class="field"><label for="f-state">State</label>
      <select class="select" id="f-state" name="state">${states.map((s) => html`<option value=${s}>${s}</option>`)}</select>
      <span class="hint">Backlog waits; an active state runs now.</span></div>
    <div class="field"><label for="f-prio">Priority</label>
      <select class="select" id="f-prio" name="priority"><option value="">None</option><option>1</option><option>2</option><option>3</option><option>4</option></select></div></div>
    ${agentField(m)}
    <div class="field"><label for="f-labels">Labels</label>
      <input class="input" id="f-labels" name="labels" placeholder="docs, backend"><span class="hint">Comma-separated.</span></div>
    <div class="field-err" id="f-err" hidden></div>
    <div class="form-actions"><button type="button" class="btn" data-nav=${hashFor("board")}>Cancel</button>
      <button type="submit" class="btn primary">Create &amp; dispatch</button></div>
  </form></div>`;
}

function agentField(m) {
  const kinds = m.agent_kinds || [m.default_agent];
  // Only worth choosing when more than one backend is registered.
  if (kinds.length < 2) return html`<input type="hidden" id="f-agent" name="agent" value="">`;
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
