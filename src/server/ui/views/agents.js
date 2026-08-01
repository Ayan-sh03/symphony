/** Installed-agent discovery views (extension): the board banner and the Integrate list. */
import { html, nothing } from "../vendor/lit-html/lit-html.js";
import { store } from "../store.js";
import { hashFor } from "../router.js";
import { ago } from "../format.js";

/** Availability block from the snapshot, or null before the first probe lands. */
export function availabilityOf(m) {
  const a = m && m.agents;
  return a && Array.isArray(a.agents) && !a.stale ? a : null;
}

/** Board rows whose own agent choice points at a backend this host cannot run. */
function strandedIssues(av) {
  const missing = new Set(av.agents.filter((a) => !a.usable).map((a) => a.kind));
  const rows = (store.board && store.board.issues) || [];
  return rows.filter((i) => i.agent_override && missing.has(i.agent));
}

/**
 * The first-run answer, on the page the operator is already looking at: is there a
 * runnable agent, and which one will this project use. Silent when everything is
 * installed — a banner that is always on stops being read.
 */
export function agentNotice(m) {
  const av = availabilityOf(m);
  if (!av) return nothing;
  const link = html` <a href=${hashFor("integrate")}>Integrate page</a>`;
  if (av.blocked) {
    return html`<div class="notice err"><b>No agent will run.</b> ${av.reason} — fix the command in <code>WORKFLOW.md</code> or pick a default on the${link}.</div>`;
  }
  if (av.auto_default) {
    return html`<div class="notice warn"><b>Using ${av.auto_default}.</b> ${av.reason}</div>`;
  }
  const stranded = strandedIssues(av);
  if (stranded.length) {
    return html`<div class="notice warn"><b>${stranded.length} task(s) assigned to a missing backend.</b>
      ${stranded.map((i) => i.identifier).join(", ")} — each will stop with <code>agent_unavailable</code> unless reassigned.</div>`;
  }
  return nothing;
}

function statusBadges(a, av) {
  const out = [];
  if (a.usable) out.push(html`<span class="badge ok">installed</span>`);
  else out.push(html`<span class="badge warn">missing</span>`);
  if (a.kind === av.effective_default) out.push(html`<span class="badge active"><span class="bd"></span>selected</span>`);
  if (a.kind === av.runtime_override) out.push(html`<span class="badge">runtime override</span>`);
  if (a.kind === av.auto_default) out.push(html`<span class="badge">auto default</span>`);
  if (a.kind === av.configured_default) out.push(html`<span class="badge">WORKFLOW.md</span>`);
  return out;
}

/** Per-backend availability detail for the Integrate page. */
export function agentStatusList(m) {
  const av = m && m.agents;
  if (!av || !Array.isArray(av.agents) || !av.agents.length) {
    return html`<p class="sub">Discovery has not run yet.</p>`;
  }
  return html`<div class="agent-list">
      ${av.agents.map((a) => html`<div class="agent-row">
        <div class="agent-name">${a.kind} ${statusBadges(a, av)}</div>
        <div class="sub">${a.command ? html`<code>${a.command}</code>` : "no command configured"}${a.version ? html` · ${a.version}` : nothing}</div>
        ${a.usable ? html`<div class="sub mono-path">${a.path || ""}</div>` : html`<div class="warn-text">${a.reason || "not runnable"}</div>`}
      </div>`)}
    </div>
    <div class="sub" style="margin-top:10px">
      ${av.checked_at ? html`Checked ${ago(av.checked_at)}` : "Not checked yet"}
      · <button class="btn tiny" data-refresh-agents>Re-check</button>
    </div>`;
}
