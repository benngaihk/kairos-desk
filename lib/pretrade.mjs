// Pre-trade math for Polymarket binary markets and NegRisk sets.
// Pure functions only: no I/O. Shared by scripts/build-feed.mjs (static feed)
// and worker/ (paid live endpoints), so both always agree.
//
// Fee model (taker only, maker pays 0):
//   fee_per_share(p) = rate × (p × (1 − p)) ^ exponent        (exponent defaults to 1)
// Source: Gamma market `feesEnabled` + `feeSchedule.{rate, exponent}`.
// Unknown fee => thresholds are null. We never assume 0.

export const SIZES_USD = [100, 1000];

const num = (x) => {
  if (x === null || x === undefined || x === "") return null;
  const n = typeof x === "number" ? x : Number(x);
  return Number.isFinite(n) ? n : null;
};
const r4 = (x) => (x === null || x === undefined ? null : Math.round(x * 1e4) / 1e4);
const r2 = (x) => (x === null || x === undefined ? null : Math.round(x * 100) / 100);

export function parseJsonArray(v) {
  if (Array.isArray(v)) return v;
  if (typeof v !== "string" || !v) return [];
  try {
    const a = JSON.parse(v);
    return Array.isArray(a) ? a : [];
  } catch {
    return [];
  }
}

// ---------- fees ----------

/**
 * Normalise a Gamma market's fee fields.
 * Returns {rate, exponent, src} where rate === null means "unknown".
 */
export function feeModel(m) {
  const fs = m.feeSchedule || m.fee_schedule || null;
  const enabled = m.feesEnabled ?? m.fees_enabled;
  if (enabled === false) return { rate: 0, exponent: 1, src: "feesEnabled=false" };
  const rate = num(fs && (fs.rate ?? fs.feeRate));
  const exponent = num(fs && fs.exponent) ?? 1;
  if (rate !== null) {
    // Gamma sometimes reports bps-like integers; a rate above 1 cannot be a fraction.
    const r = rate > 1 ? rate / 1e4 : rate;
    return { rate: r, exponent, src: enabled === true ? "feeSchedule.rate" : "feeSchedule.rate(feesEnabled missing)" };
  }
  return { rate: null, exponent, src: enabled === true ? "feesEnabled=true,rate missing" : "not reported" };
}

export function feePerShare(p, fee) {
  if (!fee || fee.rate === null) return null;
  if (fee.rate === 0) return 0;
  const x = Math.max(0, p * (1 - p));
  return fee.rate * Math.pow(x, fee.exponent ?? 1);
}

// ---------- books ----------

/** Normalise a CLOB book: numbers, asks ascending, bids descending, drop empty levels. */
export function normBook(b) {
  if (!b) return { bids: [], asks: [] };
  const lv = (arr) =>
    (arr || [])
      .map((l) => ({ price: num(l.price), size: num(l.size) }))
      .filter((l) => l.price !== null && l.size !== null && l.size > 0 && l.price > 0 && l.price < 1);
  const bids = lv(b.bids).sort((a, c) => c.price - a.price);
  const asks = lv(b.asks).sort((a, c) => a.price - c.price);
  return { bids, asks, tick: num(b.tick_size), min_order: num(b.min_order_size) };
}

/** The NO side's asks, synthesised from YES bids (buying NO at 1−bid ≡ selling YES at bid). */
export function mirrorAsks(bids) {
  return bids.map((l) => ({ price: r4(1 - l.price), size: l.size })).sort((a, c) => a.price - c.price);
}

/**
 * Choose the NO ask ladder conservatively: prefer the NO token's own book; if
 * that is empty, mirror YES bids. Never union the two (the API may already
 * mirror, and a union would double-count depth).
 */
export function noAsks(yesBook, noBook) {
  if (noBook && noBook.asks.length) return { asks: noBook.asks, src: "no_token_book" };
  if (yesBook && yesBook.bids.length) return { asks: mirrorAsks(yesBook.bids), src: "mirrored_yes_bids" };
  return { asks: [], src: "none" };
}

/**
 * Walk an ask ladder buying up to `usd` of notional (price × shares, fees on top)
 * or up to `shares`. Returns the all-in cost per share, which is also the
 * breakeven probability for the outcome being bought.
 * @param {{price:number,size:number}[]} asks
 * @param {{rate:number|null,exponent?:number}|null} fee
 * @param {{usd?: number|null, shares?: number|null}} [opts]
 */
export function walkAsks(asks, fee, { usd = null, shares = null } = {}) {
  let got = 0,
    spent = 0,
    fees = 0,
    worst = null;
  for (const l of asks) {
    let take = l.size;
    if (usd !== null) take = Math.min(take, (usd - spent) / l.price);
    if (shares !== null) take = Math.min(take, shares - got);
    if (take <= 1e-9) break;
    got += take;
    spent += take * l.price;
    const f = feePerShare(l.price, fee);
    fees = f === null ? null : fees + take * f;
    worst = l.price;
    if ((usd !== null && spent >= usd - 1e-9) || (shares !== null && got >= shares - 1e-9)) break;
  }
  const target = usd !== null ? usd : shares;
  const done = usd !== null ? spent : got;
  const filled = target !== null && done >= target - 1e-6;
  if (got <= 0) return { filled: false, shares: 0, notional: 0, avg_price: null, all_in: null, worst_price: null };
  return {
    filled,
    shares: r2(got),
    notional: r2(spent),
    avg_price: r4(spent / got),
    fees: fees === null ? null : r4(fees),
    all_in: fees === null ? null : r4((spent + fees) / got),
    worst_price: worst,
  };
}

/** USD notional resting within `cents` of the best ask. */
export function depthNear(asks, cents = 0.02) {
  if (!asks.length) return 0;
  const lim = asks[0].price + cents + 1e-9;
  return r2(asks.filter((l) => l.price <= lim).reduce((s, l) => s + l.price * l.size, 0));
}

// ---------- per-market thresholds ----------

/**
 * Thresholds a forecaster can act on directly:
 *   buy YES is +EV iff p_yes > buy_yes_if_p_above
 *   buy NO  is +EV iff p_yes < buy_no_if_p_below
 * Anything in between is the no-trade band (fees + spread + slippage).
 */
export function thresholds(yesAsks, noAskLadder, fee) {
  const out = {};
  const one = (opts) => {
    const y = walkAsks(yesAsks, fee, opts);
    const n = walkAsks(noAskLadder, fee, opts);
    return {
      buy_yes_if_p_above: y.filled ? y.all_in : null,
      buy_no_if_p_below: n.filled && n.all_in !== null ? r4(1 - n.all_in) : null,
      yes_avg_price: y.filled ? y.avg_price : null,
      no_avg_price: n.filled ? n.avg_price : null,
    };
  };
  // top of book: one share at the best ask
  const topY = yesAsks[0],
    topN = noAskLadder[0];
  const fy = topY ? feePerShare(topY.price, fee) : null;
  const fn = topN ? feePerShare(topN.price, fee) : null;
  out.top = {
    buy_yes_if_p_above: topY && fy !== null ? r4(topY.price + fy) : null,
    buy_no_if_p_below: topN && fn !== null ? r4(1 - (topN.price + fn)) : null,
    yes_ask: topY ? topY.price : null,
    no_ask: topN ? topN.price : null,
    yes_ask_shares: topY ? r2(topY.size) : null,
    no_ask_shares: topN ? r2(topN.size) : null,
  };
  for (const s of SIZES_USD) out["usd" + s] = one({ usd: s });
  const t = out.top;
  out.band_width_top =
    t.buy_yes_if_p_above !== null && t.buy_no_if_p_below !== null ? r4(t.buy_yes_if_p_above - t.buy_no_if_p_below) : null;
  return out;
}

// ---------- flags ----------

export const FLAG_DOC = {
  FEES_ON: "Taker fee applies (feeSchedule.rate > 0). Thresholds already include it.",
  FEE_UNKNOWN: "Fee rate not reported; thresholds withheld rather than assuming 0.",
  WIDE_SPREAD: "Best ask − best bid ≥ 5¢.",
  THIN: "Less than $100 resting within 2¢ of the best ask on at least one side.",
  DUST: "Mid below 2¢ or above 98¢: longshot dust, thresholds dominated by tick size.",
  NO_BOOK: "No asks on at least one side.",
  ENDS_SOON: "End date within 72 hours.",
  PAST_END: "End date has passed but the market still trades: resolution pending or disputed.",
  NEGRISK_INCOMPLETE: "Part of a NegRisk set that is not fully tradeable; summing this set's asks is not an arbitrage.",
  NEGRISK_PLACEHOLDER: "This leg is a placeholder (Other / Person-*) in a NegRisk set.",
};

export function marketFlags({ fee, yesBook, noLadder, mid, spread, endDate, now, setIncomplete, placeholder }) {
  const f = [];
  if (fee.rate === null) f.push("FEE_UNKNOWN");
  else if (fee.rate > 0) f.push("FEES_ON");
  if (spread !== null && spread >= 0.05 - 1e-9) f.push("WIDE_SPREAD");
  if (!yesBook.asks.length || !noLadder.length) f.push("NO_BOOK");
  else if (depthNear(yesBook.asks) < 100 || depthNear(noLadder) < 100) f.push("THIN");
  if (mid !== null && (mid < 0.02 || mid > 0.98)) f.push("DUST");
  if (endDate) {
    const h = (Date.parse(endDate) - now) / 36e5;
    if (Number.isFinite(h)) {
      if (h < 0) f.push("PAST_END");
      else if (h < 72) f.push("ENDS_SOON");
    }
  }
  if (setIncomplete) f.push("NEGRISK_INCOMPLETE");
  if (placeholder) f.push("NEGRISK_PLACEHOLDER");
  return f;
}

// ---------- NegRisk sets ----------

const PLACEHOLDER_RE = /^(other|others|person\s*[a-z0-9]+|candidate\s*[a-z0-9]+|player\s*[a-z0-9]+|team\s*[a-z0-9]+|field)$/i;

export function isPlaceholder(m) {
  if (m.negRiskOther === true) return true;
  const t = String(m.groupItemTitle || "").trim();
  return t !== "" && PLACEHOLDER_RE.test(t);
}

export function isTradeable(m) {
  return m.active !== false && m.closed !== true && m.enableOrderBook !== false && m.acceptingOrders !== false;
}

/**
 * Audit a NegRisk event: can you actually buy every outcome that can still win?
 * legs: [{market, yesBook, fee}] for every market in the event (tradeable or not).
 */
export function auditSet(event, legs, { shares = 100 } = {}) {
  const live = [],
    missing = [];
  for (const L of legs) {
    const m = L.market;
    const label = m.groupItemTitle || m.question || m.slug;
    // Closed legs are treated as resolved/eliminated and excluded from the partition.
    if (m.closed === true) continue;
    const ask = L.yesBook.asks[0];
    if (!isTradeable(m) || !ask) {
      missing.push({ label, market_id: String(m.id), placeholder: isPlaceholder(m), why: !isTradeable(m) ? "not tradeable" : "no ask" });
      continue;
    }
    live.push({ L, label, ask });
  }
  let gross = 0,
    feeSum = 0,
    feeKnown = true,
    minTop = Infinity,
    bidSum = 0,
    midSum = 0,
    anyBidMissing = false;
  for (const x of live) {
    gross += x.ask.price;
    const f = feePerShare(x.ask.price, x.L.fee);
    if (f === null) feeKnown = false;
    else feeSum += f;
    minTop = Math.min(minTop, x.ask.size);
    const bid = x.L.yesBook.bids[0];
    if (bid) {
      bidSum += bid.price;
      midSum += (bid.price + x.ask.price) / 2;
    } else anyBidMissing = true;
  }
  // at size: buy `shares` of every leg
  let sizedCost = 0,
    sizedOk = live.length > 0;
  for (const x of live) {
    const w = walkAsks(x.L.yesBook.asks, x.L.fee, { shares });
    if (!w.filled || w.all_in === null) {
      sizedOk = false;
      break;
    }
    sizedCost += w.all_in;
  }
  const complete = missing.length === 0 && live.length >= 2;
  const net = feeKnown ? gross + feeSum : null;
  let verdict, reason;
  if (!complete) {
    verdict = "INCOMPLETE";
    reason = `${missing.length} leg(s) cannot be bought (${missing
      .slice(0, 3)
      .map((x) => x.label)
      .join(", ")}${missing.length > 3 ? ", …" : ""}). Summing the remaining asks is not an arbitrage.`;
  } else if (net === null) {
    verdict = "FEE_UNKNOWN";
    reason = "At least one leg does not report a fee rate.";
  } else if (net < 1 && sizedOk && sizedCost < 1) {
    verdict = "CANDIDATE";
    reason = `Full set costs ${r4(sizedCost)} per $1 payout for ${shares} shares of every leg, after fees. Unverified: check resolution rules and fill before acting.`;
  } else if (net < 1) {
    // Sub-$1 only for the few shares resting at the best asks: not tradeable size.
    verdict = "TOP_OF_BOOK_ONLY";
    reason = `Under $1 (${net.toFixed(4)}) only for ${r2(minTop)} shares, worth at most $${((1 - net) * minTop).toFixed(2)}. At ${shares} shares per leg it costs ${sizedOk ? r4(sizedCost) : "more than the book holds"}.`;
  } else {
    verdict = "NO_EDGE";
    reason = `Full set costs ${net.toFixed(4)} per $1 payout after fees.`;
  }
  return {
    event_id: String(event.id),
    slug: event.slug,
    title: event.title,
    url: `https://polymarket.com/event/${event.slug}`,
    n_legs: legs.length,
    n_live: live.length,
    n_missing: missing.length,
    missing: missing.slice(0, 20),
    complete,
    buy_set_gross: r4(gross),
    buy_set_net: r4(net),
    buy_set_edge: net === null ? null : r4(1 - net),
    buy_set_min_top_shares: live.length ? r2(minTop) : null,
    ["buy_set_net_" + shares + "sh"]: sizedOk && feeKnown ? r4(sizedCost) : null,
    sum_yes_bid: anyBidMissing ? null : r4(bidSum),
    overround_mid: anyBidMissing ? null : r4(midSum - 1),
    verdict,
    reason,
  };
}

// ---------- one row per market ----------

/**
 * Build the public row for one binary market.
 * yesRaw/noRaw are raw CLOB book objects (or null).
 */
export function marketRow({ event, market: m, yesRaw, noRaw, now = Date.now(), setIncomplete = false }) {
  const [yesToken, noToken] = parseJsonArray(m.clobTokenIds).map(String);
  const fee = feeModel(m);
  const yesBook = normBook(yesRaw);
  const noBook = normBook(noRaw);
  const no = noAsks(yesBook, noBook);
  const bid = yesBook.bids[0]?.price ?? null;
  const ask = yesBook.asks[0]?.price ?? null;
  const mid = bid !== null && ask !== null ? r4((bid + ask) / 2) : null;
  const spread = bid !== null && ask !== null ? r4(ask - bid) : null;
  const placeholder = event?.negRisk || m.negRisk ? isPlaceholder(m) : false;
  return {
    id: String(m.id),
    slug: m.slug,
    question: m.question,
    outcome: m.groupItemTitle || null,
    event_slug: event?.slug ?? null,
    event_title: event?.title ?? null,
    url: `https://polymarket.com/event/${event?.slug ?? m.slug}`,
    end_date: m.endDate || event?.endDate || null,
    neg_risk: Boolean(m.negRisk ?? event?.negRisk),
    yes_token: yesToken ?? null,
    no_token: noToken ?? null,
    bid,
    ask,
    mid,
    spread,
    fee,
    thresholds: thresholds(yesBook.asks, no.asks, fee),
    depth_usd_2c: { yes: depthNear(yesBook.asks), no: depthNear(no.asks) },
    no_book_src: no.src,
    volume_24h: num(m.volume24hr) !== null ? Math.round(num(m.volume24hr)) : null,
    liquidity: num(m.liquidityNum ?? m.liquidity) !== null ? Math.round(num(m.liquidityNum ?? m.liquidity)) : null,
    resolution_source: m.resolutionSource || event?.resolutionSource || null,
    flags: marketFlags({ fee, yesBook, noLadder: no.asks, mid, spread, endDate: m.endDate || event?.endDate, now, setIncomplete, placeholder }),
  };
}
