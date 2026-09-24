import test from "node:test";
import assert from "node:assert/strict";
import { feeModel, feePerShare, normBook, noAsks, walkAsks, thresholds, auditSet, marketRow, isPlaceholder } from "../lib/pretrade.mjs";
import { buildFeed, diff } from "../scripts/build-feed.mjs";

const close = (a, b, eps = 1e-4) => assert.ok(Math.abs(a - b) <= eps, `${a} !≈ ${b}`);
const fee5 = { rate: 0.05, exponent: 1, src: "t" };

test("fee matches the desk receipt (Newsom ask 0.137 @ 4%)", () => {
  close(feePerShare(0.137, { rate: 0.04, exponent: 1 }), 0.004729, 1e-6);
});

test("feeModel never assumes 0 when the rate is missing", () => {
  assert.equal(feeModel({ feesEnabled: true }).rate, null);
  assert.equal(feeModel({}).rate, null);
  assert.equal(feeModel({ feesEnabled: false }).rate, 0);
  assert.equal(feeModel({ feesEnabled: true, feeSchedule: { rate: 0.05 } }).rate, 0.05);
  assert.equal(feeModel({ feesEnabled: true, feeSchedule: { rate: "0.03", exponent: 2 } }).exponent, 2);
  assert.equal(feePerShare(0.5, { rate: null }), null);
});

test("normBook sorts CLOB ladders best-first regardless of API order", () => {
  const b = normBook({ bids: [{ price: "0.60", size: "5" }, { price: "0.65", size: "10" }], asks: [{ price: "0.70", size: "3" }, { price: "0.66", size: "0" }, { price: "0.67", size: "4" }] });
  assert.deepEqual(b.bids.map((l) => l.price), [0.65, 0.6]);
  assert.deepEqual(b.asks.map((l) => l.price), [0.67, 0.7]);
});

test("NO asks: prefer the NO book, else mirror YES bids, never union", () => {
  const yes = normBook({ bids: [{ price: "0.65", size: "100" }], asks: [] });
  assert.equal(noAsks(yes, normBook({ asks: [{ price: "0.36", size: "9" }] })).src, "no_token_book");
  const m = noAsks(yes, normBook(null));
  assert.equal(m.src, "mirrored_yes_bids");
  close(m.asks[0].price, 0.35);
});

test("Oct FOMC +25bp: buy YES needs p > ask + fee", () => {
  // desk.json 2026-09-24: hike25 bid 0.65 ask 0.66, feeSchedule.rate 0.05
  const yes = normBook({ bids: [{ price: "0.65", size: "1000" }], asks: [{ price: "0.66", size: "1000" }] });
  const t = thresholds(yes.asks, noAsks(yes, normBook(null)).asks, fee5);
  close(t.top.buy_yes_if_p_above, 0.66 + 0.05 * 0.66 * 0.34);
  close(t.top.buy_no_if_p_below, 1 - (0.35 + 0.05 * 0.35 * 0.65));
  assert.ok(t.band_width_top > 0.01 && t.band_width_top < 0.05);
  assert.equal(t.usd100.buy_yes_if_p_above, t.top.buy_yes_if_p_above);
});

test("walkAsks crosses levels and reports unfillable sizes as not filled", () => {
  const asks = [{ price: 0.5, size: 100 }, { price: 0.6, size: 100 }];
  const w = walkAsks(asks, { rate: 0, exponent: 1 }, { usd: 80 });
  assert.equal(w.filled, true);
  close(w.shares, 100 + 30 / 0.6, 0.01); // 100 @ 0.50 ($50) then 50 @ 0.60 ($30)
  close(w.avg_price, 80 / w.shares);
  assert.equal(walkAsks(asks, fee5, { usd: 1000 }).filled, false);
  const t = thresholds(asks, asks, fee5);
  assert.equal(t.usd1000.buy_yes_if_p_above, null);
});

const leg = (id, title, ask, extra = {}) => ({
  market: { id, groupItemTitle: title, active: true, closed: false, acceptingOrders: true, enableOrderBook: true, ...extra },
  yesBook: normBook({ bids: ask ? [{ price: String(Math.max(0.001, ask - 0.01)), size: "500" }] : [], asks: ask ? [{ price: String(ask), size: "500" }] : [] }),
  fee: fee5,
});

test("NegRisk set with an untradeable placeholder is INCOMPLETE, not an edge", () => {
  const s = auditSet({ id: 1, slug: "dem-nom", title: "Dem nominee" }, [
    leg(1, "Gavin Newsom", 0.137),
    leg(2, "AOC", 0.183),
    leg(3, "Josh Shapiro", 0.062),
    leg(4, "Other", null, { acceptingOrders: false, negRiskOther: true }),
  ]);
  assert.equal(s.verdict, "INCOMPLETE");
  assert.equal(s.complete, false);
  assert.equal(s.missing[0].placeholder, true);
  assert.ok(s.buy_set_net < 1); // looks like an edge; the verdict says why it is not
});

test("complete Fed-style set over $1 after fees is NO_EDGE", () => {
  const s = auditSet({ id: 2, slug: "fed", title: "Fed" }, [leg(1, "Hold", 0.34), leg(2, "+25", 0.66), leg(3, "+50", 0.011), leg(4, "-25", 0.006), leg(5, "-50", 0.003)]);
  assert.equal(s.verdict, "NO_EDGE");
  close(s.buy_set_gross, 1.02);
  assert.ok(s.buy_set_net > 1.04);
});

test("sub-$1 set that only holds at the best asks is TOP_OF_BOOK_ONLY (BoE Nov case)", () => {
  // Top of book sums under $1, but one leg has 5 shares and the next level is far higher.
  const L = (id, levels) => ({
    market: { id, groupItemTitle: String(id), active: true, closed: false, acceptingOrders: true, enableOrderBook: true },
    yesBook: normBook({ bids: [], asks: levels.map(([p, sz]) => ({ price: String(p), size: String(sz) })) }),
    fee: { rate: 0, exponent: 1 },
  });
  const s = auditSet({ id: 4, slug: "boe", title: "BoE" }, [L(1, [[0.3, 500]]), L(2, [[0.3, 500]]), L(3, [[0.381, 5], [0.45, 500]])]);
  assert.equal(s.verdict, "TOP_OF_BOOK_ONLY");
  assert.ok(s.buy_set_net < 1);
  assert.ok(s.buy_set_net_100sh > 1);
  assert.match(s.reason, /at most \$0\.10\b/);
});

test("complete set under $1 after fees is only a CANDIDATE", () => {
  const s = auditSet({ id: 3, slug: "x", title: "x" }, [leg(1, "A", 0.3), leg(2, "B", 0.3), leg(3, "C", 0.3)]);
  assert.equal(s.verdict, "CANDIDATE");
  assert.match(s.reason, /Unverified/);
});

test("placeholder detection", () => {
  assert.equal(isPlaceholder({ groupItemTitle: "Person C" }), true);
  assert.equal(isPlaceholder({ groupItemTitle: "Other" }), true);
  assert.equal(isPlaceholder({ groupItemTitle: "Pete Buttigieg" }), false);
  assert.equal(isPlaceholder({ negRiskOther: true, groupItemTitle: "Anyone else" }), true);
});

test("marketRow flags fees, thin books and past end dates", () => {
  const now = Date.parse("2026-09-24T00:00:00Z");
  const r = marketRow({
    event: { slug: "e", title: "E" },
    market: { id: 9, slug: "m", question: "Q?", clobTokenIds: '["y","n"]', feesEnabled: true, feeSchedule: { rate: 0.04 }, endDate: "2026-09-20T00:00:00Z" },
    yesRaw: { bids: [{ price: "0.40", size: "10" }], asks: [{ price: "0.50", size: "10" }] },
    noRaw: null,
    now,
  });
  assert.deepEqual(r.flags.sort(), ["FEES_ON", "PAST_END", "THIN", "WIDE_SPREAD"].sort());
  assert.equal(r.yes_token, "y");
  close(r.mid, 0.45);
});

test("buildFeed end-to-end against mocked Gamma + CLOB", async () => {
  const events = [
    {
      id: "e1",
      slug: "fed-oct",
      title: "Fed Oct",
      negRisk: true,
      markets: [
        { id: "a", slug: "a", question: "Hold?", groupItemTitle: "Hold", clobTokenIds: '["ya","na"]', negRisk: true, feesEnabled: true, feeSchedule: { rate: 0.05 }, endDate: "2026-10-28T00:00:00Z" },
        { id: "b", slug: "b", question: "+25?", groupItemTitle: "+25", clobTokenIds: '["yb","nb"]', negRisk: true, feesEnabled: true, feeSchedule: { rate: 0.05 }, endDate: "2026-10-28T00:00:00Z" },
      ],
    },
    { id: "e2", slug: "btc", title: "BTC", markets: [{ id: "c", slug: "c", question: "BTC 100k?", clobTokenIds: '["yc","nc"]', feesEnabled: false, endDate: "2026-09-30T00:00:00Z" }] },
  ];
  const book = (id, bid, ask) => ({ asset_id: id, bids: [{ price: String(bid), size: "1000" }], asks: [{ price: String(ask), size: "1000" }] });
  const books = { ya: book("ya", 0.33, 0.34), yb: book("yb", 0.65, 0.66), yc: book("yc", 0.1, 0.11) };
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(url);
    let body;
    if (url.includes("/events")) body = new URL(url).searchParams.get("offset") === "0" ? events : [];
    else if (url.endsWith("/books")) body = JSON.parse(init.body).map((x) => books[x.token_id]).filter(Boolean);
    return { ok: true, status: 200, json: async () => body };
  };
  const f = await buildFeed({ fetchImpl, now: Date.parse("2026-09-24T00:00:00Z"), maxEvents: 100 });
  assert.equal(f.markets.n, 3);
  assert.equal(f.sets.n, 1);
  assert.equal(f.sets.sets[0].verdict, "NO_EDGE");
  const btc = f.markets.markets.find((m) => m.id === "c");
  assert.equal(btc.fee.rate, 0);
  assert.equal(btc.no_book_src, "mirrored_yes_bids");
  close(btc.thresholds.top.buy_yes_if_p_above, 0.11);
  close(btc.thresholds.top.buy_no_if_p_below, 0.1);
  assert.equal(f.index.coverage.markets, 3);
  assert.ok(f.index.how_to_use.length > 0);

  const wide = structuredClone(f.markets);
  Object.assign(wide.markets.find((m) => m.id === "c"), { mid: 0.5, spread: 0.9 });
  assert.equal(diff(wide, f.markets.markets, Date.now()).moves.length, 0, "moves on a wide book are noise");
  const moved = structuredClone(f.markets);
  moved.markets.find((m) => m.id === "c").mid = 0.2;
  const d = diff(moved, f.markets.markets, Date.now());
  assert.equal(d.moves.length, 1);
  close(d.moves[0].delta, 0.105 - 0.2);
});
