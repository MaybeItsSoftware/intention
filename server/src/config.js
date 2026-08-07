// Server configuration, all from the environment. Nothing here has a default
// that would weaken verification: the two "allow unverified" switches are
// opt-in, refuse to engage unless NODE_ENV is explicitly 'development', and are
// logged loudly at boot.

function required(name) {
  const value = process.env[name];
  if (!value) return '';
  return value;
}

function bool(name) {
  return /^(1|true|yes)$/i.test(process.env[name] || '');
}

export const config = {
  port: Number(process.env.PORT || 8787),
  env: process.env.NODE_ENV || 'production',

  // Signs the entitlement tokens clients authenticate coaching calls with.
  // Rotating it invalidates every issued token; clients re-verify silently
  // from the receipt they still hold.
  tokenSecret: required('INTENTION_TOKEN_SECRET'),
  // A token only proves "verified purchaser account" now, not "has balance"
  // (balance is always looked up live) — so unlike a subscription token,
  // nothing is lost by a long life. The only reason for any expiry at all is
  // bounding a leaked token's blast radius.
  tokenTtlMs: Number(process.env.INTENTION_TOKEN_TTL_MS || 180 * 24 * 60 * 60 * 1000),

  // Path to the durable state file (balances, purchase-idempotency records).
  // Point it at a mounted volume in production; unset means in-memory only,
  // which keeps tests and local dev hermetic but loses paid credit on restart.
  stateFile: process.env.INTENTION_STATE_FILE || '',

  // How many trailing X-Forwarded-For entries were appended by proxies we
  // control or trust (Railway's edge appends the peer it actually observed).
  // The client IP is taken counting from the END of the list — the leading
  // entries are attacker-supplied. index.js logs a few raw headers after boot
  // so this assumption can be checked against real traffic.
  trustProxyHops: Number(process.env.INTENTION_TRUST_PROXY_HOPS || 1),

  // The LLM the hosted coach runs on, under our key.
  llm: {
    provider: process.env.INTENTION_LLM_PROVIDER || 'anthropic',
    apiKey: required('INTENTION_LLM_API_KEY'),
    model: process.env.INTENTION_LLM_MODEL || 'claude-sonnet-5',
    maxTokens: Number(process.env.INTENTION_LLM_MAX_TOKENS || 1024),
    // USD per million tokens — approximate published provider pricing,
    // reviewed by hand occasionally rather than fetched live. Used to turn a
    // /v1/chat call's actual token usage into a coaching-credit deduction.
    pricing: {
      'claude-sonnet-5': { inputPerMillionUsd: 3, outputPerMillionUsd: 15 },
      'claude-haiku-4.5': { inputPerMillionUsd: 1, outputPerMillionUsd: 5 },
      default: { inputPerMillionUsd: 3, outputPerMillionUsd: 15 }
    },
    // Static and hand-reviewed, not a live feed — not worth the complexity
    // for a small margin buffer on a public-benefit product.
    usdToGbpRate: Number(process.env.INTENTION_USD_TO_GBP_RATE || 0.79),
    // Applied only to the cost side of a deduction, never taken off a top-up's
    // credited value: covers LLM price drift and token-estimate slack, not a
    // margin play. Keep this small.
    marginMultiplier: Number(process.env.INTENTION_MARGIN_MULTIPLIER || 1.15)
  },

  // The cut each store takes off a top-up's face price before Intention ever
  // sees the money. Apple: 15% under the App Store Small Business Program
  // (net proceeds under $1M/yr — enroll in App Store Connect), else 30%.
  // Google: 15% is the automatic rate on the first $1M/yr, 30% above it.
  // A top-up must never credit the face price 1:1 against these — that gives
  // away the store's cut as free coaching credit on every purchase.
  storeCommission: {
    apple: Number(process.env.INTENTION_APPLE_COMMISSION_RATE || 0.15),
    google: Number(process.env.INTENTION_GOOGLE_COMMISSION_RATE || 0.15)
  },
  // Intention's own margin, skimmed off what's left of a top-up after the
  // store's cut. Unlike llm.marginMultiplier (drift buffer, kept small), this
  // is a deliberate profit margin.
  topUpSkimRate: Number(process.env.INTENTION_TOPUP_SKIM_RATE || 0.20),
  // Display unit only: how many "coaching credits" a user is shown per £1 of
  // spendable balance. The ledger itself stays in microGBP-equivalent
  // internally (server/src/store.js) — this constant never changes what a
  // message actually costs, only the number printed on the paywall.
  creditsPerGbp: Number(process.env.INTENTION_CREDITS_PER_GBP || 1000),

  // The three coaching-credit top-up tiers, one consumable SKU per platform
  // per tier. `priceGbp` is the face price charged in the store — what
  // actually gets credited is computed by creditMicrosForTopUp() below, after
  // storeCommission and topUpSkimRate both come off. Override with
  // INTENTION_TOPUPS="priceGbp:appleId:googleId,...".
  topUps: parseTopUps(),

  apple: {
    bundleId: process.env.APPLE_BUNDLE_ID || 'uk.co.maybeitssoftware.intention',
    // App Store Server API credentials (App Store Connect -> Keys -> In-App
    // Purchase). Without them the server still verifies the receipt's
    // signature, but can't re-check refunds via Get Transaction Info.
    issuerId: process.env.APPLE_ISSUER_ID || '',
    keyId: process.env.APPLE_KEY_ID || '',
    privateKey: (process.env.APPLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    environment: process.env.APPLE_ENVIRONMENT || 'production' // or 'sandbox'
  },

  google: {
    packageName: process.env.GOOGLE_PACKAGE_NAME || 'uk.co.maybeitssoftware.intention',
    // Play Developer API service account (JSON key fields).
    clientEmail: process.env.GOOGLE_CLIENT_EMAIL || '',
    privateKey: (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    // Optional secret for Google Pub/Sub webhook authorization
    webhookSecret: process.env.INTENTION_WEBHOOK_SECRET || ''
  },

  // Development escape hatches. Both are ignored outside NODE_ENV=development.
  allowUnverifiedReceipts: bool('INTENTION_ALLOW_UNVERIFIED_RECEIPTS') && process.env.NODE_ENV === 'development'
};

// Looks up a top-up tier by the product ID a receipt/purchase reports.
export function findTopUp(platform, productId) {
  const field = platform === 'apple' ? 'appleProductId' : 'googleProductId';
  return config.topUps.find(t => t[field] === productId || t.aliases?.includes(productId)) || null;
}

// What a top-up's face price actually credits, once the store's commission
// and Intention's own skim both come off. Computed per-platform (not baked
// into the topUps table) because Apple and Google commission rates can
// differ even for the same nominal price.
export function creditMicrosForTopUp(platform, priceGbp) {
  const commissionRate = config.storeCommission[platform] ?? 0.15;
  const netProceedsGbp = priceGbp * (1 - commissionRate);
  const spendableGbp = netProceedsGbp * (1 - config.topUpSkimRate);
  return Math.round(spendableGbp * 1_000_000);
}

// Display-only conversion from the ledger's microGBP-equivalent balance to
// the "coaching credits" figure shown in the UI.
export function microsToCredits(micros) {
  return Math.round((micros / 1_000_000) * config.creditsPerGbp);
}

function parseTopUps() {
  const DEFAULTS = [
    { priceGbp: 1, appleProductId: 'intention1pound', googleProductId: 'intention1pound', aliases: ['uk.co.maybeitssoftware.intention.coach.credit1', 'intention_coach_credit_1'] },
    { priceGbp: 2, appleProductId: 'intention2pound', googleProductId: 'intention2pound', aliases: ['uk.co.maybeitssoftware.intention.coach.credit2', 'intention_coach_credit_2'] },
    { priceGbp: 5, appleProductId: 'intention5pound', googleProductId: 'intention5pound', aliases: ['uk.co.maybeitssoftware.intention.coach.credit5', 'intention_coach_credit_5'] }
  ];
  const raw = process.env.INTENTION_TOPUPS;
  if (!raw) return DEFAULTS;
  return raw.split(',').map(entry => {
    const [priceGbp, appleProductId, googleProductId] = entry.split(':').map(s => s.trim());
    return { priceGbp: Number(priceGbp), appleProductId, googleProductId };
  });
}

export function assertBootConfig(log = console) {
  const problems = [];
  if (!config.tokenSecret) problems.push('INTENTION_TOKEN_SECRET is not set');
  if (!config.llm.apiKey) problems.push('INTENTION_LLM_API_KEY is not set');
  if (problems.length) {
    (log.error || log.warn)(`[intention] CRITICAL WARNING: Missing required environment configuration:\n  - ${problems.join('\n  - ')}\n[intention] Server will listen for health checks, but auth/coaching calls require these variables.`);
    return false;
  }
  if (!config.apple.issuerId || !config.apple.privateKey) {
    log.warn('[intention] App Store Server API credentials missing — Apple receipts will be checked by signature only.');
  }
  if (!config.google.clientEmail || !config.google.privateKey) {
    log.warn('[intention] Play Developer API credentials missing — Android purchases cannot be verified.');
  }
  if (config.allowUnverifiedReceipts) {
    log.warn('[intention] INTENTION_ALLOW_UNVERIFIED_RECEIPTS is on. Never use this outside local development.');
  }
}
