/**
 * Read-time cost estimation over token counts (extension, SPEC Appendix B).
 *
 * Pure: this module imports nothing and holds no state, so both the live snapshot
 * path and (later) a persisted run-history read path can share it.
 *
 * Two rules worth stating, because both look like bugs from the outside:
 *
 * - **Cost is never stored.** It is derived from the *current* `agent.pricing`
 *   config on every read. Editing prices in WORKFLOW.md therefore reprices every
 *   accumulated token, including runs that executed under the old rates. That is
 *   intended — a stored figure silently rots the moment a vendor changes a price.
 * - **It is an estimate, and it over-estimates.** Backends report one input-token
 *   figure with cached-input tokens folded in (codex: `thread/tokenUsage/updated`),
 *   and vendors bill cache reads at a discount. Cache tiers are deliberately not
 *   modelled; hence `estimated_cost`.
 */

/** Rates for one agent kind. Both rates are per million tokens. */
export interface AgentPricing {
  input_per_mtok: number;
  output_per_mtok: number;
  currency: string;
}

/**
 * Resolved `agent.pricing`: an optional flat entry applying to every kind, plus
 * per-kind overrides. Kind keys are normalized (trimmed, lowercased) at config
 * build time so lookups here are plain property reads.
 */
export interface PricingTable {
  default: AgentPricing | null;
  by_kind: Record<string, AgentPricing>;
}

export interface TokenCounts {
  input_tokens: number;
  output_tokens: number;
}

export interface EstimatedCost {
  amount: number;
  currency: string;
}

/**
 * A cost summed across agent kinds. `unpriced` names the kinds that spent tokens
 * with no rates configured; when it is non-empty the amount is a lower bound.
 */
export interface AggregateCost {
  amount: number;
  currency: string;
  partial: boolean;
  unpriced: string[];
}

/** Pricing not configured: every cost derived from this is null. */
export const EMPTY_PRICING: PricingTable = { default: null, by_kind: {} };

/** Costs are reported to 4 decimal places — a single agent turn can be sub-cent. */
function round4(n: number): number {
  return Math.round(n * 1e4) / 1e4;
}

/** A backend that reports garbage must not put NaN in the snapshot JSON. */
function safeCount(n: number): number {
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Rates for an agent kind: its own entry, else the flat default, else none. */
export function pricingFor(table: PricingTable, kind: string | null): AgentPricing | null {
  if (kind) {
    const own = table.by_kind[kind.trim().toLowerCase()];
    if (own) return own;
  }
  return table.default;
}

/** Unrounded cost in the pricing's currency; used to sum before rounding once. */
function rawCost(tokens: TokenCounts, pricing: AgentPricing): number {
  return (
    (safeCount(tokens.input_tokens) / 1e6) * pricing.input_per_mtok +
    (safeCount(tokens.output_tokens) / 1e6) * pricing.output_per_mtok
  );
}

/**
 * Cost of one run's tokens. Null pricing yields null, never 0 — "not priced" and
 * "priced, spent nothing" are different states and the console renders them
 * differently.
 */
export function costOf(tokens: TokenCounts, pricing: AgentPricing | null): EstimatedCost | null {
  if (!pricing) return null;
  return { amount: round4(rawCost(tokens, pricing)), currency: pricing.currency };
}

export function costForKind(table: PricingTable, kind: string | null, tokens: TokenCounts): EstimatedCost | null {
  return costOf(tokens, pricingFor(table, kind));
}

/**
 * Cost of tokens spent across several agent kinds, each priced with its own rates.
 * A project can mix backends (per-issue `agent` override), so multiplying a flat
 * project total by one kind's price would be silently wrong.
 *
 * Subtotals are summed unrounded and rounded once, so the aggregate always equals
 * the exact sum rather than drifting with the number of kinds.
 */
export function aggregateCost(table: PricingTable, byKind: Record<string, TokenCounts>): AggregateCost | null {
  let amount = 0;
  let currency: string | null = null;
  let priced = 0;
  const unpriced: string[] = [];
  for (const [kind, tokens] of Object.entries(byKind)) {
    const pricing = pricingFor(table, kind);
    if (!pricing) {
      if (safeCount(tokens.input_tokens) > 0 || safeCount(tokens.output_tokens) > 0) unpriced.push(kind);
      continue;
    }
    // Mixed currencies cannot be summed. buildConfig rejects them, but this module
    // is shared, so refuse rather than report a meaningless total.
    if (currency !== null && currency !== pricing.currency) return null;
    currency = pricing.currency;
    amount += rawCost(tokens, pricing);
    priced += 1;
  }
  // Nothing priced spent anything yet: report zero in the configured currency so a
  // freshly started board shows a real figure instead of a dash. Config guarantees
  // every entry shares one currency, so any of them will do.
  if (priced === 0) {
    const any = table.default ?? Object.values(table.by_kind)[0];
    if (!any) return null;
    return { amount: 0, currency: any.currency, partial: unpriced.length > 0, unpriced };
  }
  return { amount: round4(amount), currency: currency!, partial: unpriced.length > 0, unpriced };
}
