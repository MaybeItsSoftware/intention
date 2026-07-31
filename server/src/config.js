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
  tokenTtlMs: Number(process.env.INTENTION_TOKEN_TTL_MS || 7 * 24 * 60 * 60 * 1000),

  // Daily coaching messages per subscription. Generous — this is abuse
  // protection, not a meter the user is meant to feel.
  dailyMessageQuota: Number(process.env.INTENTION_DAILY_QUOTA || 200),

  // The LLM the hosted coach runs on, under our key.
  llm: {
    provider: process.env.INTENTION_LLM_PROVIDER || 'anthropic',
    apiKey: required('INTENTION_LLM_API_KEY'),
    model: process.env.INTENTION_LLM_MODEL || 'claude-sonnet-5',
    maxTokens: Number(process.env.INTENTION_LLM_MAX_TOKENS || 1024)
  },

  apple: {
    bundleId: process.env.APPLE_BUNDLE_ID || 'uk.co.maybeitssoftware.intention',
    // App Store Server API credentials (App Store Connect -> Keys -> In-App
    // Purchase). Without them the server still verifies the receipt's
    // signature, but can't re-check renewals or refunds.
    issuerId: process.env.APPLE_ISSUER_ID || '',
    keyId: process.env.APPLE_KEY_ID || '',
    privateKey: (process.env.APPLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    environment: process.env.APPLE_ENVIRONMENT || 'production', // or 'sandbox'
    productIds: (process.env.APPLE_PRODUCT_IDS ||
      'uk.co.maybeitssoftware.intention.pro.monthly,uk.co.maybeitssoftware.intention.pro.yearly'
    ).split(',').map(s => s.trim()).filter(Boolean)
  },

  google: {
    packageName: process.env.GOOGLE_PACKAGE_NAME || 'uk.co.maybeitssoftware.intention',
    // Play Developer API service account (JSON key fields).
    clientEmail: process.env.GOOGLE_CLIENT_EMAIL || '',
    privateKey: (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    productIds: (process.env.GOOGLE_PRODUCT_IDS || 'intention_pro_monthly,intention_pro_yearly')
      .split(',').map(s => s.trim()).filter(Boolean)
  },

  // Development escape hatches. Both are ignored outside NODE_ENV=development.
  allowUnverifiedReceipts: bool('INTENTION_ALLOW_UNVERIFIED_RECEIPTS') && process.env.NODE_ENV === 'development'
};

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
