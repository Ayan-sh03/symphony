/** Issue detail route: status facts, key/value panel, and the activity log.
 * One plain template — lit's diffing patches it in place on every poll, which is
 * what the old innerHTML console had to hand-approximate with patchDetail(). */
import { html, nothing } from "../vendor/lit-html/lit-html.js";
import { store } from "../store.js";
import { pageHead } from "./page.js";
import { ago, dur, until, nfmt, badge, eventKind, logKind, logLabel, shortTime } from "../format.js";

function fact(label, val) {
  return html`<span class="fact"><b>${label}</b>${val}</span>`;
}

const mono = (v) => html`<span class="mono">${v}</span>`;

function logView(events) {
  return html`<div class="log-head">Activity log <span class="count">${events.length}</span></div>
    ${events.length
      ? html`<div class="log">${events.slice().reverse().map((e) => html`<div class="log-row"><span class="t">${shortTime(e.at)}</span>
          <span class="ev"><span class="evname ${logKind(e.event)}">${logLabel(e.event)}</span>
          ${e.message ? html`<span class="evmsg">${e.message}</span>` : nothing}</span></div>`)}</div>`
      : html`<div class="log"><div class="log-empty">No agent activity recorded yet.</div></div>`}`;
}

// Look up a human title for an identifier from the loaded board, if any.
function detailTitle(identifier) {
  const issues = (store.board && store.board.issues) || [];
  const hit = issues.find((i) => i.identifier === identifier);
  return hit ? hit.title : null;
}

export function detailPage(d) {
  const run = d.running, ret = d.retry;
  const statusKind = d.status === "running" ? "active" : d.status === "completed" ? "ok" : d.status === "queued" ? "active" : "warn";

  const rows = [["Issue id", mono(d.issue_id)]];
  rows.push(["Tracker state", badge(run ? run.state : d.state, run ? "active" : "")]);
  rows.push(["Workspace", mono(d.workspace && d.workspace.path)]);
  if (run) {
    rows.push(["Session", mono(run.session_id || "—")]);
    rows.push(["Last event", run.last_event ? badge(run.last_event, eventKind(run.last_event)) : "—"]);
    rows.push(["Last update", ago(run.last_event_at)]);
    rows.push(["Tokens", mono(nfmt(run.tokens && run.tokens.input_tokens) + " in / " + nfmt(run.tokens && run.tokens.output_tokens) + " out")]);
    if (run.last_message) rows.push(["Message", run.last_message]);
  }
  if (ret) {
    rows.push(["Retry attempt", mono(ret.attempt)]);
    rows.push(["Due", until(ret.due_at)]);
    rows.push(["Reason", ret.error || "—"]);
  }
  if (d.last_error && !ret) rows.push(["Last error", d.last_error]);

  const title = detailTitle(d.issue_identifier);
  return html`${pageHead(title || d.issue_identifier, title ? d.issue_identifier : "")}
    <div class="page"><div class="facts">
      ${badge(d.status, statusKind)}
      ${d.agent ? fact("agent", mono(d.agent)) : nothing}
      ${run ? html`${fact("turns", mono(run.turn_count))}${fact("tokens", mono(nfmt(run.tokens && run.tokens.total_tokens)))}${fact("elapsed", mono(dur(run.started_at)))}` : d.ended_at ? fact("ended", ago(d.ended_at)) : nothing}
    </div>
    <div class="detail-grid"><div>${logView(d.recent_events || [])}</div>
    <div class="aside-card"><dl class="kv">${rows.map((r) => html`<dt>${r[0]}</dt><dd>${r[1]}</dd>`)}</dl></div></div></div>`;
}
