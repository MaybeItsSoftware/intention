// billing.js — the page-side In-App Purchase layer.
//
// The paywall's DOM rendering isn't covered here (it needs a document); what is
// covered is everything that decides *what a build is allowed to offer* and how
// an entitlement moves between the store, the backend, and local storage. Those
// are the parts App Store review outcomes depend on.

import { describe, it, expect } from 'vitest';
import { loadBilling, makeMockFetch } from './load.js';

const SAFARI_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const CHROME_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0.0.0 Mobile Safari/537.36';

const bridge = () => ({
  intentionBilling: {
    products: (cb) => cb({ available: true, products: [{ id: 'p', title: 'Pro', price: '£3.99' }] }),
    purchase: (id, cb) => cb({ status: 'purchased', platform: 'apple', receipt: 'jws' }),
    restore: (cb) => cb({ status: 'purchased', platform: 'apple', receipt: 'jws' }),
    status: (cb) => cb({ available: true, entitled: true }),
    manage: (cb) => cb({ ok: true })
  }
});

describe('billing mode detection', () => {
  // What a build may show is decided entirely here, so each case is a rule
  // Apple or Google would check.
  it('is "store" wherever a native purchase bridge exists', () => {
    const { ctx } = loadBilling({ window: bridge(), userAgent: SAFARI_UA });
    expect(ctx.BILLING_MODE).toBe('store');
    expect(ctx.BYOK_IS_PRIMARY).toBe(false);
  });

  it('is "store" on Android too, not "byok"', () => {
    const { ctx } = loadBilling({ window: bridge(), userAgent: ANDROID_UA });
    expect(ctx.BILLING_MODE).toBe('store');
  });

  // The Safari extension's pages ship inside the same App Store app, so they
  // must not offer a key field either — the subscription is bought in the app.
  it('is "managed" on Safari pages with no bridge', () => {
    const { ctx } = loadBilling({ userAgent: SAFARI_UA });
    expect(ctx.BILLING_MODE).toBe('managed');
    expect(ctx.BYOK_IS_PRIMARY).toBe(false);
  });

  // Chrome and Firefox have no store to buy through, so a user-supplied key
  // stays a first-class option there.
  it('is "byok" on Chrome/Firefox', () => {
    const { ctx } = loadBilling({ userAgent: CHROME_UA });
    expect(ctx.BILLING_MODE).toBe('byok');
    expect(ctx.BYOK_IS_PRIMARY).toBe(true);
  });
});

describe('entitlementSignature', () => {
  // A deep compare would see `updatedAt` change on every normalize and report a
  // change every time — which sent refreshAccessUI into an endless
  // re-render/re-verify loop.
  it('ignores updatedAt so a re-normalized entitlement compares equal', () => {
    const { ctx } = loadBilling();
    const raw = { active: true, token: 't', productId: 'p', balanceCredits: 680 };
    const a = ctx.normalizeEntitlement(raw);
    const b = ctx.normalizeEntitlement({ ...raw });
    expect(b.updatedAt).toBeGreaterThanOrEqual(a.updatedAt);
    expect(ctx.entitlementSignature(a)).toBe(ctx.entitlementSignature(b));
  });

  it('notices the changes that actually matter, including a balance-only change', () => {
    const { ctx } = loadBilling();
    const base = ctx.normalizeEntitlement({ active: true, token: 't', productId: 'p', balanceCredits: 680 });
    const sig = ctx.entitlementSignature(base);
    expect(ctx.entitlementSignature({ ...base, active: false })).not.toBe(sig);
    expect(ctx.entitlementSignature({ ...base, token: 'other' })).not.toBe(sig);
    expect(ctx.entitlementSignature({ ...base, productId: 'other' })).not.toBe(sig);
    expect(ctx.entitlementSignature({ ...base, pendingVerification: true })).not.toBe(sig);
    // The core regression this needs to catch: a balance change after a chat
    // message, with active/token/productId all unchanged.
    expect(ctx.entitlementSignature({ ...base, balanceCredits: 340 })).not.toBe(sig);
    expect(ctx.entitlementSignature(null)).toBe('none');
  });
});

describe('normalizeEntitlement', () => {
  it('coerces a backend response into the stored shape', () => {
    const { ctx } = loadBilling();
    const e = ctx.normalizeEntitlement({
      active: 1, source: 'apple', receipt: 'jws', balanceMicros: 1000000, balanceGbp: 1, balanceCredits: 1000
    });
    expect(e.active).toBe(true);
    // The server never sends this for a top-up — stays falsy so
    // entitlementIsActive()'s "no expiresAt means active forever" branch
    // needs no change.
    expect(e.expiresAt).toBe(null);
    expect(e.productId).toBe('');
    expect(e.receipt).toBe('jws');
    expect(e.balanceMicros).toBe(1000000);
    expect(e.balanceGbp).toBe(1);
    expect(e.balanceCredits).toBe(1000);
  });

  it('returns null for nothing', () => {
    const { ctx } = loadBilling();
    expect(ctx.normalizeEntitlement(null)).toBe(null);
  });
});

describe('verifyPurchase', () => {
  it('posts the receipt to the backend and keeps it for later re-checks', async () => {
    const fetch = makeMockFetch({ active: true, token: 'tok', productId: 'pro.monthly', expiresAt: 999 });
    const { ctx } = loadBilling({ fetch });
    const entitlement = await ctx.verifyPurchase({ platform: 'apple', receipt: 'jws' });

    const call = fetch.calls[0];
    expect(call.url).toBe('https://api.intention.maybeitssoftware.uk/v1/entitlement/verify');
    expect(JSON.parse(call.init.body)).toEqual({ platform: 'apple', receipt: 'jws' });
    expect(entitlement.token).toBe('tok');
    expect(entitlement.source).toBe('apple');
    // Kept so a failed verification can be retried without re-purchasing.
    expect(entitlement.receipt).toBe('jws');
  });

  it('honours a backend override', async () => {
    const fetch = makeMockFetch({ active: true, token: 't' });
    const { ctx } = loadBilling({ fetch });
    await ctx.verifyPurchase({ platform: 'google', receipt: {}, backendUrl: 'http://localhost:8787/' });
    expect(fetch.calls[0].url).toBe('http://localhost:8787/v1/entitlement/verify');
  });

  it('surfaces the backend error code', async () => {
    const fetch = makeMockFetch({ status: 401, json: { code: 'entitlement_invalid', error: 'nope' } });
    const { ctx } = loadBilling({ fetch });
    const error = await ctx.verifyPurchase({ platform: 'apple', receipt: 'jws' }).catch(e => e);
    expect(error.code).toBe('entitlement_invalid');
  });
});

describe('refreshEntitlement', () => {
  const stored = { active: true, token: 'tok', source: 'apple', receipt: 'jws' };

  it('re-checks through the refresh route when a token is held', async () => {
    const fetch = makeMockFetch({ active: true, token: 'tok2', balanceGbp: 2 });
    const { ctx } = loadBilling({ fetch });
    const refreshed = await ctx.refreshEntitlement(stored);
    expect(fetch.calls[0].url).toMatch(/\/v1\/entitlement\/refresh$/);
    expect(refreshed.token).toBe('tok2');
  });

  it('surfaces an updated balance without flipping active', async () => {
    const fetch = makeMockFetch({ active: true, token: 'tok', balanceMicros: 500000, balanceGbp: 0.5 });
    const { ctx } = loadBilling({ fetch });
    const refreshed = await ctx.refreshEntitlement(stored);
    expect(refreshed.active).toBe(true);
    expect(refreshed.balanceGbp).toBe(0.5);
  });

  // A purchase that couldn't be confirmed at the time keeps its receipt, so the
  // retry goes back through verify rather than giving up on it.
  it('falls back to verifying the receipt when there is no token yet', async () => {
    const fetch = makeMockFetch({ active: true, token: 'tok' });
    const { ctx } = loadBilling({ fetch });
    await ctx.refreshEntitlement({ ...stored, token: '' });
    expect(fetch.calls[0].url).toMatch(/\/v1\/entitlement\/verify$/);
  });

  // Offline is not the same as unsubscribed: a flaky connection must never
  // lock out someone who is paying.
  it('keeps access on a network failure and marks it for retry', async () => {
    const fetch = async () => { throw new TypeError('Failed to fetch'); };
    const { ctx } = loadBilling({ fetch });
    const refreshed = await ctx.refreshEntitlement(stored);
    expect(refreshed.active).toBe(true);
    expect(refreshed.pendingVerification).toBe(true);
  });

  // Tokens now age out at an absolute lifetime, so a rejected token with a
  // stored receipt re-proves the purchase through verify instead of dying.
  it('re-verifies from the stored receipt when the token is rejected', async () => {
    const fetch = makeMockFetch((url) =>
      url.endsWith('/refresh')
        ? { status: 401, json: { code: 'entitlement_expired' } }
        : { active: true, token: 'fresh-token', balanceGbp: 1 }
    );
    const { ctx } = loadBilling({ fetch });
    const refreshed = await ctx.refreshEntitlement(stored);
    expect(fetch.calls.map(c => c.url.split('/').pop())).toEqual(['refresh', 'verify']);
    expect(refreshed.active).toBe(true);
    expect(refreshed.token).toBe('fresh-token');
  });

  it('drops access when both the token and the receipt are rejected', async () => {
    const fetch = makeMockFetch({ status: 401, json: { code: 'entitlement_invalid' } });
    const { ctx } = loadBilling({ fetch });
    const refreshed = await ctx.refreshEntitlement(stored);
    expect(refreshed.active).toBe(false);
    expect(refreshed.pendingVerification).toBe(false);
  });

  it('leaves an entitlement with nothing to re-check alone', async () => {
    const fetch = makeMockFetch({});
    const { ctx } = loadBilling({ fetch });
    const bare = { active: false, token: '', receipt: null };
    expect(await ctx.refreshEntitlement(bare)).toBe(bare);
    expect(fetch.calls.length).toBe(0);
  });
});

describe('access codes', () => {
  it('redeems a code into an entitlement', async () => {
    const fetch = makeMockFetch({ active: true, token: 'tok', productId: 'pro.monthly' });
    const { ctx } = loadBilling({ fetch });
    const entitlement = await ctx.redeemAccessCode('  int-abcd-efgh ');
    expect(fetch.calls[0].url).toMatch(/\/v1\/entitlement\/redeem$/);
    expect(JSON.parse(fetch.calls[0].init.body).code).toBe('int-abcd-efgh');
    expect(entitlement.source).toBe('code');
  });

  it('mints a linking code with the entitlement token as authorization', async () => {
    const fetch = makeMockFetch({ code: 'INT-AAAA-BBBB', expiresAt: 1 });
    const { ctx } = loadBilling({ fetch });
    const result = await ctx.requestAccessCode({ token: 'tok' });
    expect(fetch.calls[0].init.headers.authorization).toBe('Bearer tok');
    expect(result.code).toBe('INT-AAAA-BBBB');
  });

  it('refuses to mint one without coaching credit on this device', async () => {
    const fetch = makeMockFetch({});
    const { ctx } = loadBilling({ fetch });
    await expect(ctx.requestAccessCode(null)).rejects.toThrow(/No coaching credit/);
    expect(fetch.calls.length).toBe(0);
  });
});

describe('store bridge', () => {
  it('promisifies the native callbacks', async () => {
    const { ctx } = loadBilling({ window: bridge(), userAgent: SAFARI_UA });
    expect((await ctx.fetchStoreProducts()).products[0].id).toBe('p');
    expect((await ctx.purchaseProduct('p')).status).toBe('purchased');
    expect((await ctx.restorePurchases()).receipt).toBe('jws');
    expect((await ctx.storeEntitlementStatus()).entitled).toBe(true);
  });

  // Browser builds have no bridge at all; calling through must resolve, not
  // throw, so the paywall can fall back to its own copy.
  it('reports unavailable rather than throwing when there is no bridge', async () => {
    const { ctx } = loadBilling({ userAgent: CHROME_UA });
    expect(await ctx.fetchStoreProducts()).toEqual({ available: false });
    expect(await ctx.purchaseProduct('p')).toEqual({ available: false });
  });
});
