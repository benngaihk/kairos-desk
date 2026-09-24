// Kairos paid live API: pre-trade checks for Polymarket, paid per call over x402 (USDC).
// Same math as the free static feed (../../lib/pretrade.mjs), but computed live
// at the size the agent asks for.

import { Hono } from "hono";
import type { Context } from "hono";
import { paymentMiddleware, x402ResourceServer } from "@x402/hono";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import type { FacilitatorClient } from "@x402/core/server";
import { bazaarResourceServerExtension, declareDiscoveryExtension } from "@x402/extensions/bazaar";
import { createFacilitatorConfig } from "@coinbase/x402";
// @ts-ignore -- plain ESM shared with the Node feed builder
import { marketRow, auditSet, normBook, noAsks, walkAsks, feeModel, parseJsonArray } from "../../lib/pretrade.mjs";

type Env = {
  PAY_TO?: string; // your USDC receiving address; endpoints stay closed until set
  X402_NETWORK?: string; // eip155:84532 (Base Sepolia, default) or eip155:8453 (Base mainnet)
  FACILITATOR_URL?: string; // default https://x402.org/facilitator (testnet only)
  CDP_API_KEY_ID?: string; // set both CDP keys to use Coinbase's mainnet facilitator
  CDP_API_KEY_SECRET?: string;
  PRICE_QUOTE?: string;
  PRICE_SET?: string;
  FREE_FEED_URL?: string;
};

const GAMMA = "https://gamma-api.polymarket.com";
const CLOB = "https://clob.polymarket.com";
const MAX_USD = 100_000;

async function j(url: string, init?: RequestInit): Promise<any> {
  const r = await fetch(url, { ...init, headers: { accept: "application/json", "content-type": "application/json" } });
  if (!r.ok) throw new HttpError(502, `upstream ${r.status} for ${new URL(url).pathname}`);
  return r.json();
}

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function books(tokenIds: string[]): Promise<Map<string, any>> {
  const out = new Map<string, any>();
  if (!tokenIds.length) return out;
  const res = await j(`${CLOB}/books`, { method: "POST", body: JSON.stringify(tokenIds.map((t) => ({ token_id: t }))) });
  for (const b of res || []) if (b?.asset_id) out.set(String(b.asset_id), b);
  return out;
}

async function findMarket(key: string): Promise<{ market: any; event: any }> {
  const q = /^\d+$/.test(key) ? `id=${key}` : `slug=${encodeURIComponent(key)}`;
  const ms = await j(`${GAMMA}/markets?${q}`);
  const market = Array.isArray(ms) ? ms[0] : null;
  if (!market) throw new HttpError(404, `market not found: ${key}`);
  const event = Array.isArray(market.events) && market.events[0] ? market.events[0] : null;
  return { market, event };
}

async function quote(key: string, usd: number) {
  const { market, event } = await findMarket(key);
  const [y, n] = parseJsonArray(market.clobTokenIds).map(String);
  if (!y || !n) throw new HttpError(422, "market has no CLOB tokens");
  const bk = await books([y, n]);
  const row = marketRow({ event, market, yesRaw: bk.get(y), noRaw: bk.get(n) });
  const fee = feeModel(market);
  const yesBook = normBook(bk.get(y));
  const no = noAsks(yesBook, normBook(bk.get(n)));
  const yw = walkAsks(yesBook.asks, fee, { usd });
  const nw = walkAsks(no.asks, fee, { usd });
  return {
    as_of_utc: new Date().toISOString(),
    live: true,
    requested_usd: usd,
    at_size: {
      buy_yes_if_p_above: yw.filled ? yw.all_in : null,
      buy_no_if_p_below: nw.filled && nw.all_in !== null ? Math.round((1 - nw.all_in) * 1e4) / 1e4 : null,
      buy_yes: yw,
      buy_no: nw,
      note: "all_in = avg price + taker fee per share = breakeven probability for that side. filled=false means the book cannot absorb this size.",
    },
    market: row,
  };
}

async function setCheck(slug: string, shares: number) {
  const es = await j(`${GAMMA}/events?slug=${encodeURIComponent(slug)}`);
  const event = Array.isArray(es) ? es[0] : null;
  if (!event) throw new HttpError(404, `event not found: ${slug}`);
  const ms: any[] = event.markets || [];
  const yesIds = ms.map((m) => parseJsonArray(m.clobTokenIds).map(String)[0]).filter(Boolean);
  const bk = await books(yesIds);
  const legs = ms.map((m) => ({ market: m, yesBook: normBook(bk.get(parseJsonArray(m.clobTokenIds).map(String)[0])), fee: feeModel(m) }));
  return { as_of_utc: new Date().toISOString(), live: true, neg_risk: Boolean(event.negRisk || event.enableNegRisk), ...auditSet(event, legs, { shares }) };
}

function describe(env: Env, origin: string) {
  return {
    name: "Kairos pre-trade API",
    what: "Live, fee-exact pre-trade checks for Polymarket: the probability you must beat to buy YES or NO at your size, and whether a NegRisk set is actually complete.",
    free_feed: env.FREE_FEED_URL || "https://benngaihk.github.io/kairos-desk/v1/index.json",
    payment: { protocol: "x402", network: env.X402_NETWORK || "eip155:84532", asset: "USDC", pay_to_configured: Boolean(env.PAY_TO) },
    endpoints: [
      { path: `${origin}/v1/quote?market=<slug|id>&usd=<1..${MAX_USD}>`, price: env.PRICE_QUOTE || "$0.01", returns: "buy_yes_if_p_above / buy_no_if_p_below at that size, book walk, fees, flags" },
      { path: `${origin}/v1/set?event=<slug>&shares=<n>`, price: env.PRICE_SET || "$0.02", returns: "NegRisk completeness, full-set cost after fees, verdict" },
    ],
    disclaimer: "Data, not trading advice.",
  };
}

function build(env: Env) {
  const app = new Hono<{ Bindings: Env }>();
  const network = (env.X402_NETWORK || "eip155:84532") as `${string}:${string}`;

  app.onError((err, c) => {
    const status = err instanceof HttpError ? err.status : 500;
    return c.json({ error: err.message }, status as any);
  });

  app.get("/", (c) => c.json(describe(env, new URL(c.req.url).origin)));
  app.get("/health", async (c) => {
    if (c.req.query("deep") !== "1") return c.json({ ok: true });
    // Proves upstream reachability from Cloudflare; returns no market data.
    const t0 = Date.now();
    const ms = await j(`${GAMMA}/markets?limit=1&active=true&closed=false`);
    const [y] = parseJsonArray(ms?.[0]?.clobTokenIds).map(String);
    const bk = y ? await books([y]) : new Map();
    return c.json({ ok: true, gamma: Array.isArray(ms) && ms.length > 0, clob: bk.size > 0, ms: Date.now() - t0, pay_to_configured: Boolean(env.PAY_TO), network });
  });

  if (!env.PAY_TO) {
    // Fail closed: never serve paid routes for free because a secret is missing.
    app.get("/v1/*", (c) => c.json({ error: "payments not configured (PAY_TO unset)" }, 503));
    return app;
  }

  const facilitatorKey = `${env.FACILITATOR_URL}|${env.CDP_API_KEY_ID}`;
  const inner =
    env.CDP_API_KEY_ID && env.CDP_API_KEY_SECRET
      ? new HTTPFacilitatorClient({ ...createFacilitatorConfig(env.CDP_API_KEY_ID, env.CDP_API_KEY_SECRET), timeoutMs: 15_000 })
      : new HTTPFacilitatorClient({ url: env.FACILITATOR_URL || "https://x402.org/facilitator", timeoutMs: 15_000 });
  const facilitator = cachedFacilitator(inner, facilitatorKey);
  const server = new x402ResourceServer(facilitator).register(network, new ExactEvmScheme()).registerExtension(bazaarResourceServerExtension);

  const pay = (price: string) => ({ scheme: "exact", price, network, payTo: env.PAY_TO as string });
  const freeFeed = env.FREE_FEED_URL || "https://benngaihk.github.io/kairos-desk/v1/index.json";
  const unpaid = (what: string) => () => ({
    contentType: "application/json",
    body: {
      error: "payment required",
      what,
      how: "Pay with x402: read the PAYMENT-REQUIRED header, sign, retry with PAYMENT-SIGNATURE. Any x402 client (@x402/fetch, x402-axios, agent wallets) does this automatically.",
      free_alternative: `Free static snapshot (not live, fixed sizes): ${freeFeed}`,
    },
  });
  app.use(
    paymentMiddleware(
      {
        "GET /v1/quote": {
          accepts: pay(env.PRICE_QUOTE || "$0.01"),
          serviceName: "Kairos pre-trade",
          description: "Polymarket pre-trade check at your size: fee-exact breakeven probability for buying YES or NO, book walk, liquidity and resolution flags.",
          mimeType: "application/json",
          tags: ["polymarket", "prediction-markets", "trading", "fees", "orderbook"],
          unpaidResponseBody: unpaid("Live pre-trade quote at your size: breakeven probability for YES and NO after fees and slippage."),
          extensions: declareDiscoveryExtension({
            input: { market: "fed-decision-in-october", usd: 500 },
            inputSchema: {
              properties: { market: { type: "string", description: "Polymarket market slug or numeric id" }, usd: { type: "number", description: "Notional to buy, USD" } },
              required: ["market"],
            },
            output: { example: { at_size: { buy_yes_if_p_above: 0.6712, buy_no_if_p_below: 0.6386 } } },
          }),
        },
        "GET /v1/set": {
          accepts: pay(env.PRICE_SET || "$0.02"),
          serviceName: "Kairos pre-trade",
          description: "Polymarket NegRisk set audit: are all outcomes buyable, what does the full set cost after fees, is the apparent arbitrage real.",
          mimeType: "application/json",
          tags: ["polymarket", "arbitrage", "negrisk", "prediction-markets"],
          unpaidResponseBody: unpaid("Live NegRisk set audit: completeness, full-set cost after fees, verdict."),
          extensions: declareDiscoveryExtension({
            input: { event: "democratic-presidential-nominee-2028", shares: 100 },
            inputSchema: {
              properties: { event: { type: "string", description: "Polymarket event slug" }, shares: { type: "number", description: "Shares per leg to price (default 100)" } },
              required: ["event"],
            },
            output: { example: { verdict: "INCOMPLETE", buy_set_net: 0.9604, n_missing: 3 } },
          }),
        },
      },
      server,
    ),
  );

  app.get("/v1/quote", async (c: Context) => {
    const key = (c.req.query("market") || "").trim();
    const usd = Number(c.req.query("usd") || 100);
    if (!key) throw new HttpError(400, "market is required");
    if (!(usd > 0 && usd <= MAX_USD)) throw new HttpError(400, `usd must be in (0, ${MAX_USD}]`);
    return c.json(await quote(key, usd));
  });

  app.get("/v1/set", async (c: Context) => {
    const slug = (c.req.query("event") || "").trim();
    const shares = Number(c.req.query("shares") || 100);
    if (!slug) throw new HttpError(400, "event is required");
    if (!(shares > 0 && shares <= 1e6)) throw new HttpError(400, "shares out of range");
    return c.json(await setCheck(slug, shares));
  });

  return app;
}

// Workers cannot await a promise created during another request, and the x402
// middleware starts its facilitator sync when it is constructed. So the app is
// built per request, and only the facilitator's /supported answer (plain data)
// is cached across requests.
let supported: { key: string; at: number; data: Awaited<ReturnType<FacilitatorClient["getSupported"]>> } | null = null;
const SUPPORTED_TTL_MS = 10 * 60_000;

function cachedFacilitator(inner: FacilitatorClient, key: string): FacilitatorClient {
  return {
    verify: (p, r) => inner.verify(p, r),
    settle: (p, r) => inner.settle(p, r),
    async getSupported() {
      if (supported && supported.key === key && Date.now() - supported.at < SUPPORTED_TTL_MS) return supported.data;
      const data = await inner.getSupported();
      supported = { key, at: Date.now(), data };
      return data;
    },
  };
}

export default {
  fetch(req: Request, env: Env, ctx: ExecutionContext) {
    return build(env).fetch(req, env, ctx);
  },
};
