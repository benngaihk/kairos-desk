# Kairos paid live API (Cloudflare Worker + x402)

Live versions of the free feed's pre-trade numbers, computed at the size the caller asks for and paid per call in USDC over [x402](https://x402.org).

| Route | Price | Returns |
|---|---|---|
| `GET /v1/quote?market=<slug\|id>&usd=<n>` | $0.01 | `buy_yes_if_p_above` / `buy_no_if_p_below` at that size, the book walk, fees, flags |
| `GET /v1/set?event=<slug>&shares=<n>` | $0.02 | NegRisk completeness, full-set cost after fees, verdict |
| `GET /` | free | description, prices, network |

The math is `../lib/pretrade.mjs`, the same file that builds the free feed.

## Deploy with GitHub Actions (recommended)

Add these under repo **Settings → Secrets and variables → Actions → Secrets**:

| Secret | Where to get it |
|---|---|
| `CLOUDFLARE_API_TOKEN` | dash.cloudflare.com → My Profile → API Tokens → Create Token → template **Edit Cloudflare Workers** |
| `CLOUDFLARE_ACCOUNT_ID` | dash.cloudflare.com → Workers & Pages → right sidebar "Account ID" |
| `PAY_TO` | the 0x address that should receive USDC (on Base) |

Then run **Actions → Deploy paid API worker → Run workflow**. That workflow deploys the worker and checks that it can reach Polymarket and that it answers unpaid calls with 402. The job summary prints the worker URL. Every later push to `worker/**` or `lib/**` redeploys.

## Deploy by hand (about 10 minutes)

```bash
cd worker
npm ci
npx wrangler login
npx wrangler secret put PAY_TO        # your USDC receiving address (0x…)
npx wrangler deploy                   # prints https://kairos-pretrade.<you>.workers.dev
```

Paid routes return **503 until `PAY_TO` is set**. The worker fails closed and never serves them for free.

The default is **Base Sepolia (testnet)** through the public `https://x402.org/facilitator`. Test with faucet USDC first:

```bash
curl -i "https://kairos-pretrade.<you>.workers.dev/v1/quote?market=<slug>&usd=500"
# → 402 plus a PAYMENT-REQUIRED header. Pay it with any x402 client, e.g. @x402/fetch.
```

### Switch to real money (Base mainnet)

1. Create a CDP API key at https://portal.cdp.coinbase.com
2. `npx wrangler secret put CDP_API_KEY_ID` and `npx wrangler secret put CDP_API_KEY_SECRET`
3. In `wrangler.toml` set `X402_NETWORK = "eip155:8453"`, then run `npx wrangler deploy`

### Advertise it

- GitHub repo → Settings → Secrets and variables → Actions → **Variables** → add `PAID_API_BASE` = your worker URL. The next Pages build puts it in `v1/index.json` (`paid_live_api`), and the homepage shows it.
- Routes declare x402 **Bazaar** discovery metadata. Facilitators that support Bazaar catalog the service after its first settled payment.

## Notes

- Workers cannot await a promise created during a different request, so the app is built per request. Only the facilitator's `/supported` answer is cached, as plain data, for 10 minutes. See `src/index.ts`.
- At startup `wrangler dev` logs `invalid bazaar extension: Code generation from strings disallowed`. This is the SDK's local schema self-check, which needs `eval`, and Workers forbid `eval`. The discovery metadata is still sent in the 402 response.
- `npm run check` runs the type-check and a dry-run bundle.
