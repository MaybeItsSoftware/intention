// billing.js — the page-side In-App Purchase layer.
//
// The paywall's DOM rendering isn't covered here (it needs a document); what is
// covered is everything that decides *what a build is allowed to offer* and how
// an entitlement moves between the store, the backend, and local storage. Those
// are the parts App Store review outcomes depend on.

import { describe, it, expect, vi } from 'vitest';
import { loadBilling, loadSource, makeMockFetch } from './load.js';

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

// WebKit's default user agent for an app-hosted web view — no "Safari", no
// "Version/". The iOS/macOS app's options page and its hidden background host
// both run under this, so a /Safari/ test would have missed the App Store
// binary itself and left the custom-key route live exactly where 3.1.1 bites.
const APPLE_APP_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';
const FIREFOX_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:121.0) Gecko/20100101 Firefox/121.0';

describe('Apple build detection', () => {
  // Everything 3.1.1 turns on: this flag is what removes the custom-key field
  // and what makes resolveAIRoute() refuse a stored key.
  const isApple = (userAgent) => loadBilling({ userAgent }).ctx.IS_APPLE_BUILD;

  it('covers the Safari web extension', () => {
    expect(isApple(SAFARI_UA)).toBe(true);
  });

  it("covers the app's own web views, which don't say Safari", () => {
    expect(isApple(APPLE_APP_UA)).toBe(true);
  });

  it('excludes Chrome, Firefox and the Android app WebView', () => {
    expect(isApple(CHROME_UA)).toBe(false);
    expect(isApple(FIREFOX_UA)).toBe(false);
    expect(isApple(ANDROID_UA)).toBe(false);
  });
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
    expect(ctx.BYOK_IS_PRIMARY).toBe(false);
  });
});

// Being *allowed to mention* a user's own key is a weaker thing than leading
// with it, and the two stores differ: Play's payments policy never engages on a
// key the user already holds with a third party, Apple's 3.1.1 does. So Android
// may offer it under the purchase buttons while Apple may not.
describe('whether a build may offer a user-supplied key at all', () => {
  it('offers it on Android, without demoting Play Billing', () => {
    const { ctx } = loadBilling({ window: bridge(), userAgent: ANDROID_UA });
    expect(ctx.BYOK_IS_OFFERED).toBe(true);
    expect(ctx.BYOK_IS_PRIMARY).toBe(false);
  });

  it('does not offer it on an Apple store build', () => {
    const { ctx } = loadBilling({ window: bridge(), userAgent: SAFARI_UA });
    expect(ctx.BYOK_IS_OFFERED).toBe(false);
  });

  it('does not offer it on Safari extension pages either', () => {
    const { ctx } = loadBilling({ userAgent: SAFARI_UA });
    expect(ctx.BYOK_IS_OFFERED).toBe(false);
  });

  it('offers it in the browsers, where it is the way in', () => {
    const { ctx } = loadBilling({ userAgent: CHROME_UA });
    expect(ctx.BYOK_IS_OFFERED).toBe(true);
  });
});

describe('store product strings', () => {
  // Play appends " (App name)" to every in-app product title it returns.
  it('drops the app name Play appends to product titles', () => {
    const { ctx } = loadBilling({ userAgent: CHROME_UA });
    expect(ctx.cleanProductTitle('1,000 Intention Coach Credits (Intention)'))
      .toBe('1,000 Intention Coach Credits');
  });

  it('leaves a title alone when the store did not append anything', () => {
    const { ctx } = loadBilling({ userAgent: CHROME_UA });
    expect(ctx.cleanProductTitle('1,000 Coach Credits')).toBe('1,000 Coach Credits');
    expect(ctx.cleanProductTitle('')).toBe('');
  });

  // Only the app's own name comes off — a bracket someone meant to be there stays.
  it('keeps a trailing bracket that is not the app name', () => {
    const { ctx } = loadBilling({ userAgent: CHROME_UA });
    expect(ctx.cleanProductTitle('5,000 Credits (best value)')).toBe('5,000 Credits (best value)');
  });

  it('drops a description that opens by restating the title', () => {
    const { ctx } = loadBilling({ userAgent: CHROME_UA });
    expect(ctx.cleanProductDesc('1,000 Intention Coach Credits', '1,000 Credits for about 500 messages'))
      .toBe('For about 500 messages');
    expect(ctx.cleanProductDesc('2,000 Intention Credits', '2,000 Intention Credits for about 1,000 messages'))
      .toBe('For about 1,000 messages');
  });

  it('keeps a description whose count is not the one in the title', () => {
    const { ctx } = loadBilling({ userAgent: CHROME_UA });
    expect(ctx.cleanProductDesc('1,000 Coach Credits', '500 credits of bonus time'))
      .toBe('500 credits of bonus time');
  });

  it('keeps a description that says nothing but the count', () => {
    const { ctx } = loadBilling({ userAgent: CHROME_UA });
    expect(ctx.cleanProductDesc('1,000 Coach Credits', '1,000 Credits')).toBe('1,000 Credits');
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
    expect(call.url).toBe('https://api.intention.maybeitssoftware.co.uk/v1/entitlement/verify');
    expect(JSON.parse(call.init.body)).toEqual({ platform: 'apple', receipt: 'jws' });
    expect(entitlement.token).toBe('tok');
    expect(entitlement.source).toBe('apple');
    // Kept so a failed verification can be retried without re-purchasing.
    expect(entitlement.receipt).toBe('jws');
  });

  // Store-issued promo codes are redeemed outside the app's purchase flow, so
  // their transaction carries no account token and the backend has nothing to
  // credit. The client asserts its own on every store verify to cover that.
  it('asserts the device account token on store builds', async () => {
    const fetch = makeMockFetch({ active: true, token: 'tok' });
    const win = bridge();
    win.intentionBilling.accountToken = (cb) => cb({ token: 'uuid-from-keychain' });
    const { ctx } = loadBilling({ fetch, window: win, userAgent: SAFARI_UA });
    await ctx.verifyPurchase({ platform: 'apple', receipt: 'jws' });
    expect(JSON.parse(fetch.calls[0].init.body)).toEqual({
      platform: 'apple', receipt: 'jws', accountToken: 'uuid-from-keychain'
    });
  });

  // A browser has no bridge to ask, and no store code to redeem either.
  it('sends no account token on browser builds', async () => {
    const fetch = makeMockFetch({ active: true, token: 'tok' });
    const { ctx } = loadBilling({ fetch, userAgent: CHROME_UA });
    await ctx.verifyPurchase({ platform: 'apple', receipt: 'jws' });
    expect(JSON.parse(fetch.calls[0].init.body)).toEqual({ platform: 'apple', receipt: 'jws' });
  });

  // An app built against an older bridge has no accountToken action. A bought
  // purchase must still verify — only a redemption actually needs the token.
  it('still verifies when the bridge has no accountToken action', async () => {
    const fetch = makeMockFetch({ active: true, token: 'tok' });
    const { ctx } = loadBilling({ fetch, window: bridge(), userAgent: SAFARI_UA });
    await ctx.verifyPurchase({ platform: 'apple', receipt: 'jws' });
    expect(JSON.parse(fetch.calls[0].init.body)).toEqual({ platform: 'apple', receipt: 'jws' });
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

  // The failure mode a callback API makes easy: a bridge that is present,
  // answers the method check, and then never calls back. There is no error to
  // catch and no rejection to await — the promise simply never settles, and
  // whatever awaited it never runs. That is how one unguarded
  // `await storeAccountRestored()` on the paywall's render path could leave the
  // AI-access card permanently empty with nothing logged.
  //
  // A missed deadline resolves to the same { available: false } shape "no
  // bridge" already resolves to, so nothing downstream needs a second path.
  it('gives up on a bridge that never calls back, rather than hanging for ever', async () => {
    vi.useFakeTimers();
    try {
      const silent = { intentionBilling: { accountToken: () => {}, products: () => {}, status: () => {} } };
      const { ctx } = loadBilling({ window: silent, userAgent: ANDROID_UA });
      const restored = ctx.storeAccountRestored();
      const products = ctx.fetchStoreProducts();
      let settled = false;
      restored.then(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(1000);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(ctx.BRIDGE_QUERY_TIMEOUT_MS);
      // undefined is "this build cannot tell", which every caller treats as
      // "say nothing" — the right answer for a bridge that said nothing.
      expect(await restored).toBe(undefined);
      expect(await products).toEqual({ available: false, error: 'The store did not respond.' });
    } finally {
      vi.useRealTimers();
    }
  });

  // ...and the deadline must not be able to cut off a purchase, which is
  // waiting on a human in the store's own sheet and may take minutes.
  it('puts no deadline on a purchase or a redemption', async () => {
    vi.useFakeTimers();
    try {
      let finish;
      const slow = {
        intentionBilling: {
          purchase: (id, cb) => { finish = () => cb({ status: 'purchased', receipt: 'jws' }); },
          redeem: (cb) => { finish = () => cb({ status: 'purchased', receipt: 'jws' }); }
        }
      };
      const { ctx } = loadBilling({ window: slow, userAgent: ANDROID_UA });
      const pending = ctx.purchaseProduct('p');
      let settled = false;
      pending.then(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(ctx.BRIDGE_QUERY_TIMEOUT_MS * 4);
      expect(settled).toBe(false);
      finish();
      expect((await pending).status).toBe('purchased');
    } finally {
      vi.useRealTimers();
    }
  });

  // The bridge is native code we do not control, so a late second callback
  // after the deadline must not resurrect anything.
  it('latches its answer, so a late callback changes nothing', async () => {
    vi.useFakeTimers();
    try {
      let late;
      const win = { intentionBilling: { accountToken: (cb) => { late = cb; } } };
      const { ctx } = loadBilling({ window: win, userAgent: ANDROID_UA });
      const pending = ctx.storeAccountToken();
      await vi.advanceTimersByTimeAsync(ctx.BRIDGE_QUERY_TIMEOUT_MS + 1);
      late({ token: 'too-late' });
      expect(await pending).toBe('');
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// Getting a balance back after a reinstall
// ---------------------------------------------------------------------------
//
// A top-up is a consumable: its receipt is consumed at purchase, Play stops
// returning it and Apple's currentEntitlements excludes it by design. So after
// a reinstall the ONLY thing left is the account id the platform put back, and
// these are the rules for spending it.

// Every call below names a `route`, and that is not incidental: the guard used
// to be on the BUILD, which is a different question — BILLING_MODE is 'store'
// on Android whether the coach is running on our credit or on a key the user
// pasted. attemptSilentRecovery now asks nothing unless the resolved route says
// there is a balance of ours to look for, and a caller that names no route asks
// nothing at all. 'locked' is the ordinary first-run case (no credit yet) and
// 'hosted' is the one refreshEntitlement reaches with a token that has died.
describe('silent recovery', () => {
  const storeBridge = (token = 'acct-uuid') => {
    const b = bridge();
    b.intentionBilling.accountToken = (cb) => cb({ token });
    return b;
  };

  // The single most important property in this file after the 3.1.1 guard. A
  // browser has no bridge and therefore no account id, and the server cannot
  // tell a browser from anything else — so if the guard is not here, every
  // Chrome install quietly posts an empty recovery request on first run.
  it('makes no network call at all on a browser build', async () => {
    const { ctx, fetch } = loadBilling({ userAgent: CHROME_UA });
    expect(await ctx.attemptSilentRecovery('https://api.test', { route: 'locked' })).toBe(null);
    expect(fetch.calls).toHaveLength(0);
  });

  it('asks with the surviving account id on an Apple store build', async () => {
    const fetch = makeMockFetch({ active: true, balanceCredits: 1240, token: 't' });
    const { ctx } = loadBilling({ window: storeBridge(), userAgent: SAFARI_UA, fetch });
    const recovered = await ctx.attemptSilentRecovery('https://api.test', { route: 'locked' });
    expect(fetch.calls[0].url).toBe('https://api.test/v1/entitlement/recover');
    expect(JSON.parse(fetch.calls[0].init.body)).toEqual({ platform: 'apple', accountToken: 'acct-uuid' });
    expect(recovered.balanceCredits).toBe(1240);
    expect(recovered.source).toBe('apple');
  });

  it('names the Play platform on Android', async () => {
    const fetch = makeMockFetch({ active: true, token: 't' });
    const { ctx } = loadBilling({ window: storeBridge(), userAgent: ANDROID_UA, fetch });
    await ctx.attemptSilentRecovery('https://api.test', { route: 'locked' });
    expect(JSON.parse(fetch.calls[0].init.body).platform).toBe('google');
  });

  // The overwhelmingly common caller is a brand-new user who has never bought
  // anything. Telling them their credit could not be recovered would be both
  // alarming and false, so a 404 has to be silence.
  it('swallows "no balance for this account" into a quiet null', async () => {
    const fetch = makeMockFetch({ status: 404, json: { code: 'no_balance_for_account', error: 'none' } });
    const { ctx } = loadBilling({ window: storeBridge(), userAgent: SAFARI_UA, fetch });
    expect(await ctx.attemptSilentRecovery('https://api.test', { route: 'locked' })).toBe(null);
  });

  // ...but an outage means "unknown", and swallowing it would turn a server
  // having a bad minute into "your credit is gone".
  it('rethrows a real server error rather than reporting no credit', async () => {
    const fetch = makeMockFetch({ status: 500, json: { code: 'server_error', error: 'boom' } });
    const { ctx } = loadBilling({ window: storeBridge(), userAgent: SAFARI_UA, fetch });
    await expect(ctx.attemptSilentRecovery('https://api.test', { route: 'locked' })).rejects.toThrow('boom');
  });

  // The privacy half of the same guard, and the reason it is on the route and
  // not the build. BILLING_MODE is 'store' on Android, and Android also offers
  // a custom key — so a user who pasted their own Anthropic key, never bought
  // anything, and was told in PRIVACY.md that nothing about their coaching
  // reaches Intention was having a stable device UUID posted, unauthenticated,
  // to /v1/entitlement/recover on every settings open for the life of the
  // install.
  it('asks nothing on the byok route, on a build with a bridge and an id to send', async () => {
    const { ctx, fetch } = loadBilling({ window: storeBridge(), userAgent: ANDROID_UA });
    expect(await ctx.attemptSilentRecovery('https://api.test', { route: 'byok' })).toBe(null);
    expect(fetch.calls).toHaveLength(0);
  });

  // The one exception, and it is a person pressing a button rather than a
  // route: "Restore credit from a previous install" is somebody asking, and
  // refusing it on the byok route would make the button a decoration for the
  // one user on a custom key who does have credit stranded somewhere.
  it('asks on any route when the user pressed the button', async () => {
    const fetch = makeMockFetch({ active: true, token: 't', balanceCredits: 10 });
    const { ctx } = loadBilling({ window: storeBridge(), userAgent: ANDROID_UA, fetch });
    await ctx.attemptSilentRecovery('https://api.test', { route: 'byok', userAsked: true });
    expect(fetch.calls.map(c => c.url)).toEqual(['https://api.test/v1/entitlement/recover']);
  });

  // Fail closed, so the next call site added here has to say which route it is
  // on before it can send anything.
  it('asks nothing when the caller names no route at all', async () => {
    const { ctx, fetch } = loadBilling({ window: storeBridge(), userAgent: ANDROID_UA });
    expect(await ctx.attemptSilentRecovery('https://api.test')).toBe(null);
    expect(await ctx.attemptSilentRecovery('https://api.test', { route: 'something-new' })).toBe(null);
    expect(fetch.calls).toHaveLength(0);
  });

  // refreshEntitlement's doc comment promises it falls back to the entitlement
  // we already hold rather than throwing, and this is the door that voided it:
  // the last-resort recovery call is the one thing in there that can reject,
  // and nothing above it caught. reconcileEntitlement -> refreshAccessUI ->
  // showSettingsView is an un-awaited chain, so one 500 here took the whole
  // settings page with it.
  it('does not throw out of refreshEntitlement when the last resort fails too', async () => {
    const fetch = makeMockFetch((url) => url.endsWith('/recover')
      ? { status: 500, json: { code: 'server_error', error: 'boom' } }
      : { status: 401, json: { code: 'entitlement_invalid', error: 'gone' } });
    const { ctx } = loadBilling({ window: storeBridge(), userAgent: SAFARI_UA, fetch });
    const out = await ctx.refreshEntitlement({ active: true, token: 'stale', source: 'apple' },
      'https://api.test', { route: 'hosted' });
    expect(fetch.calls.map(c => c.url.split('/').pop())).toEqual(['refresh', 'recover']);
    expect(out.active).toBe(false);
    expect(out.lastError).toBe('entitlement_invalid');
  });

  it('does not ask when the bridge has no account id to give', async () => {
    const { ctx, fetch } = loadBilling({ window: storeBridge(''), userAgent: SAFARI_UA });
    expect(await ctx.attemptSilentRecovery('https://api.test', { route: 'locked' })).toBe(null);
    expect(fetch.calls).toHaveLength(0);
  });

  // refreshEntitlement is the single funnel: every path that can discover a
  // dead entitlement already passes through its rejected-token branch.
  it('is reached from refreshEntitlement when the token has aged out', async () => {
    const fetch = makeMockFetch((url) => url.endsWith('/refresh')
      ? { status: 401, json: { code: 'entitlement_invalid', error: 'gone' } }
      : { active: true, balanceCredits: 900, token: 'fresh' });
    const { ctx } = loadBilling({ window: storeBridge(), userAgent: SAFARI_UA, fetch });
    const out = await ctx.refreshEntitlement({ token: 'stale', source: 'apple' }, 'https://api.test',
      { route: 'hosted' });
    expect(out.active).toBe(true);
    expect(out.token).toBe('fresh');
    expect(fetch.calls.map(c => c.url)).toContain('https://api.test/v1/entitlement/recover');
  });

  it('is not reached when the stored receipt still verifies', async () => {
    const fetch = makeMockFetch((url) => url.endsWith('/refresh')
      ? { status: 401, json: { code: 'entitlement_invalid', error: 'gone' } }
      : { active: true, balanceCredits: 500, token: 'from-receipt' });
    const { ctx } = loadBilling({ window: storeBridge(), userAgent: SAFARI_UA, fetch });
    const out = await ctx.refreshEntitlement(
      { token: 'stale', source: 'apple', receipt: 'jws' }, 'https://api.test', { route: 'hosted' });
    expect(out.token).toBe('from-receipt');
    expect(fetch.calls.map(c => c.url)).not.toContain('https://api.test/v1/entitlement/recover');
  });
});

describe('the recovery check marker', () => {
  it('is carried through normalizeEntitlement', () => {
    const { ctx } = loadBilling();
    expect(ctx.normalizeEntitlement({ active: true, recoveryCheckedAt: 1234 }).recoveryCheckedAt).toBe(1234);
    expect(ctx.normalizeEntitlement({ active: true }).recoveryCheckedAt).toBe(0);
  });

  // It moves every time we ask the backend a question, so counting it would
  // make each recovery check look like a change and re-render forever — the
  // same trap updatedAt is already excluded for.
  it('is ignored by entitlementSignature, so a check is not a change', () => {
    const { ctx } = loadBilling();
    const base = { active: true, token: 't', balanceCredits: 10 };
    expect(ctx.entitlementSignature({ ...base, recoveryCheckedAt: 0 }))
      .toBe(ctx.entitlementSignature({ ...base, recoveryCheckedAt: Date.now() }));
  });
});


// ---------------------------------------------------------------------------
// What the paywall is allowed to put on screen
// ---------------------------------------------------------------------------
//
// Guideline 3.1.1 forbids unlocking in-app functionality against anything
// bought outside IAP, and Apple has already rejected a build of this app for
// leaving the key field merely unadvertised. Everything below asserts on the
// RENDERED TREE rather than on a flag or a source string, because the flag was
// never the thing review looked at.
//
// renderPaywall builds with createElement/textContent throughout, so the shim
// only has to answer element construction, parenting and property writes —
// no layout, no selectors, no event loop. A full jsdom would answer questions
// nothing here asks.

function makeNode(tagName) {
  const classes = new Set();
  const attrs = {};
  const handlers = {};
  const node = {
    tagName,
    children: [],
    dataset: {},
    style: {},
    hidden: false,
    disabled: false,
    open: false,
    _handlers: handlers,
    classList: {
      add: (...c) => c.forEach(x => classes.add(x)),
      remove: (...c) => c.forEach(x => classes.delete(x)),
      contains: (c) => classes.has(c),
      toggle: (c, on) => {
        const want = on === undefined ? !classes.has(c) : !!on;
        if (want) classes.add(c); else classes.delete(c);
        return want;
      }
    },
    setAttribute: (k, v) => { attrs[k] = String(v); },
    getAttribute: (k) => (k in attrs ? attrs[k] : null),
    appendChild: (child) => { node.children.push(child); return child; },
    append: (...kids) => { node.children.push(...kids); },
    addEventListener: (type, fn) => { (handlers[type] = handlers[type] || []).push(fn); },
    querySelector: () => null
  };
  // The one thing renderPaywall does that is not construction: it empties the
  // container it is handed, and the "busy" helper asks whether a button has
  // element children before it flattens the label.
  Object.defineProperty(node, 'innerHTML', {
    get: () => '',
    set: () => { node.children.length = 0; }
  });
  Object.defineProperty(node, 'firstElementChild', {
    get: () => node.children[0] || null
  });
  return node;
}

// Every node in the tree, in document order.
function flatten(node, out = []) {
  for (const child of node.children || []) {
    out.push(child);
    flatten(child, out);
  }
  return out;
}

const allText = (node) => flatten(node).map(n => n.textContent || '').join(' ');
const byId = (node, id) => flatten(node).find(n => n.id === id) || null;
const byClass = (node, className) => flatten(node)
  .filter(n => typeof n.className === 'string' && n.className.split(' ').includes(className));

function loadPaywall({ window: win = {}, userAgent, fetch } = {}) {
  const mockFetch = fetch || makeMockFetch({});
  const navigator = { userAgent };
  const document = { createElement: makeNode, getElementById: () => null };
  const ctx = loadSource(['providers.js', 'billing.js'], {
    fetch: mockFetch,
    extraGlobals: { window: { ...win, navigator }, navigator, document }
  });
  return { ctx, container: makeNode('div'), fetch: mockFetch };
}

// What verifyPurchase actually leaves behind: the receipt is stored alongside
// the token (see "posts the receipt to the backend and keeps it for later
// re-checks" above), and `src` is how the server says this session proved
// itself. Both matter to the paywall now — whether a recovery code may be
// offered is decided from them — so the fixture has to be the real shape.
const ACTIVE = { active: true, token: 'tok', balanceCredits: 1240, source: 'apple', receipt: 'jws', src: 'store' };

// Rendered on every store and managed build, so every one of these is a thing
// review would see.
const forbidden = (container, ctx) => {
  const nodes = flatten(container);
  const text = allText(container);
  return {
    anchors: nodes.filter(n => n.tagName === 'a').length,
    keyFields: nodes.filter(n => n.type === 'password' || n.id === 'int-pw-key').length,
    providerPickers: nodes.filter(n => n.id === 'int-pw-provider').length,
    // The vendor names themselves, taken from the provider table rather than
    // hardcoded, so a provider added later is covered without an edit here.
    vendors: Object.entries(ctx.PROVIDERS)
      .filter(([, cfg]) => !cfg.hosted)
      .map(([, cfg]) => cfg.label)
      .filter(label => text.includes(label)),
    externalUrls: text.match(/https?:\/\//g) || []
  };
};

describe('Guideline 3.1.1: what an Apple build may render', () => {
  const bridged = () => {
    const b = bridge();
    b.intentionBilling.accountToken = (cb) => cb({ token: 'acct' });
    return b;
  };

  it('shows no key field, no provider name and no link on a store build', async () => {
    const { ctx, container } = loadPaywall({ window: bridged(), userAgent: SAFARI_UA });
    await ctx.renderPaywall(container, { entitlement: null, onRestore: async () => {}, onPurchase: async () => {}, onRedeem: async () => {} });
    expect(forbidden(container, ctx)).toEqual({
      anchors: 0, keyFields: 0, providerPickers: 0, vendors: [], externalUrls: []
    });
  });

  it('shows none of them on a store build with credit either', async () => {
    const { ctx, container } = loadPaywall({ window: bridged(), userAgent: SAFARI_UA });
    await ctx.renderPaywall(container, {
      entitlement: ACTIVE,
      onRestore: async () => {}, onPurchase: async () => {},
      onLinkBrowser: async () => ({ code: 'INT-AAAA-BBBB' }),
      onShowRecoveryCode: async () => ({ code: 'INT-AAAA-BBBB-CCCC-DDDD' })
    });
    expect(forbidden(container, ctx)).toEqual({
      anchors: 0, keyFields: 0, providerPickers: 0, vendors: [], externalUrls: []
    });
  });

  it('shows none of them on a managed build — the Safari extension pages', async () => {
    const { ctx, container } = loadPaywall({ userAgent: SAFARI_UA });
    expect(ctx.BILLING_MODE).toBe('managed');
    await ctx.renderPaywall(container, { entitlement: null, onRedeem: async () => {} });
    expect(forbidden(container, ctx)).toEqual({
      anchors: 0, keyFields: 0, providerPickers: 0, vendors: [], externalUrls: []
    });
  });

  it('shows none of them on a managed build with credit', async () => {
    const { ctx, container } = loadPaywall({ userAgent: SAFARI_UA });
    await ctx.renderPaywall(container, {
      entitlement: ACTIVE,
      onShowRecoveryCode: async () => ({ code: 'INT-AAAA-BBBB-CCCC-DDDD' })
    });
    expect(forbidden(container, ctx)).toEqual({
      anchors: 0, keyFields: 0, providerPickers: 0, vendors: [], externalUrls: []
    });
  });

  // The counterpart: the guard has to be able to fail, or it proves nothing.
  // Chrome and Firefox may show all of it, because no store sells anything
  // there and the key is the only route a browser can actually finish.
  it('does render the key route on a browser build, so the guard can fail', async () => {
    const { ctx, container } = loadPaywall({ userAgent: CHROME_UA });
    await ctx.renderPaywall(container, { entitlement: null, onSaveKey: async () => {}, onRedeem: async () => {} });
    const seen = forbidden(container, ctx);
    expect(seen.keyFields).toBeGreaterThan(0);
    expect(seen.providerPickers).toBe(1);
    expect(seen.vendors.length).toBeGreaterThan(0);
  });
});

describe('no code of any kind', () => {
  // Chrome and Firefox run on the user's own API key and nothing else, and the
  // app builds and Safari buy through the store. No build takes a pasted code
  // or shows one to write down.
  it('renders no code box and no recovery code on any build', async () => {
    const withCredit = { active: true, token: 'tok', balanceCredits: 400, source: 'apple', receipt: 'jws', src: 'store' };
    for (const userAgent of [CHROME_UA, SAFARI_UA, ANDROID_UA]) {
      for (const entitlement of [null, withCredit]) {
        const { ctx, container } = loadPaywall({ window: userAgent === ANDROID_UA ? bridge() : {}, userAgent });
        await ctx.renderPaywall(container, {
          entitlement, onRestore: async () => {}, onPurchase: async () => {}, onSaveKey: async () => {}
        });
        expect(byId(container, 'int-pw-code-input')).toBe(null);
        expect(byClass(container, 'int-pw-recovery')).toHaveLength(0);
        expect(byClass(container, 'int-pw-link')).toHaveLength(0);
        expect(allText(container).toLowerCase()).not.toContain('recovery code');
      }
    }
  });

  it('offers a browser the key route alone', async () => {
    const { ctx, container } = loadPaywall({ userAgent: CHROME_UA });
    await ctx.renderPaywall(container, { entitlement: null, onSaveKey: async () => {} });
    expect(byClass(container, 'int-pw-route')).toHaveLength(1);
    expect(byId(container, 'int-pw-key')).toBeTruthy();
    expect(allText(container)).not.toContain('coaching credit');
  });

  it('exposes none of the code helpers', () => {
    const { ctx } = loadBilling();
    for (const name of ['redeemAccessCode', 'requestAccessCode', 'requestRecoveryCode', 'canMintRecoveryCode']) {
      expect(typeof ctx[name]).toBe('undefined');
    }
  });
});

describe('API-key configuration within the access flow', () => {
  it('saves a custom model and edits or removes an existing key in the same flow', async () => {
    const { ctx, container } = loadPaywall({ userAgent: CHROME_UA });
    const saved = [];
    let removed = 0;
    await ctx.renderPaywall(container, {
      route: 'byok',
      keyConfig: { provider: 'anthropic', model: 'existing-model', apiKey: 'saved-key' },
      onSaveKey: async (config) => saved.push(config),
      onRemoveKey: async () => { removed += 1; }
    });
    expect(byId(container, 'int-pw-key-route').tagName).toBe('details');
    expect(byId(container, 'int-pw-model').value).toBe('existing-model');
    expect(byId(container, 'int-pw-key').value).toBe('saved-key');
    byId(container, 'int-pw-model').value = '  custom-model  ';
    byId(container, 'int-pw-key').value = '  changed-key  ';
    const save = flatten(container).find(n => n.textContent === 'Save key');
    await save._handlers.click[0]();
    expect(saved).toEqual([{ provider: 'anthropic', model: 'custom-model', apiKey: 'changed-key' }]);
    await byClass(container, 'int-pw-remove-key')[0]._handlers.click[0]();
    expect(removed).toBe(1);
    expect(allText(container)).not.toContain('Settings → Advanced');
  });

  it('uses the selected provider default when no model is given and rejects an empty key', async () => {
    const { ctx, container } = loadPaywall({ userAgent: CHROME_UA });
    const saved = [];
    await ctx.renderPaywall(container, { onSaveKey: async (config) => saved.push(config) });
    byId(container, 'int-pw-provider').value = 'groq';
    byId(container, 'int-pw-provider')._handlers.change[0]();
    byId(container, 'int-pw-key').value = '   ';
    const save = flatten(container).find(n => n.textContent === 'Save key');
    await save._handlers.click[0]();
    expect(saved).toEqual([]);
    byId(container, 'int-pw-key').value = 'key';
    await save._handlers.click[0]();
    expect(saved[0].model).toBe(ctx.PROVIDERS.groq.defaultModel);
  });

  it('offers Android configuration beneath purchases and has no explanatory paragraphs under the routes', async () => {
    const { ctx, container } = loadPaywall({ window: bridge(), userAgent: ANDROID_UA });
    await ctx.renderPaywall(container, {
      onUseOwnKey: async () => {}, onSaveKey: async () => {}, onRedeemStoreCode: async () => {}
    });
    expect(byId(container, 'int-pw-model')).toBeTruthy();
    expect(byClass(container, 'int-pw-redeem')).toHaveLength(1);
    expect(allText(container)).not.toContain('Been given a code');
    expect(allText(container)).not.toContain('Already pay for an AI provider');
    expect(allText(container)).not.toContain('Point the coach at an account');
  });

  it('renders no API fields on Apple even if a key callback is supplied', async () => {
    const { ctx, container } = loadPaywall({ window: bridge(), userAgent: SAFARI_UA });
    await ctx.renderPaywall(container, { onUseOwnKey: async () => {}, onSaveKey: async () => {}, onRemoveKey: async () => {} });
    expect(byId(container, 'int-pw-key-route')).toBeNull();
    expect(byId(container, 'int-pw-model')).toBeNull();
  });
});

describe('restoring credit from a previous install', () => {
  const bridged = () => {
    const b = bridge();
    b.intentionBilling.accountToken = (cb) => cb({ token: 'acct' });
    return b;
  };

  // A different question from "Recover an interrupted purchase", which asks
  // the STORE about a transaction that never finished and correctly answers
  // "no pending purchase found" after a reinstall.
  it('offers its own button on a store build with no credit', async () => {
    const { ctx, container } = loadPaywall({ window: bridged(), userAgent: SAFARI_UA });
    await ctx.renderPaywall(container, {
      entitlement: null, onRestore: async () => {}, onPurchase: async () => {},
      onRecoverFromDevice: async () => null
    });
    expect(byClass(container, 'int-pw-recover')).toHaveLength(1);
  });

  it('does not offer it once there is credit', async () => {
    const { ctx, container } = loadPaywall({ window: bridged(), userAgent: SAFARI_UA });
    await ctx.renderPaywall(container, {
      entitlement: ACTIVE, onRestore: async () => {}, onPurchase: async () => {},
      onRecoverFromDevice: async () => null
    });
    expect(byClass(container, 'int-pw-recover')).toHaveLength(0);
  });

  // `undefined` is "this build cannot tell" — Apple's bridge omits the field
  // and the notice would be untrue there.
  it('explains a fresh install only when the bridge actually said so', async () => {
    const withFlag = loadPaywall({ window: bridged(), userAgent: ANDROID_UA });
    await withFlag.ctx.renderPaywall(withFlag.container, {
      entitlement: null, onRestore: async () => {}, onPurchase: async () => {}, accountRestored: false
    });
    expect(allText(withFlag.container)).toContain('This looks like a fresh install');

    const without = loadPaywall({ window: bridged(), userAgent: ANDROID_UA });
    await without.ctx.renderPaywall(without.container, {
      entitlement: null, onRestore: async () => {}, onPurchase: async () => {}
    });
    expect(allText(without.container)).not.toContain('This looks like a fresh install');
  });
});

// ---------------------------------------------------------------------------
// options-access.js — the page that drives all of the above
// ---------------------------------------------------------------------------
//
// It lives here rather than in a file of its own because it is the other half
// of this one: options-access.js holds no rules about billing, it only decides
// when to ask billing.js a question and what to do with the answer. Every
// defect below is on that seam — a question asked on the wrong route, an answer
// written over a purchase, an exception from an opportunistic question taking
// the whole settings page with it.
//
// The stubbed background is deliberately thin. What the real one does with a
// merge is pinned in tests/background.test.js; what matters here is which
// message the page sends and what it does next.
function loadAccessPage({ userAgent = ANDROID_UA, fetch, entitlement = null, route = 'locked',
  accountToken = 'DEVICE-UUID', bridge: hasBridge = true } = {}) {
  const mockFetch = fetch || makeMockFetch({ status: 404, json: { code: 'no_balance_for_account', error: 'none' } });
  const stored = { entitlement };
  const sent = [];
  const sendBg = async (message) => {
    sent.push(message);
    if (message.action === 'getAccess') return { route, entitlement: stored.entitlement };
    if (message.action === 'saveEntitlement') {
      stored.entitlement = message.entitlement;
      return { ok: true, entitlement: stored.entitlement };
    }
    if (message.action === 'mergeEntitlement') {
      stored.entitlement = { ...(stored.entitlement || { active: false, source: '' }), ...message.entitlement };
      return { ok: true, entitlement: stored.entitlement };
    }
    return { ok: true };
  };
  const win = {
    navigator: { userAgent },
    addEventListener: () => {}
  };
  if (hasBridge) win.intentionBilling = { accountToken: (cb) => cb({ token: accountToken }), products: (cb) => cb({ available: true, products: [] }) };
  const container = makeNode('div');
  const ctx = loadSource(['providers.js', 'billing.js', 'options-access.js'], {
    fetch: mockFetch,
    extraGlobals: {
      window: win,
      navigator: win.navigator,
      document: { createElement: makeNode, getElementById: (id) => (id === 'access-card' ? container : null) },
      sendBg,
      getConfig: async () => ({ backendUrl: 'https://api.test' }),
      refreshCreditChip: async () => {},
      HAS_APP_BLOCKING: true
    }
  });
  return { ctx, fetch: mockFetch, stored, sent, container };
}

describe('the settings page and an unreachable backend', () => {
  // The defect this whole harness exists for. attemptSilentRecovery rethrows
  // anything that is not a 404, and there was no catch anywhere above it:
  // recoverStrandedCredit -> reconcileEntitlement -> refreshAccessUI ->
  // options.js's showSettingsView, which does not await and does not catch. One
  // offline recovery check therefore aborted the entire settings render — no
  // blocked-site list, no blocking-mode card, no apps card, no stats, and not
  // one button bound. The settings screen was a dead husk whenever the device
  // was offline.
  it('does not throw when an opportunistic recovery check fails', async () => {
    const offline = async () => { throw new TypeError('Failed to fetch'); };
    const { ctx } = loadAccessPage({ fetch: offline });
    await expect(ctx.reconcileEntitlement(null, 'locked')).resolves.toBe(null);
  });

  it('renders the paywall and returns, offline, so the rest of the page runs', async () => {
    const offline = async () => { throw new TypeError('Failed to fetch'); };
    const { ctx, container } = loadAccessPage({ fetch: offline });
    await expect(ctx.refreshAccessUI('access-card')).resolves.toBeUndefined();
    expect(container.children.length).toBeGreaterThan(0);
  });

  // Nothing is written down either: we were not told anything, so the 24-hour
  // "we asked and there was nothing" marker must not be recorded. A device that
  // was merely offline has to ask again next time.
  it('records no answer it never received', async () => {
    const offline = async () => { throw new TypeError('Failed to fetch'); };
    const { ctx, stored, sent } = loadAccessPage({ fetch: offline });
    await ctx.reconcileEntitlement(null, 'locked');
    expect(stored.entitlement).toBe(null);
    expect(sent.filter(m => m.action === 'mergeEntitlement' || m.action === 'saveEntitlement')).toHaveLength(0);
  });

  // The one caller somebody is watching: the manual button, whose own handler
  // catches and shows the message.
  it('still reports a failure to the button that asked for it', async () => {
    const offline = async () => { throw new TypeError('Failed to fetch'); };
    const { ctx } = loadAccessPage({ fetch: offline });
    await expect(ctx.recoverStrandedCredit(null, { force: true, route: 'locked' }))
      .rejects.toThrow(/Failed to fetch/);
  });
});

describe('when the settings page asks about a stranded balance', () => {
  it('asks nothing at all on the byok route, bridge and account id notwithstanding', async () => {
    const { ctx, fetch, stored, sent } = loadAccessPage({ route: 'byok' });
    await ctx.reconcileEntitlement(null, 'byok');
    expect(fetch.calls).toHaveLength(0);
    // And writes no entitlement object to record a question nobody asked.
    expect(stored.entitlement).toBe(null);
    expect(sent.filter(m => m.action === 'mergeEntitlement')).toHaveLength(0);
  });

  it('still asks on the locked route, which is what it is for', async () => {
    const { ctx, fetch } = loadAccessPage({ route: 'locked' });
    await ctx.reconcileEntitlement(null, 'locked');
    expect(fetch.calls.map(c => c.url)).toEqual(['https://api.test/v1/entitlement/recover']);
  });

  // The manual button is the user asking, whatever route the coach is on.
  it('honours the manual button on the byok route', async () => {
    const { ctx, fetch } = loadAccessPage({ route: 'byok' });
    await ctx.recoverStrandedCredit(null, { force: true, route: 'byok' });
    expect(fetch.calls.map(c => c.url)).toEqual(['https://api.test/v1/entitlement/recover']);
  });
});

describe('a purchase that lands while the recovery check is in flight', () => {
  // SEVERE, and the reason every recovery write is a merge now. The read
  // happens before an unbounded await; the write happened after it, through a
  // whole-object save. Buy a top-up while /v1/entitlement/recover is still out
  // on a slow network — returning from the Play sheet fires
  // 'intention-app-active', which runs a second refreshAccessUI that verifies
  // and persists the purchase — and the 404 arriving afterwards wrote back a
  // snapshot taken before any of it. The money was taken, the receipt was
  // deleted so nothing could re-verify, and the recoveryCheckedAt it wrote in
  // its place suppressed the re-check for 24 hours.
  const PURCHASE = {
    active: true, source: 'google', token: 'TOKEN-FROM-PURCHASE',
    receipt: 'PLAY-RECEIPT', balanceCredits: 5000
  };

  it('does not let a 404 overwrite the purchase', async () => {
    let release;
    const gate = new Promise(r => { release = r; });
    const page = loadAccessPage({
      fetch: async () => {
        await gate;
        return { ok: false, status: 404, async json() { return { code: 'no_balance_for_account', error: 'none' }; } };
      }
    });
    const pending = page.ctx.reconcileEntitlement(null, 'locked');
    page.stored.entitlement = { ...PURCHASE };
    release();
    await pending;
    expect(page.stored.entitlement).toMatchObject(PURCHASE);
    // ...and the marker it went there to write is still written.
    expect(page.stored.entitlement.recoveryCheckedAt).toBeGreaterThan(0);
  });

  // The hit path has the same hazard and one of its own: /v1/entitlement/recover
  // has never heard of a receipt, so its answer normalizes to receipt: null.
  // Writing that whole object would delete the only durable proof this device
  // has.
  it('keeps the stored receipt when a recovery does find a balance', async () => {
    let release;
    const gate = new Promise(r => { release = r; });
    const page = loadAccessPage({
      fetch: async () => {
        await gate;
        return { ok: true, status: 200, async json() { return { active: true, token: 'ACCOUNT-TOKEN', balanceCredits: 900, src: 'account' }; } };
      }
    });
    const pending = page.ctx.reconcileEntitlement(null, 'locked');
    page.stored.entitlement = { ...PURCHASE };
    release();
    await pending;
    expect(page.stored.entitlement.receipt).toBe('PLAY-RECEIPT');
    expect(page.stored.entitlement.balanceCredits).toBe(900);
  });
});

describe('the low-balance line in the AI access card', () => {
  it('explains insufficient credit without claiming a positive balance is empty', async () => {
    const { ctx, container } = loadPaywall({ window: bridge(), userAgent: ANDROID_UA });
    await ctx.renderPaywall(container, { entitlement: ACTIVE, errorCode: 'balance_exhausted' });
    expect(allText(container)).toContain('Not enough coaching credit to send this message');
    expect(allText(container)).toContain('1,240 coaching credits');
    expect(allText(container)).not.toContain('No coaching credit');
  });
  it('appears at or under the shared threshold and not above it', async () => {
    const low = loadPaywall({ userAgent: CHROME_UA });
    await low.ctx.renderPaywall(low.container, {
      entitlement: { ...ACTIVE, balanceCredits: low.ctx.LOW_CREDIT_CREDITS }
    });
    expect(byClass(low.container, 'int-pw-low')).toHaveLength(1);

    const fine = loadPaywall({ userAgent: CHROME_UA });
    await fine.ctx.renderPaywall(fine.container, {
      entitlement: { ...ACTIVE, balanceCredits: fine.ctx.LOW_CREDIT_CREDITS + 1 }
    });
    expect(byClass(fine.container, 'int-pw-low')).toHaveLength(0);
  });

  // Zero is not low, it is spent — and the paywall is already the screen about
  // that. background.js's getAccess and its chat reply both carry `> 0` for
  // exactly this reason, and without it here a sub-1-credit balance produced
  // three surfaces telling one user three different stories: a header chip
  // reading "Credit 0" with no warning at all, a gate note saying nothing, and
  // this line saying "Running low".
  it('says nothing at a balance that has floored to zero', async () => {
    const { ctx, container } = loadPaywall({ userAgent: CHROME_UA });
    await ctx.renderPaywall(container, { entitlement: { ...ACTIVE, balanceCredits: 0 } });
    expect(byClass(container, 'int-pw-low')).toHaveLength(0);
    expect(allText(container)).not.toContain('Running low');
  });

  // The balance is credits and never a currency figure: what a top-up credits
  // is net of the store's commission and Intention's margin, so a £ amount
  // would read as a broken conversion rather than a game-currency balance.
  it('still states the balance in credits, never in money', async () => {
    const { ctx, container } = loadPaywall({ userAgent: CHROME_UA });
    await ctx.renderPaywall(container, { entitlement: ACTIVE });
    expect(allText(container)).toContain('1,240 coaching credits');
    expect(allText(container)).not.toMatch(/[£$€]/);
  });
});

describe('Coach tab access warning', () => {
  const page = () => {
    const status = makeNode('div');
    const navigator = { userAgent: ANDROID_UA };
    const ctx = loadSource(['providers.js', 'billing.js', 'options-access.js'], {
      extraGlobals: {
        window: { intentionBilling: {}, navigator }, navigator,
        document: { createElement: makeNode, getElementById: (id) => id === 'coach-access-status' ? status : null }
      }
    });
    return { ctx, status };
  };

  it('distinguishes no credit, low credit and insufficient credit, then clears the warning after a top-up', () => {
    const { ctx, status } = page();
    ctx.refreshCoachAccessStatus({ route: 'locked', balanceCredits: 0 });
    expect(allText(status)).toContain('No coaching credit');
    expect(flatten(status).find(n => n.tagName === 'button').textContent).toBe('Top up coaching credit');
    ctx.refreshCoachAccessStatus({ route: 'hosted', lowCredit: true, balanceCredits: 25 });
    expect(allText(status)).toContain('Coaching credit is low: 25 credits');
    ctx.refreshCoachAccessStatus({ route: 'hosted', balanceCredits: 1240 }, 'balance_exhausted');
    expect(allText(status)).toContain('Not enough coaching credit to send this message');
    expect(allText(status)).not.toContain('No coaching credit');
    ctx.refreshCoachAccessStatus({ route: 'hosted', balanceCredits: 2000 });
    expect(status.hidden).toBe(true);
  });

  it('shows no credit warning when coaching uses a saved provider key', () => {
    const { ctx, status } = page();
    ctx.refreshCoachAccessStatus({ route: 'byok', balanceCredits: 0 });
    expect(status.hidden).toBe(true);
  });
});
