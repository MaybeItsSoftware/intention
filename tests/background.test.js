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

// Sender shapes: a content script in a browser tab (which always carries the
// page URL), an extension page (options/coaching), and a native host with no
// tabs. host defaults to the page the gate actually runs on in most tests.
const tab = (id, host = 'instagram.com') => ({ tab: { id }, url: `https://${host}/` });
const EXT_PAGE = { url: 'chrome-extension://test/coaching.html' };
const NATIVE = {};

// Transcripts are keyed per (site, day) — deliberately NOT per tab like
// sessions and alarms, so the coach remembers a conversation you continue in
// another tab, and forgets it tomorrow.
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const transcript = (domain) => `site:${domain}:${today()}`;

// An LLM reply that grants `minutes`, in Anthropic's response shape.
function grantingFetch(minutes = 10, reason = 'check DMs') {
  return makeMockFetch({
    content: [
      { type: 'text', text: 'Okay.' },
      { type: 'tool_use', id: 't1', name: 'grant_access', input: { minutes, reason } }
    ]
  });
}

// Same, but the model attests this grant as the daily quick check.
function quickCheckFetch(minutes = 3, reason = 'grab an address') {
  return makeMockFetch({
    content: [
      { type: 'text', text: 'Okay.' },
      { type: 'tool_use', id: 't1', name: 'grant_access', input: { minutes, reason, quick_check: true } }
    ]
  });
}

// The system prompt of the most recent request. handleChat now sends the
// cache-split block array (splitSystemForCache), so normalise string-or-blocks
// back to one string before asserting on its contents.
const systemPromptOf = (fetch) => {
  const s = JSON.parse(fetch.calls.at(-1).init.body).system;
  return typeof s === 'string' ? s : s.map(b => b.text).join('\n');
};

describe('sessionKeyFor', () => {
  it('keys on the tab id when there is one', () => {
    const { ctx } = loadBackground();
    expect(ctx.sessionKeyFor(7, 'instagram.com')).toBe('tab:7:instagram.com');
    expect(ctx.sessionKeyFor(0, 'instagram.com')).toBe('tab:0:instagram.com');
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
    expect(Object.keys(histories).sort())
      .toEqual([transcript('instagram.com'), transcript('youtube.com')]);
    // Neither conversation may see the other's turns.
    expect(histories[transcript('instagram.com')].map(m => m.content)).toContain('one');
    expect(histories[transcript('instagram.com')].map(m => m.content)).not.toContain('two');
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
    expect(chrome.storage._store.activeSessions['tab:42:instagram.com']).toBeDefined();

    // The mock's tabs.sendMessage rejects, standing in for a closed tab.
    await listeners.alarm({ name: 'checkin-tab:42:instagram.com' });
    expect(chrome.storage._store.activeSessions['tab:42:instagram.com']).toBeUndefined();
  });

  it('banks the minutes of an unreachable tab before dropping its session', async () => {
    const { ctx, chrome, listeners } = loadBackground({ seed: CONFIGURED, fetch: grantingFetch(10) });
    await ctx.handleMessage(
      { action: 'chat', mode: 'gate', domain: 'instagram.com', userMessage: 'a' },
      tab(42)
    );
    chrome.storage._store.activeSessions['tab:42:instagram.com'].startTime = Date.now() - 10 * 60000;

    // Deleting without banking used to lose these minutes entirely: nothing
    // else ever records a deleted session's time.
    await listeners.alarm({ name: 'checkin-tab:42:instagram.com' });

    expect(chrome.storage._store.activeSessions['tab:42:instagram.com']).toBeUndefined();
    const stats = await ctx.getStatsForDomain('instagram.com');
    expect(stats.minutesToday).toBe(10);
    expect(stats.sessionsToday[0].outcome).toBe('ran_out');
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

    // A pass belongs to one tab, so the sessions stay separate...
    expect(Object.keys(chrome.storage._store.activeSessions).sort())
      .toEqual(['tab:1:instagram.com', 'tab:2:instagram.com']);
    // ...but the conversation does not. Opening the same site in a second tab
    // continues the argument rather than meeting a coach with no memory of it.
    const histories = chrome.storage._store.chatHistories;
    expect(Object.keys(histories)).toEqual([transcript('instagram.com')]);
    expect(histories[transcript('instagram.com')].map(m => m.content))
      .toEqual(expect.arrayContaining(['a', 'b']));
  });

  it('closing a tab records its minutes and clears its state', async () => {
    const { ctx, chrome, listeners } = loadBackground({ seed: CONFIGURED, fetch: grantingFetch(10) });
    await ctx.handleMessage(
      { action: 'chat', mode: 'gate', domain: 'instagram.com', userMessage: 'a' },
      tab(5)
    );
    chrome.storage._store.activeSessions['tab:5:instagram.com'].startTime = Date.now() - 4 * 60000;

    await listeners.tabRemoved(5);

    expect(chrome.storage._store.activeSessions['tab:5:instagram.com']).toBeUndefined();
    const stats = await ctx.getStatsForDomain('instagram.com');
    expect(stats.minutesToday).toBe(4);
    // The transcript outlives the tab on purpose: coming back later the same
    // day should not reset the coach's memory of why you were here.
    expect(chrome.storage._store.chatHistories[transcript('instagram.com')]).toBeDefined();
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
    chrome.storage._store.activeSessions['tab:3:instagram.com'].startTime = Date.now() - 30 * 60000;
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
    expect(Object.keys(histories).sort()).toEqual([transcript('a.com'), transcript('b.com')]);
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

// --------------------------------------------------------------------------
// Safari: the coaching page has no sender.tab, and WebKit does not reliably
// honour a session rule's tabIds condition. Both used to strand the user on
// the gate straight after it granted them time.
// --------------------------------------------------------------------------

// Stateful declarativeNetRequest mock — the default one in load.js forgets
// every rule, which is exactly what these tests are about.
function statefulDnr(chrome) {
  let dynamic = [];
  let session = [];
  // Ids are unique in a real rule store: an add replaces whatever held the id.
  const apply = (list, { removeRuleIds = [], addRules = [] } = {}) => {
    const addedIds = addRules.map(r => r.id);
    return list
      .filter(r => !removeRuleIds.includes(r.id) && !addedIds.includes(r.id))
      .concat(addRules);
  };
  chrome.declarativeNetRequest = {
    getDynamicRules: async () => structuredClone(dynamic),
    updateDynamicRules: async (update) => { dynamic = apply(dynamic, update); },
    updateSessionRules: async (update) => { session = apply(session, update); },
    redirectedDomains: () => dynamic.map(r => r.condition.urlFilter).sort(),
    allowedTabs: () => session.map(r => r.condition.tabIds?.[0]).sort()
  };
  return chrome.declarativeNetRequest;
}

describe('a live pass lifts the domain redirect rule', () => {
  it('drops the rule on grant and restores it when the session ends', async () => {
    const { ctx, chrome } = loadBackground({
      seed: { ...CONFIGURED, setupComplete: true, blockedDomains: ['instagram.com'] },
      fetch: grantingFetch(10)
    });
    const dnr = statefulDnr(chrome);

    await ctx.syncBlockingRules();
    expect(dnr.redirectedDomains()).toEqual(['||instagram.com^']);

    await ctx.handleMessage(
      { action: 'chat', mode: 'gate', domain: 'instagram.com', userMessage: 'a' },
      tab(3)
    );
    // Without this the redirect rule would fire on the way back to the site
    // and drop the user right back on the gate they just talked through.
    expect(dnr.redirectedDomains()).toEqual([]);
    expect(dnr.allowedTabs()).toEqual([3]);

    await ctx.handleMessage(
      { action: 'endSession', domain: 'instagram.com', reason: 'fulfilled' },
      tab(3)
    );
    expect(dnr.redirectedDomains()).toEqual(['||instagram.com^']);
  });

  it('restores the rule on the next visit if the pass expired unnoticed', async () => {
    const { ctx, chrome } = loadBackground({
      seed: { ...CONFIGURED, setupComplete: true, blockedDomains: ['instagram.com'] },
      fetch: grantingFetch(10)
    });
    const dnr = statefulDnr(chrome);
    await ctx.handleMessage(
      { action: 'chat', mode: 'gate', domain: 'instagram.com', userMessage: 'a' },
      tab(3)
    );
    expect(dnr.redirectedDomains()).toEqual([]);

    // Time runs out with no alarm to notice it (a suspended background page).
    chrome.storage._store.activeSessions['tab:3:instagram.com'].startTime = Date.now() - 30 * 60000;
    await ctx.handleMessage({ action: 'checkPageMatch', host: 'www.instagram.com' }, tab(3));
    // checkPageMatch kicks off the resync without waiting for it, so the page
    // isn't held up; queueing behind it is how a test waits for that work.
    await ctx.syncBlockingRules();
    expect(dnr.redirectedDomains()).toEqual(['||instagram.com^']);
  });
});

// --------------------------------------------------------------------------
// Safari accepts a redirect rule pointing at an extension page and then fails
// the load — NSURLErrorFileDoesNotExist, "Safari Can't Find the File" — so
// every blocked visit ended on an error page instead of the gate, and the
// content script that would have gated it never ran.
// --------------------------------------------------------------------------
describe('a runtime whose DNR cannot reach the gate', () => {
  const seedBlocked = { ...CONFIGURED, setupComplete: true, blockedDomains: ['instagram.com'] };

  it('is left to the content script rather than given a redirect rule', async () => {
    const { ctx, chrome } = loadBackground({ seed: seedBlocked, native: true });
    const dnr = statefulDnr(chrome);

    await ctx.syncBlockingRules();

    expect(dnr.redirectedDomains()).toEqual([]);
  });

  it('has the rules an earlier version installed taken back off it', async () => {
    const { ctx, chrome } = loadBackground({ seed: seedBlocked, native: true });
    const dnr = statefulDnr(chrome);
    await chrome.declarativeNetRequest.updateDynamicRules({
      addRules: [{
        id: 1000,
        priority: 1,
        action: { type: 'redirect', redirect: { extensionPath: '/coaching.html?domain=instagram.com' } },
        condition: { urlFilter: '||instagram.com^', resourceTypes: ['main_frame'] }
      }]
    });

    await ctx.syncBlockingRules();

    expect(dnr.redirectedDomains()).toEqual([]);
  });

  it('still gates the page it let through', async () => {
    const { ctx } = loadBackground({ seed: seedBlocked, native: true });
    const match = await ctx.handleMessage({ action: 'checkPageMatch', host: 'www.instagram.com' }, tab(3));
    expect(match.isBlocked).toBe(true);
    expect(match.session).toBe(null);
  });
});

describe('a rule set that points somewhere wrong', () => {
  it('is rewritten, not read as already correct', async () => {
    const { ctx, chrome } = loadBackground({
      seed: { ...CONFIGURED, setupComplete: true, blockedDomains: ['instagram.com'] }
    });
    statefulDnr(chrome);
    // Same domain, wrong target: a check that compared only what a rule
    // catches called this correct and left the user with no way back.
    await chrome.declarativeNetRequest.updateDynamicRules({
      addRules: [{
        id: 1000,
        priority: 1,
        action: { type: 'redirect', redirect: { extensionPath: '/gone.html?domain=instagram.com' } },
        condition: { urlFilter: '||instagram.com^', resourceTypes: ['main_frame'] }
      }]
    });

    await ctx.syncBlockingRules();

    const targets = (await chrome.declarativeNetRequest.getDynamicRules())
      .map(r => r.action.redirect.extensionPath);
    expect(targets).toEqual(['/coaching.html?domain=instagram.com']);
  });
});

describe('sessions granted without a tab id', () => {
  it('are visible to the content script that lands on the site', async () => {
    const { ctx } = loadBackground({
      seed: {
        ...CONFIGURED,
        setupComplete: true,
        blockedDomains: ['instagram.com'],
        activeSessions: {
          'target:instagram.com': { domain: 'instagram.com', startTime: Date.now(), intervalMinutes: 10 }
        }
      }
    });
    const match = await ctx.handleMessage({ action: 'checkPageMatch', host: 'www.instagram.com' }, tab(4));
    expect(match.isBlocked).toBe(true);
    expect(match.session).not.toBe(null);

    const asked = await ctx.handleMessage({ action: 'getSession', domain: 'instagram.com' }, tab(4));
    expect(asked.session).not.toBe(null);
  });
});

describe('tab id sent by an extension page', () => {
  it('keys the session when the sender carries no tab', async () => {
    const { ctx, chrome } = loadBackground({
      seed: { ...CONFIGURED, setupComplete: true, blockedDomains: ['instagram.com'] },
      fetch: grantingFetch(10)
    });
    await ctx.handleMessage(
      { action: 'chat', mode: 'gate', domain: 'instagram.com', userMessage: 'a', tabId: 9 },
      NATIVE
    );
    expect(Object.keys(chrome.storage._store.activeSessions)).toEqual(['tab:9:instagram.com']);
  });

  it('never overrides a real sender.tab', async () => {
    const { ctx } = loadBackground({
      seed: {
        ...CONFIGURED,
        activeSessions: {
          '99': { domain: 'instagram.com', startTime: Date.now(), intervalMinutes: 10 }
        }
      }
    });
    const asked = await ctx.handleMessage(
      { action: 'getSession', domain: 'instagram.com', tabId: 99 },
      tab(5)
    );
    expect(asked.session).toBe(null);
  });
});

// The coach's grant_access path was a hand-inlined copy of grantSession that
// had dropped its opening recordGrant call. Since stats.grantsToday is fed
// only by recordGrant, the daily cap compared 0 >= 3 forever and the
// escalating-skepticism prompt had no reasons to escalate on. Every test here
// fails against that version.
describe('an AI-granted pass is recorded like any other', () => {
  it('counts towards the day, so the cap can ever be reached', async () => {
    const { ctx } = loadBackground({ seed: CONFIGURED, fetch: grantingFetch(10, 'check DMs') });
    await ctx.handleMessage(
      { action: 'chat', mode: 'gate', domain: 'instagram.com', userMessage: 'a' },
      NATIVE
    );
    const stats = await ctx.getStatsForDomain('instagram.com');
    expect(stats.grantsToday).toBe(1);
  });

  it('refuses a fourth grant and says why, instead of granting forever', async () => {
    const { ctx, chrome, fetch } = loadBackground({ seed: CONFIGURED, fetch: grantingFetch(5, 'one more look') });
    for (let i = 0; i < 3; i++) {
      await ctx.handleMessage(
        { action: 'chat', mode: 'gate', domain: 'instagram.com', userMessage: 'a' },
        NATIVE
      );
      // Retire each pass so the next call is a fresh grant, not an extension.
      delete chrome.storage._store.activeSessions['target:instagram.com'];
    }
    expect((await ctx.getStatsForDomain('instagram.com')).grantsToday).toBe(3);

    const fourth = await ctx.handleMessage(
      { action: 'chat', mode: 'gate', domain: 'instagram.com', userMessage: 'a' },
      NATIVE
    );
    expect(fourth.grantedSession ?? null).toBe(null);
    expect(chrome.storage._store.activeSessions['target:instagram.com']).toBeUndefined();
    // The fact lives in systemNote for the UI to render outside the chat; the
    // rejection also fires the honesty turn, so the reply is two texts joined
    // and the fourth conversation cost two calls (3 grants + 2 = 5 total).
    // The lane is on by default and unspent, so the refusal names the one
    // remaining exception rather than declaring the day fully closed.
    expect(fourth.systemNote).toBe('Daily grant cap reached — only the 3-minute quick check is still available today.');
    expect(fetch.calls.length).toBe(5);
    expect(fourth.assistantText).toBe('Okay.\n\nOkay.');
  });

  it('declares the day fully closed once the quick check is spent too', async () => {
    const { ctx } = loadBackground({
      seed: {
        ...CONFIGURED,
        dailyStats: {
          [today()]: { 'instagram.com': { minutes: 15, grants: 3, quickChecks: 1, sessions: [] } }
        }
      },
      fetch: grantingFetch(5, 'one more look')
    });
    const resp = await ctx.handleMessage(
      { action: 'chat', mode: 'gate', domain: 'instagram.com', userMessage: 'a' },
      NATIVE
    );
    expect(resp.grantedSession ?? null).toBe(null);
    expect(resp.systemNote).toBe('Daily grant cap reached — no more time can be granted today.');
  });

  it('honours a per-domain cap lower than the default', async () => {
    const { ctx, chrome, fetch } = loadBackground({
      seed: { ...CONFIGURED, domainLimits: { 'instagram.com': { maxGrants: 1 } } },
      fetch: grantingFetch(5)
    });
    await ctx.handleMessage(
      { action: 'chat', mode: 'gate', domain: 'instagram.com', userMessage: 'a' },
      NATIVE
    );
    delete chrome.storage._store.activeSessions['target:instagram.com'];

    const second = await ctx.handleMessage(
      { action: 'chat', mode: 'gate', domain: 'instagram.com', userMessage: 'a' },
      NATIVE
    );
    expect(second.grantedSession ?? null).toBe(null);
    expect(second.systemNote).toBe('Daily grant cap reached — only the 3-minute quick check is still available today.');
    // Rejection + honesty turn: one call for the first grant, two for this.
    expect(fetch.calls.length).toBe(3);
    expect(second.assistantText).toBe('Okay.\n\nOkay.');
  });

  it('feeds the stated reason back into the prompt context', async () => {
    const { ctx } = loadBackground({ seed: CONFIGURED, fetch: grantingFetch(10, 'reply to a DM') });
    await ctx.handleMessage(
      { action: 'chat', mode: 'gate', domain: 'instagram.com', userMessage: 'a' },
      NATIVE
    );
    const stats = await ctx.getStatsForDomain('instagram.com');
    expect(stats.reasonsToday).toContain('reply to a DM');
  });

  it('leaves the same state behind as the no-AI simple path', async () => {
    const seed = { ...CONFIGURED, blockedDomains: ['instagram.com'] };
    const viaCoach = loadBackground({ seed, fetch: grantingFetch(10, 'check DMs') });
    await viaCoach.ctx.handleMessage(
      { action: 'chat', mode: 'gate', domain: 'instagram.com', userMessage: 'a' },
      tab(7)
    );

    const viaSimple = loadBackground({ seed: { ...seed, blockingMode: 'simple' } });
    await viaSimple.ctx.handleMessage(
      { action: 'simpleGrant', domain: 'instagram.com' },
      tab(7)
    );

    const coachSession = viaCoach.chrome.storage._store.activeSessions['tab:7:instagram.com'];
    const simpleSession = viaSimple.chrome.storage._store.activeSessions['tab:7:instagram.com'];
    expect(Object.keys(coachSession).sort()).toEqual(Object.keys(simpleSession).sort());
    expect((await viaCoach.ctx.getStatsForDomain('instagram.com')).grantsToday)
      .toBe((await viaSimple.ctx.getStatsForDomain('instagram.com')).grantsToday);
  });
});

// The quick check: a small daily lane the coach may grant immediately, on by
// default, mechanically fenced here so the model cannot be sweet-talked past
// its budget. Separate from the grants cap by design; never separate from the
// absolute minutes cap.
describe('the quick-check lane', () => {
  const dayStats = (site) => ({ [today()]: { 'instagram.com': site } });

  it('spends the lane, not a grant, and flags the session', async () => {
    const { ctx, chrome, fetch } = loadBackground({ seed: CONFIGURED, fetch: quickCheckFetch(3) });
    const resp = await ctx.handleMessage(
      { action: 'chat', mode: 'gate', domain: 'instagram.com', userMessage: 'need the address from a DM' },
      NATIVE
    );
    expect(resp.grantedSession.intervalMinutes).toBe(3);
    expect(resp.systemNote ?? '').toBe('');
    expect(fetch.calls.length).toBe(1);
    const stats = await ctx.getStatsForDomain('instagram.com');
    expect(stats.grantsToday).toBe(0);
    expect(stats.quickChecksToday).toBe(1);
    expect(chrome.storage._store.activeSessions['target:instagram.com'].quickCheck).toBe(true);
  });

  it('stays available after the grants cap is hit', async () => {
    const { ctx } = loadBackground({
      seed: { ...CONFIGURED, dailyStats: dayStats({ minutes: 15, grants: 3, sessions: [] }) },
      fetch: quickCheckFetch(3)
    });
    const resp = await ctx.handleMessage(
      { action: 'chat', mode: 'gate', domain: 'instagram.com', userMessage: 'check one message' },
      NATIVE
    );
    expect(resp.grantedSession.intervalMinutes).toBe(3);
    expect((await ctx.getStatsForDomain('instagram.com')).quickChecksToday).toBe(1);
  });

  it('clamps an inflated ask to the lane budget and says so honestly', async () => {
    const { ctx, fetch } = loadBackground({ seed: CONFIGURED, fetch: quickCheckFetch(10) });
    const resp = await ctx.handleMessage(
      { action: 'chat', mode: 'gate', domain: 'instagram.com', userMessage: 'check one message' },
      NATIVE
    );
    expect(resp.grantedSession.intervalMinutes).toBe(3);
    expect(resp.systemNote).toBe('Quick checks top out at 3 minutes — your pass is 3 minutes.');
    // Clamp fires the honesty turn: two calls, correction names the budget.
    expect(fetch.calls.length).toBe(2);
    const lastMsg = JSON.parse(fetch.calls.at(-1).init.body).messages.at(-1);
    expect(lastMsg.content).toContain('quick-check budget');
  });

  it('never exceeds the remaining daily minutes', async () => {
    const { ctx } = loadBackground({
      seed: {
        ...CONFIGURED,
        domainLimits: { 'instagram.com': { maxGrants: 3, maxMinutes: 5 } },
        dailyStats: dayStats({ minutes: 3, grants: 1, sessions: [] })
      },
      fetch: quickCheckFetch(3)
    });
    const resp = await ctx.handleMessage(
      { action: 'chat', mode: 'gate', domain: 'instagram.com', userMessage: 'check one message' },
      NATIVE
    );
    expect(resp.grantedSession.intervalMinutes).toBe(2);
    expect(resp.systemNote).toBe('Only 2 minutes were available under your daily cap — your quick check is 2 minutes.');
  });

  it('is rejected outright when the absolute minutes cap is spent', async () => {
    const { ctx, chrome, fetch } = loadBackground({
      seed: {
        ...CONFIGURED,
        domainLimits: { 'instagram.com': { maxGrants: 3, maxMinutes: 5 } },
        dailyStats: dayStats({ minutes: 5, grants: 1, sessions: [] })
      },
      fetch: quickCheckFetch(3)
    });
    const resp = await ctx.handleMessage(
      { action: 'chat', mode: 'gate', domain: 'instagram.com', userMessage: 'check one message' },
      NATIVE
    );
    expect(resp.grantedSession ?? null).toBe(null);
    expect(chrome.storage._store.activeSessions?.['target:instagram.com']).toBeUndefined();
    expect(resp.systemNote).toBe('Absolute max of 5 minutes reached — no more time can be granted today.');
    const lastMsg = JSON.parse(fetch.calls.at(-1).init.body).messages.at(-1);
    expect(lastMsg.content).toContain('Not even a quick check');
  });

  it('downgrades to a normal grant once the lane is spent', async () => {
    const { ctx, fetch } = loadBackground({
      seed: { ...CONFIGURED, dailyStats: dayStats({ minutes: 3, grants: 0, quickChecks: 1, sessions: [] }) },
      fetch: quickCheckFetch(3)
    });
    const resp = await ctx.handleMessage(
      { action: 'chat', mode: 'gate', domain: 'instagram.com', userMessage: 'check one message' },
      NATIVE
    );
    // The grant still lands — the user gave a real reason — but as one of the
    // normal daily grants, and the honesty turn says so.
    expect(resp.grantedSession.intervalMinutes).toBe(3);
    const stats = await ctx.getStatsForDomain('instagram.com');
    expect(stats.grantsToday).toBe(1);
    expect(stats.quickChecksToday).toBe(1);
    expect(fetch.calls.length).toBe(2);
    const lastMsg = JSON.parse(fetch.calls.at(-1).init.body).messages.at(-1);
    expect(lastMsg.content).toContain("today's quick check is already used");
  });

  it('downgrades when the lane is disabled for this site', async () => {
    const { ctx, fetch } = loadBackground({
      seed: { ...CONFIGURED, domainLimits: { 'instagram.com': { quickCheck: { minutes: 0, usesPerDay: 0 } } } },
      fetch: quickCheckFetch(3)
    });
    const resp = await ctx.handleMessage(
      { action: 'chat', mode: 'gate', domain: 'instagram.com', userMessage: 'check one message' },
      NATIVE
    );
    expect(resp.grantedSession.intervalMinutes).toBe(3);
    expect((await ctx.getStatsForDomain('instagram.com')).grantsToday).toBe(1);
    const lastMsg = JSON.parse(fetch.calls.at(-1).init.body).messages.at(-1);
    expect(lastMsg.content).toContain('quick checks are turned off for this site');
  });

  it('never extends: a quick_check flag at check-in becomes a normal grant', async () => {
    const { ctx, fetch } = loadBackground({ seed: CONFIGURED, fetch: quickCheckFetch(3) });
    const resp = await ctx.handleMessage(
      { action: 'chat', mode: 'checkin', domain: 'instagram.com', userMessage: 'two more minutes' },
      NATIVE
    );
    expect(resp.grantedSession.intervalMinutes).toBe(3);
    const stats = await ctx.getStatsForDomain('instagram.com');
    expect(stats.grantsToday).toBe(1);
    expect(stats.quickChecksToday).toBe(0);
    const lastMsg = JSON.parse(fetch.calls.at(-1).init.body).messages.at(-1);
    expect(lastMsg.content).toContain('cannot be used to extend');
  });
});

// Sessions used to be keyed on the tab id alone, so a pass earned on one
// blocked site opened every other blocked site in that tab for the rest of the
// pass -- no conversation required -- and handed the next site's gate the
// previous site's transcript. Keys are now per (tab, domain).
describe('a pass is confined to the site it was earned on', () => {
  const TWO_SITES = {
    ...CONFIGURED,
    setupComplete: true,
    blockedDomains: ['instagram.com', 'reddit.com']
  };

  it('does not open a second blocked site in the same tab', async () => {
    const { ctx } = loadBackground({ seed: TWO_SITES, fetch: grantingFetch(10, 'check DMs') });
    await ctx.handleMessage(
      { action: 'chat', mode: 'gate', domain: 'instagram.com', userMessage: 'a' },
      tab(42)
    );

    const sameSite = await ctx.handleMessage({ action: 'checkPageMatch', host: 'www.instagram.com' }, tab(42));
    expect(sameSite.session).not.toBe(null);

    const otherSite = await ctx.handleMessage({ action: 'checkPageMatch', host: 'www.reddit.com' }, tab(42));
    expect(otherSite.isBlocked).toBe(true);
    expect(otherSite.session).toBe(null);
  });

  it('does not answer getSession for another domain in the same tab', async () => {
    const { ctx } = loadBackground({ seed: TWO_SITES, fetch: grantingFetch(10) });
    await ctx.handleMessage(
      { action: 'chat', mode: 'gate', domain: 'instagram.com', userMessage: 'a' },
      tab(42)
    );
    const asked = await ctx.handleMessage({ action: 'getSession', domain: 'reddit.com' }, tab(42));
    expect(asked.session).toBe(null);
  });

  it('keeps each site transcript to itself', async () => {
    const { ctx, chrome } = loadBackground({ seed: TWO_SITES, fetch: grantingFetch(10) });
    await ctx.handleMessage(
      { action: 'chat', mode: 'gate', domain: 'instagram.com', userMessage: 'something private' },
      tab(42)
    );
    await ctx.handleMessage(
      { action: 'chat', mode: 'gate', domain: 'reddit.com', userMessage: 'unrelated' },
      tab(42)
    );

    const histories = chrome.storage._store.chatHistories;
    expect(JSON.stringify(histories[transcript('instagram.com')])).toContain('something private');
    expect(JSON.stringify(histories[transcript('reddit.com')])).not.toContain('something private');
  });

  it('lets one tab hold a live pass on two sites at once', async () => {
    const { ctx, chrome } = loadBackground({ seed: TWO_SITES, fetch: grantingFetch(10) });
    await ctx.handleMessage(
      { action: 'chat', mode: 'gate', domain: 'instagram.com', userMessage: 'a' },
      tab(42)
    );
    await ctx.handleMessage(
      { action: 'chat', mode: 'gate', domain: 'reddit.com', userMessage: 'b' },
      tab(42)
    );
    expect(Object.keys(chrome.storage._store.activeSessions).sort())
      .toEqual(['tab:42:instagram.com', 'tab:42:reddit.com']);
  });

  it('banks both of a tab sessions when it closes', async () => {
    const { ctx, chrome, listeners } = loadBackground({ seed: TWO_SITES, fetch: grantingFetch(10) });
    await ctx.handleMessage(
      { action: 'chat', mode: 'gate', domain: 'instagram.com', userMessage: 'a' },
      tab(42)
    );
    await ctx.handleMessage(
      { action: 'chat', mode: 'gate', domain: 'reddit.com', userMessage: 'b' },
      tab(42)
    );
    chrome.storage._store.activeSessions['tab:42:instagram.com'].startTime = Date.now() - 3 * 60000;
    chrome.storage._store.activeSessions['tab:42:reddit.com'].startTime = Date.now() - 2 * 60000;

    await listeners.tabRemoved(42);

    expect(chrome.storage._store.activeSessions).toEqual({});
    // Both transcripts survive the tab closing — memory is per site, per day.
    expect(Object.keys(chrome.storage._store.chatHistories).sort())
      .toEqual([transcript('instagram.com'), transcript('reddit.com')]);
    expect((await ctx.getStatsForDomain('instagram.com')).minutesToday).toBe(3);
    expect((await ctx.getStatsForDomain('reddit.com')).minutesToday).toBe(2);
  });

  it('hands the tab allow rule to the session still running', async () => {
    const { ctx, chrome } = loadBackground({ seed: TWO_SITES, fetch: grantingFetch(10) });
    await ctx.handleMessage(
      { action: 'chat', mode: 'gate', domain: 'instagram.com', userMessage: 'a' },
      tab(42)
    );
    await ctx.handleMessage(
      { action: 'chat', mode: 'gate', domain: 'reddit.com', userMessage: 'b' },
      tab(42)
    );
    await ctx.handleMessage({ action: 'endSession', domain: 'instagram.com' }, tab(42));

    // One rule per tab, so ending one session must re-point the rule at the
    // survivor rather than removing it and stranding that pass.
    const forTab = chrome.declarativeNetRequest._sessionRules.filter(r => r.id === 42);
    expect(forTab).toHaveLength(1);
    expect(forTab[0].condition.urlFilter).toContain('reddit.com');
  });
});

describe('sessions written under the old key format', () => {
  const legacySeed = (extra = {}) => ({
    ...CONFIGURED,
    setupComplete: true,
    blockedDomains: ['instagram.com', 'reddit.com'],
    activeSessions: {
      '42': { domain: 'instagram.com', startTime: Date.now(), intervalMinutes: 10 }
    },
    ...extra
  });

  it('are still honoured for their own domain', async () => {
    const { ctx } = loadBackground({ seed: legacySeed() });
    const asked = await ctx.handleMessage({ action: 'getSession', domain: 'instagram.com' }, tab(42));
    expect(asked.session).not.toBe(null);
  });

  it('are not honoured for a different domain', async () => {
    const { ctx } = loadBackground({ seed: legacySeed() });
    const asked = await ctx.handleMessage({ action: 'getSession', domain: 'reddit.com' }, tab(42));
    expect(asked.session).toBe(null);
  });

  it('are rekeyed, with transcript and check-in, on reconcile', async () => {
    const { ctx, chrome } = loadBackground({
      seed: legacySeed({ chatHistories: { '42': [{ role: 'user', content: 'earlier' }] } })
    });
    await ctx.handleMessage({ action: 'reconcileSessions' }, NATIVE);

    const sessions = chrome.storage._store.activeSessions;
    expect(sessions['42']).toBeUndefined();
    expect(sessions['tab:42:instagram.com']).toBeDefined();
    expect(chrome.storage._store.chatHistories['tab:42:instagram.com'][0].content).toBe('earlier');
    expect(chrome.alarms._created.some(a => a.name === 'checkin-tab:42:instagram.com')).toBe(true);
  });

  it('still bank if their old check-in alarm fires first', async () => {
    const { ctx, chrome, listeners } = loadBackground({ seed: legacySeed() });
    chrome.storage._store.activeSessions['42'].startTime = Date.now() - 10 * 60000;

    // The tab id is still recoverable from the legacy alarm name, so this
    // takes the same path as before and drops the unreachable tab's session.
    await listeners.alarm({ name: 'checkin-42' });

    expect(chrome.storage._store.activeSessions['42']).toBeUndefined();
  });
});

// applySettingChange and simpleGrant used to be directly callable by any
// content script: a hostile page could clear the whole blocklist, or mint a
// pass on a coach-mode domain and bypass the LLM gate entirely.
describe('privileged message actions are gated on sender and mode', () => {
  const BLOCKED = { ...CONFIGURED, blockedDomains: ['instagram.com'] };

  it('refuses simpleGrant on a coach-mode domain, whoever asks', async () => {
    const { ctx, chrome } = loadBackground({ seed: BLOCKED });
    for (const sender of [tab(7), EXT_PAGE, NATIVE]) {
      const resp = await ctx.handleMessage(
        { action: 'simpleGrant', domain: 'instagram.com' }, sender
      );
      expect(resp.grantedSession).toBeUndefined();
      expect(resp.denied).toBeTruthy();
    }
    expect(chrome.storage._store.activeSessions ?? {}).toEqual({});
  });

  it('refuses a content script asking for a different site than its own', async () => {
    const { ctx } = loadBackground({
      seed: { ...BLOCKED, blockingMode: 'simple' }
    });
    const resp = await ctx.handleMessage(
      { action: 'simpleGrant', domain: 'instagram.com' },
      tab(7, 'evil.com')
    );
    expect(resp.grantedSession).toBeUndefined();
    expect(resp.denied).toBeTruthy();
  });

  it('still grants from the blocked page itself in simple mode', async () => {
    const { ctx } = loadBackground({ seed: { ...BLOCKED, blockingMode: 'simple' } });
    const resp = await ctx.handleMessage(
      { action: 'simpleGrant', domain: 'instagram.com' },
      tab(7, 'www.instagram.com')
    );
    expect(resp.grantedSession).toBeDefined();
  });

  it('still grants from the coaching page and native hosts in simple mode', async () => {
    for (const sender of [EXT_PAGE, NATIVE]) {
      const { ctx } = loadBackground({ seed: { ...BLOCKED, blockingMode: 'simple' } });
      const resp = await ctx.handleMessage(
        { action: 'simpleGrant', domain: 'instagram.com', tabId: 7 }, sender
      );
      expect(resp.grantedSession).toBeDefined();
    }
  });

  it('honours a per-domain simple override without opening the rest', async () => {
    const { ctx } = loadBackground({
      seed: { ...BLOCKED, domainLimits: { 'instagram.com': { mode: 'simple' } } }
    });
    const granted = await ctx.handleMessage(
      { action: 'simpleGrant', domain: 'instagram.com' }, tab(7)
    );
    expect(granted.grantedSession).toBeDefined();
  });

  it('refuses applySettingChange from any content script', async () => {
    const { ctx, chrome } = loadBackground({
      seed: { ...BLOCKED, blockingMode: 'simple' }
    });
    const resp = await ctx.handleMessage(
      { action: 'applySettingChange', changeType: 'disable_all' },
      tab(7)
    );
    expect(resp?.blockedDomains).toBeUndefined();
    expect(chrome.storage._store.blockedDomains).toEqual(['instagram.com']);
  });

  it('refuses applySettingChange without simple mode even from our own pages', async () => {
    const { ctx, chrome } = loadBackground({ seed: BLOCKED });
    const resp = await ctx.handleMessage(
      { action: 'applySettingChange', changeType: 'remove', domain: 'instagram.com' },
      EXT_PAGE
    );
    expect(resp?.blockedDomains).toBeUndefined();
    expect(chrome.storage._store.blockedDomains).toEqual(['instagram.com']);
  });

  it('applies a simple-mode change from the options page', async () => {
    const { ctx, chrome } = loadBackground({
      seed: { ...BLOCKED, blockingMode: 'simple' }
    });
    const resp = await ctx.handleMessage(
      { action: 'applySettingChange', changeType: 'remove', domain: 'instagram.com' },
      EXT_PAGE
    );
    expect(resp.blockedDomains).toEqual([]);
    expect(chrome.storage._store.blockedDomains).toEqual([]);
  });

  it('keeps clearChatHistory from wiping another session by guessed key', async () => {
    const { ctx, chrome } = loadBackground({ seed: BLOCKED });
    chrome.storage._store.chatHistories = {
      'tab:9:reddit.com': [{ role: 'user', content: 'other tab' }],
      'context': [{ role: 'user', content: 'options chat' }]
    };
    await ctx.handleMessage(
      { action: 'clearChatHistory', historyKey: 'tab:9:reddit.com', domain: 'instagram.com' },
      tab(7)
    );
    expect(chrome.storage._store.chatHistories['tab:9:reddit.com']).toBeDefined();

    // The fixed non-session namespaces are still clearable by name.
    await ctx.handleMessage(
      { action: 'clearChatHistory', historyKey: 'context' }, EXT_PAGE
    );
    expect(chrome.storage._store.chatHistories['context']).toBeUndefined();
  });
});

// tabNavContext was purely in-memory, and a coaching conversation outlives the
// MV3 worker's ~30s idle teardown — so by the time the user talked their way
// through the gate, getIntendedUrl had forgotten the deep link they clicked
// and the pass dropped them on the site's front door.
describe('the intended URL survives worker suspension', () => {
  const SEED = { ...CONFIGURED, blockedDomains: ['youtube.com'] };
  const WATCH = 'https://www.youtube.com/watch?v=abc123';

  const recordNav = async (listeners, url, tabId = 5) => {
    listeners.beforeNavigate({ frameId: 0, tabId, url });
    await new Promise(r => setTimeout(r, 0)); // let the mirrored write settle
  };

  const suspend = (ctx) => {
    for (const k of Object.keys(ctx.tabNavContext)) delete ctx.tabNavContext[k];
  };

  it('rehydrates from chrome.storage.session after a worker restart', async () => {
    const { ctx, listeners } = loadBackground({ seed: SEED, sessionArea: true });
    await recordNav(listeners, WATCH);
    suspend(ctx);
    const resp = await ctx.handleMessage(
      { action: 'getIntendedUrl', domain: 'youtube.com' }, tab(5, 'www.youtube.com')
    );
    expect(resp.url).toBe(WATCH);
  });

  it('falls back to chrome.storage.local where session storage is missing', async () => {
    const { ctx, listeners } = loadBackground({ seed: SEED });
    await recordNav(listeners, WATCH);
    suspend(ctx);
    const resp = await ctx.handleMessage(
      { action: 'getIntendedUrl', domain: 'youtube.com' }, tab(5, 'www.youtube.com')
    );
    expect(resp.url).toBe(WATCH);
  });

  it('still refuses a recorded URL from a different host', async () => {
    const { ctx, listeners } = loadBackground({ seed: SEED, sessionArea: true });
    await recordNav(listeners, 'https://evil.com/lure');
    const resp = await ctx.handleMessage(
      { action: 'getIntendedUrl', domain: 'youtube.com' }, tab(5, 'www.youtube.com')
    );
    expect(resp.url).toBe('');
  });

  it('prunes closed tabs and stale entries from the persisted map', async () => {
    const { ctx, chrome, listeners } = loadBackground({ seed: SEED, sessionArea: true });
    await recordNav(listeners, WATCH, 5);
    ctx.tabNavContext[9] = { url: 'https://old.example/', timestamp: Date.now() - 25 * 60 * 60 * 1000 };
    listeners.tabRemoved(5);
    await new Promise(r => setTimeout(r, 0));
    expect(chrome.storage._sessionStore.tabNavContext).toEqual({});
  });
});

// The gate's overlay empties the document before the chat opens, and on the
// redirect path the blocked page is never loaded at all — so the content
// script's extraction at document_start is the only look at the page anyone
// gets. It used to be sent to checkPageMatch and dropped on the floor, leaving
// the coach with whatever could be guessed from the address.
describe('what the user was actually opening reaches the coach', () => {
  const SEED = { ...CONFIGURED, blockedDomains: ['instagram.com'], setupComplete: true };
  const REEL = {
    url: 'https://instagram.com/reel/abc123',
    contentType: 'Instagram Reel',
    title: 'Sourdough starter in 30 seconds',
    source: 'dom'
  };
  it('remembers the content script\'s extraction and uses it in the chat', async () => {
    const { ctx, fetch } = loadBackground({ seed: SEED });
    await ctx.handleMessage(
      { action: 'checkPageMatch', host: 'instagram.com', pageContext: REEL },
      tab(3)
    );
    await ctx.handleMessage(
      { action: 'chat', mode: 'gate', domain: 'instagram.com', userMessage: 'hi' },
      tab(3)
    );
    expect(systemPromptOf(fetch)).toContain('Sourdough starter in 30 seconds');
  });

  it('falls back to the recorded navigation when nothing was extracted', async () => {
    const { ctx, fetch, listeners } = loadBackground({ seed: SEED });
    listeners.beforeNavigate({
      frameId: 0, tabId: 4, url: 'https://instagram.com/explore/tags/woodworking/'
    });
    await ctx.handleMessage(
      { action: 'chat', mode: 'gate', domain: 'instagram.com', userMessage: 'hi' },
      tab(4)
    );
    expect(systemPromptOf(fetch)).toContain('#woodworking');
  });

  // A recorded navigation lives for a day and the tab may have moved on since.
  // Describing the wrong site is worse than describing none, because the coach
  // will quote it back to the user as fact.
  it('refuses page context describing a different site than the one gated', async () => {
    const { ctx, fetch } = loadBackground({
      seed: { ...SEED, blockedDomains: ['instagram.com', 'youtube.com'] }
    });
    await ctx.handleMessage(
      {
        action: 'checkPageMatch',
        host: 'youtube.com',
        pageContext: { url: 'https://youtube.com/watch?v=xyz', title: 'A long video', source: 'dom' }
      },
      tab(6, 'youtube.com')
    );
    await ctx.handleMessage(
      { action: 'chat', mode: 'gate', domain: 'instagram.com', userMessage: 'hi' },
      tab(6)
    );
    const system = systemPromptOf(fetch);
    expect(system).not.toContain('A long video');
    expect(system).not.toContain('untrusted_page_data');
  });

  it('tells the coach how earlier passes ended', async () => {
    const { ctx, fetch } = loadBackground({ seed: SEED, fetch: grantingFetch(10, 'check DMs') });
    await ctx.handleMessage(
      { action: 'chat', mode: 'gate', domain: 'instagram.com', userMessage: 'a' },
      tab(7)
    );
    await ctx.handleMessage(
      { action: 'endSession', domain: 'instagram.com', reason: 'fulfilled' },
      tab(7)
    );

    const [session] = (await ctx.getStatsForDomain('instagram.com')).sessionsToday;
    expect(session.outcome).toBe('closed_early');
    expect(session.reason).toBe('check DMs');

    await ctx.handleMessage(
      { action: 'chat', mode: 'gate', domain: 'instagram.com', userMessage: 'again' },
      tab(8)
    );
    expect(systemPromptOf(fetch)).toContain('closed early');
  });

  it('records a pass that ran its clock out as such', async () => {
    const { ctx, chrome, listeners } = loadBackground({
      seed: SEED, fetch: grantingFetch(10, 'check DMs')
    });
    await ctx.handleMessage(
      { action: 'chat', mode: 'gate', domain: 'instagram.com', userMessage: 'a' },
      tab(9)
    );
    // Wind the session back so its full ten minutes have elapsed, then fire
    // the check-in alarm the way the browser would.
    const key = 'tab:9:instagram.com';
    const sessions = chrome.storage._store.activeSessions;
    sessions[key] = { ...sessions[key], startTime: Date.now() - 10 * 60 * 1000 };
    await ctx.bankExpiredSession(key);

    const [session] = (await ctx.getStatsForDomain('instagram.com')).sessionsToday;
    expect(session.outcome).toBe('ran_out');
    expect(session.usedMinutes).toBe(10);
  });
});

// Memory that outlives the tab has to end somewhere, or every site the user
// ever argued with accumulates in storage forever.
describe('transcripts expire with the day', () => {
  const SEED = { ...CONFIGURED, blockedDomains: ['instagram.com'] };

  it('drops transcripts from earlier days on the next write', async () => {
    const { ctx, chrome } = loadBackground({ seed: SEED });
    chrome.storage._store.chatHistories = {
      'site:instagram.com:2020-01-01': [{ role: 'user', content: 'ancient' }],
      'site:reddit.com:2020-01-02': [{ role: 'user', content: 'also ancient' }],
      context: [{ role: 'user', content: 'keep me' }]
    };

    await ctx.handleMessage(
      { action: 'chat', mode: 'gate', domain: 'instagram.com', userMessage: 'today' },
      tab(1)
    );

    const histories = chrome.storage._store.chatHistories;
    expect(Object.keys(histories).sort()).toEqual(['context', transcript('instagram.com')]);
    // The named namespaces the options page owns are not day-scoped.
    expect(histories.context[0].content).toBe('keep me');
  });

  it('starts the day fresh rather than continuing yesterday', async () => {
    const { ctx, chrome, fetch } = loadBackground({ seed: SEED });
    chrome.storage._store.chatHistories = {
      'site:instagram.com:2020-01-01': [{ role: 'user', content: 'yesterday I said this' }]
    };

    await ctx.handleMessage(
      { action: 'chat', mode: 'gate', domain: 'instagram.com', userMessage: 'hello' },
      tab(1)
    );

    const sent = JSON.parse(fetch.calls.at(-1).init.body);
    expect(JSON.stringify(sent.messages)).not.toContain('yesterday I said this');
  });
});

// The coach speaks first now: an empty send means Intention opened the
// conversation, and a synthetic user turn tells the model which situation it
// is opening into.
describe('the coach opens the conversation', () => {
  it('sends the gate marker when the user typed nothing', async () => {
    const { ctx, chrome, fetch } = loadBackground({ seed: CONFIGURED });
    const res = await ctx.handleMessage(
      { action: 'chat', mode: 'gate', domain: 'instagram.com' },
      tab(1)
    );
    expect(res.error).toBeUndefined();
    const sent = JSON.parse(fetch.calls.at(-1).init.body).messages;
    expect(sent).toEqual([{ role: 'user', content: ctx.CHAT_OPEN_MARKER }]);
    const history = chrome.storage._store.chatHistories[transcript('instagram.com')];
    expect(history.map(t => t.role)).toEqual(['user', 'assistant']);
    expect(history[0].content).toBe(ctx.CHAT_OPEN_MARKER);
  });

  it('sends the check-in marker in checkin mode', async () => {
    const { ctx, fetch } = loadBackground({ seed: CONFIGURED });
    await ctx.handleMessage(
      { action: 'chat', mode: 'checkin', domain: 'instagram.com' },
      tab(1)
    );
    const sent = JSON.parse(fetch.calls.at(-1).init.body).messages;
    expect(sent.at(-1).content).toBe(ctx.CHECKIN_OPEN_MARKER);
  });

  it('does not stack markers when the first attempt failed', async () => {
    let call = 0;
    const fetch = makeMockFetch(() => {
      call += 1;
      if (call === 1) return { status: 500, json: 'down' };
      return { content: [{ type: 'text', text: 'hello' }] };
    });
    const { ctx, chrome } = loadBackground({ seed: CONFIGURED, fetch });

    const first = await ctx.handleMessage(
      { action: 'chat', mode: 'gate', domain: 'instagram.com' },
      tab(1)
    );
    expect(first.error).toBeDefined();
    // The failure returned before persistence, so the retry starts clean...
    expect(chrome.storage._store.chatHistories ?? {}).toEqual({});

    const second = await ctx.handleMessage(
      { action: 'chat', mode: 'gate', domain: 'instagram.com' },
      tab(1)
    );
    expect(second.assistantText).toBe('hello');
    // ...and the model sees exactly one marker, however many retries happened.
    const sent = JSON.parse(fetch.calls.at(-1).init.body).messages;
    expect(sent.filter(m => m.content === ctx.CHAT_OPEN_MARKER)).toHaveLength(1);
  });
});

// When a grant is clamped or rejected, the model's spoken text still promises
// whatever it asked for. A single extra turn tells the model what actually
// happened so it can say so itself — and never more than one turn.
describe('the honesty turn after a clamped or rejected grant', () => {
  // 3 of a 5-minute daily cap already used, so only 2 minutes remain.
  const clampSeed = () => ({
    ...CONFIGURED,
    domainLimits: { 'instagram.com': { maxGrants: 3, maxMinutes: 5 } },
    dailyStats: {
      [today()]: {
        'instagram.com': { minutes: 3, grants: 1, sessions: [{ reason: 'earlier', grantedMinutes: 3, grantedAt: Date.now() }] }
      }
    }
  });

  it('grants the real minutes and lets the coach restate them', async () => {
    const fetch = grantingFetch(10, 'check DMs');
    const { ctx, chrome } = loadBackground({ seed: clampSeed(), fetch });
    const res = await ctx.handleMessage(
      { action: 'chat', mode: 'gate', domain: 'instagram.com', userMessage: 'a' },
      tab(1)
    );

    expect(res.grantedSession.intervalMinutes).toBe(2);
    expect(res.systemNote).toBe('Only 2 minutes were available under your daily cap — your pass is 2 minutes.');
    expect(fetch.calls.length).toBe(2);

    // The correction turn carries no tools (an empty array is omitted from
    // the request body) and ends on the synthetic user turn naming the gap.
    const secondBody = JSON.parse(fetch.calls[1].init.body);
    expect(secondBody.tools).toBeUndefined();
    const lastMsg = secondBody.messages.at(-1);
    expect(lastMsg.role).toBe('user');
    expect(lastMsg.content).toMatch(/^\(Intention:/);
    expect(lastMsg.content).toContain('asked for 10 minutes');
    expect(lastMsg.content).toContain('only 2 were available');

    // Both texts reach the user, joined.
    expect(res.assistantText).toBe('Okay.\n\nOkay.');

    // Persisted transcript alternates roles around the synthetic turn.
    const history = chrome.storage._store.chatHistories[transcript('instagram.com')];
    expect(history.map(t => t.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(history[2].content).toMatch(/^\(Intention:/);
  });

  it('names the 60-minute ceiling, not a daily cap the user never set', async () => {
    // No per-domain limits at all: the only thing clamping a 90-minute ask
    // is the hard per-pass ceiling, and the correction must say so.
    const fetch = grantingFetch(90, 'watch a lecture');
    const { ctx } = loadBackground({ seed: CONFIGURED, fetch });
    const res = await ctx.handleMessage(
      { action: 'chat', mode: 'gate', domain: 'instagram.com', userMessage: 'a' },
      tab(1)
    );

    expect(res.grantedSession.intervalMinutes).toBe(60);
    expect(res.systemNote).toBe('Passes top out at 60 minutes — your pass is 60 minutes.');
    expect(res.systemNote).not.toMatch(/daily cap/);
    const secondBody = JSON.parse(fetch.calls[1].init.body);
    expect(secondBody.messages.at(-1).content).toContain('60-minute ceiling');
    expect(secondBody.messages.at(-1).content).not.toContain('daily');
  });

  it('never loops: tool calls on the correction turn are ignored', async () => {
    // Static mock: the correction turn ALSO answers with a grant_access call.
    const fetch = grantingFetch(10, 'check DMs');
    const { ctx, chrome } = loadBackground({ seed: clampSeed(), fetch });
    await ctx.handleMessage(
      { action: 'chat', mode: 'gate', domain: 'instagram.com', userMessage: 'a' },
      tab(1)
    );
    expect(fetch.calls.length).toBe(2);
    expect(Object.keys(chrome.storage._store.activeSessions)).toEqual(['tab:1:instagram.com']);
  });

  it('keeps the grant and the first reply when the honesty turn fails', async () => {
    let call = 0;
    const fetch = makeMockFetch(() => {
      call += 1;
      if (call === 1) {
        return {
          content: [
            { type: 'text', text: 'Okay.' },
            { type: 'tool_use', id: 't1', name: 'grant_access', input: { minutes: 10, reason: 'check DMs' } }
          ]
        };
      }
      return { status: 500, json: 'down' };
    });
    const { ctx, chrome } = loadBackground({ seed: clampSeed(), fetch });
    const res = await ctx.handleMessage(
      { action: 'chat', mode: 'gate', domain: 'instagram.com', userMessage: 'a' },
      tab(1)
    );

    // The grant already landed; a failed follow-up must not turn it into an error.
    expect(res.error).toBeUndefined();
    expect(res.grantedSession.intervalMinutes).toBe(2);
    expect(res.systemNote).toBeTruthy();
    expect(res.assistantText).toBe('Okay.');
    // The synthetic user turn was popped, so the transcript still alternates.
    const history = chrome.storage._store.chatHistories[transcript('instagram.com')];
    expect(history.at(-1).role).toBe('assistant');
    expect(history.at(-1).content).toBe('Okay.');
  });
});

// Reading a transcript leaks what the user told their coach, so getHistory is
// held to a stricter bar than clearChatHistory: named namespaces open only to
// our own pages, and content scripts only ever see their own site's transcript.
describe('getHistory', () => {
  const seedHistories = () => ({
    ...CONFIGURED,
    chatHistories: {
      context: [
        { role: 'user', content: 'about me' },
        { role: 'assistant', content: 'noted' }
      ],
      [transcript('instagram.com')]: [
        { role: 'user', content: '(user just opened the conversation)' },
        { role: 'assistant', content: 'hey' },
        { role: 'user', content: '(Intention: your grant was clamped.)' },
        { role: 'assistant', content: 'actually 2 minutes' },
        { role: 'user', content: 'fine' }
      ]
    }
  });

  it('lets an extension page read the named namespaces', async () => {
    const { ctx } = loadBackground({ seed: seedHistories() });
    const res = await ctx.handleMessage({ action: 'getHistory', historyKey: 'context' }, EXT_PAGE);
    expect(res.turns).toEqual([
      { role: 'user', content: 'about me' },
      { role: 'assistant', content: 'noted' }
    ]);
  });

  it('coerces a content sender to its own site and filters synthetic turns', async () => {
    const { ctx } = loadBackground({ seed: seedHistories() });
    const res = await ctx.handleMessage(
      { action: 'getHistory', domain: 'instagram.com' },
      tab(3, 'www.instagram.com')
    );
    expect(res.turns.map(t => t.content)).toEqual(['hey', 'actually 2 minutes', 'fine']);
  });

  it('gives a content sender on another host nothing', async () => {
    const { ctx } = loadBackground({ seed: seedHistories() });
    const res = await ctx.handleMessage(
      { action: 'getHistory', domain: 'instagram.com' },
      tab(3, 'evil.com')
    );
    expect(res.turns).toEqual([]);
  });

  it('does not let a content sender read a namespaced transcript by naming its key', async () => {
    const { ctx } = loadBackground({ seed: seedHistories() });
    const res = await ctx.handleMessage(
      { action: 'getHistory', historyKey: 'context', domain: 'instagram.com' },
      tab(3, 'www.instagram.com')
    );
    // Coerced to the site's own transcript, never the options page's.
    expect(res.turns.map(t => t.content)).not.toContain('about me');
    expect(res.turns.map(t => t.content)).toContain('hey');
  });
});

describe('walking away from the gate', () => {
  it('counts the walk-away and leaves tab closing to the client', async () => {
    const { ctx, chrome } = loadBackground({ seed: CONFIGURED });
    const removed = [];
    chrome.tabs.remove = (id) => removed.push(id);

    const res = await ctx.handleMessage(
      { action: 'endSession', domain: 'instagram.com', reason: 'walked_away' },
      tab(4)
    );

    expect(res.ok).toBe(true);
    // The client shows its walk-away moment first and owns the close timing.
    expect(removed).toEqual([]);
    const stats = await ctx.getStatsForDomain('instagram.com');
    expect(stats.walkedAwayToday).toBe(1);
    expect(stats.walkedAwayWeek).toBe(1);
  });

  it("cannot be spoofed by a page for another site's streak", async () => {
    const { ctx } = loadBackground({ seed: CONFIGURED });
    // A hostile page on evil.example posting a walk-away for instagram.com:
    // the streak the prompt trusts must not be inflatable cross-domain.
    const res = await ctx.handleMessage(
      { action: 'endSession', domain: 'instagram.com', reason: 'walked_away' },
      tab(4, 'evil.example')
    );
    expect(res.ok).toBe(true);
    expect((await ctx.getStatsForDomain('instagram.com')).walkedAwayToday).toBe(0);
  });

  it('retires a live pass instead of counting it as a walk-away', async () => {
    const { ctx, chrome } = loadBackground({ seed: CONFIGURED, fetch: grantingFetch(10) });
    await ctx.handleMessage(
      { action: 'chat', mode: 'gate', domain: 'instagram.com', userMessage: 'a' },
      tab(4)
    );

    const res = await ctx.handleMessage(
      { action: 'endSession', domain: 'instagram.com', reason: 'walked_away' },
      tab(4)
    );

    expect(res.ok).toBe(true);
    expect(chrome.storage._store.activeSessions['tab:4:instagram.com']).toBeUndefined();
    expect((await ctx.getStatsForDomain('instagram.com')).walkedAwayToday).toBe(0);
  });
});

// An LLM reply that saves one coach observation, in Anthropic's response shape.
function notingFetch(observation) {
  return makeMockFetch({
    content: [
      { type: 'text', text: 'Noted.' },
      { type: 'tool_use', id: 'n1', name: 'note_observation', input: { observation } }
    ]
  });
}

describe('note_observation', () => {
  const tenNotes = () => Array.from({ length: 10 }, (_, i) => ({ text: `note ${i}`, domain: 'x.com', at: 1 }));

  it('stores the note and shows it to the next conversation', async () => {
    const fetch = notingFetch('They reach for Instagram mid-afternoon.');
    const { ctx, chrome } = loadBackground({ seed: CONFIGURED, fetch });
    await ctx.handleMessage(
      { action: 'chat', mode: 'gate', domain: 'instagram.com', userMessage: 'a' },
      tab(1)
    );
    expect(chrome.storage._store.coachObservations).toEqual([
      expect.objectContaining({ text: 'They reach for Instagram mid-afternoon.', domain: 'instagram.com' })
    ]);

    await ctx.handleMessage(
      { action: 'chat', mode: 'gate', domain: 'instagram.com', userMessage: 'b' },
      tab(1)
    );
    const system = systemPromptOf(fetch);
    expect(system).toContain("Things you've noticed before");
    expect(system).toContain('They reach for Instagram mid-afternoon.');
  });

  it('does not store the same note twice', async () => {
    const { ctx, chrome } = loadBackground({
      seed: { ...CONFIGURED, coachObservations: tenNotes() },
      fetch: notingFetch('note 9')
    });
    await ctx.handleMessage(
      { action: 'chat', mode: 'gate', domain: 'x.com', userMessage: 'a' },
      tab(1)
    );
    const texts = chrome.storage._store.coachObservations.map(o => o.text);
    expect(texts).toHaveLength(10);
    expect(texts.filter(t => t === 'note 9')).toHaveLength(1);
  });

  it('caps the notepad at ten, dropping the oldest', async () => {
    const { ctx, chrome } = loadBackground({
      seed: { ...CONFIGURED, coachObservations: tenNotes() },
      fetch: notingFetch('a fresh note')
    });
    await ctx.handleMessage(
      { action: 'chat', mode: 'gate', domain: 'x.com', userMessage: 'a' },
      tab(1)
    );
    const texts = chrome.storage._store.coachObservations.map(o => o.text);
    expect(texts).toHaveLength(10);
    expect(texts).not.toContain('note 0');
    expect(texts.at(-1)).toBe('a fresh note');
  });

  it('is ignored outside gate and check-in conversations', async () => {
    const { ctx, chrome } = loadBackground({ seed: CONFIGURED, fetch: notingFetch('sneaky') });
    await ctx.handleMessage(
      { action: 'chat', mode: 'context', userMessage: 'a' },
      EXT_PAGE
    );
    expect(chrome.storage._store.coachObservations).toBeUndefined();
  });
});

describe('save_onboarding limits', () => {
  it('stores -1, not NaN, when the model omits a daily minutes cap', async () => {
    const fetch = makeMockFetch({
      content: [
        { type: 'text', text: 'Saved.' },
        {
          type: 'tool_use', id: 't1', name: 'save_onboarding',
          input: {
            user_context: 'me',
            blocked_domains: ['y.com'],
            domain_limits: [{ domain: 'y.com', max_grants_per_day: 2 }]
          }
        }
      ]
    });
    const { ctx, chrome } = loadBackground({ seed: CONFIGURED, fetch });
    await ctx.handleMessage({ action: 'chat', mode: 'setup', userMessage: 'done' }, EXT_PAGE);
    // `Number(undefined) ?? -1` was NaN, which read as an always-hit cap.
    expect(chrome.storage._store.domainLimits['y.com']).toEqual({ maxGrants: 2, maxMinutes: -1 });
  });
});
