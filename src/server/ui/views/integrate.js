/** Integration guide route: how to add an agent backend, plus the default-agent picker. */
import { html, nothing } from "../vendor/lit-html/lit-html.js";
import { live } from "../vendor/lit-html/directives/live.js";
import { store } from "../store.js";
import { pageHead } from "./page.js";
import { agentStatusList, agentNotice } from "./agents.js";
import { modelStatusList } from "./models.js";

function chips(list, active) {
  return list.map((k, i) => html`${i ? " " : ""}<span class="badge ${k === active ? "active" : ""}">${k === active ? html`<span class="bd"></span>` : nothing}${k}</span>`);
}

const STEPS = [
  [html`Implement <code>AgentSession</code>`, html`Create <code>src/agent/&lt;your-agent&gt;.ts</code> with <code>start()</code> → <code>runTurn()</code>* → <code>stop()</code>. Launch your backend in the per-issue workspace and drive one turn per <code>runTurn</code>.`],
  [html`Emit <code>AgentUpdate</code>s`, html`Call <code>opts.onUpdate</code> with events like <code>session_started</code>, <code>turn_started</code>, <code>agent_message</code>, <code>command</code>, <code>turn_completed</code>, <code>turn_failed</code>. These feed the metrics and this activity log.`],
  [html`Register the backend`, html`Add a factory in <code>src/agent/registry.ts</code> via <code>registerAgentFactory({ kind, create })</code>.`],
  [html`Select it`, html`Set <code>agent.kind: &lt;your-agent&gt;</code> in <code>WORKFLOW.md</code>. Read your own config from <code>opts.config</code>.`],
  [html`Test`, html`Follow <code>test/orchestrator.test.ts</code> (<code>makeFakeFactory</code>) — register a fake backend and assert dispatch → result → done.`],
];

export function integratePage() {
  const m = (store.state && store.state.meta) || {};
  const agents = m.agent_kinds || [m.agent_kind];
  const trackers = m.tracker_kinds || [m.tracker_kind];
  const defAgent = m.default_agent || m.agent_kind;
  // Uninstalled backends stay selectable — a CLI can be installed a minute from
  // now, and blocking the choice would strand an operator who is mid-setup.
  const missing = new Set(((m.agents && m.agents.agents) || []).filter((a) => !a.usable).map((a) => a.kind));
  const defSelect = agents.length > 1
    ? html`<select class="select" data-default-agent .value=${live(defAgent || "")}>
        ${agents.map((k) => html`<option value=${k} ?selected=${k === defAgent}>${k}${missing.has(k) ? " (not installed)" : ""}</option>`)}
      </select><span class="hint">Runs any task without its own agent set. Applies immediately.</span>`
    : html`<div>${chips(agents, defAgent)}</div><span class="hint">Register another backend to switch the default per task.</span>`;
  return html`${pageHead("Integrate your own agent", "")}
    <div class="page">
    <p class="page-lead">Symphony talks to any coding agent through one <code>AgentSession</code> interface. The orchestrator, tracker, workspace, and this console are backend-neutral — adding an agent means writing one class and registering it.</p>
    ${agentNotice(m)}
    <div class="detail-grid"><div>
      <div class="log-head">Add a backend in 5 steps</div>
      <div class="isteps">${STEPS.map((s, i) => html`<div class="istep"><div class="inum">${i + 1}</div><div><div class="ititle">${s[0]}</div><div class="idesc">${s[1]}</div></div></div>`)}</div>
      <p class="sub" style="margin-top:18px">Full walkthrough, the event vocabulary, and the tracker-adapter contract are in <code>INTEGRATION.md</code> in the repo.</p>
    </div><div>
      <div class="aside-card"><div class="field" style="margin:0"><label>Default agent</label>${defSelect}</div></div>
      <div class="aside-card"><div class="log-head" style="margin-top:0">Agents on this machine</div>${agentStatusList(m)}
      <div class="log-head">Registered trackers</div><div>${chips(trackers, m.tracker_kind)}</div></div>
      <div class="aside-card"><div class="log-head" style="margin-top:0">Models ${defAgent || "the backend"} names</div>${modelStatusList(m)}</div>
    </div></div></div>`;
}
