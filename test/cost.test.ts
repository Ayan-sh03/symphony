import { test } from "node:test";
import assert from "node:assert/strict";
import { EMPTY_PRICING, aggregateCost, costForKind, costOf, pricingFor } from "../src/history/cost.ts";
import type { PricingTable } from "../src/history/cost.ts";

const usd = (i: number, o: number) => ({ input_per_mtok: i, output_per_mtok: o, currency: "USD" });

test("cost is tokens per million times the rate", () => {
  const c = costOf({ input_tokens: 1_500_000, output_tokens: 500_000 }, usd(2.5, 10));
  assert.deepEqual(c, { amount: 8.75, currency: "USD" });
});

test("cost rounds to 4 decimal places", () => {
  // 1234 in @ 0.1/Mtok = 0.0001234 -> 0.0001
  assert.equal(costOf({ input_tokens: 1234, output_tokens: 0 }, usd(0.1, 0))!.amount, 0.0001);
  // 500 in @ 0.1/Mtok = 0.00005 -> rounds up to 0.0001
  assert.equal(costOf({ input_tokens: 500, output_tokens: 0 }, usd(0.1, 0))!.amount, 0.0001);
});

test("unset pricing yields null, not zero", () => {
  assert.equal(costOf({ input_tokens: 1_000_000, output_tokens: 1_000_000 }, null), null);
});

test("priced but nothing spent is zero, not null", () => {
  assert.deepEqual(costOf({ input_tokens: 0, output_tokens: 0 }, usd(2.5, 10)), { amount: 0, currency: "USD" });
});

test("non-finite or negative token counts are treated as zero", () => {
  const c = costOf({ input_tokens: Number.NaN, output_tokens: -5 }, usd(2.5, 10));
  assert.deepEqual(c, { amount: 0, currency: "USD" });
});

test("pricingFor: per-kind entry, flat fallback, then nothing", () => {
  const table: PricingTable = { default: usd(1, 2), by_kind: { codex: usd(3, 4) } };
  assert.equal(pricingFor(table, "codex")!.input_per_mtok, 3);
  assert.equal(pricingFor(table, "Codex")!.input_per_mtok, 3, "kind lookup is case-insensitive");
  assert.equal(pricingFor(table, "opencode")!.input_per_mtok, 1, "unknown kind falls back to the flat default");
  assert.equal(pricingFor(table, null)!.input_per_mtok, 1);
  assert.equal(pricingFor(EMPTY_PRICING, "codex"), null);
  assert.equal(pricingFor({ default: null, by_kind: { codex: usd(3, 4) } }, "opencode"), null);
});

test("costForKind prices a run with its own backend's rates", () => {
  const table: PricingTable = { default: usd(1, 1), by_kind: { opencode: usd(10, 10) } };
  const tokens = { input_tokens: 1_000_000, output_tokens: 0 };
  assert.equal(costForKind(table, "opencode", tokens)!.amount, 10);
  assert.equal(costForKind(table, "codex", tokens)!.amount, 1);
});

test("aggregateCost sums kinds priced differently, rounding only once", () => {
  const table: PricingTable = { default: null, by_kind: { codex: usd(0.1, 0), opencode: usd(0.1, 0) } };
  // Each kind alone is 0.00005 -> rounds to 0.0001; rounding per kind then summing
  // would give 0.0002. Summing first gives 0.0001.
  const agg = aggregateCost(table, {
    codex: { input_tokens: 500, output_tokens: 0 },
    opencode: { input_tokens: 500, output_tokens: 0 },
  })!;
  assert.equal(agg.amount, 0.0001);
  assert.equal(agg.partial, false);
  assert.deepEqual(agg.unpriced, []);

  const mixed = aggregateCost(table, {
    codex: { input_tokens: 2_000_000, output_tokens: 0 },
    opencode: { input_tokens: 3_000_000, output_tokens: 0 },
  })!;
  assert.equal(mixed.amount, 0.5);
});

test("aggregateCost uses each kind's own rate, not the default kind's", () => {
  const table: PricingTable = { default: null, by_kind: { codex: usd(2, 0), opencode: usd(20, 0) } };
  const agg = aggregateCost(table, {
    codex: { input_tokens: 1_000_000, output_tokens: 0 },
    opencode: { input_tokens: 1_000_000, output_tokens: 0 },
  })!;
  assert.equal(agg.amount, 22, "2M tokens priced at each kind's rate, not 2M x one rate");
});

test("aggregateCost reports partial coverage as a lower bound", () => {
  const table: PricingTable = { default: null, by_kind: { codex: usd(2, 0) } };
  const agg = aggregateCost(table, {
    codex: { input_tokens: 1_000_000, output_tokens: 0 },
    opencode: { input_tokens: 5_000_000, output_tokens: 0 },
  })!;
  assert.equal(agg.amount, 2, "only the priced kind contributes");
  assert.equal(agg.partial, true);
  assert.deepEqual(agg.unpriced, ["opencode"]);
});

test("aggregateCost is null when nothing is priced", () => {
  assert.equal(aggregateCost(EMPTY_PRICING, { codex: { input_tokens: 1_000_000, output_tokens: 0 } }), null);
  assert.equal(aggregateCost(EMPTY_PRICING, {}), null);
});

test("aggregateCost is zero in the configured currency before any tokens are spent", () => {
  assert.deepEqual(aggregateCost({ default: usd(2, 4), by_kind: {} }, {}), {
    amount: 0, currency: "USD", partial: false, unpriced: [],
  });
  assert.deepEqual(aggregateCost({ default: null, by_kind: { codex: usd(2, 4) } }, {}), {
    amount: 0, currency: "USD", partial: false, unpriced: [],
  });
});

test("aggregateCost refuses to sum mixed currencies", () => {
  const table: PricingTable = {
    default: null,
    by_kind: { codex: usd(2, 0), opencode: { input_per_mtok: 2, output_per_mtok: 0, currency: "EUR" } },
  };
  const agg = aggregateCost(table, {
    codex: { input_tokens: 1_000_000, output_tokens: 0 },
    opencode: { input_tokens: 1_000_000, output_tokens: 0 },
  });
  assert.equal(agg, null);
});
