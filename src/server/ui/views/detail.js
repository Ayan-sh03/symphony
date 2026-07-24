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

// Repository deliverable: branch/commit/files recorded when the run completed,
// plus the operator actions that move it forward (review → done, push).
function deliveryPanel(d) {
  const del = d.delivery;
  if (!del || !del.branch) return nothing;
  const m = (store.state && store.state.meta) || {};
  const shortSha = del.commit_sha ? del.commit_sha.slice(0, 7) : null;
  const rows = [
    ["Branch", html`${mono(del.branch)} <button class="btn sm" data-copy=${del.branch} data-copy-what="Branch" title="Copy the branch name">Copy</button>`],
    ["Commit", shortSha ? html`${mono(shortSha)} <button class="btn sm" data-copy=${del.commit_sha} data-copy-what="Commit SHA" title="Copy the full commit SHA">Copy</button>` : "—"],
    ["Base branch", del.base_branch ? mono(del.base_branch) : "—"],
    ["Delivered", ago(del.delivered_at)],
    ["Pushed", del.pushed_at ? ago(del.pushed_at) : "—"],
  ];
  if (del.tests) rows.push(["Tests", del.tests]);
  if (del.uncommitted && del.uncommitted.length) rows.push(["Uncommitted", html`<span class="warn-text">${del.uncommitted.length} path(s) left in the preserved workspace</span>`]);
  const inReview = m.review_state && String(d.state || "").toLowerCase() === String(m.review_state).toLowerCase();
  const canPush = m.delivery_mode && m.delivery_mode !== "branch" && !del.pushed_at;
  const files = del.files_changed || [];
  return html`<div class="aside-card">
    <div class="log-head" style="margin-top:0">Delivery ${del.needs_attention ? badge("needs attention", "warn") : badge("recorded", "ok")}</div>
    ${del.needs_attention ? html`<p class="warn-text">${del.attention_reason || "The workspace was preserved — inspect it before cleanup."}</p>` : nothing}
    <dl class="kv">${rows.map((r) => html`<dt>${r[0]}</dt><dd>${r[1]}</dd>`)}</dl>
    ${files.length ? html`<div class="log-head">Files changed <span class="count">${files.length}</span></div>
      <div class="files">${files.map((f) => html`<div class="file mono">${f}</div>`)}</div>` : nothing}
    ${del.summary ? html`<div class="log-head">Summary</div><p class="sub">${del.summary}</p>` : nothing}
    ${inReview || canPush ? html`<div class="dactions">
      ${inReview ? html`<button class="btn primary sm" data-state-id=${d.issue_id} data-state-to=${(m.terminal_states && m.terminal_states[0]) || "done"} title="Accept the delivered branch and close the issue">✓ Mark done</button>` : nothing}
      ${canPush ? html`<button class="btn sm" data-push-id=${d.issue_id} title="Push the branch to the origin remote">⇪ Push branch</button>` : nothing}
    </div>` : nothing}
  </div>`;
}

export function detailPage(d) {
  const run = d.running, ret = d.retry;
  const statusKind = d.status === "running" || d.status === "queued" ? "active"
    : d.status === "completed" || d.status === "delivered" ? "ok" : "warn";

  const rows = [["Issue id", mono(d.issue_id)]];
  const trackerState = run ? run.state : d.state;
  rows.push(["Tracker state", trackerState ? badge(trackerState, run ? "active" : "") : "—"]);
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
    <div><div class="aside-card"><dl class="kv">${rows.map((r) => html`<dt>${r[0]}</dt><dd>${r[1]}</dd>`)}</dl></div>${deliveryPanel(d)}</div></div></div>`;
}
