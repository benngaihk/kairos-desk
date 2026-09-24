// "Proof" metrics: what an agent that skips the pre-trade check gets wrong,
// measured on the current feed. Pure functions over markets.json / sets.json rows.
//
// The naive agent prices trades at the mid and ignores taker fees; a naive
// arbitrage bot buys any NegRisk set whose best asks sum to less than $1.

import { feePerShare } from "./pretrade.mjs";

const r4 = (x) => (x === null || x === undefined ? null : Math.round(x * 1e4) / 1e4);
const median = (a) => {
  const s = a.filter((x) => x !== null && x !== undefined && Number.isFinite(x)).sort((x, y) => x - y);
  return s.length ? s[Math.floor(s.length / 2)] : null;
};

/** A market whose mid means something: tight, non-dust, at least $100 resting near the best ask on both sides. */
export function isLiquid(m) {
  const t = m.thresholds?.top;
  return (
    m.mid !== null &&
    m.spread !== null &&
    m.spread <= 0.05 &&
    !m.flags.some((f) => f === "DUST" || f === "NO_BOOK" || f === "THIN" || f === "FEE_UNKNOWN") &&
    t &&
    t.buy_yes_if_p_above !== null &&
    t.buy_no_if_p_below !== null
  );
}

const title = (m) => (m.outcome && m.event_title ? `${m.event_title} — ${m.outcome}` : m.question);

/** How far from the mid a forecast must be before either side is +EV, at a given size key. */
export function hurdle(m, size = "top") {
  const t = m.thresholds?.[size];
  if (!t || t.buy_yes_if_p_above === null || t.buy_no_if_p_below === null || m.mid === null) return null;
  return Math.min(t.buy_yes_if_p_above - m.mid, m.mid - t.buy_no_if_p_below);
}

export function fakeArbReason(s) {
  if (s.verdict === "INCOMPLETE") return `${s.n_missing} outcome(s) cannot be bought; if one of them wins, every leg loses`;
  if (s.verdict === "TOP_OF_BOOK_ONLY") return `only ${s.buy_set_min_top_shares} shares at those prices; at 100 per leg it costs ${s.buy_set_net_100sh ?? "more than the book holds"}`;
  if (s.verdict === "NO_EDGE") return `taker fees push the cost to ${s.buy_set_net}`;
  return s.reason;
}

/** A set a naive bot would plausibly believe: at least two live legs and not an obviously settled event. */
export function isPlausibleFakeArb(s) {
  return s.buy_set_gross !== null && s.buy_set_gross < 1 && s.buy_set_gross >= 0.5 && s.n_live >= 2 && s.verdict !== "CANDIDATE";
}

export function buildProof({ markets, sets, generated, prevHistory = [] }) {
  const L = markets.filter(isLiquid);
  // Everything with a two-sided book that is not dust: what an agent picking a market at random faces.
  const B = markets.filter((m) => !m.flags.includes("DUST") && !m.flags.includes("NO_BOOK") && !m.flags.includes("FEE_UNKNOWN") && hurdle(m, "top") !== null);
  const illiquid = B.filter((m) => !isLiquid(m));
  const hurdles = L.map((m) => hurdle(m, "top"));
  const h1000 = L.map((m) => hurdle(m, "usd1000"));
  const share = (arr, f) => (arr.length ? r4(arr.filter(f).length / arr.length) : null);

  const feeHeavy = L.map((m) => ({ m, fee: feePerShare(m.thresholds.top.yes_ask, m.fee) ?? 0 }))
    .filter((x) => x.fee >= 0.01)
    .sort((a, b) => b.fee - a.fee);

  const degenerate = sets.filter((s) => s.buy_set_gross !== null && s.buy_set_gross < 1 && s.verdict !== "CANDIDATE" && !isPlausibleFakeArb(s));
  // Most convincing first: the closer to $1, the more a bot would trust it.
  const fakeArbs = sets
    .filter(isPlausibleFakeArb)
    .sort((a, b) => b.buy_set_gross - a.buy_set_gross)
    .map((s) => ({
      slug: s.slug,
      title: s.title,
      url: s.url,
      naive_cost: s.buy_set_gross,
      naive_claimed_profit: r4(1 - s.buy_set_gross),
      verdict: s.verdict,
      why: fakeArbReason(s),
    }));

  const cheapest = L.filter((m) => m.depth_usd_2c.yes >= 1000 && m.depth_usd_2c.no >= 1000)
    .sort((a, b) => a.thresholds.band_width_top - b.thresholds.band_width_top || (b.volume_24h || 0) - (a.volume_24h || 0))
    .slice(0, 15)
    .map((m) => ({
      id: m.id,
      title: title(m),
      url: m.url,
      mid: m.mid,
      buy_yes_if_p_above: m.thresholds.top.buy_yes_if_p_above,
      buy_no_if_p_below: m.thresholds.top.buy_no_if_p_below,
      band: m.thresholds.band_width_top,
      fee_rate: m.fee.rate,
      depth_usd_2c: m.depth_usd_2c,
    }));

  const summary = {
    generated_utc: generated,
    markets: markets.length,
    liquid_markets: L.length,
    markets_with_book: B.length,
    share_illiquid: B.length ? r4(illiquid.length / B.length) : null,
    median_hurdle_illiquid: r4(median(illiquid.map((m) => hurdle(m, "top")))),
    median_hurdle_top: r4(median(hurdles)),
    median_hurdle_usd1000: r4(median(h1000)),
    unfillable_usd1000: L.filter((m) => hurdle(m, "usd1000") === null).length,
    share_1pp_edge_untradeable: share(hurdles, (h) => h > 0.01),
    share_2pp_edge_untradeable: share(hurdles, (h) => h > 0.02),
    share_3pp_edge_untradeable: share(hurdles, (h) => h > 0.03),
    fee_at_ask_over_1pp: feeHeavy.length,
    fake_arbs: fakeArbs.length,
    degenerate_sub_dollar_sets: degenerate.length,
    fake_arbs_by_verdict: fakeArbs.reduce((o, x) => ((o[x.verdict] = (o[x.verdict] || 0) + 1), o), {}),
    real_candidates: sets.filter((s) => s.verdict === "CANDIDATE").length,
  };

  const lite = {
    t: generated,
    liquid: summary.liquid_markets,
    hurdle: summary.median_hurdle_top,
    illiquid: summary.share_illiquid,
    eaten1: summary.share_1pp_edge_untradeable,
    fee1: summary.fee_at_ask_over_1pp,
    fake: summary.fake_arbs,
    real: summary.real_candidates,
  };
  const history = [...(Array.isArray(prevHistory) ? prevHistory : []), lite].slice(-500);

  return {
    schema: "1.0",
    generated_utc: generated,
    definitions: {
      naive_agent: "Prices trades at the mid and ignores taker fees.",
      naive_arb_bot: "Buys a NegRisk set whenever its best YES asks sum to less than $1.",
      liquid: "Spread ≤ 5¢, not dust, ≥ $100 within 2¢ of the best ask on both sides, fee rate known.",
      hurdle: "How far p(YES) must be from the mid before buying YES or NO is +EV after spread and fees (the smaller of the two sides).",
      share_illiquid: "Share of non-dust markets with a two-sided book that fail the liquid test; median_hurdle_illiquid is their median hurdle.",
      share_Npp_edge_untradeable: "Share of liquid markets where a forecast N pp away from the mid still has no +EV trade at 1 share.",
      fake_arbs: "NegRisk sets with at least two live legs whose best asks sum to $0.50–$1.00, i.e. that a naive bot would believe. degenerate_sub_dollar_sets counts the rest (settled or near-empty events).",
      fee_at_ask_over_1pp: "Liquid markets where the taker fee at the best YES ask alone is ≥ 1pp, erasing any forecast edge smaller than that.",
    },
    summary,
    fake_arbs: fakeArbs.slice(0, 30),
    fee_heavy: feeHeavy.slice(0, 15).map((x) => ({ id: x.m.id, title: title(x.m), url: x.m.url, ask: x.m.thresholds.top.yes_ask, fee_rate: x.m.fee.rate, fee_at_ask: r4(x.fee) })),
    cheapest_to_trade: cheapest,
    history,
  };
}
