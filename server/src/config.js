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

  // The three coaching-credit top-up tiers, one consumable SKU per platform
  // per tier. Override with INTENTION_TOPUPS="amountGbp:appleId:googleId,...".
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
    privateKey: (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n')
  },

  // Development escape hatches. Both are ignored outside NODE_ENV=development.
  allowUnverifiedReceipts: bool('INTENTION_ALLOW_UNVERIFIED_RECEIPTS') && process.env.NODE_ENV === 'development'
};

// Looks up a top-up tier by the product ID a receipt/purchase reports.
export function findTopUp(platform, productId) {
  const field = platform === 'apple' ? 'appleProductId' : 'googleProductId';
  return config.topUps.find(t => t[field] === productId) || null;
}

function parseTopUps() {
  const DEFAULTS = [
    { amountGbp: 1, appleProductId: 'uk.co.maybeitssoftware.intention.coach.credit1', googleProductId: 'intention_coach_credit_1' },
    { amountGbp: 2, appleProductId: 'uk.co.maybeitssoftware.intention.coach.credit2', googleProductId: 'intention_coach_credit_2' },
    { amountGbp: 5, appleProductId: 'uk.co.maybeitssoftware.intention.coach.credit5', googleProductId: 'intention_coach_credit_5' }
  ];
  const raw = process.env.INTENTION_TOPUPS;
  const tiers = raw
    ? raw.split(',').map(entry => {
        const [amountGbp, appleProductId, googleProductId] = entry.split(':').map(s => s.trim());
        return { amountGbp: Number(amountGbp), appleProductId, googleProductId };
      })
    : DEFAULTS;
  return tiers.map(t => ({ ...t, creditMicros: Math.round(t.amountGbp * 1_000_000) }));
}

export function assertBootConfig(log = console) {
  const problems = [];
  if (!config.tokenSecret) problems.push('INTENTION_TOKEN_SECRET is not set');
  if (!config.llm.apiKey) problems.push('INTENTION_LLM_API_KEY is not set');
  if (problems.length) {
    throw new Error(`Refusing to start:\n  - ${problems.join('\n  - ')}`);
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
