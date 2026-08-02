/**
 * Per-task model views (extension, SPEC Appendix B.7): the form picker, the board
 * badge and mix tile, and the Integrate-page listing.
 *
 * The through-line everywhere below: Symphony never validates a model id. The list is
 * a convenience read back from the backend, so any id may be typed, a saved model the
 * backend no longer lists stays selected, and no copy here claims a listed model is
 * "available" — a listing says what the CLI enumerated, not that credentials work.
 */
import { html, nothing } from "../vendor/lit-html/lit-html.js";
import { live } from "../vendor/lit-html/directives/live.js";
import { store } from "../store.js";
import { ensureModels } from "../api.js";
import { ago } from "../format.js";

/** Sentinel option value that switches the field to free text. Never submitted. */
export const CUSTOM_MODEL = "__custom__";

/** The backend whose models the open form should list: its own choice, else the default. */
export function formModelKind(m) {
  return store.formAgent || m.default_agent || m.agent_kind || null;
}

/**
 * The model an issue is pinned to. Board rows carry it; the detail payload may not,
 * so fall back to the row the board already loaded (same trick as detailTitle).
 */
export function issueModelOf(d) {
  if (d && "model" in d) return d.model;
  const rows = (store.board && store.board.issues) || [];
  const hit = rows.find((i) => i.identifier === (d && d.issue_identifier));
  return hit ? hit.model || null : null;
}

/** Compact marker for a pinned model; nothing at all when the run takes the backend default. */
export function modelBadge(model) {
  if (!model) return nothing;
  return html`<span class="model-tag" title=${"Model " + model + " — sent to the backend exactly as written"}>${model}</span>`;
}

/**
 * Model picker for the issue forms. A `<select>` of what the backend listed, with the
 * backend default first and an "Other model…" escape hatch that turns the control into
 * a plain text box — nothing an operator types is ever refused.
 */
export function modelField(prefix, kind, current) {
  ensureModels(kind); // idempotent; resolves into the store and repaints when it lands
  const entry = kind ? store.models[kind] || null : null;
  const models = (entry && entry.models) || [];
  const saved = current || "";
  // What the control holds right now: the operator's pick if they made one, otherwise
  // what the issue already carries. Held in the store so a listing that arrives late
  // cannot renumber the options out from under the selection.
  const picked = store.modelDraft != null ? store.modelDraft : saved;
  const control = store.modelCustom
    ? html`<input class="input" id="${prefix}-model" name="model" autocomplete="off" data-model-text
        placeholder="model id, spelled the way the backend spells it" .defaultValue=${picked}>`
    : modelSelect(prefix, kind, models, picked);
  return html`<div class="field"><label for="${prefix}-model">Model</label>
    ${control}
    ${modelHint(kind, entry, models, picked)}</div>`;
}

function optionLabel(x) {
  const base = x.label && x.label !== x.id ? x.label + " (" + x.id + ")" : x.id;
  return x.default ? base + " · default" : base;
}

/**
 * `?selected` picks the right option on first paint; `live(.value)` re-asserts it when
 * a listing lands mid-form and rebuilds the options — same pairing as the board's agent
 * select. Without it, removing the option the browser had selected silently snaps the
 * field back to Default, which reads as Symphony clearing a model it never touched.
 */
function modelSelect(prefix, kind, models, picked) {
  const def = models.find((x) => x.default);
  const listed = models.some((x) => x.id === picked);
  return html`<select class="select" id="${prefix}-model" name="model" data-model-select .value=${live(picked)}>
    <option value="" ?selected=${!picked}>${def ? "Default (" + def.id + ")" : "Default — whatever " + (kind || "the backend") + " picks"}</option>
    ${models.map((x) => html`<option value=${x.id} ?selected=${x.id === picked}>${optionLabel(x)}</option>`)}
    ${picked && !listed
      ? html`<option value=${picked} ?selected=${true}>${picked} — not in the current list</option>`
      : nothing}
    <option value=${CUSTOM_MODEL}>Other model…</option>
  </select>`;
}

/**
 * Say honestly which of the four states the listing is in. An empty list is never
 * rendered as an authoritative "this backend has no models": `stale` means no probe has
 * finished, and a probe can also fail outright.
 */
function modelHint(kind, entry, models, picked) {
  const unlisted = picked && !models.some((x) => x.id === picked);
  let line;
  if (!kind) line = html`No backend resolved yet, so there is nothing to ask for a model list.`;
  else if (!entry || entry.loading) line = html`Asking <b>${kind}</b> which models it can name…`;
  else if (entry.error) line = html`Could not read a model list from <b>${kind}</b> — ${entry.error}. Type an id to use one anyway.`;
  else if (entry.stale) line = html`No listing yet: discovery has not completed a probe of <b>${kind}</b>. This is not "no models" — type an id if you know one.`;
  else if (!models.length) line = html`<b>${kind}</b> returned nothing. Either it does not report a model list or the probe failed — type an id to use one anyway.`;
  else line = html`${models.length} model(s) named by <b>${kind}</b>${entry.fetched_at ? html`, read ${ago(entry.fetched_at)}` : nothing}.
    The id is passed through unchecked; <b>${kind}</b> decides whether it can run it.`;
  return html`<span class="hint">${line}
    ${kind ? html` <button type="button" class="btn tiny" data-refresh-models=${kind} title=${"Ask " + kind + " for its model list again"}>Refresh</button>` : nothing}
    ${store.modelCustom ? html` <button type="button" class="btn tiny" data-model-list>Back to the list</button>` : nothing}
    ${unlisted && !store.modelCustom
      ? html`<br><span class="warn-text">${picked} is not in the current list. It stays selected and is sent unchanged.</span>`
      : nothing}</span>`;
}

/** Board tile: how the loaded issues split across pinned models and the backend default. */
export function modelMixTile() {
  const issues = (store.board && store.board.issues) || [];
  if (!issues.length) return nothing;
  const counts = new Map();
  let onDefault = 0;
  for (const i of issues) {
    if (i.model) counts.set(i.model, (counts.get(i.model) || 0) + 1);
    else onDefault += 1;
  }
  const rows = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const title = rows.length
    ? rows.map((r) => r[0] + " ×" + r[1]).join(" · ") + " · backend default ×" + onDefault
    : "No issue pins a model — every run takes whatever its backend defaults to";
  return html`<div class="metric model-mix" title=${title}>
    <div class="k">Models in use</div>
    <div class="v">${rows.length}<span class="u">pinned</span></div>
    <div class="mix">
      ${rows.slice(0, 3).map((r) => html`<div class="mix-row"><span class="mix-name mono">${r[0]}</span><span class="mix-n">${r[1]}</span></div>`)}
      ${rows.length > 3 ? html`<div class="mix-row"><span class="mix-name sub">+${rows.length - 3} more</span></div>` : nothing}
      <div class="mix-row"><span class="mix-name sub">backend default</span><span class="mix-n">${onDefault}</span></div>
    </div></div>`;
}

/** Integrate-page listing for the project's effective backend, with the same re-check affordance. */
export function modelStatusList(m) {
  const kind = m.default_agent || m.agent_kind || null;
  if (!kind) return html`<p class="sub">No agent backend is resolved, so there is nothing to list.</p>`;
  ensureModels(kind);
  const entry = store.models[kind] || null;
  const models = (entry && entry.models) || [];
  let body;
  if (!entry || entry.loading) body = html`<p class="sub">Asking <b>${kind}</b> which models it can name…</p>`;
  else if (entry.error) body = html`<p class="warn-text">Could not read a model list from ${kind} — ${entry.error}</p>`;
  else if (entry.stale) body = html`<p class="sub">No probe of ${kind} has completed yet. An empty list here means unknown, not none.</p>`;
  else if (!models.length) body = html`<p class="sub">${kind} named no models. It may not report a list, or the probe may have failed — a model id can still be typed on any issue.</p>`;
  else body = html`<div class="model-list">${models.map((x) => html`<div class="model-row">
      <span class="mono">${x.id}</span>
      ${x.default ? html`<span class="badge active"><span class="bd"></span>default</span>` : nothing}
      ${x.label && x.label !== x.id ? html`<span class="sub">${x.label}</span>` : nothing}
    </div>`)}</div>`;
  return html`${body}
    <div class="sub" style="margin-top:10px">
      ${entry && entry.fetched_at ? html`Listed ${ago(entry.fetched_at)}` : "Not listed yet"}
      · <button class="btn tiny" data-refresh-models=${kind}>Re-check</button>
    </div>
    <p class="sub" style="margin-top:8px">Symphony never validates a model id — whatever an issue names is handed to ${kind} verbatim.</p>`;
}
