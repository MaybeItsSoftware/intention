# Intention backend

The hosted half of Intention's coach. It exists because App Store Review
Guideline 3.1.1 requires access to in-app features to be sold through In-App
Purchase — so Intention holds the LLM provider key, sells coaching credit
through Apple and Google as a repurchasable consumable top-up (not a
subscription), and proxies coaching calls against whatever balance that
credit left.

Zero dependencies: Node 20+, `node:http`, `node:crypto`, and `fetch`.

```bash
cp .env.template .env   # fill in the secrets below
npm start               # or: npm run dev
```

## What it does

1. **Verifies a purchase.** The app sends the receipt its store gave it — a
   StoreKit signed transaction (JWS) on Apple, a purchase token on Play. Apple
   receipts are checked against the certificate chain in the JWS, with the root
   pinned to Apple's, and then re-read through the App Store Server API's Get
   Transaction Info for a refund. Play tokens are exchanged with the Play
   Developer API's one-time-products endpoint. Each purchase is credited
   exactly once (keyed by the transaction/order id). The credited amount is
   never the store price 1:1 — `creditMicrosForTopUp()` in
   `server/src/config.js` nets out the store's commission
   (`storeCommission.apple`/`.google`) and Intention's own margin
   (`topUpSkimRate`) first, so the store's cut is never handed out as free
   coaching credit. The balance is shown to users as "coaching tokens"
   (`tokensPerGbp`), not a £ figure — a currency amount would look like a
   broken conversion once it no longer matches the price paid 1:1.
2. **Mints an entitlement token.** A short HMAC-signed statement — account
   subject and product — that the client sends on every coaching call. It
   proves "known, verified purchaser," not "has balance": balance is always
   looked up live, so the token's life (`INTENTION_TOKEN_TTL_MS`) is long and
   carries no financial risk the way a subscription token's would.
3. **Proxies the coach.** `/v1/chat` checks the balance is positive, forwards
   the conversation to the LLM under Intention's key, then deducts the actual
   cost of that call (computed from token usage × per-model pricing, converted
   to GBP, with a small margin buffer) from the balance. Request/response
   shapes match the client's own provider adapters, so the app's gate logic is
   identical on both routes.

## Routes

| Route | Auth | Purpose |
|-------|------|---------|
| `GET /health` | — | Liveness |
| `POST /v1/entitlement/verify` | — | `{ platform, receipt }` → credits the top-up (once), returns entitlement + token |
| `POST /v1/entitlement/refresh` | — | `{ token }` → re-checked token, live balance (never re-grants) |
| `POST /v1/entitlement/code` | Bearer | Mint a one-time code linking a browser to this account's balance |
| `POST /v1/entitlement/redeem` | — | `{ code }` → entitlement + token, live balance |
| `POST /v1/chat` | Bearer | `{ system, messages, tools }` → `{ text, toolCalls, balanceMicros, balanceGbp }` |

Error responses carry a `code` the client acts on: `entitlement_invalid` (401)
and `entitlement_expired` (402) send the user back to the paywall,
`balance_exhausted` (402) does too — running out of credit is exactly as much
a "go buy more" state as an unverifiable purchase — and `upstream_unavailable`
(503) means the store, not the account, is the problem, so nobody gets locked
out over it.

## Configuration

See [`.env.template`](.env.template). `INTENTION_TOKEN_SECRET` and
`INTENTION_LLM_API_KEY` are required and the server refuses to start without
them. Missing store credentials are a startup warning, not a failure: Apple
receipts still get their signature checked, but Play purchases can't be
verified at all until `GOOGLE_CLIENT_EMAIL` / `GOOGLE_PRIVATE_KEY` are set.

The three top-up tiers, per-model LLM pricing, and the USD→GBP/margin
constants used to compute a deduction all live in `server/src/config.js` —
see the `topUps`/`llm.pricing`/`llm.usdToGbpRate`/`llm.marginMultiplier`
fields there; override via `INTENTION_TOPUPS`/`INTENTION_USD_TO_GBP_RATE`/
`INTENTION_MARGIN_MULTIPLIER` if the defaults ever need to change.

What a top-up actually credits is a second, separate calculation from what a
chat message deducts. `storeCommission.apple`/`.google` (default 15%/15% —
override via `INTENTION_APPLE_COMMISSION_RATE`/`INTENTION_GOOGLE_COMMISSION_RATE`)
and `topUpSkimRate` (default 20% — `INTENTION_TOPUP_SKIM_RATE`) both come off
a top-up's face price before any of it becomes spendable balance; see
`creditMicrosForTopUp()`. `tokensPerGbp` (default 1000 —
`INTENTION_TOKENS_PER_GBP`) is display-only, converting that spendable
balance into the token count shown on the paywall.

`INTENTION_ALLOW_UNVERIFIED_RECEIPTS=1` skips store verification for local work.
It is ignored unless `NODE_ENV=development`, and it is logged loudly at boot.

## State

The credit balance ledger, purchase-idempotency records, and browser-linking
codes all live in an in-memory `MemoryStore` (`src/store.js`). One process is
enough to run this. To run several, implement the same
`get`/`set`/`delete`/`increment` against Redis or a KV store and pass it in —
nothing else changes (the balance and idempotency keys move with it for free).

A server restart between crediting a purchase and a client's next retry can in
principle lose that credit record along with the balance itself — a known,
accepted gap while the store stays in-memory; it goes away once the store
above is backed by something persistent.

## Tests

Run from the repo root (`npm test`); the suite is `tests/server.test.js`. Store
verification is injected, so the tests need neither network access nor
credentials. Apple's signature walk is exercised against a locally generated
certificate chain, which it must reject.

## Deploying

Any Node host works. Point the apps at it by setting the `backendUrl` key in
extension storage, or by changing `DEFAULT_INTENTION_BACKEND_URL` in
`shared/providers.js` (then `scripts/sync.sh`). Terminate TLS in front of it —
the entitlement token is a bearer credential.
