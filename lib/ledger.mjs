// Paper-trading ledger: pre-registered forecasts, cost-aware decisions, settlement
// and scoring. Pure functions; I/O lives in scripts/jev-run.mjs.

export const STAKE_USD = 100;
const r4 = (x) => (x === null || x === undefined ? null : Math.round(x * 1e4) / 1e4);
const r2 = (x) => (x === null || x === undefined ? null : Math.round(x * 100) / 100);

/**
 * Decide from a forecast p(YES) and the market's $100 thresholds.
 * Returns {side: "YES"|"NO"|null, cost} where cost is the all-in price per share.
 */
export function decide(p, thr) {
  if (p === null || !thr) return { side: null, cost: null, edge: null };
  const yes = thr.buy_yes_if_p_above,
    no = thr.buy_no_if_p_below;
  if (yes !== null && p > yes) return { side: "YES", cost: yes, edge: r4(p - yes) };
  if (no !== null && p < no) return { side: "NO", cost: r4(1 - no), edge: r4(no - p) };
  return { side: null, cost: null, edge: null };
}

/** Resolution from a Gamma market: true (YES), false (NO) or null (not resolved yet). */
export function resolution(m) {
  if (!m || m.closed !== true) return null;
  let prices = m.outcomePrices;
  if (typeof prices === "string") {
    try {
      prices = JSON.parse(prices);
    } catch {
      return null;
    }
  }
  const y = Number(Array.isArray(prices) ? prices[0] : NaN);
  if (!Number.isFinite(y)) return null;
  if (y >= 0.99) return true;
  if (y <= 0.01) return false;
  return null; // closed but not cleanly resolved (e.g. 50/50) — leave open
}

/** Settle one ledger entry. Paper stake buys STAKE/cost shares of the chosen side. */
export function settle(entry, resolvedYes, when) {
  if (entry.outcome !== undefined && entry.outcome !== null) return entry;
  if (resolvedYes === null) return entry;
  const out = { ...entry, outcome: resolvedYes ? 1 : 0, settled_utc: when };
  if (entry.side) {
    const won = (entry.side === "YES") === resolvedYes;
    const shares = STAKE_USD / entry.cost;
    out.pnl_usd = r2((won ? shares : 0) - STAKE_USD);
  }
  return out;
}

/** Aggregate record: paper P&L on trades, and Brier of the model vs the market mid on every resolved forecast. */
export function scoreboard(entries) {
  const resolved = entries.filter((e) => e.outcome === 0 || e.outcome === 1);
  const trades = entries.filter((e) => e.side);
  const settledTrades = trades.filter((e) => e.pnl_usd !== undefined && e.pnl_usd !== null);
  const brier = (key) => (resolved.length ? r4(resolved.reduce((s, e) => s + (e[key] - e.outcome) ** 2, 0) / resolved.length) : null);
  const pnl = settledTrades.reduce((s, e) => s + e.pnl_usd, 0);
  return {
    forecasts: entries.length,
    resolved: resolved.length,
    brier_model: brier("p_model"),
    brier_market: brier("mid"),
    trades: trades.length,
    open_trades: trades.length - settledTrades.length,
    settled_trades: settledTrades.length,
    wins: settledTrades.filter((e) => e.pnl_usd > 0).length,
    pnl_usd: r2(pnl),
    roi: settledTrades.length ? r4(pnl / (STAKE_USD * settledTrades.length)) : null,
  };
}

/** Pull a Noul probability out of a System One response without assuming one exact shape. */
export function noulProbability(body, key) {
  const pools = [body?.answers, body?.results, body?.output, body];
  for (const pool of pools) {
    const a = pool?.[key];
    if (a === undefined || a === null) continue;
    if (typeof a === "number") return a;
    for (const k of ["probability", "p", "value", "prob", "true"]) if (typeof a[k] === "number") return a[k];
    if (a.probabilities && typeof a.probabilities.true === "number") return a.probabilities.true;
  }
  return null;
}
