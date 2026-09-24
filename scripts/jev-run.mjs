#!/usr/bin/env node
// Pre-registered paper trading with TypeSafe's Jev.
//   node scripts/jev-run.mjs --feed docs/v1 --ledger ledger/jev-ledger.json --public docs/v1/jev.json
// Env: TYPESAFE_API_KEY (required), JEV_MODEL (default jev-latest), JEV_MAX (new forecasts per run, default 30),
//      JEV_HORIZON_DAYS (only markets ending within this many days, default 45).
//
// Jev sees the question, the resolution rules and today's date. It never sees the
// market price, so its forecast is independent of the thing it is scored against.
// Each market is forecast once; the ledger is committed to git before resolution.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { isLiquid } from "../lib/proof.mjs";
import { decide, resolution, settle, scoreboard, noulProbability } from "../lib/ledger.mjs";

const GAMMA = "https://gamma-api.polymarket.com";
const JEV_URL = "https://api.typesafe.ai/v1/systemone";
const QKEY = "resolves_yes";

export function buildState(row, rules, now) {
  const lines = [
    `Today's date (UTC): ${new Date(now).toISOString().slice(0, 10)}`,
    `Prediction market question: ${row.question}`,
  ];
  if (row.outcome && row.event_title) lines.push(`This is the outcome "${row.outcome}" in the multi-outcome event "${row.event_title}".`);
  if (row.end_date) lines.push(`Market end date: ${row.end_date}`);
  if (rules) lines.push(`Resolution rules: ${String(rules).replace(/\s+/g, " ").slice(0, 1800)}`);
  if (row.resolution_source) lines.push(`Resolution source: ${row.resolution_source}`);
  return lines.join("\n");
}

export function pickCandidates(markets, entries, now, { max = 30, horizonDays = 45 } = {}) {
  const seen = new Set(entries.map((e) => e.id));
  const lo = now + 6 * 36e5,
    hi = now + horizonDays * 864e5;
  return markets
    .filter((m) => isLiquid(m) && !seen.has(m.id) && m.end_date && !m.flags.includes("PAST_END"))
    .filter((m) => {
      const t = Date.parse(m.end_date);
      return Number.isFinite(t) && t > lo && t < hi;
    })
    .sort((a, b) => (b.volume_24h || 0) - (a.volume_24h || 0))
    .slice(0, max);
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const k = i++;
        try {
          out[k] = await fn(items[k]);
        } catch (e) {
          out[k] = { error: String(e?.message || e) };
        }
      }
    })
  );
  return out;
}

async function gammaMarket(fetchImpl, id) {
  const r = await fetchImpl(`${GAMMA}/markets?id=${encodeURIComponent(id)}`, { headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(`gamma ${r.status}`);
  const a = await r.json();
  return Array.isArray(a) ? a[0] : null;
}

async function askJev(fetchImpl, key, model, state) {
  const r = await fetchImpl(JEV_URL, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      model,
      state,
      questions: {
        [QKEY]: {
          type: "noul",
          instructions: "Will this prediction market resolve YES under its resolution rules? Answer with the probability that it does.",
        },
      },
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`jev ${r.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

export async function runJev({ fetchImpl = fetch, now = Date.now(), markets, ledger, apiKey, model = "jev-latest", max = 30, horizonDays = 45, log = console.log }) {
  const when = new Date(now).toISOString();
  const entries = [...(ledger?.entries || [])];

  // 1. settle anything that has resolved
  const open = [...new Set(entries.filter((e) => e.outcome === undefined || e.outcome === null).map((e) => e.id))].slice(0, 300);
  const got = await pool(open, 4, (id) => gammaMarket(fetchImpl, id));
  const res = new Map(open.map((id, k) => [id, got[k] && !got[k].error ? resolution(got[k]) : null]));
  let settled = 0;
  for (let k = 0; k < entries.length; k++) {
    const r = res.get(entries[k].id);
    if (r === true || r === false) {
      const before = entries[k];
      entries[k] = settle(before, r, when);
      if (entries[k] !== before) settled++;
    }
  }

  // 2. new blind forecasts
  const cands = pickCandidates(markets, entries, now, { max, horizonDays });
  const details = await pool(cands, 4, (m) => gammaMarket(fetchImpl, m.id));
  let firstRaw = true,
    failed = 0,
    added = 0;
  for (let k = 0; k < cands.length; k++) {
    const m = cands[k];
    const rules = details[k] && !details[k].error ? details[k].description : null;
    let p = null;
    try {
      const body = await askJev(fetchImpl, apiKey, model, buildState(m, rules, now));
      if (firstRaw) {
        log("jev raw response (first):", JSON.stringify(body).slice(0, 600));
        firstRaw = false;
      }
      p = noulProbability(body, QKEY);
    } catch (e) {
      log(`jev error on ${m.slug}: ${e.message}`);
    }
    if (p === null || !(p >= 0 && p <= 1)) {
      failed++;
      continue;
    }
    const thr = m.thresholds.usd100;
    const d = decide(p, thr);
    entries.push({
      t: when,
      id: m.id,
      slug: m.slug,
      question: m.question,
      outcome_label: m.outcome,
      event_title: m.event_title,
      url: m.url,
      end_date: m.end_date,
      model,
      p_model: Math.round(p * 1e4) / 1e4,
      mid: m.mid,
      buy_yes_if_p_above: thr.buy_yes_if_p_above,
      buy_no_if_p_below: thr.buy_no_if_p_below,
      side: d.side,
      cost: d.cost,
      edge: d.edge,
      outcome: null,
    });
    added++;
  }
  log(`jev: settled ${settled}, candidates ${cands.length}, new forecasts ${added}, failed ${failed}`);

  const board = scoreboard(entries);
  const byTime = (a, b) => String(b.t).localeCompare(String(a.t));
  const pub = {
    schema: "1.0",
    generated_utc: when,
    model,
    method:
      "Blind, pre-registered: Jev sees the question, rules and date but never the price. One forecast per market, committed to the `ledger` branch before resolution. Paper trade $100 only when the forecast clears the fee-and-slippage threshold at $100. Scored at resolution; Brier compares Jev with the market mid at forecast time.",
    ledger_url: "https://github.com/benngaihk/kairos-desk/commits/ledger",
    scoreboard: board,
    open_trades: entries.filter((e) => e.side && (e.outcome === null || e.outcome === undefined)).sort(byTime).slice(0, 50),
    settled: entries.filter((e) => e.outcome === 0 || e.outcome === 1).sort((a, b) => String(b.settled_utc).localeCompare(String(a.settled_utc))).slice(0, 50),
    recent_forecasts: entries.slice().sort(byTime).slice(0, 50),
  };
  return { ledger: { schema: "1.0", model, updated_utc: when, entries }, pub, stats: { settled, added, failed, candidates: cands.length } };
}

async function main() {
  const args = process.argv.slice(2);
  const arg = (k, d) => {
    const i = args.indexOf(k);
    return i >= 0 ? args[i + 1] : d;
  };
  const apiKey = process.env.TYPESAFE_API_KEY;
  if (!apiKey) {
    console.log("TYPESAFE_API_KEY not set; skipping Jev run");
    return;
  }
  const feedDir = arg("--feed", "docs/v1");
  const ledgerPath = arg("--ledger", "ledger/jev-ledger.json");
  const pubPath = arg("--public", "docs/v1/jev.json");
  const markets = JSON.parse(await readFile(`${feedDir}/markets.json`, "utf8")).markets;
  let ledger = null;
  try {
    ledger = JSON.parse(await readFile(ledgerPath, "utf8"));
  } catch {
    ledger = { entries: [] };
  }
  const out = await runJev({
    markets,
    ledger,
    apiKey,
    model: process.env.JEV_MODEL || "jev-latest",
    max: Number(process.env.JEV_MAX || 30),
    horizonDays: Number(process.env.JEV_HORIZON_DAYS || 45),
  });
  await mkdir(dirname(ledgerPath), { recursive: true });
  await writeFile(ledgerPath, JSON.stringify(out.ledger, null, 1) + "\n");
  await writeFile(pubPath, JSON.stringify(out.pub) + "\n");
  console.log("jev scoreboard:", JSON.stringify(out.pub.scoreboard));
  for (const e of out.pub.open_trades.slice(0, 10))
    console.log(`  open ${e.side} ${e.slug}: jev ${e.p_model} vs mid ${e.mid}, cost ${e.cost}, edge ${e.edge}, ends ${e.end_date}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
