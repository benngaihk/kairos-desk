import test from "node:test";
import assert from "node:assert/strict";
import { buildProof, isLiquid, hurdle } from "../lib/proof.mjs";
import { marketRow } from "../lib/pretrade.mjs";

const now = Date.parse("2026-09-24T00:00:00Z");
const mk = (id, bid, ask, size, fee = { feesEnabled: true, feeSchedule: { rate: 0.05 } }) =>
  marketRow({
    event: { slug: "e" + id, title: "E" + id },
    market: { id, slug: "m" + id, question: `Q${id}?`, clobTokenIds: `["y${id}","n${id}"]`, endDate: "2027-01-01T00:00:00Z", volume24hr: 1000, ...fee },
    yesRaw: { bids: [{ price: String(bid), size: String(size) }], asks: [{ price: String(ask), size: String(size) }] },
    noRaw: null,
    now,
  });

test("hurdle = spread/2 + fee at the ask, measured from the mid", () => {
  const m = mk(1, 0.49, 0.51, 5000); // fee at 0.51 = 0.05*0.51*0.49 = 0.0125
  assert.ok(isLiquid(m));
  const h = hurdle(m);
  assert.ok(Math.abs(h - (0.01 + 0.05 * 0.49 * 0.51)) < 2e-4, String(h));
});

test("wide, thin and dust markets are not counted as liquid", () => {
  assert.equal(isLiquid(mk(2, 0.3, 0.4, 5000)), false); // 10c spread
  assert.equal(isLiquid(mk(3, 0.49, 0.5, 10)), false); // thin
  assert.equal(isLiquid(mk(4, 0.004, 0.005, 1e6)), false); // dust
});

test("buildProof: fake arbs, fee-heavy markets, cheapest list and appended history", () => {
  const markets = [mk(1, 0.49, 0.51, 5000), mk(5, 0.5, 0.505, 9000, { feesEnabled: false }), mk(6, 0.2, 0.26, 5000)];
  const sets = [
    { slug: "dem", title: "Dem", url: "u", buy_set_gross: 0.927, buy_set_net: 0.9604, verdict: "INCOMPLETE", n_missing: 75 },
    { slug: "boe", title: "BoE", url: "u", buy_set_gross: 0.981, buy_set_net: 0.9935, verdict: "TOP_OF_BOOK_ONLY", buy_set_min_top_shares: 5, buy_set_net_100sh: 1.0203 },
    { slug: "fed", title: "Fed", url: "u", buy_set_gross: 0.99, buy_set_net: 1.013, verdict: "NO_EDGE" },
    { slug: "fine", title: "Fine", url: "u", buy_set_gross: 1.02, buy_set_net: 1.04, verdict: "NO_EDGE" },
  ];
  const p = buildProof({ markets, sets, generated: "2026-09-24T00:00:00Z", prevHistory: [{ t: "old" }] });
  assert.equal(p.summary.liquid_markets, 2);
  assert.equal(p.summary.fake_arbs, 3);
  assert.deepEqual(p.fake_arbs.map((x) => x.slug), ["dem", "boe", "fed"]);
  assert.match(p.fake_arbs[0].why, /75 outcome/);
  assert.match(p.fake_arbs[2].why, /fees/);
  assert.equal(p.summary.fee_at_ask_over_1pp, 1);
  assert.equal(p.cheapest_to_trade[0].id, "5"); // no fee, half-cent spread
  assert.equal(p.history.length, 2);
  assert.equal(p.history[1].fake, 3);
});
