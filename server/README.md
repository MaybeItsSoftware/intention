# Intention backend

The hosted half of Intention's coach. It exists because App Store Review
Guideline 3.1.1 requires access to in-app features to be sold through In-App
Purchase — so Intention holds the LLM provider key, sells access through Apple
and Google, and proxies coaching calls for anyone with an active subscription.

Zero dependencies: Node 20+, `node:http`, `node:crypto`, and `fetch`.

```bash
cp .env.template .env   # fill in the secrets below
npm start               # or: npm run dev
```

## What it does

1. **Verifies a purchase.** The app sends the receipt its store gave it — a
   StoreKit signed transaction (JWS) on Apple, a purchase token on Play. Apple
   receipts are checked against the certificate chain in the JWS, with the root
   pinned to Apple's, and then re-read through the App Store Server API for the
   current renewal/refund state. Play tokens are exchanged with the Play
   Developer API.
2. **Mints an entitlement token.** A short HMAC-signed statement — subscription
   subject, product, expiry — that the client sends on every coaching call. Its
   life is capped at both `INTENTION_TOKEN_TTL_MS` and the subscription's own
   expiry, so a cancelled plan can't outlive its term.
3. **Proxies the coach.** `/v1/chat` validates the token, spends one message
   from the day's quota, and forwards the conversation to the LLM under
   Intention's key. Request and response shapes match the client's own provider
   adapters, so the app's gate logic is identical on both routes.

## Routes

| Route | Auth | Purpose |
|-------|------|---------|
| `GET /health` | — | Liveness |
| `POST /v1/entitlement/verify` | — | `{ platform, receipt }` → entitlement + token |
| `POST /v1/entitlement/refresh` | — | `{ token }` → re-checked entitlement + token |
| `POST /v1/entitlement/code` | Bearer | Mint a one-time code linking a browser to this subscription |
| `POST /v1/entitlement/redeem` | — | `{ code }` → entitlement + token |
| `POST /v1/chat` | Bearer | `{ system, messages, tools }` → `{ text, toolCalls }` |

Error responses carry a `code` the client acts on: `entitlement_invalid` (401)
and `entitlement_expired` (402) send the user back to the paywall,
`quota_exceeded` (429) doesn't, and `upstream_unavailable` (503) means the
store — not the subscription — is the problem, so nobody gets locked out over it.

## Configuration

See [`.env.template`](.env.template). `INTENTION_TOKEN_SECRET` and
`INTENTION_LLM_API_KEY` are required and the server refuses to start without
them. Missing store credentials are a startup warning, not a failure: Apple
receipts still get their signature checked, but Play purchases can't be
verified at all until `GOOGLE_CLIENT_EMAIL` / `GOOGLE_PRIVATE_KEY` are set.

`INTENTION_ALLOW_UNVERIFIED_RECEIPTS=1` skips store verification for local work.
It is ignored unless `NODE_ENV=development`, and it is logged loudly at boot.

## State

Quota counters and browser-linking codes live in an in-memory `MemoryStore`
(`src/store.js`). One process is enough to run this. To run several, implement
the same `get`/`set`/`delete`/`increment` against Redis or a KV store and pass
it in — nothing else changes.

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
