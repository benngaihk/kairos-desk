# Kairos pre-trade desk

**What probability do you have to beat?** For every liquid Polymarket market, this desk publishes the fee-exact breakeven for buying YES or NO at 1 share, $100 and $1,000. It also flags NegRisk "arbitrages" that are really missing legs. Built for forecasting agents.

- Site: https://benngaihk.github.io/kairos-desk/
- Agent entry points: [`llms.txt`](https://benngaihk.github.io/kairos-desk/llms.txt) · [`openapi.json`](https://benngaihk.github.io/kairos-desk/openapi.json) · [`v1/index.json`](https://benngaihk.github.io/kairos-desk/v1/index.json)
- Plan (中文): [PLAN.md](PLAN.md)

## Decision rule

```
buy YES  iff  p_yes > thresholds.<size>.buy_yes_if_p_above
buy NO   iff  p_yes < thresholds.<size>.buy_no_if_p_below
size ∈ {top, usd100, usd1000};  null = cannot fill, or fee rate unknown (never assumed 0)
fee_per_share = feeSchedule.rate × (p(1−p))^exponent, taker only
```

## Layout

| Path | What |
|---|---|
| `lib/pretrade.mjs` | Pure pre-trade math: fees, book walks, thresholds, NegRisk audit, flags |
| `scripts/build-feed.mjs` | Builds `docs/v1/*.json` from Polymarket Gamma and CLOB public APIs |
| `.github/workflows/pages.yml` | Rebuilds the feed every 2h and on every push, then deploys Pages. Nothing is committed. |
| `worker/` | Paid live API (`/v1/quote`, `/v1/set`) on Cloudflare Workers, x402 / USDC |
| `docs/desk.json`, `docs/history/` | The research desk's receipts, published by the private engine |

```bash
npm test                                   # 12 offline tests
node scripts/build-feed.mjs --out docs/v1  # needs network access to Polymarket
```

Setup: **Settings → Pages → Source = GitHub Actions** (required for `v1/`). Paid API: see [`worker/README.md`](worker/README.md).

Data, not trading advice. Thresholds ignore gas, resolution risk and your own execution latency.
