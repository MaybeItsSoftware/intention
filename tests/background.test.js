// background.js — session/history keying and the storage-mutation queue.
//
// These cover the two sender shapes the worker actually sees: the extensions
// deliver {tab:{id}}, while the native ports (Android's BackgroundJsHelper,
// iOS's BackgroundJSHost) deliver a sender with no tab at all. The native
// shape has no test coverage anywhere else — there's no way to run the Android
// or iOS hosts from here.

import { describe, it, expect } from 'vitest';
import { loadBackground, makeMockFetch } from './load.js';

const CONFIGURED = { provider: 'anthropic', apiKey: 'test-key', model: 'claude-sonnet-5' };

// Sender shapes: a browser tab vs a native host with no tabs.
const tab = (id) => ({ tab: { id } });
const NATIVE = {};

// An LLM reply that grants `minutes`, in Anthropic's response shape.
function grantingFetch(minutes = 10, reason = 'check DMs') {
  return makeMockFetch({
    content: [
      { type: 'text', text: 'Okay.' },
      { type: 'tool_use', id: 't1', name: 'grant_access', input: { minutes, reason } }
    ]
  });
}

describe('sessionKeyFor', () => {
  it('keys on the tab id when there is one', () => {
    const { ctx } = loadBackground();
    expect(ctx.sessionKeyFor(7, 'instagram.com')).toBe('7');
    expect(ctx.sessionKeyFor(0, 'instagram.com')).toBe('0');
  });

  it('falls back to the target when the sender has no tab', () => {
    const { ctx } = loadBackground();
    expect(ctx.sessionKeyFor(undefined, 'instagram.com')).toBe('target:instagram.com');
    expect(ctx.sessionKeyFor(null, 'com.instagram.android')).toBe('target:com.instagram.android');
  });

  it('is null when there is neither', () => {
    const { ctx } = loadBackground();
    expect(ctx.sessionKeyFor(undefined, undefined)).toBe(null);
  });
});

describe('activeSession', () => {
  it('rejects a banked session even when its time has not run out', () => {
    const { ctx } = loadBackground();
    const session = { domain: 'x.com', startTime: Date.now(), intervalMinutes: 10, endedAt: Date.now() };
    expect(ctx.activeSession(session)).toBe(null);
    expect(ctx.isBanked(session)).toBe(true);
  });

  it('rejects a session whose time has run out but keeps it bankable', () => {
    const { ctx } = loadBackground();
    const session = { domain: 'x.com', startTime: Date.now() - 20 * 60000, intervalMinutes: 10 };
    expect(ctx.activeSession(session)).toBe(null);
    expect(ctx.isBanked(session)).toBe(false);
  });

  it('accepts a live pass', () => {
    const { ctx } = loadBackground();
    const session = { domain: 'x.com', startTime: Date.now(), intervalMinutes: 10 };
    expect(ctx.activeSession(session)).toBe(session);
  });
});

describe('chat from a native host (no sender.tab)', () => {
  it('answers instead of failing with "No history context"', async () => {
    const { ctx } = loadBackground({ seed: CONFIGURED });
    const res = await ctx.handleMessage(
      { action: 'chat', mode: 'gate', domain: 'apps', isApp: true, userMessage: 'hi' },
      NATIVE
    );
    expect(res.error).toBeUndefined();
    expect(res.assistantText).toBe('ok');
  });

  it('keeps a separate history per target', async () => {
    const { ctx, chrome } = loadBackground({ seed: CONFIGURED });
    await ctx.handleMessage(
      { action: 'chat', mode: 'gate', domain: 'instagram.com', userMessage: 'one' },
      NATIVE
    );
    await ctx.handleMessage(
      { action: 'chat', mode: 'gate', domain: 'youtube.com', userMessage: 'two' },
      NATIVE
    );

    const histories = chrome.storage._store.chatHistories;
    expect(Object.keys(histories).sort()).toEqual(['target:instagram.com', 'target:youtube.com']);
    // Neither conversation may see the other's turns.
    expect(histories['target:instagram.com'].map(m => m.content)).toContain('one');
    expect(histories['target:instagram.com'].map(m => m.content)).not.toContain('two');
  });

  it('keeps a separate session per target, so a second grant does not evict the first', async () => {
    const { ctx, chrome } = loadBackground({ seed: CONFIGURED, fetch: grantingFetch(10) });
    await ctx.handleMessage(
      { action: 'chat', mode: 'gate', domain: 'instagram.com', userMessage: 'a' },
      NATIVE
    );
    await ctx.handleMessage(
      { action: 'chat', mode: 'gate', domain: 'youtube.com', userMessage: 'b' },
      NATIVE
    );

    const sessions = chrome.storage._store.activeSessions;
    expect(Object.keys(sessions).sort()).toEqual(['target:instagram.com', 'target:youtube.com']);
    expect(sessions['target:instagram.com'].domain).toBe('instagram.com');
    expect(sessions['target:youtube.com'].domain).toBe('youtube.com');
  });

  it('ends only the target it was asked to end', async () => {
    const { ctx, chrome } = loadBackground({ seed: CONFIGURED, fetch: grantingFetch(10) });
    await ctx.handleMessage(
      { action: 'chat', mode: 'gate', domain: 'instagram.com', userMessage: 'a' },
      NATIVE
    );
    await ctx.handleMessage(
      { action: 'chat', mode: 'gate', domain: 'youtube.com', userMessage: 'b' },
      NATIVE
    );

    // "Not now" on YouTube must not end the Instagram pass.
    await ctx.handleMessage(
      { action: 'endSession', domain: 'youtube.com', reason: 'fulfilled' },
      NATIVE
    );

    const sessions = chrome.storage._store.activeSessions;
    expect(sessions['target:youtube.com']).toBeUndefined();
    expect(sessions['target:instagram.com']).toBeDefined();
  });

  it('scopes the check-in alarm to the target', async () => {
    const { ctx, chrome } = loadBackground({ seed: CONFIGURED, fetch: grantingFetch(10) });
    await ctx.handleMessage(
      { action: 'chat', mode: 'gate', domain: 'instagram.com', userMessage: 'a' },
      NATIVE
    );
    await ctx.handleMessage(
      { action: 'chat', mode: 'gate', domain: 'youtube.com', userMessage: 'b' },
      NATIVE
    );
    expect(chrome.alarms._created.map(a => a.name)).toEqual([
      'checkin-target:instagram.com',
      'checkin-target:youtube.com'
    ]);
  });
});

describe('check-in alarm', () => {
  it('banks a native session without deleting it, so the coach keeps its reason', async () => {
    const { ctx, chrome, listeners } = loadBackground({ seed: CONFIGURED, fetch: grantingFetch(10, 'reply to a DM') });
    await ctx.handleMessage(
      { action: 'chat', mode: 'gate', domain: 'instagram.com', userMessage: 'a' },
      NATIVE
    );
    // Pretend the granted window has passed.
    chrome.storage._store.activeSessions['target:instagram.com'].startTime = Date.now() - 10 * 60000;

    await listeners.alarm({ name: 'checkin-target:instagram.com' });

    const session = chrome.storage._store.activeSessions['target:instagram.com'];
    expect(session).toBeDefined();
    expect(session.endedAt).toBeTypeOf('number');
    expect(session.reason).toBe('reply to a DM');
    expect(ctx.activeSession(session)).toBe(null);
    // Its minutes were recorded, capped at what was granted.
    const stats = await ctx.getStatsForDomain('instagram.com');
    expect(stats.minutesToday).toBe(10);
  });

  it('does not double-count a banked session when it is later ended', async () => {
    const { ctx, chrome, listeners } = loadBackground({ seed: CONFIGURED, fetch: grantingFetch(10) });
    await ctx.handleMessage(
      { action: 'chat', mode: 'gate', domain: 'instagram.com', userMessage: 'a' },
      NATIVE
    );
    chrome.storage._store.activeSessions['target:instagram.com'].startTime = Date.now() - 10 * 60000;

    await listeners.alarm({ name: 'checkin-target:instagram.com' });
    await ctx.handleMessage({ action: 'endSession', domain: 'instagram.com' }, NATIVE);

    const stats = await ctx.getStatsForDomain('instagram.com');
    expect(stats.minutesToday).toBe(10);
    expect(chrome.storage._store.activeSessions['target:instagram.com']).toBeUndefined();
  });

  it('still drops a tab-keyed session when the tab has no content script', async () => {
    const { ctx, chrome, listeners } = loadBackground({ seed: CONFIGURED, fetch: grantingFetch(10) });
    await ctx.handleMessage(
      { action: 'chat', mode: 'gate', domain: 'instagram.com', userMessage: 'a' },
      tab(42)
    );
    expect(chrome.storage._store.activeSessions['42']).toBeDefined();

    // The mock's tabs.sendMessage rejects, standing in for a closed tab.
    await listeners.alarm({ name: 'checkin-42' });
    expect(chrome.storage._store.activeSessions['42']).toBeUndefined();
  });
});

// Stands in for what the native hosts do on start: Android's BootReceiver and
// BackgroundJsHelper, and iOS's BackgroundJSHost, both send
// { action: 'reconcileSessions' } once the background page is up, because a
// device restart leaves them with sessions in storage but no alarms.
describe('reconcileSessions', () => {
  it('banks a pass that ran out while the device was off', async () => {
    const { ctx, chrome } = loadBackground({ seed: CONFIGURED, fetch: grantingFetch(10, 'reply to a DM') });
    await ctx.handleMessage(
      { action: 'chat', mode: 'gate', domain: 'instagram.com', userMessage: 'a' },
      NATIVE
    );
    // The pass ran out while the phone was powered off, so its alarm never fired.
    chrome.storage._store.activeSessions['target:instagram.com'].startTime = Date.now() - 30 * 60000;

    const res = await ctx.handleMessage({ action: 'reconcileSessions' }, NATIVE);

    expect(res.banked).toEqual(['target:instagram.com']);
    expect(res.rearmed).toEqual([]);
    // Capped at what was granted, not the half hour the phone was off for.
    const stats = await ctx.getStatsForDomain('instagram.com');
    expect(stats.minutesToday).toBe(10);
    // Kept, so a check-in can still quote the reason.
    const session = chrome.storage._store.activeSessions['target:instagram.com'];
    expect(session.reason).toBe('reply to a DM');
    expect(ctx.activeSession(session)).toBe(null);
  });

  it('re-arms the check-in for a pass with time left, at its original expiry', async () => {
    const { ctx, chrome } = loadBackground({ seed: CONFIGURED, fetch: grantingFetch(10) });
    await ctx.handleMessage(
      { action: 'chat', mode: 'gate', domain: 'instagram.com', userMessage: 'a' },
      NATIVE
    );
    const session = chrome.storage._store.activeSessions['target:instagram.com'];
    // Four of the ten granted minutes were spent before the restart.
    session.startTime = Date.now() - 4 * 60000;
    chrome.alarms._created.length = 0;

    const res = await ctx.handleMessage({ action: 'reconcileSessions' }, NATIVE);

    expect(res.banked).toEqual([]);
    expect(res.rearmed).toEqual(['target:instagram.com']);
    expect(chrome.alarms._created).toHaveLength(1);
    const alarm = chrome.alarms._created[0];
    expect(alarm.name).toBe('checkin-target:instagram.com');
    // Absolute expiry, so the remaining six minutes are what's left — not a
    // fresh ten from the moment the device came back up.
    expect(alarm.info.when).toBe(session.startTime + 10 * 60000);
    // Still a live pass: the user is not re-gated for time they already have.
    const stats = await ctx.getStatsForDomain('instagram.com');
    expect(stats.minutesToday).toBe(0);
  });

  it('leaves an already-banked session alone, so minutes are never counted twice', async () => {
    const { ctx, chrome, listeners } = loadBackground({ seed: CONFIGURED, fetch: grantingFetch(10) });
    await ctx.handleMessage(
      { action: 'chat', mode: 'gate', domain: 'instagram.com', userMessage: 'a' },
      NATIVE
    );
    chrome.storage._store.activeSessions['target:instagram.com'].startTime = Date.now() - 10 * 60000;
    await listeners.alarm({ name: 'checkin-target:instagram.com' });

    // Two reconciles on top of the alarm that already banked it.
    await ctx.handleMessage({ action: 'reconcileSessions' }, NATIVE);
    const res = await ctx.handleMessage({ action: 'reconcileSessions' }, NATIVE);

    expect(res.banked).toEqual([]);
    expect(res.rearmed).toEqual([]);
    const stats = await ctx.getStatsForDomain('instagram.com');
    expect(stats.minutesToday).toBe(10);
  });

  it('handles every session in storage, not just the first', async () => {
    const now = Date.now();
    const { ctx, chrome } = loadBackground({
      seed: {
        ...CONFIGURED,
        activeSessions: {
          'target:instagram.com': { domain: 'instagram.com', intervalMinutes: 10, startTime: now - 30 * 60000 },
          'target:youtube.com': { domain: 'youtube.com', intervalMinutes: 15, startTime: now - 60 * 60000 },
          'target:com.reddit.frontpage': { domain: 'com.reddit.frontpage', intervalMinutes: 5, startTime: now - 60000 }
        }
      }
    });

    const res = await ctx.handleMessage({ action: 'reconcileSessions' }, NATIVE);

    expect(res.banked.sort()).toEqual(['target:instagram.com', 'target:youtube.com']);
    expect(res.rearmed).toEqual(['target:com.reddit.frontpage']);
    expect((await ctx.getStatsForDomain('instagram.com')).minutesToday).toBe(10);
    expect((await ctx.getStatsForDomain('youtube.com')).minutesToday).toBe(15);
    expect(chrome.alarms._created.map(a => a.name)).toEqual(['checkin-target:com.reddit.frontpage']);
  });

  it('is a no-op when there are no sessions', async () => {
    const { ctx, chrome } = loadBackground({ seed: CONFIGURED });
    const res = await ctx.handleMessage({ action: 'reconcileSessions' }, NATIVE);
    expect(res).toEqual({ banked: [], rearmed: [] });
    expect(chrome.alarms._created).toEqual([]);
  });
});

describe('extension tab keying still holds', () => {
  it('gives two tabs on the same site their own sessions and histories', async () => {
    const { ctx, chrome } = loadBackground({ seed: CONFIGURED, fetch: grantingFetch(10) });
    await ctx.handleMessage(
      { action: 'chat', mode: 'gate', domain: 'instagram.com', userMessage: 'a' },
      tab(1)
    );
    await ctx.handleMessage(
      { action: 'chat', mode: 'gate', domain: 'instagram.com', userMessage: 'b' },
      tab(2)
    );

    expect(Object.keys(chrome.storage._store.activeSessions).sort()).toEqual(['1', '2']);
    expect(Object.keys(chrome.storage._store.chatHistories).sort()).toEqual(['1', '2']);
  });

  it('closing a tab records its minutes and clears its state', async () => {
    const { ctx, chrome, listeners } = loadBackground({ seed: CONFIGURED, fetch: grantingFetch(10) });
    await ctx.handleMessage(
      { action: 'chat', mode: 'gate', domain: 'instagram.com', userMessage: 'a' },
      tab(5)
    );
    chrome.storage._store.activeSessions['5'].startTime = Date.now() - 4 * 60000;

    await listeners.tabRemoved(5);

    expect(chrome.storage._store.activeSessions['5']).toBeUndefined();
    expect(chrome.storage._store.chatHistories['5']).toBeUndefined();
    const stats = await ctx.getStatsForDomain('instagram.com');
    expect(stats.minutesToday).toBe(4);
  });

  it('reports a session to checkPageMatch only while it is live', async () => {
    const { ctx, chrome } = loadBackground({
      seed: { ...CONFIGURED, setupComplete: true, blockedDomains: ['instagram.com'] },
      fetch: grantingFetch(10)
    });
    await ctx.handleMessage(
      { action: 'chat', mode: 'gate', domain: 'instagram.com', userMessage: 'a' },
      tab(3)
    );

    let match = await ctx.handleMessage({ action: 'checkPageMatch', host: 'www.instagram.com' }, tab(3));
    expect(match.isBlocked).toBe(true);
    expect(match.session).not.toBe(null);

    // Run the clock past the granted window without firing the alarm — a
    // restarted service worker loses its alarms, and the pass must not outlive
    // its minutes just because nothing was there to close it.
    chrome.storage._store.activeSessions['3'].startTime = Date.now() - 30 * 60000;
    match = await ctx.handleMessage({ action: 'checkPageMatch', host: 'www.instagram.com' }, tab(3));
    expect(match.session).toBe(null);
  });
});

describe('concurrent writes', () => {
  it('does not let one conversation drop another\'s history', async () => {
    // Both calls read chatHistories, then await the LLM, then write it back.
    // Without the mutation queue the second write clobbers the first.
    const slowFetch = makeMockFetch(async () => {
      await new Promise(r => setTimeout(r, 5));
      return { content: [{ type: 'text', text: 'ok' }] };
    });
    const { ctx, chrome } = loadBackground({ seed: CONFIGURED, fetch: slowFetch });

    await Promise.all([
      ctx.handleMessage({ action: 'chat', mode: 'gate', domain: 'a.com', userMessage: 'one' }, NATIVE),
      ctx.handleMessage({ action: 'chat', mode: 'gate', domain: 'b.com', userMessage: 'two' }, NATIVE)
    ]);

    const histories = chrome.storage._store.chatHistories;
    expect(Object.keys(histories).sort()).toEqual(['target:a.com', 'target:b.com']);
  });

  it('does not let concurrent stats writes drop each other', async () => {
    const { ctx } = loadBackground();
    await Promise.all([
      ctx.recordSessionMinutes('a.com', 5),
      ctx.recordSessionMinutes('b.com', 7),
      ctx.recordSessionMinutes('a.com', 3)
    ]);
    expect((await ctx.getStatsForDomain('a.com')).minutesToday).toBe(8);
    expect((await ctx.getStatsForDomain('b.com')).minutesToday).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// AI access routing (Apple guideline 3.1.1 refactor)
// ---------------------------------------------------------------------------
//
// Three states, and which one wins matters: a fresh install must land on the
// subscription (never on a key prompt), a configured custom key must override
// it, and neither present must lock the coach rather than failing at the LLM.

const ACTIVE_ENTITLEMENT = {
  active: true,
  token: 'entitlement-token',
  productId: 'uk.co.maybeitssoftware.intention.pro.monthly',
  expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
  source: 'apple'
};

describe('resolveAIRoute', () => {
  it('locks a fresh install — no key, no subscription', async () => {
    const { ctx } = loadBackground();
    expect((await ctx.resolveAIRoute()).route).toBe('locked');
  });

  it('routes to the hosted backend on an active entitlement', async () => {
    const { ctx } = loadBackground({ seed: { entitlement: ACTIVE_ENTITLEMENT } });
    const route = await ctx.resolveAIRoute();
    expect(route.route).toBe('hosted');
    expect(route.provider).toBe('intention');
    expect(route.accessToken).toBe('entitlement-token');
  });

  it('lets a custom key override an active subscription', async () => {
    const { ctx } = loadBackground({ seed: { entitlement: ACTIVE_ENTITLEMENT, ...CONFIGURED } });
    const route = await ctx.resolveAIRoute();
    expect(route.route).toBe('byok');
    expect(route.provider).toBe('anthropic');
    expect(route.apiKey).toBe('test-key');
  });

  it('locks when the entitlement has lapsed beyond its grace period', async () => {
    const lapsed = { ...ACTIVE_ENTITLEMENT, expiresAt: Date.now() - 8 * 24 * 60 * 60 * 1000 };
    const { ctx } = loadBackground({ seed: { entitlement: lapsed } });
    expect((await ctx.resolveAIRoute()).route).toBe('locked');
  });

  // Renewals can post slightly late, and a skewed device clock shouldn't lock
  // out someone who is paying.
  it('holds access briefly past expiry', async () => {
    const justExpired = { ...ACTIVE_ENTITLEMENT, expiresAt: Date.now() - 60 * 1000 };
    const { ctx } = loadBackground({ seed: { entitlement: justExpired } });
    expect((await ctx.resolveAIRoute()).route).toBe('hosted');
  });

  it('ignores an entitlement the backend has rejected', async () => {
    const dead = { ...ACTIVE_ENTITLEMENT, active: false };
    const { ctx } = loadBackground({ seed: { entitlement: dead } });
    expect((await ctx.resolveAIRoute()).route).toBe('locked');
  });
});

describe('handleChat access gating', () => {
  it('returns locked instead of calling any provider when there is no access', async () => {
    const fetch = makeMockFetch({ content: [{ type: 'text', text: 'should not happen' }] });
    const { ctx } = loadBackground({ seed: { blockedDomains: ['x.com'] }, fetch });
    const res = await ctx.handleChat({ tabId: 1, mode: 'gate', domain: 'x.com', userMessage: 'hi' });
    expect(res.locked).toBe(true);
    expect(fetch.calls.length).toBe(0);
  });

  it('sends hosted calls to the backend with the entitlement token, not an API key', async () => {
    const fetch = makeMockFetch({ text: 'Okay.', toolCalls: [] });
    const { ctx } = loadBackground({ seed: { entitlement: ACTIVE_ENTITLEMENT }, fetch });
    const res = await ctx.handleChat({ tabId: 1, mode: 'gate', domain: 'x.com', userMessage: 'hi' });
    expect(res.assistantText).toBe('Okay.');
    const call = fetch.calls[0];
    expect(call.url).toMatch(/\/v1\/chat$/);
    expect(call.init.headers.authorization).toBe('Bearer entitlement-token');
    expect(call.init.headers['x-api-key']).toBeUndefined();
  });

  it('still honours the grant tool over the hosted route', async () => {
    const fetch = makeMockFetch({
      text: 'Ten minutes.',
      toolCalls: [{ id: 't1', name: 'grant_access', input: { minutes: 10, reason: 'reply to a DM' } }]
    });
    const { ctx } = loadBackground({ seed: { entitlement: ACTIVE_ENTITLEMENT }, fetch });
    const res = await ctx.handleChat({ tabId: 4, mode: 'gate', domain: 'x.com', userMessage: 'hi' });
    expect(res.grantedSession.intervalMinutes).toBe(10);
  });

  // A subscription that lapsed mid-conversation has to stop counting as access,
  // or every retry produces the same failure with no way back to the paywall.
  it('marks the entitlement stale when the backend rejects it', async () => {
    const fetch = makeMockFetch({ status: 401, json: { code: 'entitlement_expired', error: 'gone' } });
    const { ctx, chrome } = loadBackground({ seed: { entitlement: ACTIVE_ENTITLEMENT }, fetch });
    const res = await ctx.handleChat({ tabId: 1, mode: 'gate', domain: 'x.com', userMessage: 'hi' });
    expect(res.locked).toBe(true);
    expect(chrome.storage._store.entitlement.active).toBe(false);
    expect((await ctx.resolveAIRoute()).route).toBe('locked');
  });

  it('leaves a working entitlement alone on an ordinary network failure', async () => {
    const fetch = async () => { throw new TypeError('Failed to fetch'); };
    fetch.calls = [];
    const { ctx, chrome } = loadBackground({ seed: { entitlement: ACTIVE_ENTITLEMENT }, fetch });
    const res = await ctx.handleChat({ tabId: 1, mode: 'gate', domain: 'x.com', userMessage: 'hi' });
    expect(res.networkError).toBe(true);
    expect(res.locked).toBeUndefined();
    expect(chrome.storage._store.entitlement.active).toBe(true);
  });
});

describe('entitlement storage', () => {
  it('normalizes what it stores and reports the route back', async () => {
    const { ctx, chrome } = loadBackground();
    await ctx.handleMessage({ action: 'saveEntitlement', entitlement: { ...ACTIVE_ENTITLEMENT, junk: 'x' } }, {});
    expect(chrome.storage._store.entitlement.junk).toBeUndefined();
    expect(chrome.storage._store.entitlement.token).toBe('entitlement-token');
    const access = await ctx.handleMessage({ action: 'getAccess' }, {});
    expect(access.route).toBe('hosted');
    expect(access.hasCustomKey).toBe(false);
  });

  it('clears the entitlement when handed nothing', async () => {
    const { ctx, chrome } = loadBackground({ seed: { entitlement: ACTIVE_ENTITLEMENT } });
    await ctx.handleMessage({ action: 'saveEntitlement', entitlement: null }, {});
    expect(chrome.storage._store.entitlement).toBe(null);
  });

  it('reports the custom key route without leaking the key itself', async () => {
    const { ctx } = loadBackground({ seed: CONFIGURED });
    const access = await ctx.handleMessage({ action: 'getAccess' }, {});
    expect(access.route).toBe('byok');
    expect(access.hasCustomKey).toBe(true);
    expect(access.customProvider).toBe('anthropic');
    expect(JSON.stringify(access)).not.toContain('test-key');
  });
});

describe('checkPageMatch reports access', () => {
  it('tells the content script when there is no coach to talk to', async () => {
    const { ctx } = loadBackground({ seed: { blockedDomains: ['x.com'], setupComplete: true } });
    const res = await ctx.checkPageMatch('x.com', 1);
    expect(res.isBlocked).toBe(true);
    expect(res.accessRoute).toBe('locked');
  });
});

describe('setup no longer collects credentials', () => {
  it('completes with no provider or key', async () => {
    const { ctx, chrome } = loadBackground();
    await ctx.handleMessage({
      action: 'saveSetup',
      config: { userContext: 'ctx', blockedDomains: ['x.com'], domainLimits: {} }
    }, {});
    expect(chrome.storage._store.setupComplete).toBe(true);
    expect(chrome.storage._store.apiKey).toBe('');
    expect(chrome.storage._store.provider).toBe('');
  });
});
