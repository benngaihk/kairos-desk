import test from "node:test";
import assert from "node:assert/strict";
import { decide, resolution, settle, scoreboard, noulProbability } from "../lib/ledger.mjs";
import { runJev, pickCandidates, buildState } from "../scripts/jev-run.mjs";
import { marketRow } from "../lib/pretrade.mjs";

const thr = { buy_yes_if_p_above: 0.671, buy_no_if_p_below: 0.639 };

test("decide trades only outside the no-trade band", () => {
  assert.deepEqual(decide(0.72, thr), { side: "YES", cost: 0.671, edge: 0.049 });
  assert.equal(decide(0.6, thr).side, "NO");
  assert.equal(decide(0.6, thr).cost, 0.361);
  assert.equal(decide(0.65, thr).side, null);
  assert.equal(decide(null, thr).side, null);
});

test("resolution reads Gamma outcomePrices only when closed", () => {
  assert.equal(resolution({ closed: true, outcomePrices: '["1","0"]' }), true);
  assert.equal(resolution({ closed: true, outcomePrices: ["0", "1"] }), false);
  assert.equal(resolution({ closed: false, outcomePrices: '["1","0"]' }), null);
  assert.equal(resolution({ closed: true, outcomePrices: '["0.5","0.5"]' }), null);
});

test("settle pays STAKE/cost shares and is idempotent", () => {
  const e = { id: "1", side: "YES", cost: 0.5, p_model: 0.7, mid: 0.45, outcome: null };
  const s = settle(e, true, "t");
  assert.equal(s.pnl_usd, 100);
  assert.equal(settle(s, false, "t2"), s);
  assert.equal(settle({ ...e, side: "NO" }, true, "t").pnl_usd, -100);
});

test("scoreboard compares model and market Brier on resolved forecasts", () => {
  const b = scoreboard([
    { p_model: 0.9, mid: 0.6, outcome: 1, side: "YES", pnl_usd: 50 },
    { p_model: 0.2, mid: 0.3, outcome: 0 },
    { p_model: 0.5, mid: 0.5, outcome: null, side: "NO" },
  ]);
  assert.equal(b.resolved, 2);
  assert.equal(b.brier_model, (0.01 + 0.04) / 2);
  assert.equal(b.brier_market, (0.16 + 0.09) / 2);
  assert.equal(b.trades, 2);
  assert.equal(b.open_trades, 1);
  assert.equal(b.pnl_usd, 50);
});

test("noulProbability tolerates several response shapes", () => {
  assert.equal(noulProbability({ answers: { q: { probability: 0.3 } } }, "q"), 0.3);
  assert.equal(noulProbability({ q: { value: 0.4 } }, "q"), 0.4);
  assert.equal(noulProbability({ results: { q: 0.5 } }, "q"), 0.5);
  assert.equal(noulProbability({}, "q"), null);
});

const now = Date.parse("2026-09-24T12:00:00Z");
const row = (id, end, vol) =>
  marketRow({
    event: { slug: "e" + id, title: "E" + id },
    market: { id, slug: "m" + id, question: `Will ${id} happen?`, clobTokenIds: `["y${id}","n${id}"]`, endDate: end, volume24hr: vol, feesEnabled: true, feeSchedule: { rate: 0.05 } },
    yesRaw: { bids: [{ price: "0.49", size: "5000" }], asks: [{ price: "0.50", size: "5000" }] },
    noRaw: null,
    now,
  });

test("candidates: liquid, ending within horizon, not already forecast, busiest first", () => {
  const ms = [row("a", "2026-10-10T00:00:00Z", 10), row("b", "2026-10-10T00:00:00Z", 99), row("c", "2027-06-01T00:00:00Z", 500), row("d", "2026-09-24T14:00:00Z", 900)];
  const c = pickCandidates(ms, [{ id: "a" }], now, { max: 10, horizonDays: 45 });
  assert.deepEqual(c.map((m) => m.id), ["b"]);
});

test("runJev: blind state, paper trade, settlement on a later run", async () => {
  const ms = [row("b", "2026-10-10T00:00:00Z", 99)];
  const bodies = [];
  let closed = false;
  const fetchImpl = async (url, init) => {
    if (url.startsWith("https://api.typesafe.ai")) {
      bodies.push(JSON.parse(init.body));
      return { ok: true, status: 200, text: async () => JSON.stringify({ answers: { resolves_yes: { probability: 0.8 } } }) };
    }
    const m = { id: "b", description: "Resolves YES if b happens.", closed, outcomePrices: closed ? '["1","0"]' : '["0.5","0.5"]' };
    return { ok: true, status: 200, json: async () => [m] };
  };
  const logs = [];
  const r1 = await runJev({ fetchImpl, now, markets: ms, ledger: { entries: [] }, apiKey: "k", log: (...a) => logs.push(a.join(" ")) });
  assert.equal(r1.stats.added, 1);
  const st = bodies[0].state;
  assert.match(st, /Resolves YES if b happens/);
  assert.doesNotMatch(st, /0\.49|0\.50|0\.495|price/i, "the model must not see the market price");
  assert.equal(bodies[0].questions.resolves_yes.type, "noul");
  const e = r1.ledger.entries[0];
  assert.equal(e.side, "YES");
  assert.equal(r1.pub.open_trades.length, 1);

  closed = true;
  const r2 = await runJev({ fetchImpl, now: now + 864e5, markets: ms, ledger: r1.ledger, apiKey: "k", log: () => {} });
  assert.equal(r2.stats.settled, 1);
  assert.equal(r2.stats.added, 0, "one forecast per market");
  assert.ok(r2.pub.scoreboard.pnl_usd > 0);
  assert.equal(r2.pub.scoreboard.resolved, 1);
});

test("buildState includes date, rules and outcome context", () => {
  const s = buildState({ question: "Q?", outcome: "Hold", event_title: "Fed", end_date: "2026-10-28" }, "Rules text", now);
  assert.match(s, /2026-09-24/);
  assert.match(s, /"Hold" in the multi-outcome event "Fed"/);
  assert.match(s, /Rules text/);
});
