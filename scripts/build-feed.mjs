#!/usr/bin/env node
// Build the free agent feed under docs/v1/ from Polymarket's public APIs.
//   node scripts/build-feed.mjs [--out docs/v1] [--max-events 300]
// Env: SITE_URL (for change detection against the last deploy), PAID_API_BASE (optional).
// Zero dependencies; Node >= 20.

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { marketRow, auditSet, normBook, feeModel, parseJsonArray, FLAG_DOC, SIZES_USD } from "../lib/pretrade.mjs";

export const SCHEMA_VERSION = "1.0";
const GAMMA = "https://gamma-api.polymarket.com";
const CLOB = "https://clob.polymarket.com";

async function getJson(fetchImpl, url, init, tries = 4) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetchImpl(url, { ...init, headers: { accept: "application/json", "content-type": "application/json", ...(init?.headers || {}) } });
      if (r.ok) return await r.json();
      last = new Error(`${r.status} ${url}`);
      if (r.status < 500 && r.status !== 429) break;
    } catch (e) {
      last = e;
    }
    await new Promise((res) => setTimeout(res, 500 * 2 ** i));
  }
  throw last;
}

export async function fetchEvents(fetchImpl, maxEvents) {
  const out = [];
  const page = 100;
  for (let off = 0; off < maxEvents; off += page) {
    const q = new URLSearchParams({
      active: "true",
      closed: "false",
      archived: "false",
      order: "volume24hr",
      ascending: "false",
      limit: String(Math.min(page, maxEvents - off)),
      offset: String(off),
    });
    const batch = await getJson(fetchImpl, `${GAMMA}/events?${q}`);
    if (!Array.isArray(batch) || !batch.length) break;
    out.push(...batch);
    if (batch.length < page) break;
  }
  return out;
}

export async function fetchBooks(fetchImpl, tokenIds, chunk = 100, concurrency = 4) {
  const books = new Map();
  const chunks = [];
  for (let i = 0; i < tokenIds.length; i += chunk) chunks.push(tokenIds.slice(i, i + chunk));
  let next = 0;
  async function worker() {
    while (next < chunks.length) {
      const c = chunks[next++];
      const res = await getJson(fetchImpl, `${CLOB}/books`, { method: "POST", body: JSON.stringify(c.map((t) => ({ token_id: t }))) });
      for (const b of res || []) if (b && b.asset_id) books.set(String(b.asset_id), b);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, chunks.length) }, worker));
  return books;
}

const wantMarket = (m) => m && m.closed !== true && m.enableOrderBook !== false && parseJsonArray(m.clobTokenIds).length === 2;

/** Pure-ish core: everything except file writes. `prev` is the last published markets.json (or null). */
export async function buildFeed({ fetchImpl = fetch, now = Date.now(), maxEvents = 300, prev = null, paidApiBase = null, siteUrl = null } = {}) {
  const events = await fetchEvents(fetchImpl, maxEvents);
  const tokens = [];
  for (const e of events)
    for (const m of e.markets || []) if (wantMarket(m)) tokens.push(...parseJsonArray(m.clobTokenIds).map(String));
  const books = await fetchBooks(fetchImpl, [...new Set(tokens)]);

  const markets = [];
  const sets = [];
  for (const e of events) {
    const ms = (e.markets || []).filter(wantMarket);
    const negRisk = Boolean(e.negRisk || e.enableNegRisk || ms.some((m) => m.negRisk));
    let incomplete = false;
    if (negRisk && ms.length >= 2) {
      const legs = (e.markets || []).map((m) => {
        const [y] = parseJsonArray(m.clobTokenIds).map(String);
        return { market: m, yesBook: normBook(books.get(y)), fee: feeModel(m) };
      });
      const s = auditSet(e, legs);
      incomplete = !s.complete;
      sets.push(s);
    }
    for (const m of ms) {
      if (m.acceptingOrders === false) continue;
      const [y, n] = parseJsonArray(m.clobTokenIds).map(String);
      markets.push(marketRow({ event: e, market: m, yesRaw: books.get(y), noRaw: books.get(n), now, setIncomplete: negRisk && incomplete }));
    }
  }

  const generated = new Date(now).toISOString();
  const changes = diff(prev, markets, now);
  const index = summarize({ markets, sets, changes, generated, paidApiBase, siteUrl, nEvents: events.length, nBooks: books.size });
  return {
    index,
    markets: { schema: SCHEMA_VERSION, generated_utc: generated, n: markets.length, markets },
    sets: { schema: SCHEMA_VERSION, generated_utc: generated, n: sets.length, sets },
    changes,
  };
}

export function diff(prev, markets, now) {
  const generated = new Date(now).toISOString();
  if (!prev || !Array.isArray(prev.markets)) return { schema: SCHEMA_VERSION, generated_utc: generated, since_utc: null, moves: [], new_markets: 0, flag_changes: [] };
  const old = new Map(prev.markets.map((m) => [m.id, m]));
  const moves = [],
    flagChanges = [];
  let fresh = 0;
  for (const m of markets) {
    const o = old.get(m.id);
    if (!o) {
      fresh++;
      continue;
    }
    if (m.mid !== null && o.mid !== null && Math.abs(m.mid - o.mid) >= 0.03)
      moves.push({ id: m.id, slug: m.slug, question: m.question, url: m.url, mid_before: o.mid, mid_now: m.mid, delta: Math.round((m.mid - o.mid) * 1e4) / 1e4 });
    const a = new Set(o.flags || []),
      b = new Set(m.flags || []);
    const added = [...b].filter((x) => !a.has(x)),
      removed = [...a].filter((x) => !b.has(x));
    if (added.length || removed.length) flagChanges.push({ id: m.id, slug: m.slug, added, removed });
  }
  moves.sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta));
  return { schema: SCHEMA_VERSION, generated_utc: generated, since_utc: prev.generated_utc ?? null, moves: moves.slice(0, 100), new_markets: fresh, flag_changes: flagChanges.slice(0, 200) };
}

const median = (a) => {
  const s = a.filter((x) => x !== null && x !== undefined).sort((x, y) => x - y);
  return s.length ? s[Math.floor(s.length / 2)] : null;
};

export function summarize({ markets, sets, changes, generated, paidApiBase, siteUrl, nEvents, nBooks }) {
  const count = (f) => markets.filter((m) => m.flags.includes(f)).length;
  const base = siteUrl ? siteUrl.replace(/\/$/, "") + "/v1" : "./v1";
  const tradeable = markets.filter((m) => !m.flags.includes("DUST") && !m.flags.includes("NO_BOOK") && m.thresholds.band_width_top !== null);
  return {
    schema: SCHEMA_VERSION,
    generated_utc: generated,
    source: "Polymarket Gamma /events (top by 24h volume) + CLOB /books, public endpoints",
    coverage: { events: nEvents, markets: markets.length, books: nBooks, negrisk_sets: sets.length },
    fee_model: {
      formula: "fee_per_share = rate × (p × (1 − p)) ^ exponent; taker only; maker rebates ignored",
      rule: "rate comes from each market's feeSchedule; if unknown, thresholds are null (never assumed 0)",
    },
    how_to_use: [
      "Have a probability p for YES. Look up the market by slug or id in markets.json.",
      "Buy YES only if p > thresholds.<size>.buy_yes_if_p_above; buy NO only if p < thresholds.<size>.buy_no_if_p_below.",
      "Between the two is the no-trade band: fees + spread + slippage eat any edge.",
      "Sizes: top (1 share at best ask), usd100, usd1000 (walks the book). null = not fillable at that size or fee unknown.",
      "Never sum asks across a NegRisk set flagged NEGRISK_INCOMPLETE; see sets.json.",
    ],
    sizes_usd: SIZES_USD,
    stats: {
      median_band_width_top: median(tradeable.map((m) => m.thresholds.band_width_top)),
      fees_on: count("FEES_ON"),
      fee_unknown: count("FEE_UNKNOWN"),
      thin: count("THIN"),
      wide_spread: count("WIDE_SPREAD"),
      past_end: count("PAST_END"),
      negrisk_incomplete_sets: sets.filter((s) => s.verdict === "INCOMPLETE").length,
      negrisk_candidates: sets.filter((s) => s.verdict === "CANDIDATE").length,
      moves_3pp: changes.moves.length,
    },
    flags: FLAG_DOC,
    files: {
      markets: `${base}/markets.json`,
      top: `${base}/top.json`,
      sets: `${base}/sets.json`,
      changes: `${base}/changes.json`,
      openapi: siteUrl ? siteUrl.replace(/\/$/, "") + "/openapi.json" : "./openapi.json",
    },
    paid_live_api: paidApiBase
      ? { base: paidApiBase, protocol: "x402 (HTTP 402, USDC)", endpoints: ["/v1/quote?market=<slug|id>&usd=<n>", "/v1/set?event=<slug>"] }
      : null,
    cadence: "rebuilt on every publish and on a schedule (see .github/workflows/pages.yml); not a real-time feed",
    disclaimer: "Data, not trading advice. Thresholds ignore gas, resolution risk and your own execution latency.",
  };
}

/** The page's default table: highest-volume non-dust markets. The full file is loaded only on search. */
export function topMarkets(markets, n) {
  return markets
    .filter((m) => !m.flags.includes("DUST"))
    .sort((a, b) => (b.volume_24h || 0) - (a.volume_24h || 0))
    .slice(0, n);
}

/** Human-readable summary in the Actions log, so data problems are visible without downloading the feed. */
function diagnostics(feed) {
  const sets = feed.sets.sets;
  const by = (arr, f) => arr.reduce((o, x) => ((o[f(x)] = (o[f(x)] || 0) + 1), o), {});
  console.log("sets by verdict:", JSON.stringify(by(sets, (x) => x.verdict)));
  const miss = sets.flatMap((x) => x.missing);
  console.log("missing legs by reason:", JSON.stringify(by(miss, (m) => m.why + (m.placeholder ? "+placeholder" : ""))));
  for (const x of sets.filter((x) => x.verdict === "INCOMPLETE").slice(0, 8))
    console.log(`  INCOMPLETE ${x.slug}: live ${x.n_live}/${x.n_legs}, net ${x.buy_set_net}, missing: ${x.missing.slice(0, 5).map((m) => `${m.label} (${m.why})`).join("; ")}`);
  for (const x of sets.filter((x) => x.verdict === "CANDIDATE"))
    console.log(`  CANDIDATE ${x.slug}: net ${x.buy_set_net}, gross ${x.buy_set_gross}, min top ${x.buy_set_min_top_shares} sh, 100sh ${x.buy_set_net_100sh}, legs ${x.n_live}/${x.n_legs}`);
  const ms = feed.markets.markets;
  console.log("markets by flag:", JSON.stringify(by(ms.flatMap((m) => m.flags), (f) => f)));
  const bw = ms.map((m) => m.thresholds.band_width_top).filter((x) => x !== null).sort((a, b) => a - b);
  console.log(`band_width_top p10/p50/p90: ${bw[Math.floor(bw.length * 0.1)]} / ${bw[Math.floor(bw.length * 0.5)]} / ${bw[Math.floor(bw.length * 0.9)]}; negative: ${bw.filter((x) => x < 0).length}`);
  const fees = by(ms.filter((m) => m.fee.rate !== null), (m) => m.fee.rate);
  console.log("fee rates:", JSON.stringify(fees));
}

async function main() {
  const args = process.argv.slice(2);
  const arg = (k, d) => {
    const i = args.indexOf(k);
    return i >= 0 ? args[i + 1] : d;
  };
  const out = arg("--out", "docs/v1");
  const maxEvents = Number(arg("--max-events", process.env.MAX_EVENTS || 300));
  const siteUrl = process.env.SITE_URL || null;
  let prev = null;
  if (siteUrl) {
    try {
      const r = await fetch(siteUrl.replace(/\/$/, "") + "/v1/markets.json", { headers: { "cache-control": "no-cache" } });
      if (r.ok) prev = await r.json();
    } catch {}
  }
  const t0 = Date.now();
  const feed = await buildFeed({ maxEvents, prev, paidApiBase: process.env.PAID_API_BASE || null, siteUrl });
  await mkdir(out, { recursive: true });
  const w = (f, o) => writeFile(join(out, f), JSON.stringify(o) + "\n");
  const top = { ...feed.markets, markets: topMarkets(feed.markets.markets, 400) };
  top.n = top.markets.length;
  await Promise.all([w("index.json", feed.index), w("markets.json", feed.markets), w("top.json", top), w("sets.json", feed.sets), w("changes.json", feed.changes)]);
  diagnostics(feed);
  const s = feed.index.stats;
  console.log(
    `feed: ${feed.index.coverage.events} events, ${feed.markets.n} markets, ${feed.sets.n} sets in ${((Date.now() - t0) / 1000).toFixed(1)}s; ` +
      `fees_on=${s.fees_on} fee_unknown=${s.fee_unknown} incomplete_sets=${s.negrisk_incomplete_sets} candidates=${s.negrisk_candidates} moves=${s.moves_3pp}`
  );
  if (feed.markets.n === 0) {
    console.error("no markets built; refusing to publish an empty feed");
    process.exit(1);
  }
  if (s.fee_unknown > feed.markets.n * 0.5) console.warn(`warning: fee rate unknown for ${s.fee_unknown}/${feed.markets.n} markets; check Gamma fee field names`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
