/**
 * Per-task model views (extension, SPEC Appendix B.7): the form picker, the board
 * badge and mix tile, and the Integrate-page listing.
 *
 * The through-line everywhere below: Symphony never validates a model id. The list is
 * a convenience read back from the backend, so any id may be typed, a saved model the
 * backend no longer lists stays selected, and no copy here claims a listed model is
 * "available" — a listing says what the CLI enumerated, not that credentials work.
 *
 * The picker is a custom menu rather than a `<select>`, for the same two reasons the
 * project switcher is: a background poll must not be able to collapse it, and one
 * backend (opencode) names several hundred models, which a native dropdown cannot
 * filter. The submitted value lives in a hidden input so the forms stay uncontrolled.
 */
import { html, nothing } from "../vendor/lit-html/lit-html.js";
import { store, rerender } from "../store.js";
import { ensureModels } from "../api.js";
import { ago } from "../format.js";

/** Number of models past which the menu grows a filter box. */
const FILTER_AFTER = 8;

const CARET = html`<svg class="caret" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>`;
const TICK = html`<svg class="tick" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>`;

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
 * Model picker for the issue forms: a menu of what the backend listed, with the
 * backend default first and a "Type a model id" escape hatch — nothing an operator
 * enters is ever refused. The value rides in a hidden input named `model` (exactly
 * one element carries that name in either mode, so `form.model.value` stays simple).
 */
export function modelField(prefix, kind, current) {
  ensureModels(kind); // idempotent; resolves into the store and repaints when it lands
  const entry = kind ? store.models[kind] || null : null;
  const models = (entry && entry.models) || [];
  // What the control holds right now: the operator's pick if they made one, otherwise
  // what the issue already carries. Held in the store so a listing that arrives late
  // cannot renumber the options out from under the selection.
  const picked = store.modelDraft != null ? store.modelDraft : current || "";
  const unlisted = picked && !models.some((x) => x.id === picked);
  return html`<div class="field"><label for="${prefix}-model">Model</label>
    ${store.modelCustom
      ? html`<input class="input mono-in" id="${prefix}-model" name="model" autocomplete="off" data-model-text
          placeholder="model id, spelled the way the backend spells it" .defaultValue=${picked}>`
      : html`<div class="model-pick">
          <input type="hidden" name="model" .value=${picked}>
          ${trigger(prefix, kind, models, picked)}
          ${store.modelMenuOpen ? menu(kind, models, picked) : nothing}
        </div>`}
    ${foot(kind, entry, models, unlisted, picked)}</div>`;
}

/** Closed state: the pinned id in mono, or the backend's own default named in prose. */
function trigger(prefix, kind, models, picked) {
  const def = models.find((x) => x.default);
  const body = picked
    ? html`<span class="mid">${picked}</span>${picked && models.some((x) => x.id === picked && x.default) ? html`<span class="mini-badge">default</span>` : nothing}`
    : html`<span class="mdef">Default${def ? html` — <span class="mid">${def.id}</span>` : ` — whatever ${kind || "the backend"} picks`}</span>`;
  return html`<button class="model-btn" type="button" id="${prefix}-model" data-model-toggle
    aria-haspopup="menu" aria-expanded=${store.modelMenuOpen}>${body}${CARET}</button>`;
}

/** One option row: id in mono, the backend's own label beside it, tick when current. */
function option(x, picked) {
  return html`<button class="model-opt" type="button" role="menuitem" data-model-pick=${x.id} aria-current=${x.id === picked}>
    <span class="mid">${x.id}</span>
    ${x.default ? html`<span class="mini-badge">default</span>` : nothing}
    ${x.label && x.label !== x.id ? html`<span class="mlabel">${x.label}</span>` : nothing}
    ${TICK}
  </button>`;
}

/**
 * Open state. Filtering is client-side over the listing already in the store, and the
 * box is uncontrolled — lit never binds its value, so the 1s repaint tick cannot move
 * the caret out from under someone typing.
 */
function menu(kind, models, picked) {
  const q = (store.modelFilter || "").trim().toLowerCase();
  const shown = q
    ? models.filter((x) => x.id.toLowerCase().includes(q) || (x.label || "").toLowerCase().includes(q))
    : models;
  return html`<div class="model-menu" role="menu">
    <div class="model-cap">Models ${kind || "the backend"} names
      ${kind ? html`<button type="button" class="btn tiny" data-refresh-models=${kind}>Refresh</button>` : nothing}</div>
    ${models.length > FILTER_AFTER
      ? html`<input class="model-search" type="text" data-model-filter autocomplete="off"
          placeholder="Filter ${models.length} models…" @input=${onFilter}>`
      : nothing}
    <div class="model-opts">
      <button class="model-opt" type="button" role="menuitem" data-model-pick="" aria-current=${!picked}>
        <span class="mdef">Backend default</span>${TICK}
      </button>
      ${shown.map((x) => option(x, picked))}
      ${picked && !models.some((x) => x.id === picked)
        ? option({ id: picked, label: "not in the current list" }, picked)
        : nothing}
      ${models.length && !shown.length ? html`<div class="model-none">No listed model matches that.</div>` : nothing}
    </div>
    <button class="model-opt other" type="button" role="menuitem" data-model-custom>✎ Type a model id…</button>
    <div class="model-note">Passed to ${kind || "the backend"} verbatim — it decides whether it can run it.</div>
  </div>`;
}

function onFilter(e) {
  store.modelFilter = e.target.value;
  rerender();
}

/**
 * Say honestly which of the four states the listing is in. An empty list is never
 * rendered as an authoritative "this backend has no models": `stale` means no probe has
 * finished, and a probe can also fail outright.
 */
function foot(kind, entry, models, unlisted, picked) {
  let line;
  if (!kind) line = html`No backend resolved yet, so there is nothing to ask for a model list.`;
  else if (!entry || entry.loading) line = html`Asking <b>${kind}</b> which models it can name…`;
  else if (entry.error) line = html`Could not read a list from <b>${kind}</b> — ${entry.error}. Type an id to use one anyway.`;
  else if (entry.stale) line = html`No listing yet — that means unknown, not none. Type an id if you know one.`;
  else if (!models.length) line = html`<b>${kind}</b> named no models. Type an id to use one anyway.`;
  else line = html`${models.length} models named by <b>${kind}</b>${entry.fetched_at ? html`, read ${ago(entry.fetched_at)}` : nothing}`;
  // One span, not loose text: `.model-foot` is a flex row, and bare text nodes around
  // the <b> would each become their own flex item and inherit the 8px gap.
  return html`<div class="model-foot"><span>${line}</span>
    ${store.modelCustom
      ? html`<button type="button" class="btn tiny" data-model-list>Back to the list</button>`
      : kind && !store.modelMenuOpen && (!entry || !entry.loading)
        // The open menu carries its own Refresh, and this one would peek through the gap.
        ? html`<button type="button" class="btn tiny" data-refresh-models=${kind}>Refresh</button>` : nothing}
    ${unlisted && !store.modelCustom
      ? html`<span class="warn-text w-full">${picked} is not in the current list. It stays selected and is sent unchanged.</span>`
      : nothing}</div>`;
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
      <span class="mid">${x.id}</span>
      ${x.default ? html`<span class="mini-badge">default</span>` : nothing}
      ${x.label && x.label !== x.id ? html`<span class="mlabel">${x.label}</span>` : nothing}
    </div>`)}</div>`;
  return html`${body}
    <div class="model-foot" style="margin-top:10px">
      ${entry && entry.fetched_at ? html`Listed ${ago(entry.fetched_at)}` : "Not listed yet"}
      <button class="btn tiny" data-refresh-models=${kind}>Re-check</button>
    </div>
    <p class="sub" style="margin-top:8px">Symphony never validates a model id — whatever an issue names is handed to ${kind} verbatim.</p>`;
}
