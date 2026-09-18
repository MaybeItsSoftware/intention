// background.js — session/history keying and the storage-mutation queue.
//
// These cover the two sender shapes the worker actually sees: the extensions
// deliver {tab:{id}}, while the native ports (Android's BackgroundJsHelper,
// iOS's BackgroundJSHost) deliver a sender with no tab at all. The native
// shape has no test coverage anywhere else — there's no way to run the Android
// or iOS hosts from here.

import { describe, it, expect, vi } from 'vitest';
import vm from 'node:vm';
import { loadBackground, makeMockFetch, evaluateScripts, filesForContext } from './load.js';

// Most tests here drive the coach, and the coach only grants past a spent
// intention — so the sites these tests visit carry no free opens unless a test
// says otherwise. The free path has its own tests (intentionGrant).
const SPENT = { maxGrants: 0, passMinutes: 10 };
const CONFIGURED = {
  provider: 'anthropic', apiKey: 'test-key', model: 'claude-sonnet-5',
  domainLimits: { 'instagram.com': SPENT, 'youtube.com': SPENT, 'x.com': SPENT, 'reddit.com': SPENT, 'twitter.com': SPENT },
  appLimits: { 'com.instagram.android': SPENT, 'com.google.android.youtube': SPENT }
};

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

describe('site passes across browser tabs', () => {
  const session = () => ({ domain: 'instagram.com', reason: 'reply to DMs',
    intervalMinutes: 10, startTime: Date.now() - 2 * 60000 });
  const setup = (pass = session()) => loadBackground({ seed: {
    ...CONFIGURED, setupComplete: true, blockedDomains: ['instagram.com'],
    activeSessions: { 'tab:1:instagram.com': pass }
  } });

  it('returns the original clock and reminder to a new tab on the same site', async () => {
    const { ctx, chrome } = setup();
    const match = await ctx.checkPageMatch('www.instagram.com', 2, null, 'https://www.instagram.com/');
    expect(match.session.reason).toBe('reply to DMs');
    expect(match.session.startTime).toBe(chrome.storage._store.activeSessions['tab:1:instagram.com'].startTime);
    expect(Object.keys(chrome.storage._store.activeSessions)).toEqual(['tab:1:instagram.com']);
    expect(ctx.readSession(chrome.storage._store.activeSessions, 2, 'youtube.com')).toBe(null);
  });

  it('does not share a page pass with a new tab', () => {
    const { ctx, chrome } = setup({ ...session(), scope: { kind: 'page', url: 'https://www.instagram.com/p/one/' } });
    expect(ctx.readSession(chrome.storage._store.activeSessions, 2, 'instagram.com')).toBe(null);
  });

  it('interrupts every tab on the site at expiry and refuses a further tab', async () => {
    const { ctx, chrome, listeners } = setup({ ...session(), startTime: Date.now() - 10 * 60000 });
    chrome.tabs._queryResults.push({ id: 2, url: 'https://www.instagram.com/' },
      { id: 3, url: 'https://instagram.com/reels/' }, { id: 4, url: 'https://youtube.com/' });
    await listeners.alarm({ name: 'checkin-tab:1:instagram.com' });
    expect(chrome.tabs._messages.filter(m => m.message.action === 'showCheckin').map(m => m.id)).toEqual([1, 2, 3]);
    expect((await ctx.checkPageMatch('instagram.com', 5)).session).toBe(null);
    expect((await ctx.getStatsForDomain('instagram.com')).minutesToday).toBe(10);
  });

  it('keeps the same clock when its original tab closes, then retires the last tab', async () => {
    const { ctx, chrome, listeners } = setup();
    const startTime = chrome.storage._store.activeSessions['tab:1:instagram.com'].startTime;
    chrome.tabs._queryResults.push({ id: 2, url: 'https://instagram.com/' });
    await listeners.tabRemoved(1);
    expect(chrome.storage._store.activeSessions['tab:2:instagram.com'].startTime).toBe(startTime);
    expect(chrome.storage._store.activeSessions['tab:1:instagram.com']).toBeUndefined();
    chrome.tabs._queryResults.length = 0;
    await listeners.tabRemoved(2);
    expect(chrome.storage._store.activeSessions).toEqual({});
    expect((await ctx.getStatsForDomain('instagram.com')).minutesToday).toBeCloseTo(2, 1);
  });

  it('finishing from a new tab ends the shared pass everywhere', async () => {
    const { ctx, chrome } = setup();
    chrome.tabs._queryResults.push({ id: 2, url: 'https://instagram.com/' });
    await ctx.endSession({ tabId: 2, domain: 'instagram.com', reason: 'fulfilled' });
    expect(chrome.storage._store.activeSessions).toEqual({});
    expect(chrome.tabs._messages.map(m => m.id)).toEqual([1, 2]);
  });
});

describe('Reddit subreddit and post allowances', () => {
  const seed = () => ({ ...CONFIGURED, setupComplete: true, blockedDomains: ['reddit.com'],
    domainLimits: { ...CONFIGURED.domainLimits, 'reddit.com': {
      maxGrants: 0, passMinutes: 10, allowedSubreddits: ['rust'], allowedRedditPosts: ['cats:abc123']
    } } });

  it('lets a visit to an allowed subreddit or post through and gates their neighbours', async () => {
    const { ctx } = loadBackground({ seed: seed() });
    expect((await ctx.checkPageMatch('www.reddit.com', 3, null, 'https://www.reddit.com/r/rust/')).isBlocked).toBe(false);
    expect((await ctx.checkPageMatch('www.reddit.com', 3, null, 'https://www.reddit.com/r/cats/comments/abc123/')).isBlocked).toBe(false);
    expect((await ctx.checkPageMatch('www.reddit.com', 3, null, 'https://www.reddit.com/r/cats/')).isBlocked).toBe(true);
  });

  it('allows direct removal but holds direct additions back', async () => {
    const { ctx, chrome } = loadBackground({ seed: seed() });
    await ctx.saveSettings({ domainLimits: { 'reddit.com': {
      maxGrants: 0, passMinutes: 10, allowedSubreddits: ['cats'],
      allowedRedditPosts: ['cats:abc123', 'rust:def456']
    } } });
    expect(chrome.storage._store.domainLimits['reddit.com'].allowedSubreddits).toBeUndefined();
    expect(chrome.storage._store.domainLimits['reddit.com'].allowedRedditPosts).toEqual(['cats:abc123']);
  });

  it('queues an addition for tomorrow, then merges it with the stored lists', async () => {
    const { ctx, chrome } = loadBackground({ seed: seed() });
    const value = { subreddits: ['cats'], posts: ['rust:def456'] };
    const queued = await ctx.handleMessage({ action: 'applySettingChange', changeType: 'allow_reddit',
      domain: 'reddit.com', newValue: value }, EXT_PAGE);
    expect(queued.scheduled).toBe(true);
    expect(chrome.storage._store.domainLimits['reddit.com'].allowedSubreddits).toEqual(['rust']);
    const applied = await ctx.applySettingChange({ changeType: 'allow_reddit', domain: 'reddit.com', newValue: value });
    expect(applied.allowedSubreddits).toEqual(['rust', 'cats']);
    expect(applied.allowedRedditPosts).toEqual(['cats:abc123', 'rust:def456']);
  });

  it('refuses unusable and non-Reddit additions', async () => {
    const { ctx } = loadBackground({ seed: seed() });
    expect(await ctx.applySettingChange({ changeType: 'allow_reddit', domain: 'instagram.com',
      newValue: { subreddits: ['rust'] } })).toBe(null);
    expect(await ctx.applySettingChange({ changeType: 'allow_reddit', domain: 'reddit.com',
      newValue: { subreddits: ['all'], posts: ['../bad'] } })).toBe(null);
  });
});

describe('activeSession', () => {
  it('charges only foreground time for a paused native target', () => {
    const { ctx } = loadBackground();
    const now = Date.now();
    const session = { domain: 'com.instagram.android', startTime: now - 40 * 60000,
      intervalMinutes: 10, pausedDurationMs: 3 * 60000, pausedAt: now - 35 * 60000 };
    expect(ctx.activeSession(session)).toBe(session);
    expect(ctx.sessionElapsedMs(session, now)).toBe(2 * 60000);
    expect(ctx.sessionExpiryTime(session)).toBe(Infinity);
    delete session.pausedAt;
    session.pausedDurationMs = 38 * 60000;
    expect(ctx.sessionExpiryTime(session)).toBe(now + 8 * 60000);
  });

  it('ends a daily visit at midnight even when it was paused', () => {
    const { ctx } = loadBackground();
    const now = Date.now();
    const session = { domain: 'com.instagram.android', startTime: now - 2 * 60000,
      intervalMinutes: 10, pausedAt: now - 60000, wallExpiresAt: now - 1 };
    expect(ctx.activeSession(session)).toBe(null);
  });

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

describe('Android foreground passes', () => {
  it('starts paused until the target returns from the coach', async () => {
    const { ctx, chrome } = loadBackground({ seed: {
      ...CONFIGURED, appLimits: { 'com.instagram.android': { maxGrants: 1, passMinutes: 10 } }
    } });
    const response = await ctx.handleMessage({ action: 'intentionGrant',
      domain: 'com.instagram.android', isApp: true, reason: 'reply to a friend' },
    { nativePlatform: 'android' });
    expect(response.grantedSession.pausedAt).toBe(response.grantedSession.startTime);
    expect(ctx.activeSession(response.grantedSession)).toBe(response.grantedSession);
    expect(chrome.alarms._created).toEqual([]);
  });

  it('ignores a stale alarm while the pass is paused', async () => {
    const { ctx, chrome, listeners } = loadBackground({ seed: {
      ...CONFIGURED, activeSessions: { 'target:com.instagram.android': {
        domain: 'com.instagram.android', reason: 'message a friend',
        startTime: Date.now() - 40 * 60000, intervalMinutes: 10,
        pausedAt: Date.now() - 38 * 60000
      } }
    } });
    await listeners.alarm({ name: 'checkin-target:com.instagram.android' });
    expect(chrome.storage._store.activeSessions['target:com.instagram.android'].endedAt).toBeUndefined();
    expect(ctx.activeSession(chrome.storage._store.activeSessions['target:com.instagram.android'])).not.toBeNull();
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

  // A DELIVERED MESSAGE IS NOT A RENDERED CHECK-IN, and treating it as one is
  // how a pass's minutes went missing. The content script has three arms that
  // decline to render — a conversation already owns the page, the address is
  // one the user's own part rule leaves open, or the pass is for a different
  // site than this tab is on — and every one of them RESOLVED
  // chrome.tabs.sendMessage. The catch that does the banking never ran, and
  // nothing repairs it later: reconcileSessions is only reachable through its
  // own message, which only the native hosts send.
  describe('when the tab answers but shows nothing', () => {
    async function withPassOnTab(reply) {
      const { ctx, chrome, listeners } = loadBackground({ seed: CONFIGURED, fetch: grantingFetch(10) });
      await ctx.handleMessage(
        { action: 'chat', mode: 'gate', domain: 'instagram.com', userMessage: 'a' },
        tab(42)
      );
      chrome.storage._store.activeSessions['tab:42:instagram.com'].startTime = Date.now() - 10 * 60000;
      const sent = [];
      chrome.tabs.sendMessage = (id, message) => { sent.push({ id, message }); return Promise.resolve(reply); };
      await listeners.alarm({ name: 'checkin-tab:42:instagram.com' });
      return { ctx, chrome, sent };
    }

    it('banks the pass when the page says it showed nothing', async () => {
      const { ctx, chrome } = await withPassOnTab({ shown: false });
      expect(chrome.storage._store.activeSessions['tab:42:instagram.com']).toBeUndefined();
      const stats = await ctx.getStatsForDomain('instagram.com');
      expect(stats.minutesToday).toBe(10);
      expect(stats.sessionsToday[0].outcome).toBe('ran_out');
    });

    // Anything that is not an explicit yes is a no: an older content script
    // answers nothing at all, and its pass must not be stranded either.
    it('banks it for a reply that says nothing about it', async () => {
      const { chrome } = await withPassOnTab(undefined);
      expect(chrome.storage._store.activeSessions['tab:42:instagram.com']).toBeUndefined();
    });

    // The contrast case: a check-in that really did go up owns the session
    // now, and banking it here would take the outcome away from the
    // conversation the user is having about it.
    it('leaves the session alone when the check-in really went up', async () => {
      const { chrome } = await withPassOnTab({ shown: true });
      expect(chrome.storage._store.activeSessions['tab:42:instagram.com']).toBeDefined();
      expect(chrome.storage._store.activeSessions['tab:42:instagram.com'].endedAt).toBeUndefined();
    });

    // A tab can hold passes on two blocked sites at once, so the page cannot
    // tell which one expired without being told.
    it('names the domain whose pass expired', async () => {
      const { sent } = await withPassOnTab({ shown: true });
      expect(sent).toHaveLength(1);
      expect(sent[0].message).toEqual({ action: 'showCheckin', domain: 'instagram.com' });
    });
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

// The two Apple contexts this code runs in, and they don't look alike: the
// Safari web extension carries a normal Safari user agent, while the app's own
// web views (the visible options page and the hidden BackgroundJSHost) get
// WebKit's default, which names neither "Safari" nor "Version/".
const APPLE_APP_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';
const APPLE_SAFARI_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';

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

  // App Store guideline 3.1.1: nothing bought outside In-App Purchase may
  // enable paid functionality, and no provider sells an API key through IAP.
  // Dropping the settings field isn't enough on its own — a key written by an
  // older build is still sitting in storage — so the route refuses it here.
  it('ignores a custom key on an Apple build, falling back to bought credit', async () => {
    const { ctx } = loadBackground({
      seed: { entitlement: ACTIVE_ENTITLEMENT, ...CONFIGURED },
      userAgent: APPLE_APP_UA
    });
    expect((await ctx.resolveAIRoute()).route).toBe('hosted');
  });

  it('locks an Apple build holding nothing but a custom key', async () => {
    const { ctx } = loadBackground({ seed: CONFIGURED, userAgent: APPLE_SAFARI_UA });
    expect((await ctx.resolveAIRoute()).route).toBe('locked');
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
    const { ctx } = loadBackground({ seed: { entitlement: ACTIVE_ENTITLEMENT, domainLimits: { 'x.com': SPENT } }, fetch });
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

  // The throttle marker for "when did this device last ask the backend whether
  // a balance was still attached to its account id". It is not on the
  // whitelist by accident anywhere else: dropped, a fresh install would
  // re-hit an unauthenticated, per-IP rate-limited endpoint on every settings
  // open, on behalf of everyone behind the same NAT.
  it('round-trips the recovery-check marker', async () => {
    const { ctx, chrome } = loadBackground();
    await ctx.handleMessage({
      action: 'saveEntitlement',
      entitlement: { ...ACTIVE_ENTITLEMENT, recoveryCheckedAt: 1710000000000 }
    }, {});
    expect(chrome.storage._store.entitlement.recoveryCheckedAt).toBe(1710000000000);
    await ctx.handleMessage({ action: 'saveEntitlement', entitlement: { ...ACTIVE_ENTITLEMENT } }, {});
    expect(chrome.storage._store.entitlement.recoveryCheckedAt).toBe(0);
  });

  // How the session behind the token proved itself, as the server stamped it.
  // The options page decides from it whether a recovery code may be offered at
  // all, so like the marker above it is dropped on every save unless it is on
  // the whitelist — and the page would then re-learn nothing and go on offering
  // a button the server can only refuse.
  it('round-trips the session kind the server stamped', async () => {
    const { ctx, chrome } = loadBackground();
    await ctx.handleMessage({ action: 'saveEntitlement',
      entitlement: { ...ACTIVE_ENTITLEMENT, src: 'store' } }, {});
    expect(chrome.storage._store.entitlement.src).toBe('store');
  });
});

// ---------------------------------------------------------------------------
// Writing an entitlement without clobbering one
// ---------------------------------------------------------------------------
//
// saveEntitlement is a whole-object write, which is right when the caller has
// just verified a purchase and holds the complete truth. It is wrong on the far
// side of an unbounded await, and options-access.js's recovery check is exactly
// that: it reads the entitlement, spends a network round trip on
// /v1/entitlement/recover, and writes back what it read. A purchase verified in
// between — returning from the Play sheet fires 'intention-app-active', which
// runs a second refreshAccessUI, which is precisely when a top-up completes —
// was overwritten by the snapshot. That took the money and locked the user out:
// receipt gone, so nothing could re-verify, and the recoveryCheckedAt written
// in its place suppressed the re-check for a day.
describe('mergeEntitlement', () => {
  const PURCHASE = {
    active: true, source: 'google', token: 'TOKEN-FROM-PURCHASE',
    receipt: 'PLAY-RECEIPT', balanceCredits: 5000, src: 'store'
  };

  it('writes only the keys it was given, over whatever is stored now', async () => {
    const { ctx, chrome } = loadBackground({ seed: { entitlement: { ...PURCHASE } } });
    const res = await ctx.handleMessage({
      action: 'mergeEntitlement', entitlement: { recoveryCheckedAt: 1710000000000 }
    }, {});
    expect(res.ok).toBe(true);
    expect(chrome.storage._store.entitlement).toMatchObject({ ...PURCHASE, recoveryCheckedAt: 1710000000000 });
    expect(res.entitlement.balanceCredits).toBe(5000);
  });

  // The shape of the defect, side by side. Both callers hold the same stale
  // snapshot — an empty entitlement read before the purchase existed — and are
  // writing the one thing they learned on top of it. Only one of them can do
  // that without taking the purchase with it.
  it('is the difference between recording an answer and undoing a purchase', async () => {
    const stale = { active: false, source: '', recoveryCheckedAt: 1710000000000 };

    const saving = loadBackground({ seed: { entitlement: { ...PURCHASE } } });
    await saving.ctx.handleMessage({ action: 'saveEntitlement', entitlement: stale }, {});
    expect(saving.chrome.storage._store.entitlement.token).toBe('');
    expect(saving.chrome.storage._store.entitlement.receipt).toBe(null);
    expect(saving.chrome.storage._store.entitlement.balanceCredits).toBe(0);

    const merging = loadBackground({ seed: { entitlement: { ...PURCHASE } } });
    await merging.ctx.handleMessage({
      action: 'mergeEntitlement', entitlement: { recoveryCheckedAt: stale.recoveryCheckedAt }
    }, {});
    const stored = merging.chrome.storage._store.entitlement;
    expect(stored.token).toBe('TOKEN-FROM-PURCHASE');
    expect(stored.receipt).toBe('PLAY-RECEIPT');
    expect(stored.balanceCredits).toBe(5000);
    expect(stored.recoveryCheckedAt).toBe(stale.recoveryCheckedAt);
  });

  it('starts from nothing when nothing is stored, and normalizes like a save', async () => {
    const { ctx, chrome } = loadBackground();
    await ctx.handleMessage({
      action: 'mergeEntitlement', entitlement: { recoveryCheckedAt: 5, junk: 'x' }
    }, {});
    expect(chrome.storage._store.entitlement.active).toBe(false);
    expect(chrome.storage._store.entitlement.recoveryCheckedAt).toBe(5);
    expect(chrome.storage._store.entitlement.junk).toBeUndefined();
  });

  it('leaves the stored entitlement alone when handed nothing to merge', async () => {
    const { ctx, chrome } = loadBackground({ seed: { entitlement: { ...PURCHASE } } });
    const res = await ctx.handleMessage({ action: 'mergeEntitlement', entitlement: null }, {});
    expect(res.ok).toBe(false);
    expect(chrome.storage._store.entitlement.token).toBe('TOKEN-FROM-PURCHASE');
  });
});

// ---------------------------------------------------------------------------
// The balance, where it can actually be seen
// ---------------------------------------------------------------------------
//
// "There seems to be no means to see credit balance" was fair: formatBalance()
// was only reachable from inside the paywall, which is the one surface someone
// who has already paid never opens again. getAccess is what the settings chip
// and the gate note both read, so the two exclusions that keep them honest are
// decided once, here.
describe('getAccess reports the balance', () => {
  const withCredits = (balanceCredits) => ({ ...ACTIVE_ENTITLEMENT, balanceCredits });

  it('hands back the credit balance alongside the route', async () => {
    const { ctx } = loadBackground({ seed: { entitlement: withCredits(1240) } });
    const access = await ctx.handleMessage({ action: 'getAccess' }, {});
    expect(access.route).toBe('hosted');
    expect(access.balanceCredits).toBe(1240);
    expect(access.lowCredit).toBe(false);
  });

  it('flags a balance at or under the shared threshold as low', async () => {
    const { ctx } = loadBackground({ seed: { entitlement: withCredits(ctxThreshold()) } });
    const access = await ctx.handleMessage({ action: 'getAccess' }, {});
    expect(access.lowCredit).toBe(true);
    expect(access.balanceCredits).toBe(ctxThreshold());
  });

  it('does not flag one credit above it', async () => {
    const { ctx } = loadBackground({ seed: { entitlement: withCredits(ctxThreshold() + 1) } });
    expect((await ctx.handleMessage({ action: 'getAccess' }, {})).lowCredit).toBe(false);
  });

  // Zero is LOCKED, not low. A different state with a different screen behind
  // it — the paywall replaces the conversation — so a warning here would be
  // the third time in one session that a dead account was made to look merely
  // unwell.
  it('treats an exhausted balance as locked rather than low', async () => {
    const { ctx } = loadBackground({ seed: { entitlement: { ...ACTIVE_ENTITLEMENT, active: false, balanceCredits: 0 } } });
    const access = await ctx.handleMessage({ action: 'getAccess' }, {});
    expect(access.route).toBe('locked');
    expect(access.balanceCredits).toBe(0);
    expect(access.lowCredit).toBe(false);
  });

  // The gate paints this line on every blocked page, so getAccess is now asked
  // from inside arbitrary web pages. The entitlement carries a bearer token
  // that can SPEND the balance — the numbers are all a content script needs,
  // and this is the same rule getConfig already applies to apiKey.
  it('withholds the entitlement token from a content-script sender', async () => {
    const { ctx } = loadBackground({ seed: { entitlement: withCredits(1240) } });
    const page = { url: 'https://instagram.com/', tab: { id: 4 } };
    const access = await ctx.handleMessage({ action: 'getAccess' }, page);
    expect(access.entitlement).toBe(null);
    expect(JSON.stringify(access)).not.toContain('entitlement-token');
    // ...while still answering the question it was asked.
    expect(access.route).toBe('hosted');
    expect(access.balanceCredits).toBe(1240);
  });

  it('still hands the whole entitlement to an extension page', async () => {
    const { ctx, chrome } = loadBackground({ seed: { entitlement: withCredits(1240) } });
    const optionsPage = { url: chrome.runtime.getURL('options.html') };
    const access = await ctx.handleMessage({ action: 'getAccess' }, optionsPage);
    expect(access.entitlement.token).toBe('entitlement-token');
  });

  // getConfig returns the SAME stored object, and stripped only apiKey — so
  // the control getAccess had just grown was half a control, and the next
  // content-script feature that wanted any part of the config would have
  // reopened it without anything failing to say so.
  it('withholds the entitlement token from a content sender asking getConfig', async () => {
    const { ctx } = loadBackground({ seed: { entitlement: withCredits(1240) } });
    const page = { url: 'https://instagram.com/', tab: { id: 4 } };
    const config = await ctx.handleMessage({ action: 'getConfig' }, page);
    expect(config.entitlement).toBe(null);
    expect(JSON.stringify(config)).not.toContain('entitlement-token');
    // ...while still answering everything the page legitimately asks for.
    expect(config.accessRoute).toBe('hosted');
    expect(config.blockedDomains).toEqual([]);
  });

  // The native hosts keep it, and that is the difference from apiKey. Android
  // and iOS deliver an empty sender for EVERY message, including the ones our
  // own settings page sends — and options-access.js reconciles a purchase
  // against this token, so blanking it here would break restore on the only
  // two builds that sell anything.
  it('still hands it to an extension page and a native host', async () => {
    for (const sender of [EXT_PAGE, NATIVE]) {
      const { ctx } = loadBackground({ seed: { entitlement: withCredits(1240) } });
      const config = await ctx.handleMessage({ action: 'getConfig' }, sender);
      expect(config.entitlement.token).toBe('entitlement-token');
    }
  });

  // A custom key has no balance with us at all, so "running low" would not be
  // a small inaccuracy — it would tell someone they had run out of something
  // they never bought.
  it('never flags a custom-key route, whatever is stored', async () => {
    const { ctx } = loadBackground({ seed: { ...CONFIGURED, entitlement: withCredits(5) } });
    const access = await ctx.handleMessage({ action: 'getAccess' }, {});
    expect(access.route).toBe('byok');
    expect(access.lowCredit).toBe(false);
  });
});

// Read out of providers.js rather than repeated, so this suite cannot pass
// against a threshold the shipped code no longer uses.
function ctxThreshold() {
  return loadBackground().ctx.LOW_CREDIT_CREDITS;
}

// ---------------------------------------------------------------------------
// ...and what the gate does with that answer
// ---------------------------------------------------------------------------
//
// getAccess hands back the stored balance on every route, because the settings
// page wants the number even when it will not paint it. Deciding what that
// means is the reader's job, and one of the two readers was not doing it:
// options.js's chip goes to explicit lengths to hide itself on 'byok' ("a chip
// reading 0 would not be a small inaccuracy, it would be the wrong mental
// model"), while gate-ui.js's credit note was never told the route at all. So a
// user who bought credit, spent some, then pointed the coach at their own
// Anthropic key was told "830 coaching credits left" on every blocked page
// while every message was billed to that key.
//
// The two surfaces are fed the same getAccess response here, on purpose: the
// bug was that they disagreed about it.
function creditNote(access) {
  const note = {
    id: 'int-credit-note', textContent: '', hidden: false,
    dataset: { persistent: '' }, classList: { toggle() {} }
  };
  const sandbox = {
    document: { getElementById: (id) => (id === 'int-credit-note' ? note : null), createElement: () => ({}) },
    window: { addEventListener() {}, removeEventListener() {}, location: { href: '' } },
    console: { log() {}, warn() {}, error() {} },
    navigator: { userAgent: 'Chrome/120' },
    chrome: { runtime: { sendMessage: (msg, cb) => cb(access), lastError: null } },
    setTimeout, clearTimeout, setInterval, clearInterval,
    Math, JSON, Promise, Error, Object, Array, String, Number, Date
  };
  sandbox.globalThis = sandbox;
  const context = vm.createContext(sandbox);
  evaluateScripts(context, filesForContext('content', { only: ['report.js', 'gate-ui.js'] }));
  sandbox.loadCreditNote();
  return note;
}

describe('the gate credit note reads the same answer the chip does', () => {
  const access = async (seed) => {
    const { ctx } = loadBackground({ seed });
    return ctx.handleMessage({ action: 'getAccess' }, {});
  };

  it('says nothing on a custom key, whatever balance is left over from before', async () => {
    const byok = await access({ ...CONFIGURED, entitlement: { ...ACTIVE_ENTITLEMENT, balanceCredits: 830 } });
    expect(byok.route).toBe('byok');
    // The number is still in the response — the settings page is entitled to
    // it — and the note still has to keep quiet about it.
    expect(byok.balanceCredits).toBe(830);
    const note = creditNote(byok);
    expect(note.hidden).toBe(true);
    expect(note.textContent).toBe('');
  });

  it('paints the balance on the hosted route, where it is being spent', async () => {
    const hosted = await access({ entitlement: { ...ACTIVE_ENTITLEMENT, balanceCredits: 830 } });
    expect(hosted.route).toBe('hosted');
    expect(creditNote(hosted).textContent).toBe('830 coaching credits left.');
  });

  it('warns when the hosted balance is low', async () => {
    const low = await access({ entitlement: { ...ACTIVE_ENTITLEMENT, balanceCredits: ctxThreshold() } });
    expect(creditNote(low).textContent).toContain('running low');
  });

  // Zero is locked, and the paywall is already saying that louder.
  it('says nothing at zero, on any route', async () => {
    const locked = await access({ entitlement: { ...ACTIVE_ENTITLEMENT, active: false, balanceCredits: 0 } });
    expect(locked.route).toBe('locked');
    expect(creditNote(locked).hidden).toBe(true);
  });
});

// The gate paints a credit line after every turn. Without the ride-along it
// would have to ask getAccess for a number the response it just received was
// already carrying — a second round trip per message, for a balance this
// message is what changed.
describe('handleChat carries the balance back', () => {
  it('reports the balance the hosted call answered with', async () => {
    const fetch = makeMockFetch({ text: 'Okay.', toolCalls: [], balanceCredits: 900, balanceMicros: 9, balanceGbp: 0.9 });
    const { ctx } = loadBackground({ seed: { entitlement: ACTIVE_ENTITLEMENT }, fetch });
    const res = await ctx.handleChat({ tabId: 1, mode: 'gate', domain: 'x.com', userMessage: 'hi' });
    expect(res.balanceCredits).toBe(900);
    expect(res.lowCredit).toBe(false);
  });

  it('flags a low balance with the same threshold getAccess uses', async () => {
    const fetch = makeMockFetch({ text: 'Okay.', toolCalls: [], balanceCredits: ctxThreshold() });
    const { ctx } = loadBackground({ seed: { entitlement: ACTIVE_ENTITLEMENT }, fetch });
    const res = await ctx.handleChat({ tabId: 1, mode: 'gate', domain: 'x.com', userMessage: 'hi' });
    expect(res.lowCredit).toBe(true);
  });

  // A route with no balance behind it says nothing at all, rather than
  // reporting a zero the gate would have to know to ignore.
  it('says nothing about a balance on a custom-key route', async () => {
    const fetch = makeMockFetch({ content: [{ type: 'text', text: 'Okay.' }] });
    const { ctx } = loadBackground({ seed: CONFIGURED, fetch });
    const res = await ctx.handleChat({ tabId: 1, mode: 'gate', domain: 'x.com', userMessage: 'hi' });
    expect(res.balanceCredits).toBeUndefined();
    expect(res.lowCredit).toBe(false);
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

// The suggestion grid ranks on this tally, and the tally is the one thing in
// the extension that writes down a site nobody asked it to watch — so its
// bounds are the point of these tests, not just its arithmetic.
describe('candidate visit tally', () => {
  const seed = { blockedDomains: ['instagram.com'], setupComplete: true };

  it('counts an unblocked candidate site', async () => {
    const { ctx, chrome } = loadBackground({ seed });
    await ctx.checkPageMatch('news.ycombinator.com', 1);
    await ctx.getCandidateVisits();
    expect(chrome.storage._store.siteVisits['news.ycombinator.com'].count).toBe(1);
  });

  it('folds a subdomain into its candidate', async () => {
    const { ctx, chrome } = loadBackground({ seed });
    await ctx.recordCandidateVisit('old.reddit.com');
    expect(chrome.storage._store.siteVisits['reddit.com'].count).toBe(1);
  });

  it('records nothing for a host outside the catalogue', async () => {
    const { ctx, chrome } = loadBackground({ seed });
    await ctx.checkPageMatch('example.com', 1);
    await ctx.checkPageMatch('notreddit.com', 1);
    // Nothing written at all — not an empty object, no key.
    expect(chrome.storage._store.siteVisits).toBeUndefined();
  });

  it('records nothing for a site that is already blocked', async () => {
    const { ctx, chrome } = loadBackground({ seed });
    await ctx.checkPageMatch('www.instagram.com', 1);
    // Nothing written at all — not an empty object, no key.
    expect(chrome.storage._store.siteVisits).toBeUndefined();
  });

  it('counts a sitting once, however many pages deep it goes', async () => {
    const { ctx, chrome } = loadBackground({ seed });
    await ctx.recordCandidateVisit('reddit.com');
    await ctx.recordCandidateVisit('reddit.com');
    await ctx.recordCandidateVisit('reddit.com');
    expect(chrome.storage._store.siteVisits['reddit.com'].count).toBe(1);
  });

  it('counts again once the gap has passed', async () => {
    const { ctx, chrome } = loadBackground({ seed });
    await ctx.recordCandidateVisit('reddit.com');
    chrome.storage._store.siteVisits['reddit.com'].last = Date.now() - (31 * 60 * 1000);
    await ctx.recordCandidateVisit('reddit.com');
    expect(chrome.storage._store.siteVisits['reddit.com'].count).toBe(2);
  });

  it('hands the tally to the options page', async () => {
    const { ctx } = loadBackground({ seed });
    await ctx.recordCandidateVisit('www.youtube.com');
    const visits = await ctx.handleMessage({ action: 'getSiteVisits' }, {});
    expect(visits['youtube.com'].count).toBe(1);
  });
});

describe('setup no longer collects credentials', () => {
  // The shape the wizard actually sends: it carries the credential fields
  // through from storage precisely so finishing setup cannot wipe a key, and
  // on a build that never offered one they arrive as empty strings.
  it('completes with no provider or key', async () => {
    const { ctx, chrome } = loadBackground();
    await ctx.handleMessage({
      action: 'saveSetup',
      config: { provider: '', apiKey: '', model: '', userContext: 'ctx', blockedDomains: ['x.com'], domainLimits: {} }
    }, {});
    expect(chrome.storage._store.setupComplete).toBe(true);
    expect(chrome.storage._store.apiKey).toBe('');
    expect(chrome.storage._store.provider).toBe('');
  });
});

// saveSetup writes every field it is GIVEN. It used to write every field it
// could name, present or not, so `|| ''` turned "not mentioned" into
// "cleared" — and options-wizard.js omits userContext, contextProjects and
// contextReasons on purpose, with a comment saying that omitting them is what
// protects context an existing user built up with the coach. It was not.
describe('saveSetup only writes the fields it was given', () => {
  const EXISTING = {
    setupComplete: true,
    userContext: 'writing a dissertation on lichens',
    contextProjects: 'the dissertation',
    contextReasons: 'I keep opening reddit at 1am',
    apiKey: 'sk-real-key',
    provider: 'anthropic',
    appLabels: { 'com.instagram.android': 'Instagram' },
    blockedDomains: ['reddit.com']
  };
  // Exactly what options-wizard.js sends: the three context keys absent.
  const WIZARD = {
    provider: 'anthropic', apiKey: 'sk-real-key', model: '',
    blockedDomains: ['reddit.com', 'x.com'], domainLimits: {},
    blockedApps: [], appLimits: {}, appLabels: { 'com.instagram.android': 'Instagram' },
    serviceReasons: {}, blockingMode: 'coach', simpleBehavior: 'pass', simplePassMinutes: 10
  };

  it('leaves the coach context alone when the wizard omits it', async () => {
    const { ctx, chrome } = loadBackground({ seed: { ...EXISTING } });
    await ctx.handleMessage({ action: 'saveSetup', config: { ...WIZARD } }, {});
    expect(chrome.storage._store.userContext).toBe('writing a dissertation on lichens');
    expect(chrome.storage._store.contextProjects).toBe('the dissertation');
    expect(chrome.storage._store.contextReasons).toBe('I keep opening reddit at 1am');
    // ...and still writes what it WAS given.
    expect(chrome.storage._store.blockedDomains).toEqual(['reddit.com', 'x.com']);
    expect(chrome.storage._store.setupComplete).toBe(true);
  });

  // Present-but-empty is a real answer and still clears the field: the
  // distinction is absence, not falsiness.
  it('still clears a field that was sent as empty', async () => {
    const { ctx, chrome } = loadBackground({ seed: { ...EXISTING } });
    await ctx.handleMessage({ action: 'saveSetup', config: { ...WIZARD, userContext: '' } }, {});
    expect(chrome.storage._store.userContext).toBe('');
  });

  // An omitted blocklist is the same trap wearing the blocklist's clothes:
  // "cleared" here means every blocked site silently unblocked. An omitted
  // limits map is the same trap again — the sites stay blocked and lose their
  // grant and minute caps.
  it('does not unblock everything when the blocklist is omitted', async () => {
    const { ctx, chrome } = loadBackground({
      seed: { ...EXISTING, domainLimits: { 'reddit.com': { maxGrants: 2, maxMinutes: 30 } } }
    });
    const noList = { ...WIZARD };
    delete noList.blockedDomains;
    delete noList.domainLimits;
    await ctx.handleMessage({ action: 'saveSetup', config: noList }, {});
    expect(chrome.storage._store.blockedDomains).toEqual(['reddit.com']);
    expect(chrome.storage._store.domainLimits).toEqual({ 'reddit.com': { maxGrants: 2, maxMinutes: 30 } });
  });

  // "When they started", not "when they last pressed Finish": the leaving
  // conversation reads it to say how long they have been at this.
  it('keeps the original setup date rather than restamping it', async () => {
    const started = Date.now() - 40 * 86400000;
    const { ctx, chrome } = loadBackground({ seed: { ...EXISTING, setupCompletedAt: started } });
    await ctx.handleMessage({ action: 'saveSetup', config: { ...WIZARD } }, {});
    expect(chrome.storage._store.setupCompletedAt).toBe(started);
  });
});

// What the user said each service is for, written during setup. It is the one
// piece of free text that reaches a system prompt without ever passing through
// a model first, which is why it is trimmed, capped and dropped when blank
// rather than stored as the page sent it.
describe('per-service setup answers', () => {
  const reasons = {
    'instagram.com': { purpose: '  DMs from my sister.  ', legitimateUse: 'A specific reply.' }
  };

  it('persists them through saveSetup, trimmed', async () => {
    const { ctx, chrome } = loadBackground();
    await ctx.handleMessage({
      action: 'saveSetup',
      config: { blockedDomains: ['instagram.com'], domainLimits: {}, serviceReasons: reasons }
    }, {});
    expect(chrome.storage._store.serviceReasons['instagram.com'].purpose).toBe('DMs from my sister.');
    expect(chrome.storage._store.serviceReasons['instagram.com'].updatedAt).toBeGreaterThan(0);
  });

  it('drops an entry with nothing written in it', async () => {
    const { ctx, chrome } = loadBackground();
    await ctx.handleMessage({
      action: 'saveSetup',
      config: {
        blockedDomains: ['x.com'],
        domainLimits: {},
        serviceReasons: { 'x.com': { purpose: '   ', legitimateUse: '' } }
      }
    }, {});
    expect(chrome.storage._store.serviceReasons).toEqual({});
  });

  it('caps a very long answer rather than letting it flood the prompt', async () => {
    const { ctx, chrome } = loadBackground();
    await ctx.handleMessage({
      action: 'saveSetup',
      config: {
        blockedDomains: ['x.com'],
        domainLimits: {},
        serviceReasons: { 'x.com': { purpose: 'a'.repeat(5000) } }
      }
    }, {});
    expect(chrome.storage._store.serviceReasons['x.com'].purpose).toHaveLength(500);
  });

  it('sanitizes on the settings path too, not just setup', async () => {
    const { ctx, chrome } = loadBackground();
    await ctx.handleMessage({
      action: 'saveSettings',
      config: { serviceReasons: { 'x.com': { purpose: '  Two niche subs.  ' } } }
    }, {});
    expect(chrome.storage._store.serviceReasons['x.com'].purpose).toBe('Two niche subs.');
  });

  it('hands them back to the options page', async () => {
    const { ctx } = loadBackground({ seed: { serviceReasons: reasons } });
    const config = await ctx.handleMessage({ action: 'getConfig' }, {});
    expect(config.serviceReasons['instagram.com'].purpose).toContain('sister');
  });
});

// The point of the whole feature: at the gate, the coach is holding what the
// user said this particular site is for.
describe('the gate prompt carries the per-service answers', () => {
  const seed = {
    entitlement: ACTIVE_ENTITLEMENT,
    serviceReasons: {
      'instagram.com': { purpose: 'DMs from my sister.', legitimateUse: 'A specific reply.' }
    }
  };

  it('reaches a website gate', async () => {
    const fetch = makeMockFetch({ text: 'Okay.', toolCalls: [] });
    const { ctx } = loadBackground({ seed, fetch });
    await ctx.handleChat({ tabId: 1, mode: 'gate', domain: 'instagram.com', userMessage: 'hi' });
    expect(systemPromptOf(fetch)).toContain('DMs from my sister.');
  });

  // The whole reason serviceKeyFor exists: the app and the site are separate
  // targets everywhere else, and the user answered the questions once.
  it('reaches the Instagram app gate from the answer written about the website', async () => {
    const fetch = makeMockFetch({ text: 'Okay.', toolCalls: [] });
    const { ctx } = loadBackground({ seed, fetch });
    await ctx.handleChat({
      mode: 'gate', domain: 'com.instagram.android', isApp: true,
      appLabel: 'Instagram', userMessage: 'hi'
    });
    const prompt = systemPromptOf(fetch);
    expect(prompt).toContain('DMs from my sister.');
    expect(prompt).toContain('A specific reply.');
  });

  it('does not leak one service\'s answer into another\'s gate', async () => {
    const fetch = makeMockFetch({ text: 'Okay.', toolCalls: [] });
    const { ctx } = loadBackground({ seed, fetch });
    await ctx.handleChat({ tabId: 1, mode: 'gate', domain: 'reddit.com', userMessage: 'hi' });
    expect(systemPromptOf(fetch)).not.toContain('DMs from my sister.');
  });

  it('says nothing at all when the user skipped the questions', async () => {
    const fetch = makeMockFetch({ text: 'Okay.', toolCalls: [] });
    const { ctx } = loadBackground({ seed: { entitlement: ACTIVE_ENTITLEMENT }, fetch });
    await ctx.handleChat({ tabId: 1, mode: 'gate', domain: 'instagram.com', userMessage: 'hi' });
    expect(systemPromptOf(fetch)).not.toContain('Why they blocked');
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
          '99': { domain: 'instagram.com', startTime: Date.now(), intervalMinutes: 10,
            scope: { kind: 'page', url: 'https://instagram.com/p/one/' } }
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

  // The coach is the way past a spent intention, never a way to pay for time
  // that was already free. A grant it attempts while opens remain is refused,
  // and both the user and the model are told to use an open instead.
  it('refuses a coach grant while free opens remain, and says why', async () => {
    const { ctx, chrome, fetch } = loadBackground({
      seed: { ...CONFIGURED, domainLimits: { 'instagram.com': { maxGrants: 2, passMinutes: 10 } } },
      fetch: grantingFetch(5, 'one more look')
    });
    const resp = await ctx.handleMessage(
      { action: 'chat', mode: 'gate', domain: 'instagram.com', userMessage: 'a' },
      NATIVE
    );
    expect(resp.grantedSession ?? null).toBe(null);
    expect(chrome.storage._store.activeSessions?.['target:instagram.com']).toBeUndefined();
    expect(resp.systemNote).toBe('You still have 2 free opens today. Use one from the gate instead.');
    // Rejection + honesty turn.
    expect(fetch.calls.length).toBe(2);
  });

  // Past the intention there is no second ceiling: credit is the friction.
  // Every pass is short, and every one is recorded as negotiated.
  it('keeps granting past the intention, and marks each pass negotiated', async () => {
    const { ctx, chrome } = loadBackground({ seed: CONFIGURED, fetch: grantingFetch(5, 'one more look') });
    for (let i = 0; i < 5; i++) {
      const resp = await ctx.handleMessage(
        { action: 'chat', mode: 'gate', domain: 'instagram.com', userMessage: 'a' },
        NATIVE
      );
      expect(resp.grantedSession.intervalMinutes).toBe(5);
      delete chrome.storage._store.activeSessions['target:instagram.com'];
    }
    const stats = await ctx.getStatsForDomain('instagram.com');
    expect(stats.grantsToday).toBe(5);
    expect(stats.negotiatedToday).toBe(5);
    const sessions = chrome.storage._store.dailyStats[today()]['instagram.com'].sessions;
    expect(sessions.every(sess => sess.negotiated === true)).toBe(true);
  });

  // Negotiated passes do not use up the day's opens: the gate counts opens
  // from the free passes alone.
  it('does not spend the intention with negotiated passes', async () => {
    const { ctx } = loadBackground({
      seed: {
        ...CONFIGURED,
        domainLimits: { 'instagram.com': { maxGrants: 1, passMinutes: 10 } },
        dailyStats: { [today()]: { 'instagram.com': { minutes: 30, grants: 3, negotiated: 2, sessions: [] } } }
      }
    });
    expect(await ctx.getIntention('instagram.com')).toMatchObject({ opens: 1, opensUsed: 1, opensLeft: 0 });
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

  it('leaves the same session shape behind as a free open', async () => {
    const seed = { ...CONFIGURED, blockedDomains: ['instagram.com'] };
    const viaCoach = loadBackground({ seed, fetch: grantingFetch(10, 'check DMs') });
    await viaCoach.ctx.handleMessage(
      { action: 'chat', mode: 'gate', domain: 'instagram.com', userMessage: 'a' },
      tab(7)
    );

    const viaSimple = loadBackground({
      seed: { ...seed, domainLimits: { 'instagram.com': { maxGrants: 3, passMinutes: 10 } } }
    });
    await viaSimple.ctx.handleMessage(
      { action: 'intentionGrant', domain: 'instagram.com', reason: 'check DMs' },
      tab(7)
    );

    const coachSession = viaCoach.chrome.storage._store.activeSessions['tab:7:instagram.com'];
    const simpleSession = viaSimple.chrome.storage._store.activeSessions['tab:7:instagram.com'];
    expect(Object.keys(coachSession).sort()).toEqual(Object.keys(simpleSession).sort());
    expect((await viaCoach.ctx.getStatsForDomain('instagram.com')).grantsToday)
      .toBe((await viaSimple.ctx.getStatsForDomain('instagram.com')).grantsToday);
  });
});

// The quick check is retired. It was a small daily lane, ON by default, that a
// model-attested grant could spend BEFORE the grants cap was checked — so
// deleting its settings control alone would have left every gate quietly
// handing out a cap-bypassing pass with the off switch gone. These are the
// tests that hold the lane shut: the flag is no longer in the tool schema, and
// even a model that invents it gets a plain grant, counted like any other.
describe('the retired quick-check lane is inert', () => {
  it('an invented quick_check flag buys nothing: it is a normal grant', async () => {
    const { ctx, chrome, fetch } = loadBackground({ seed: CONFIGURED, fetch: quickCheckFetch(3) });
    const resp = await ctx.handleMessage(
      { action: 'chat', mode: 'gate', domain: 'instagram.com', userMessage: 'need the address from a DM' },
      NATIVE
    );
    expect(resp.grantedSession.intervalMinutes).toBe(3);
    expect(fetch.calls.length).toBe(1);
    const stats = await ctx.getStatsForDomain('instagram.com');
    // It counts as a grant like any other, and the separate tally stays untouched.
    expect(stats.grantsToday).toBe(1);
    expect(stats.quickChecksToday).toBe(0);
    expect(chrome.storage._store.activeSessions['target:instagram.com'].quickCheck).toBeUndefined();
  });

  it('a flagged check-in grant is a plain extension, as it always was', async () => {
    const { ctx } = loadBackground({ seed: CONFIGURED, fetch: quickCheckFetch(3) });
    const resp = await ctx.handleMessage(
      { action: 'chat', mode: 'checkin', domain: 'instagram.com', userMessage: 'two more minutes' },
      NATIVE
    );
    expect(resp.grantedSession.intervalMinutes).toBe(3);
    const stats = await ctx.getStatsForDomain('instagram.com');
    expect(stats.grantsToday).toBe(1);
    expect(stats.quickChecksToday).toBe(0);
  });
});

// The two change types that loosened the lane went with it. An approval that
// somehow still arrives for one — a queued transcript, a replayed message —
// must write nothing at all rather than resurrect a stored lane.
describe('the retired quick-check change types apply nothing', () => {
  const approvingFetch = () => makeMockFetch({
    content: [
      { type: 'text', text: 'Alright.' },
      { type: 'tool_use', id: 't1', name: 'approve_setting_change', input: { reason: 'considered' } }
    ]
  });

  it('leaves the domain entry exactly as it was', async () => {
    const { ctx, chrome } = loadBackground({
      seed: { ...CONFIGURED, domainLimits: { 'reddit.com': { maxGrants: 2, maxMinutes: 20, mode: 'coach' } } },
      fetch: approvingFetch()
    });
    const resp = await ctx.handleMessage(
      {
        action: 'chat', mode: 'settings_gate', domain: 'reddit.com',
        changeType: 'increase_quick_check',
        currentValue: { minutes: 3, usesPerDay: 1 }, newValue: { minutes: 5, usesPerDay: 2 },
        userMessage: 'I need slightly longer checks for work'
      },
      EXT_PAGE
    );
    expect(resp.approved ?? null).toBeFalsy();
    expect(chrome.storage._store.domainLimits['reddit.com'])
      .toEqual({ maxGrants: 2, maxMinutes: 20, mode: 'coach' });
  });

  it('leaves the app entry exactly as it was', async () => {
    const { ctx, chrome } = loadBackground({
      seed: { ...CONFIGURED, appLimits: { 'com.instagram.android': { maxGrants: 3 } } },
      fetch: approvingFetch()
    });
    await ctx.handleMessage(
      {
        action: 'chat', mode: 'settings_gate', domain: 'com.instagram.android',
        changeType: 'increase_app_quick_check',
        currentValue: { minutes: 3, usesPerDay: 1 }, newValue: { minutes: 0, usesPerDay: 0 },
        userMessage: 'turn it off'
      },
      EXT_PAGE
    );
    expect(chrome.storage._store.appLimits['com.instagram.android']).toEqual({ maxGrants: 3 });
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
    const { chrome, listeners } = loadBackground({ seed: legacySeed() });
    chrome.storage._store.activeSessions['42'].startTime = Date.now() - 10 * 60000;

    // The tab id is still recoverable from the legacy alarm name, so this
    // takes the same path as before and drops the unreachable tab's session.
    await listeners.alarm({ name: 'checkin-42' });

    expect(chrome.storage._store.activeSessions['42']).toBeUndefined();
  });
});

// applySettingChange and the free-pass action used to be directly callable by
// any content script: a hostile page could clear the whole blocklist, or mint a
// pass for another site. Opens are spent only by the site's own page (or our
// pages and native hosts), and settings change only from our own pages.
describe('privileged message actions are gated on sender and intention', () => {
  const BLOCKED = { ...CONFIGURED, blockedDomains: ['instagram.com'] };
  const WITH_OPENS = { ...BLOCKED, domainLimits: { 'instagram.com': { maxGrants: 2, passMinutes: 5 } } };

  it('refuses intentionGrant once the intention is spent, whoever asks', async () => {
    const { ctx, chrome } = loadBackground({ seed: BLOCKED });
    for (const sender of [tab(7), EXT_PAGE, NATIVE]) {
      const resp = await ctx.handleMessage(
        { action: 'intentionGrant', domain: 'instagram.com', reason: 'check DMs', tabId: 7 }, sender
      );
      expect(resp.grantedSession).toBeUndefined();
      expect(resp.denied).toBeTruthy();
      expect(resp.intention).toMatchObject({ opens: 0 });
    }
    expect(chrome.storage._store.activeSessions ?? {}).toEqual({});
  });

  it('refuses a content script asking for a different site than its own', async () => {
    const { ctx } = loadBackground({ seed: WITH_OPENS });
    const resp = await ctx.handleMessage(
      { action: 'intentionGrant', domain: 'instagram.com', reason: 'check DMs' },
      tab(7, 'evil.com')
    );
    expect(resp.grantedSession).toBeUndefined();
    expect(resp.denied).toBeTruthy();
  });

  it('grants one open of the intended length from the blocked page itself', async () => {
    const { ctx } = loadBackground({ seed: WITH_OPENS });
    const resp = await ctx.handleMessage(
      { action: 'intentionGrant', domain: 'instagram.com', reason: 'check DMs' },
      tab(7, 'www.instagram.com')
    );
    expect(resp.grantedSession.intervalMinutes).toBe(5);
    expect(await ctx.getIntention('instagram.com')).toMatchObject({ opensUsed: 1, opensLeft: 1 });
  });

  it('grants from the coaching page and native hosts too', async () => {
    for (const sender of [EXT_PAGE, NATIVE]) {
      const { ctx } = loadBackground({ seed: WITH_OPENS });
      const resp = await ctx.handleMessage(
        { action: 'intentionGrant', domain: 'instagram.com', reason: 'check DMs', tabId: 7 }, sender
      );
      expect(resp.grantedSession).toBeDefined();
    }
  });

  it('stops at the intention: the third open of two is refused', async () => {
    const { ctx, chrome } = loadBackground({ seed: WITH_OPENS });
    for (let i = 0; i < 2; i++) {
      const ok = await ctx.handleMessage({ action: 'intentionGrant', domain: 'instagram.com', reason: 'check DMs' }, NATIVE);
      expect(ok.grantedSession).toBeDefined();
      delete chrome.storage._store.activeSessions['target:instagram.com'];
    }
    const third = await ctx.handleMessage({ action: 'intentionGrant', domain: 'instagram.com', reason: 'check DMs' }, NATIVE);
    expect(third.grantedSession).toBeUndefined();
    expect(third.denied).toBe('intention spent');
    // A free open is never recorded as negotiated.
    expect((await ctx.getStatsForDomain('instagram.com')).negotiatedToday).toBe(0);
  });

  it('refuses applySettingChange from any content script', async () => {
    const { ctx, chrome } = loadBackground({ seed: BLOCKED });
    const resp = await ctx.handleMessage(
      { action: 'applySettingChange', changeType: 'disable_all' },
      tab(7)
    );
    expect(resp?.blockedDomains).toBeUndefined();
    expect(resp?.scheduled).toBeUndefined();
    expect(chrome.storage._store.blockedDomains).toEqual(['instagram.com']);
    expect(chrome.storage._store.pendingChanges).toBeUndefined();
  });
});

describe('daily time allowance', () => {
  const DAILY = {
    ...CONFIGURED,
    blockedDomains: ['instagram.com'],
    domainLimits: { 'instagram.com': { intentionMode: 'dailyTime', dailyTimeMinutes: 30 } }
  };

  it('requires a reason and a chosen duration for each free pass', async () => {
    const { ctx, chrome } = loadBackground({ seed: DAILY });
    const noReason = await ctx.handleMessage(
      { action: 'intentionGrant', domain: 'instagram.com', minutes: 10 }, NATIVE
    );
    expect(noReason.denied).toBe('reason required');
    const noMinutes = await ctx.handleMessage(
      { action: 'intentionGrant', domain: 'instagram.com', reason: 'Read a message' }, NATIVE
    );
    expect(noMinutes.denied).toBe('invalid visit duration');
    expect(chrome.storage._store.activeSessions ?? {}).toEqual({});
  });

  it('reserves the selected time and releases unused minutes when a pass ends early', async () => {
    const { ctx, chrome } = loadBackground({ seed: DAILY });
    const first = await ctx.handleMessage(
      { action: 'intentionGrant', domain: 'instagram.com', reason: 'Read a message', minutes: 20 }, NATIVE
    );
    expect(first.grantedSession.intervalMinutes).toBe(20);
    expect((await ctx.getIntention('instagram.com')).minutesLeft).toBe(10);
    chrome.storage._store.activeSessions['target:instagram.com'].startTime = Date.now() - 5 * 60000;
    await ctx.handleMessage({ action: 'endSession', domain: 'instagram.com', reason: 'done' }, NATIVE);
    expect((await ctx.getIntention('instagram.com')).minutesLeft).toBeGreaterThanOrEqual(24);
    const second = await ctx.handleMessage(
      { action: 'intentionGrant', domain: 'instagram.com', reason: 'Check a reply', minutes: 20 }, NATIVE
    );
    expect(second.grantedSession.intervalMinutes).toBe(20);
    expect((await ctx.getIntention('instagram.com')).minutesLeft).toBeLessThanOrEqual(5);
  });

  it('serializes parallel requests so they cannot both spend the same remaining time', async () => {
    const { ctx } = loadBackground({ seed: DAILY });
    const ask = () => ctx.handleMessage(
      { action: 'intentionGrant', domain: 'instagram.com', reason: 'Check updates', minutes: 20 }, NATIVE
    );
    const [a, b] = await Promise.all([ask(), ask()]);
    expect([a, b].filter(r => r.grantedSession)).toHaveLength(1);
    expect([a, b].filter(r => r.denied)).toHaveLength(1);
  });

  it('keeps negotiated time behind the coach while free daily time remains', async () => {
    const { ctx, chrome } = loadBackground({ seed: DAILY, fetch: grantingFetch(5, 'check updates') });
    const resp = await ctx.handleMessage(
      { action: 'chat', mode: 'gate', domain: 'instagram.com', userMessage: 'Need to check updates' }, NATIVE
    );
    expect(resp.grantedSession ?? null).toBe(null);
    expect(resp.systemNote).toContain('minutes of today\'s intended time available');
    expect(chrome.storage._store.activeSessions?.['target:instagram.com']).toBeUndefined();
  });
});

// A loosening asked for from Settings is never refused and never applied on
// the spot. It waits until tomorrow — the coach is the only way to have it now.
describe('loosening from settings waits until tomorrow', () => {
  const BLOCKED = { ...CONFIGURED, blockedDomains: ['instagram.com'] };

  it('queues a removal instead of applying it', async () => {
    const { ctx, chrome } = loadBackground({ seed: BLOCKED });
    const resp = await ctx.handleMessage(
      { action: 'applySettingChange', changeType: 'remove', domain: 'instagram.com' },
      EXT_PAGE
    );
    expect(resp.scheduled).toBe(true);
    expect(chrome.storage._store.blockedDomains).toEqual(['instagram.com']);
    const [pending] = chrome.storage._store.pendingChanges;
    expect(pending).toMatchObject({ changeType: 'remove', domain: 'instagram.com' });
    expect(pending.effectiveAt).toBe(ctx.nextDayStart(pending.requestedAt));
  });

  it('applies a queued change once its day has come', async () => {
    const { ctx, chrome } = loadBackground({
      seed: {
        ...BLOCKED,
        pendingChanges: [{ changeType: 'remove', domain: 'instagram.com', newValue: null, requestedAt: 1, effectiveAt: Date.now() - 1000 }]
      }
    });
    await ctx.handleMessage({ action: 'reconcileSessions' }, NATIVE);
    expect(chrome.storage._store.blockedDomains).toEqual([]);
    expect(chrome.storage._store.pendingChanges).toEqual([]);
  });

  it('leaves a change that is not yet due exactly where it is', async () => {
    const pending = { changeType: 'remove', domain: 'instagram.com', newValue: null, requestedAt: 1, effectiveAt: Date.now() + 3600000 };
    const { ctx, chrome } = loadBackground({ seed: { ...BLOCKED, pendingChanges: [pending] } });
    await ctx.getIntention('instagram.com');
    expect(chrome.storage._store.blockedDomains).toEqual(['instagram.com']);
    expect(chrome.storage._store.pendingChanges).toEqual([pending]);
  });

  it('applies a raised intention on its day, keeping the part rule', async () => {
    const { ctx, chrome } = loadBackground({
      seed: {
        ...BLOCKED,
        domainLimits: { 'instagram.com': { maxGrants: 1, passMinutes: 5, scope: 'only', parts: ['instagram:reels'] } },
        pendingChanges: [{ changeType: 'increase_limit', domain: 'instagram.com', newValue: { maxGrants: 3, passMinutes: 15 }, requestedAt: 1, effectiveAt: Date.now() - 1 }]
      }
    });
    expect(await ctx.getIntention('instagram.com')).toMatchObject({ opens: 3, minutesEach: 15 });
    expect(chrome.storage._store.domainLimits['instagram.com']).toEqual({
      maxGrants: 3, passMinutes: 15, scope: 'only', parts: ['instagram:reels']
    });
  });

  it('asking again replaces the earlier request rather than stacking', async () => {
    const { ctx, chrome } = loadBackground({ seed: BLOCKED });
    for (const opens of [4, 6]) {
      await ctx.handleMessage(
        { action: 'applySettingChange', changeType: 'increase_limit', domain: 'instagram.com', newValue: { maxGrants: opens, passMinutes: 10 } },
        EXT_PAGE
      );
    }
    expect(chrome.storage._store.pendingChanges).toHaveLength(1);
    expect(chrome.storage._store.pendingChanges[0].newValue.maxGrants).toBe(6);
  });

  it('cancelling a queued change is free and immediate', async () => {
    const { ctx, chrome } = loadBackground({ seed: BLOCKED });
    await ctx.handleMessage({ action: 'applySettingChange', changeType: 'remove', domain: 'instagram.com' }, EXT_PAGE);
    await ctx.handleMessage({ action: 'cancelPendingChange', changeType: 'remove', domain: 'instagram.com' }, EXT_PAGE);
    expect(chrome.storage._store.pendingChanges).toEqual([]);
  });

  it('a later tightening supersedes a queued raise for the same target', async () => {
    const { ctx, chrome } = loadBackground({
      seed: { ...BLOCKED, domainLimits: { 'instagram.com': { maxGrants: 3, passMinutes: 10 } } }
    });
    await ctx.handleMessage(
      { action: 'applySettingChange', changeType: 'increase_limit', domain: 'instagram.com', newValue: { maxGrants: 5, passMinutes: 10 } },
      EXT_PAGE
    );
    await ctx.saveSettings({ domainLimits: { 'instagram.com': { maxGrants: 2, passMinutes: 10 } } });
    expect(chrome.storage._store.pendingChanges).toEqual([]);
    expect(chrome.storage._store.domainLimits['instagram.com'].maxGrants).toBe(2);
  });

  // The direction guard behind the UI: a whole-map write cannot raise an
  // intention, field by field, while a tightening in the same write stands.
  it('saveSettings holds a raised intention at its stored value', async () => {
    const { ctx, chrome } = loadBackground({
      seed: { ...BLOCKED, domainLimits: { 'instagram.com': { maxGrants: 3, passMinutes: 10 } } }
    });
    await ctx.saveSettings({ domainLimits: { 'instagram.com': { maxGrants: 9, passMinutes: 5 } } });
    expect(chrome.storage._store.domainLimits['instagram.com']).toMatchObject({ maxGrants: 3, passMinutes: 5 });
  });

  // Shortening the cool-off waits out the cool-off it replaces, not just the
  // night — otherwise asking to shorten a three-day wait would be a way around it.
  it('shortening the leave cool-off waits for the current cool-off too', async () => {
    const { ctx, chrome } = loadBackground({ seed: { ...BLOCKED, leaveDelayMinutes: 4320 } });
    const before = Date.now();
    await ctx.handleMessage({ action: 'applySettingChange', changeType: 'decrease_leave_delay', newValue: 60 }, EXT_PAGE);
    const [pending] = chrome.storage._store.pendingChanges;
    expect(pending.effectiveAt).toBeGreaterThanOrEqual(before + 4320 * 60000);
    expect(chrome.storage._store.leaveDelayMinutes).toBe(4320);
  });

  it('rewording what a service is for applies at once', async () => {
    const { ctx, chrome } = loadBackground({
      seed: { ...BLOCKED, serviceReasons: { 'instagram.com': { purpose: 'old', updatedAt: 1 } } }
    });
    await ctx.handleMessage(
      { action: 'applySettingChange', changeType: 'edit_site_purpose', domain: 'instagram.com', newValue: 'new' },
      EXT_PAGE
    );
    expect(chrome.storage._store.serviceReasons['instagram.com'].purpose).toBe('new');
    expect(chrome.storage._store.pendingChanges).toBeUndefined();
  });
});

describe('privileged message actions: chat history', () => {
  const BLOCKED = { ...CONFIGURED, blockedDomains: ['instagram.com'] };

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
    const { ctx, chrome } = loadBackground({
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
  // The intention is spent (CONFIGURED), so the coach can grant — and any pass
  // it grants past the intention is capped at 10 minutes.
  const clampSeed = () => ({
    ...CONFIGURED,
    dailyStats: {
      [today()]: {
        'instagram.com': { minutes: 3, grants: 1, sessions: [{ reason: 'earlier', grantedMinutes: 3, grantedAt: Date.now() }] }
      }
    }
  });

  it('grants the real minutes and lets the coach restate them', async () => {
    const fetch = grantingFetch(30, 'check DMs');
    const { ctx, chrome } = loadBackground({ seed: clampSeed(), fetch });
    const res = await ctx.handleMessage(
      { action: 'chat', mode: 'gate', domain: 'instagram.com', userMessage: 'a' },
      tab(1)
    );

    expect(res.grantedSession.intervalMinutes).toBe(10);
    expect(res.systemNote).toBe('Extra time comes in passes of up to 10 minutes, and your pass is 10 minutes.');
    expect(fetch.calls.length).toBe(2);

    // The correction turn carries no tools (an empty array is omitted from
    // the request body) and ends on the synthetic user turn naming the gap.
    const secondBody = JSON.parse(fetch.calls[1].init.body);
    expect(secondBody.tools).toBeUndefined();
    const lastMsg = secondBody.messages.at(-1);
    expect(lastMsg.role).toBe('user');
    expect(lastMsg.content).toMatch(/^\(Intention:/);
    expect(lastMsg.content).toContain('asked for 30 minutes');
    expect(lastMsg.content).toContain('only 10 were available');
    expect(lastMsg.content).toContain("beyond today's intention");

    // Both texts reach the user, joined.
    expect(res.assistantText).toBe('Okay.\n\nOkay.');

    // Persisted transcript alternates roles around the synthetic turn.
    const history = chrome.storage._store.chatHistories[transcript('instagram.com')];
    expect(history.map(t => t.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(history[2].content).toMatch(/^\(Intention:/);
  });

  it('leaves a short ask alone — the clamp is a ceiling, not a target', async () => {
    const fetch = grantingFetch(5, 'one reply');
    const { ctx } = loadBackground({ seed: clampSeed(), fetch });
    const res = await ctx.handleMessage(
      { action: 'chat', mode: 'gate', domain: 'instagram.com', userMessage: 'a' },
      tab(1)
    );
    expect(res.grantedSession.intervalMinutes).toBe(5);
    expect(res.systemNote).toBeFalsy();
    expect(fetch.calls.length).toBe(1); // nothing to correct, no honesty turn
  });

  // How much time is already spent today changes nothing about the length of
  // a negotiated pass: there is no daily ceiling past the intention to clamp to.
  it('has no daily ceiling to clamp to past the intention', async () => {
    const fetch = grantingFetch(10, 'find one thing');
    const { ctx } = loadBackground({
      seed: { ...CONFIGURED, dailyStats: { [today()]: { 'instagram.com': { minutes: 300, grants: 9, sessions: [] } } } },
      fetch
    });
    const res = await ctx.handleMessage(
      { action: 'chat', mode: 'gate', domain: 'instagram.com', userMessage: 'a' },
      tab(1)
    );
    expect(res.grantedSession.intervalMinutes).toBe(10);
    expect(res.systemNote).toBeFalsy();
  });

  it('never loops: tool calls on the correction turn are ignored', async () => {
    // Static mock: the correction turn ALSO answers with a grant_access call.
    const fetch = grantingFetch(30, 'check DMs');
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
            { type: 'tool_use', id: 't1', name: 'grant_access', input: { minutes: 30, reason: 'check DMs' } }
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
    expect(res.grantedSession.intervalMinutes).toBe(10);
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

// Reporting a coach message (Play's AI-Generated Content policy). The page
// sends only the text it can see; everything else is resolved here, because a
// page has no stable handle on a turn — they carry no ids, and histories are
// truncated from the front as they grow.
describe('reporting a coach message', () => {
  const seeded = (histories) => ({ ...CONFIGURED, chatHistories: histories });

  it('sends the reported message with the user turn that provoked it', async () => {
    const fetch = makeMockFetch({});
    const { ctx } = loadBackground({
      fetch,
      seed: seeded({
        [transcript('instagram.com')]: [
          { role: 'user', content: 'why not' },
          { role: 'assistant', content: 'something unkind' }
        ]
      })
    });

    const res = await ctx.handleMessage(
      { action: 'reportMessage', text: 'something unkind', note: 'this was cruel' },
      tab(1)
    );

    expect(res.ok).toBe(true);
    const call = fetch.calls.at(-1);
    expect(call.url).toMatch(/\/v1\/report$/);
    const body = JSON.parse(call.init.body);
    expect(body.reported).toBe('something unkind');
    expect(body.prompt).toBe('why not');
    expect(body.note).toBe('this was cruel');
    // Which route produced it is the point of collecting these.
    expect(body.provider).toBe('byok:anthropic');
  });

  it('still reports a message it cannot find a transcript for', async () => {
    const fetch = makeMockFetch({});
    const { ctx } = loadBackground({ fetch, seed: seeded({}) });
    const res = await ctx.handleMessage(
      { action: 'reportMessage', text: 'a canned simple-mode line', note: '' },
      tab(1)
    );
    expect(res.ok).toBe(true);
    expect(JSON.parse(fetch.calls.at(-1).init.body).prompt).toBe('');
  });

  it('does not attach an assistant turn as the prompt', async () => {
    const fetch = makeMockFetch({});
    const { ctx } = loadBackground({
      fetch,
      seed: seeded({
        context: [
          { role: 'assistant', content: 'an opener nobody asked for' },
          { role: 'assistant', content: 'and then this' }
        ]
      })
    });
    await ctx.handleMessage({ action: 'reportMessage', text: 'and then this' }, EXT_PAGE);
    expect(JSON.parse(fetch.calls.at(-1).init.body).prompt).toBe('');
  });

  it('refuses an empty report rather than posting one', async () => {
    const fetch = makeMockFetch({});
    const { ctx } = loadBackground({ fetch, seed: seeded({}) });
    const res = await ctx.handleMessage({ action: 'reportMessage', text: '   ' }, EXT_PAGE);
    expect(res.ok).toBe(false);
    expect(fetch.calls.length).toBe(0);
  });

  it('tells the user when the report could not be sent', async () => {
    const fetch = makeMockFetch({ status: 500 });
    const { ctx } = loadBackground({ fetch, seed: seeded({}) });
    const res = await ctx.handleMessage({ action: 'reportMessage', text: 'x' }, EXT_PAGE);
    expect(res.ok).toBe(false);
    expect(res.error).toBeTruthy();
  });
});

// The gate backstop — the only second line of defence Safari has.
//
// domainsNeedingRedirect() returns nothing where a native host is listening, so
// on Safari no declarativeNetRequest rule ever fires and the content script's
// overlay is the whole gate. When that overlay doesn't appear — the script was
// never injected, the check errored, storage was unreadable — this is what is
// left between the user and the site.
describe('the gate backstop', () => {
  const BLOCKED = { setupComplete: true, blockedDomains: ['instagram.com'] };
  const PAGE = 'https://www.instagram.com/explore/';

  const withTab = (chrome, id, url) => { chrome.tabs._byId[id] = { id, url }; };

  it('sends a tab that never reported an overlay to the gate', async () => {
    const { ctx, chrome } = loadBackground({ seed: BLOCKED });
    withTab(chrome, 4, PAGE);
    await ctx.enforceGateBackstop(4, PAGE);
    expect(chrome.tabs._updates).toHaveLength(1);
    expect(chrome.tabs._updates[0].id).toBe(4);
    expect(chrome.tabs._updates[0].props.url).toContain('coaching.html?domain=instagram.com');
  });

  it('leaves a page that is not on the blocklist alone', async () => {
    const { ctx, chrome } = loadBackground({ seed: BLOCKED });
    withTab(chrome, 4, 'https://example.com/');
    await ctx.enforceGateBackstop(4, 'https://example.com/');
    expect(chrome.tabs._updates).toHaveLength(0);
  });

  it('stands down while a pass is still running', async () => {
    const { ctx, chrome } = loadBackground({
      seed: {
        ...BLOCKED,
        activeSessions: {
          'target:instagram.com': { domain: 'instagram.com', startTime: Date.now(), intervalMinutes: 10 }
        }
      }
    });
    withTab(chrome, 4, PAGE);
    await ctx.enforceGateBackstop(4, PAGE);
    expect(chrome.tabs._updates).toHaveLength(0);
  });

  // Before setup there is no blocklist to be on and nothing for the gate page
  // to coach with — the content script's own setup notice is the right answer.
  it('does not fire before setup is finished', async () => {
    const { ctx, chrome } = loadBackground({ seed: { ...BLOCKED, setupComplete: false } });
    withTab(chrome, 4, PAGE);
    await ctx.enforceGateBackstop(4, PAGE);
    expect(chrome.tabs._updates).toHaveLength(0);
  });

  it('leaves a tab that has moved on since it was scheduled', async () => {
    const { ctx, chrome } = loadBackground({ seed: BLOCKED });
    withTab(chrome, 4, 'https://example.com/');
    await ctx.enforceGateBackstop(4, PAGE);
    expect(chrome.tabs._updates).toHaveLength(0);
  });

  it('does nothing for a tab that has since closed', async () => {
    const { ctx, chrome } = loadBackground({ seed: BLOCKED });
    await ctx.enforceGateBackstop(4, PAGE);
    expect(chrome.tabs._updates).toHaveLength(0);
  });

  describe('scheduling', () => {
    it('fires once the grace period passes with no word from the page', async () => {
      vi.useFakeTimers();
      try {
        const { chrome, listeners } = loadBackground({ seed: BLOCKED });
        withTab(chrome, 4, PAGE);
        listeners.committed({ frameId: 0, tabId: 4, url: PAGE });
        await vi.advanceTimersByTimeAsync(10000);
        expect(chrome.tabs._updates).toHaveLength(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('stands down once the page reports its overlay', async () => {
      vi.useFakeTimers();
      try {
        const { ctx, chrome, listeners } = loadBackground({ seed: BLOCKED });
        withTab(chrome, 4, PAGE);
        listeners.committed({ frameId: 0, tabId: 4, url: PAGE });
        await ctx.handleMessage({ action: 'gateShown' }, tab(4, 'www.instagram.com'));
        await vi.advanceTimersByTimeAsync(10000);
        expect(chrome.tabs._updates).toHaveLength(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it('ignores its own gate page and anything in a subframe', async () => {
      vi.useFakeTimers();
      try {
        const { chrome, listeners } = loadBackground({ seed: BLOCKED });
        withTab(chrome, 4, PAGE);
        listeners.committed({ frameId: 0, tabId: 4, url: 'chrome-extension://test/coaching.html?domain=instagram.com' });
        listeners.committed({ frameId: 1, tabId: 5, url: PAGE });
        await vi.advanceTimersByTimeAsync(10000);
        expect(chrome.tabs._updates).toHaveLength(0);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});

// Raising an intention, once the coach approves it (or its day comes round).
describe('applySettingChange: raising an intention', () => {
  const SEED = () => ({
    ...CONFIGURED,
    blockedDomains: ['instagram.com'],
    blockedApps: ['com.instagram.android'],
    domainLimits: { 'instagram.com': { maxGrants: 1, passMinutes: 5, scope: 'only', parts: ['instagram:reels'] } },
    appLimits: { 'com.instagram.android': { maxGrants: 1, passMinutes: 5 } }
  });

  it('writes the new intention and keeps the rest of the entry', async () => {
    const { ctx, chrome } = loadBackground({ seed: SEED() });
    const res = await ctx.applySettingChange({
      changeType: 'increase_limit', domain: 'instagram.com', newValue: { maxGrants: 4, passMinutes: 15 }
    });
    expect(res.intention).toEqual({ opens: 4, minutesEach: 15 });
    expect(chrome.storage._store.domainLimits['instagram.com']).toEqual({
      maxGrants: 4, passMinutes: 15, scope: 'only', parts: ['instagram:reels']
    });
  });

  it('writes the app variant into appLimits, not domainLimits', async () => {
    const { ctx, chrome } = loadBackground({ seed: SEED() });
    await ctx.applySettingChange({
      changeType: 'increase_app_limit', domain: 'com.instagram.android', newValue: { maxGrants: 2, passMinutes: 5 }
    });
    expect(chrome.storage._store.appLimits['com.instagram.android'].maxGrants).toBe(2);
    expect(chrome.storage._store.domainLimits['instagram.com'].maxGrants).toBe(1);
  });

  // An unreadable field must leave that number as it was, never reset it to a
  // default that might be looser than what the coach approved.
  it('leaves an unreadable field as it was', async () => {
    const { ctx, chrome } = loadBackground({ seed: SEED() });
    await ctx.applySettingChange({
      changeType: 'increase_limit', domain: 'instagram.com', newValue: { maxGrants: 2 }
    });
    expect(chrome.storage._store.domainLimits['instagram.com']).toMatchObject({ maxGrants: 2, passMinutes: 5 });
  });

  it('describes an intention to the settings-gate coach as a sentence', () => {
    const { ctx } = loadBackground({ seed: SEED() });
    expect(ctx.describeIntentionForHuman({ maxGrants: 3, passMinutes: 10 })).toBe('3 opens a day, 10 minutes each');
    expect(ctx.describeIntentionForHuman({ maxGrants: 1, passMinutes: 5 })).toBe('1 open a day, 5 minutes each');
    expect(ctx.describeIntentionForHuman({ maxGrants: 0 })).toBe('blocked outright (no opens)');
  });
});

describe('applySettingChange: rewriting what a service is for', () => {
  const SEED = () => ({
    ...CONFIGURED,
    blockedDomains: ['instagram.com'],
    serviceReasons: {
      'instagram.com': { purpose: 'Replying to my sister', legitimateUse: 'A specific DM', updatedAt: 1 }
    }
  });

  it('replaces only the field the change type names', async () => {
    const { ctx, chrome } = loadBackground({ seed: SEED() });
    await ctx.applySettingChange({
      changeType: 'edit_site_purpose', domain: 'instagram.com', newValue: 'Coordinating a group trip'
    });
    const stored = chrome.storage._store.serviceReasons['instagram.com'];
    expect(stored.purpose).toBe('Coordinating a group trip');
    expect(stored.legitimateUse).toBe('A specific DM');
  });

  it('writes through the same key the app shares, not a per-domain one', async () => {
    const { ctx, chrome } = loadBackground({ seed: SEED() });
    await ctx.applySettingChange({
      changeType: 'edit_site_legitimate', domain: 'com.instagram.android', newValue: 'One reply, never the feed'
    });
    // serviceKeyFor folds the app onto the same service as the site.
    expect(chrome.storage._store.serviceReasons['instagram.com'].legitimateUse).toBe('One reply, never the feed');
    expect(chrome.storage._store.serviceReasons['com.instagram.android']).toBeUndefined();
  });

  // Coach approval must not be a way round the sanitiser: this text lands in a
  // system prompt, and saveSettings caps every other route into it.
  it('trims and caps the approved text like every other write of this key', async () => {
    const { ctx, chrome } = loadBackground({ seed: SEED() });
    await ctx.applySettingChange({
      changeType: 'edit_site_purpose', domain: 'instagram.com', newValue: '   ' + 'x'.repeat(900) + '   '
    });
    expect(chrome.storage._store.serviceReasons['instagram.com'].purpose).toHaveLength(500);
  });

  it('drops the entry when the last answer is blanked', async () => {
    const { ctx, chrome } = loadBackground({
      seed: { ...CONFIGURED, serviceReasons: { 'instagram.com': { purpose: 'Only this one', updatedAt: 1 } } }
    });
    await ctx.applySettingChange({
      changeType: 'edit_site_purpose', domain: 'instagram.com', newValue: ''
    });
    expect(chrome.storage._store.serviceReasons['instagram.com']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Page-scoped passes.
//
// A scoped pass is one granted for a single page rather than the whole site.
// It lives as an optional `scope` key on the session value, and its absence —
// never `{ kind: 'site' }` — is what every pass granted before this existed
// and every whole-site pass granted since still looks like.
//
// The single most important thing in this file is the first describe below.
// Get it wrong and a pass "for one video" silently opens the entire site while
// the badge says THIS PAGE ONLY.
// ---------------------------------------------------------------------------

const VIDEO_URL = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
const OTHER_VIDEO_URL = 'https://www.youtube.com/watch?v=oHg5SJYRHA0';
const VIDEO_CTX = {
  url: VIDEO_URL,
  contentType: 'YouTube Video',
  videoTitle: 'Never Gonna Give You Up',
  channel: 'Rick Astley'
};
const FEED_CTX = {
  url: 'https://www.youtube.com/',
  contentType: 'YouTube Page'
};

const YT_BLOCKED = { ...CONFIGURED, setupComplete: true, blockedDomains: ['youtube.com'] };

// A pass granted for one page, as grantSession writes it.
const scopedSession = (url = VIDEO_URL) => ({
  domain: 'youtube.com',
  reason: 'someone sent me this',
  startTime: Date.now(),
  intervalMinutes: 12,
  scope: {
    kind: 'page',
    key: `yt:video:${new URL(url).searchParams.get('v')}`,
    url,
    label: 'Never Gonna Give You Up',
    verb: 'Watching'
  }
});

// Only the calls that carried a conversation. The same mock fetch also answers
// page-context enrichment (oEmbed and the like), which is not a coach turn.
const llmCalls = (fetch) => fetch.calls.filter(c => {
  try { return Array.isArray(JSON.parse(c.init.body).messages); } catch (e) { return false; }
});

// An LLM reply that grants `minutes` scoped the way `scope` says.
function scopedGrantFetch(minutes = 12, scope = 'page', reason = 'someone sent me this') {
  return makeMockFetch({
    content: [
      { type: 'text', text: 'Okay.' },
      { type: 'tool_use', id: 't1', name: 'grant_access', input: { minutes, reason, scope } }
    ]
  });
}

// Drives a whole gate conversation on a YouTube video and returns the reply.
async function grantOnVideo(ctx, { tabId = 7, pageContext = VIDEO_CTX, domain = 'youtube.com' } = {}) {
  return ctx.handleMessage(
    { action: 'chat', mode: 'gate', domain, userMessage: 'a', pageContext },
    { tab: { id: tabId }, url: pageContext ? pageContext.url : `https://${domain}/` }
  );
}

describe('a scoped pass keeps the rest of the site blocked', () => {
  // THE assertion of this feature. The narrowed per-tab allow rule lets the
  // one granted page through; the domain redirect rule has to still be there
  // to catch everything else.
  it('KEEPS the domain redirect rule while a page-scoped pass is live', async () => {
    const { ctx, chrome } = loadBackground({ seed: YT_BLOCKED, fetch: scopedGrantFetch() });
    const dnr = statefulDnr(chrome);
    await ctx.syncBlockingRules();
    expect(dnr.redirectedDomains()).toEqual(['||youtube.com^']);

    const res = await grantOnVideo(ctx);
    expect(res.grantedSession.scope).toMatchObject({ kind: 'page', key: 'yt:video:dQw4w9WgXcQ' });
    expect(dnr.redirectedDomains()).toEqual(['||youtube.com^']);
  });

  // ...but only where the priority-2 allow rule can be relied on to beat the
  // priority-1 redirect. Keeping both rules up for one host is the only
  // construct in the extension that needs that ordering, and it is verified on
  // exactly one engine — the smoke suite drives a real scoped grant through a
  // real Chromium. Firefox's MV3 DNR is a partial implementation and nothing
  // here can check it, so a scoped pass degrades there to what a site pass
  // does: the redirect goes, and the content script's overlay enforces the
  // scope, which is how Safari enforces every pass today.
  //
  // The failure this avoids is not "the block is a bit weaker". It is the
  // trap: redirect wins, the granted page bounces to coaching.html, coaching.js
  // sends the user back to scope.url, and it bounces again — for the whole
  // length of a pass they paid a conversation for.
  it('degrades to a site pass on an engine whose rule ordering is unverified', async () => {
    const { ctx, chrome } = loadBackground({ seed: YT_BLOCKED, fetch: scopedGrantFetch() });
    const dnr = statefulDnr(chrome);
    // runtime.getBrowserInfo is Firefox's and nobody else's. (Chrome exposes a
    // `browser` alias of `chrome`, so the namespace alone says nothing; Safari
    // has a native host and never reaches this function at all.)
    ctx.browser = { runtime: { getBrowserInfo: async () => ({ name: 'Firefox' }) } };
    await ctx.syncBlockingRules();
    expect(dnr.redirectedDomains()).toEqual(['||youtube.com^']);

    const res = await grantOnVideo(ctx);
    expect(res.grantedSession.scope).toMatchObject({ kind: 'page' });
    expect(dnr.redirectedDomains()).toEqual([]);
  });

  // ...and the redirect comes back when that pass ends, which on Chromium is
  // the no-op the idempotence check exists for and here is a real restore.
  it('puts the redirect back when a degraded scoped pass ends', async () => {
    const { ctx, chrome } = loadBackground({ seed: YT_BLOCKED, fetch: scopedGrantFetch() });
    const dnr = statefulDnr(chrome);
    ctx.browser = { runtime: { getBrowserInfo: async () => ({ name: 'Firefox' }) } };
    await grantOnVideo(ctx);
    expect(dnr.redirectedDomains()).toEqual([]);
    await ctx.handleMessage(
      { action: 'endSession', domain: 'youtube.com', reason: 'left_page' },
      { tab: { id: 7 }, url: OTHER_VIDEO_URL }
    );
    expect(dnr.redirectedDomains()).toEqual(['||youtube.com^']);
  });

  // The contrast case, and the reason the line above is a filter and not a
  // deletion: an unscoped pass must still drop the rule, or the user is thrown
  // back onto the gate they just talked their way through.
  it('still drops it for an unscoped pass, exactly as before', async () => {
    const { ctx, chrome } = loadBackground({ seed: YT_BLOCKED, fetch: scopedGrantFetch(12, 'site') });
    const dnr = statefulDnr(chrome);
    await ctx.syncBlockingRules();

    const res = await grantOnVideo(ctx);
    expect(res.grantedSession.scope).toBeUndefined();
    expect(dnr.redirectedDomains()).toEqual([]);
  });

  it('puts nothing back when the scoped pass ends, because it never left', async () => {
    const { ctx, chrome } = loadBackground({ seed: YT_BLOCKED, fetch: scopedGrantFetch() });
    const dnr = statefulDnr(chrome);
    await grantOnVideo(ctx);
    await ctx.handleMessage(
      { action: 'endSession', domain: 'youtube.com', reason: 'left_page' },
      { tab: { id: 7 }, url: OTHER_VIDEO_URL }
    );
    expect(dnr.redirectedDomains()).toEqual(['||youtube.com^']);
  });

  // A summary that compares only what a rule catches and where it sends the
  // user cannot tell an allow from a redirect, or a narrowed rule from the one
  // it replaced — so the difference would never be applied.
  it('notices a rule set that differs only in action type or priority', async () => {
    const { ctx, chrome } = loadBackground({ seed: YT_BLOCKED });
    statefulDnr(chrome);
    await chrome.declarativeNetRequest.updateDynamicRules({
      addRules: [{
        id: 1000,
        priority: 4,
        action: { type: 'allow' },
        condition: { urlFilter: '||youtube.com^', resourceTypes: ['main_frame'] }
      }]
    });

    await ctx.syncBlockingRules();

    const rules = await chrome.declarativeNetRequest.getDynamicRules();
    expect(rules).toHaveLength(1);
    expect(rules[0].action.type).toBe('redirect');
    expect(rules[0].priority).toBe(1);
  });
});

describe('the per-tab allow rule a scoped pass registers', () => {
  const filters = (chrome) => chrome.declarativeNetRequest._sessionRules.map(r => r.condition.urlFilter);

  // Anchored at BOTH ends. A leading `|` alone says "the URL starts like
  // this", which for a rule that lets traffic PAST a block is a prefix hole —
  // see dnrUrlFilterFor, which now closes it.
  it('names the one granted page, not the whole domain', async () => {
    const { ctx, chrome } = loadBackground({ seed: YT_BLOCKED, fetch: scopedGrantFetch() });
    await grantOnVideo(ctx);
    expect(filters(chrome)).toEqual([`|${VIDEO_URL}|`]);
  });

  it('is the whole domain for an unscoped pass', async () => {
    const { ctx, chrome } = loadBackground({ seed: YT_BLOCKED, fetch: scopedGrantFetch(12, 'site') });
    await grantOnVideo(ctx);
    expect(filters(chrome)).toEqual(['||youtube.com^']);
  });

  // urlFilter is not a glob: `*`, `^` and `|` are pattern syntax, and a
  // non-ASCII byte takes the whole batch down. dnrUrlFilterFor answers '' for
  // those, and enforcement falls back to the content script — which is how
  // Safari has always enforced every pass.
  it('falls back to the whole domain when the address cannot be a filter', async () => {
    const { ctx, chrome } = loadBackground({ seed: YT_BLOCKED });
    // A `*` in the path survives URL parsing untouched, and urlFilter would
    // read it as a wildcard — an allow rule matching more than the page it was
    // built for is the failure that matters here, so no rule is built at all.
    await ctx.registerSessionRule(9, {
      domain: 'youtube.com',
      scope: { kind: 'page', key: 'url:x', url: 'https://www.youtube.com/wat*ch' }
    });
    expect(filters(chrome)).toEqual(['||youtube.com^']);
  });

  // The middle answer used to be "drop the query and anchor the path". That
  // rule could never match — a query is the only reason it was reached, and
  // both ends are anchored — so the allow rule never fired while the
  // priority-1 domain redirect did, and the granted page bounced to
  // coaching.html forever. '' now, and the caller widens to the domain for
  // this tab.
  it('gives up rather than emitting a rule that could never match its own url', async () => {
    const { ctx, chrome } = loadBackground({ seed: YT_BLOCKED });
    await ctx.registerSessionRule(9, {
      domain: 'youtube.com',
      scope: { kind: 'page', key: 'url:x', url: 'https://www.youtube.com/watch?v=a^b' }
    });
    expect(filters(chrome)).toEqual(['||youtube.com^']);
  });

  // The default is case-INSENSITIVE, which for an allow rule naming one page
  // means it also names every case-variant of it. Instagram shortcodes are
  // case-sensitive, so /p/ABC123/ and /p/abc123/ are different posts.
  it('is case-sensitive, so it cannot allow a different post with the same letters', async () => {
    const { ctx, chrome } = loadBackground({ seed: YT_BLOCKED });
    await ctx.registerSessionRule(9, {
      domain: 'instagram.com',
      scope: { kind: 'page', key: 'ig:post:ABC123', url: 'https://www.instagram.com/p/ABC123/' }
    });
    const rule = chrome.declarativeNetRequest._sessionRules.at(-1);
    expect(rule.condition.urlFilter).toBe('|https://www.instagram.com/p/ABC123/|');
    expect(rule.condition.isUrlFilterCaseSensitive).toBe(true);
  });

  // The whole-domain fallback is the one that clears the redirect for the tab,
  // so it carries the same flag rather than quietly reverting to the default.
  it('sets it on the whole-domain fallback too', async () => {
    const { ctx, chrome } = loadBackground({ seed: YT_BLOCKED });
    await ctx.registerSessionRule(9, { domain: 'youtube.com' });
    expect(chrome.declarativeNetRequest._sessionRules.at(-1).condition.isUrlFilterCaseSensitive).toBe(true);
  });

  // A tab can hold a pass on two blocked sites; ending one must not widen the
  // other from one page to the whole site.
  it('is rebuilt from the surviving session, scope and all', async () => {
    const { ctx, chrome } = loadBackground({
      seed: {
        ...YT_BLOCKED,
        blockedDomains: ['youtube.com', 'instagram.com'],
        activeSessions: {
          'tab:5:youtube.com': {
            domain: 'youtube.com', startTime: Date.now(), intervalMinutes: 10,
            scope: { kind: 'page', key: 'yt:video:dQw4w9WgXcQ', url: VIDEO_URL, label: 'x', verb: 'Watching' }
          },
          'tab:5:instagram.com': { domain: 'instagram.com', startTime: Date.now(), intervalMinutes: 10 }
        }
      }
    });
    await ctx.handleMessage(
      { action: 'endSession', domain: 'instagram.com', reason: 'fulfilled' },
      { tab: { id: 5 }, url: 'https://www.instagram.com/' }
    );
    expect(filters(chrome)).toEqual([`|${VIDEO_URL}|`]);
  });
});

describe('grant_access with scope "page"', () => {
  it('writes the scope onto the session and banks the grant as page-scoped', async () => {
    const { ctx, chrome } = loadBackground({ seed: YT_BLOCKED, fetch: scopedGrantFetch() });
    await grantOnVideo(ctx);

    const session = chrome.storage._store.activeSessions['tab:7:youtube.com'];
    expect(session.scope).toEqual({
      kind: 'page',
      key: 'yt:video:dQw4w9WgXcQ',
      url: VIDEO_URL,
      label: 'Never Gonna Give You Up',
      verb: 'Watching'
    });
    const stats = await ctx.getStatsForDomain('youtube.com');
    expect(stats.sessionsToday[0].scope).toBe('page');
  });

  // Absence is the third state. A site pass must not write `{ kind: 'site' }`,
  // because three native readers of this value have never heard of the field.
  it('leaves no scope key at all on a site pass', async () => {
    const { ctx, chrome } = loadBackground({ seed: YT_BLOCKED, fetch: scopedGrantFetch(12, 'site') });
    await grantOnVideo(ctx);
    const session = chrome.storage._store.activeSessions['tab:7:youtube.com'];
    expect('scope' in session).toBe(false);
    const stats = await ctx.getStatsForDomain('youtube.com');
    expect(stats.sessionsToday[0].scope).toBe(null);
  });

  it('reads an omitted scope as a site pass, so an older model still works', async () => {
    const { ctx, chrome } = loadBackground({ seed: YT_BLOCKED, fetch: grantingFetch(12) });
    await ctx.handleMessage(
      { action: 'chat', mode: 'gate', domain: 'youtube.com', userMessage: 'a', pageContext: VIDEO_CTX },
      { tab: { id: 7 }, url: VIDEO_URL }
    );
    expect('scope' in chrome.storage._store.activeSessions['tab:7:youtube.com']).toBe(false);
  });

  // A feed has no single page to pin to. The pass is still granted — refusing
  // it would punish the user for the model's word choice — but both channels
  // have to say what actually happened.
  // Eight minutes, so the site-pass ceiling past the intention does not also
  // bind and take the one correction turn for itself.
  it('downgrades on a feed, and tells both the user and the model', async () => {
    const { ctx, chrome } = loadBackground({ seed: YT_BLOCKED, fetch: scopedGrantFetch(8) });
    const res = await grantOnVideo(ctx, { pageContext: FEED_CTX });

    expect(res.grantedSession).toBeTruthy();
    expect('scope' in chrome.storage._store.activeSessions['tab:7:youtube.com']).toBe(false);
    expect(res.systemNote).toContain('no single page to pin that to');
  });

  it('spends a correction turn saying so in the coach voice', async () => {
    const fetch = scopedGrantFetch(8);
    const { ctx } = loadBackground({ seed: YT_BLOCKED, fetch });
    await grantOnVideo(ctx, { pageContext: FEED_CTX });
    // Two coach calls: the grant, then the honesty turn the correction forces.
    // (The mock fetch also sees page-context enrichment, which is not one.)
    expect(llmCalls(fetch)).toHaveLength(2);
    const messages = JSON.parse(fetch.calls.at(-1).init.body).messages;
    expect(messages.at(-1).content).toContain('could not identify a single page');
    expect(messages.at(-1).content).toContain('WHOLE SITE');
  });

  // Android and iOS block whole apps: there is no address, no path, nothing to
  // scope to. pageScopeFor must never be reached for one.
  it('never scopes an app target, however the model asks', async () => {
    const { ctx, chrome } = loadBackground({
      seed: { ...CONFIGURED, setupComplete: true, blockedApps: ['com.instagram.android'] },
      fetch: scopedGrantFetch(8)
    });
    const res = await ctx.handleMessage(
      { action: 'chat', mode: 'gate', domain: 'com.instagram.android', isApp: true,
        appLabel: 'Instagram', userMessage: 'a', pageContext: VIDEO_CTX },
      NATIVE
    );
    expect(res.grantedSession).toBeTruthy();
    expect('scope' in chrome.storage._store.activeSessions['target:com.instagram.android']).toBe(false);
    expect(res.systemNote).toContain('no single page to pin that to');
  });

  it('tells the coach in the prompt what kind of pass is on the table', async () => {
    const fetch = scopedGrantFetch();
    const { ctx } = loadBackground({ seed: YT_BLOCKED, fetch });
    await grantOnVideo(ctx);
    expect(systemPromptOf(fetch)).toContain('grant_access with scope "page"');

    const feedFetch = scopedGrantFetch();
    const feed = loadBackground({ seed: YT_BLOCKED, fetch: feedFetch });
    await grantOnVideo(feed.ctx, { pageContext: FEED_CTX });
    expect(systemPromptOf(feedFetch)).toContain('Scoped passes: not available here');
  });
});

describe('a pass past the intention is longer when it is scoped, and only then', () => {
  it('clamps an unscoped grant at 10', async () => {
    const { ctx } = loadBackground({ seed: YT_BLOCKED, fetch: scopedGrantFetch(45, 'site') });
    const res = await grantOnVideo(ctx);
    expect(res.grantedSession.intervalMinutes).toBe(10);
  });

  it('lets a scoped grant run to 20, because leaving the page ends it', async () => {
    const { ctx } = loadBackground({ seed: YT_BLOCKED, fetch: scopedGrantFetch(45, 'page') });
    const res = await grantOnVideo(ctx);
    expect(res.grantedSession.intervalMinutes).toBe(20);
    expect(res.grantedSession.scope).toBeTruthy();
  });

  it('never goes past 20 however long the ask', async () => {
    const { ctx } = loadBackground({ seed: YT_BLOCKED, fetch: scopedGrantFetch(600, 'page') });
    const res = await grantOnVideo(ctx);
    expect(res.grantedSession.intervalMinutes).toBe(20);
  });
});

describe('the gate backstop knows which page a pass was for', () => {
  const scopedSeed = {
    setupComplete: true,
    blockedDomains: ['youtube.com'],
    activeSessions: {
      'tab:4:youtube.com': {
        domain: 'youtube.com', startTime: Date.now(), intervalMinutes: 10,
        scope: { kind: 'page', key: 'yt:video:dQw4w9WgXcQ', url: VIDEO_URL, label: 'x', verb: 'Watching' }
      }
    }
  };

  it('stands down on the page the pass was granted for', async () => {
    const { ctx, chrome } = loadBackground({ seed: scopedSeed });
    chrome.tabs._byId[4] = { id: 4, url: VIDEO_URL };
    await ctx.enforceGateBackstop(4, VIDEO_URL);
    expect(chrome.tabs._updates).toHaveLength(0);
  });

  // Safari has no declarativeNetRequest gate at all, so this is the only
  // enforcement behind the content script there.
  it('still fires on a different page of the same site', async () => {
    const { ctx, chrome } = loadBackground({ seed: scopedSeed });
    chrome.tabs._byId[4] = { id: 4, url: OTHER_VIDEO_URL };
    await ctx.enforceGateBackstop(4, OTHER_VIDEO_URL);
    expect(chrome.tabs._updates).toHaveLength(1);
    expect(chrome.tabs._updates[0].props.url).toContain('coaching.html?domain=youtube.com');
  });

  it('stands down anywhere on the site for a pass with no scope', async () => {
    const { ctx, chrome } = loadBackground({
      seed: {
        ...scopedSeed,
        activeSessions: {
          'tab:4:youtube.com': { domain: 'youtube.com', startTime: Date.now(), intervalMinutes: 10 }
        }
      }
    });
    chrome.tabs._byId[4] = { id: 4, url: OTHER_VIDEO_URL };
    await ctx.enforceGateBackstop(4, OTHER_VIDEO_URL);
    expect(chrome.tabs._updates).toHaveLength(0);
  });
});

describe('an in-page navigation the browser does notice', () => {
  it('re-records the page context and pokes the tab', async () => {
    const { ctx, chrome, listeners } = loadBackground({ seed: YT_BLOCKED });
    expect(listeners.historyStateUpdated).toBeTypeOf('function');

    listeners.historyStateUpdated({ frameId: 0, tabId: 7, url: OTHER_VIDEO_URL });
    await Promise.resolve();

    expect(chrome.tabs._messages).toContainEqual({
      id: 7,
      message: { action: 'urlChanged', url: OTHER_VIDEO_URL }
    });
    const recorded = await ctx.readNavContext(7);
    expect(recorded.url).toBe(OTHER_VIDEO_URL);
  });

  it('ignores subframes and our own pages', async () => {
    const { chrome, listeners } = loadBackground({ seed: YT_BLOCKED });
    listeners.historyStateUpdated({ frameId: 1, tabId: 7, url: OTHER_VIDEO_URL });
    listeners.historyStateUpdated({ frameId: 0, tabId: 7, url: 'chrome-extension://test/options.html' });
    expect(chrome.tabs._messages).toHaveLength(0);
  });
});

describe('leaving the page a pass was for', () => {
  it('banks the minutes actually used under their own outcome', async () => {
    const { ctx, chrome } = loadBackground({ seed: YT_BLOCKED, fetch: scopedGrantFetch(12) });
    await grantOnVideo(ctx);
    chrome.storage._store.activeSessions['tab:7:youtube.com'].startTime = Date.now() - 4 * 60000;

    await ctx.handleMessage(
      { action: 'endSession', domain: 'youtube.com', reason: 'left_page' },
      { tab: { id: 7 }, url: OTHER_VIDEO_URL }
    );

    const stats = await ctx.getStatsForDomain('youtube.com');
    expect(stats.sessionsToday[0].outcome).toBe('left_page');
    expect(Math.round(stats.minutesToday)).toBe(4);
  });

  // The drift screen is about to put a gate up in front of them; closing the
  // tab from under it would look like a crash.
  it('does not close the tab, unlike "finished"', async () => {
    const removed = [];
    const { ctx, chrome } = loadBackground({ seed: YT_BLOCKED, fetch: scopedGrantFetch(12) });
    chrome.tabs.remove = (id) => removed.push(id);
    await grantOnVideo(ctx);
    await ctx.handleMessage(
      { action: 'endSession', domain: 'youtube.com', reason: 'left_page' },
      { tab: { id: 7 }, url: OTHER_VIDEO_URL }
    );
    expect(removed).toEqual([]);
  });
});

// The gate page asks this before it decides whether it has anything to ask.
// It cannot answer the scope half itself: coaching.html deliberately does not
// load parts.js, so a pass-through decision made there would have to guess.
describe('getSession answers where the pass applies, not just that it exists', () => {
  const seedWith = (session) => ({
    setupComplete: true,
    blockedDomains: ['youtube.com'],
    activeSessions: { 'tab:3:youtube.com': session }
  });

  it('says a scoped pass covers the page it was granted for', async () => {
    const { ctx } = loadBackground({ seed: seedWith(scopedSession()) });
    const res = await ctx.handleMessage(
      { action: 'getSession', domain: 'youtube.com', url: VIDEO_URL }, tab(3, 'youtube.com')
    );
    expect(res.session).toBeTruthy();
    expect(res.covers).toBe(true);
  });

  // Without this the gate page would hop them straight back to page one after
  // they deliberately clicked through to page two.
  it('says it does not cover a different page of the same site', async () => {
    const { ctx } = loadBackground({ seed: seedWith(scopedSession()) });
    const res = await ctx.handleMessage(
      { action: 'getSession', domain: 'youtube.com', url: OTHER_VIDEO_URL }, tab(3, 'youtube.com')
    );
    expect(res.session).toBeTruthy();
    expect(res.covers).toBe(false);
  });

  // Nowhere to check against is not a reason to let someone through.
  it('will not vouch for a scoped pass when the destination is unknown', async () => {
    const { ctx } = loadBackground({ seed: seedWith(scopedSession()) });
    const res = await ctx.handleMessage({ action: 'getSession', domain: 'youtube.com' }, tab(3, 'youtube.com'));
    expect(res.covers).toBe(false);
  });

  // The unchanged case: a caller that sends no url and a pass with no scope
  // sees exactly what it saw before any of this existed.
  it('covers everything for a pass with no scope, url or no url', async () => {
    const { ctx } = loadBackground({
      seed: seedWith({ domain: 'youtube.com', startTime: Date.now(), intervalMinutes: 10 })
    });
    const bare = await ctx.handleMessage({ action: 'getSession', domain: 'youtube.com' }, tab(3, 'youtube.com'));
    const anywhere = await ctx.handleMessage(
      { action: 'getSession', domain: 'youtube.com', url: OTHER_VIDEO_URL }, tab(3, 'youtube.com')
    );
    expect(bare.covers).toBe(true);
    expect(anywhere.covers).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Part rules: which SECTIONS of a blocked site are blocked.
//
// The rule lives on the limits entry (`scope` + `parts`) and every verdict in
// this file comes from parts.js's resolvePartVerdict — these assertions are
// about the four places the worker has to ASK it, and about what happens when
// it is never asked. Three of the four fail open if the call is missing: the
// page would gate that should not, the backstop would navigate a page the user
// is allowed to be on, and a redirect rule would catch a section that was
// explicitly left open.
// ---------------------------------------------------------------------------

describe('part rules in the worker', () => {
  const ONLY_REELS = () => ({
    ...CONFIGURED,
    setupComplete: true,
    blockedDomains: ['instagram.com'],
    domainLimits: { 'instagram.com': { maxGrants: 3, maxMinutes: 45, scope: 'only', parts: ['instagram:reels'] } }
  });

  describe('checkPageMatch', () => {
    it('does not gate an address the rule leaves open, and says why not', async () => {
      const { ctx } = loadBackground({ seed: ONLY_REELS() });
      const res = await ctx.checkPageMatch('www.instagram.com', 3, null, 'https://www.instagram.com/direct/inbox/');
      expect(res.isBlocked).toBe(false);
      // The host is still on the blocklist, and the page has to know that: it
      // is one pushState away from a part that IS blocked.
      expect(res.matchedDomain).toBe('instagram.com');
      expect(res.partRule).toEqual({ scope: 'only', parts: ['instagram:reels'] });
      expect(res.partId).toBe(null);
    });

    it('gates the part the rule names, and names it back', async () => {
      const { ctx } = loadBackground({ seed: ONLY_REELS() });
      const res = await ctx.checkPageMatch('www.instagram.com', 3, null, 'https://www.instagram.com/reels/abc/');
      expect(res.isBlocked).toBe(true);
      expect(res.partId).toBe('instagram:reels');
    });

    // Which of the two addresses a message carries is authoritative, and why
    // the answer is different within an origin and across one.
    describe('whose account of the address is used', () => {
      it('takes the message\'s address within the sender\'s own origin', async () => {
        const { ctx } = loadBackground({ seed: ONLY_REELS() });
        // Chrome fills sender.url from the document the content script was
        // INJECTED into, and a pushState re-injects nothing — so on an SPA it
        // still names the page the user left, minutes later. Inside one origin
        // the message is the content script reading window.location.href in the
        // document the browser already vouched for, and it is the fresher fact.
        // Without this, the whole SPA half of part rules is decided about the
        // wrong page: tests/smoke/gate.smoke.mjs catches it and nothing else can.
        const res = await ctx.handleMessage(
          { action: 'checkPageMatch', host: 'www.instagram.com', url: 'https://www.instagram.com/reels/abc/' },
          { tab: { id: 3 }, url: 'https://www.instagram.com/direct/' }
        );
        expect(res.isBlocked).toBe(true);
        expect(res.partId).toBe('instagram:reels');
      });

      it('refuses an address from another origin and keeps the sender\'s', async () => {
        const { ctx } = loadBackground({ seed: ONLY_REELS() });
        // The forgery this guards against: a page claiming to be somewhere
        // else entirely so that no rule of ours applies to it.
        const res = await ctx.handleMessage(
          { action: 'checkPageMatch', host: 'www.instagram.com', url: 'https://example.com/harmless' },
          { tab: { id: 3 }, url: 'https://www.instagram.com/reels/abc/' }
        );
        expect(res.isBlocked).toBe(true);
        expect(res.partId).toBe('instagram:reels');
      });

      it('falls back to the message when the runtime populates no sender', async () => {
        const { ctx } = loadBackground({ seed: ONLY_REELS() });
        // The native ports (Android, iOS) send no sender URL at all.
        const res = await ctx.handleMessage(
          { action: 'checkPageMatch', host: 'www.instagram.com', url: 'https://www.instagram.com/reels/abc/' },
          {}
        );
        expect(res.isBlocked).toBe(true);
      });
    });

    it('carries no part rule for a target that has none', async () => {
      const { ctx } = loadBackground({
        seed: { ...CONFIGURED, setupComplete: true, blockedDomains: ['instagram.com'] }
      });
      const res = await ctx.checkPageMatch('www.instagram.com', 3, null, 'https://www.instagram.com/direct/');
      expect(res.isBlocked).toBe(true);
      expect(res.partRule).toBe(null);
    });

    it('gates everything when the stored rule is malformed', async () => {
      const { ctx } = loadBackground({
        seed: {
          ...CONFIGURED,
          setupComplete: true,
          blockedDomains: ['instagram.com'],
          domainLimits: { 'instagram.com': { scope: 'only', parts: [{ nope: true }, 17] } }
        }
      });
      const res = await ctx.checkPageMatch('www.instagram.com', 3, null, 'https://www.instagram.com/direct/');
      expect(res.isBlocked).toBe(true);
    });
  });

  describe('the gate backstop', () => {
    const withTab = (chrome, id, url) => { chrome.tabs._byId[id] = { id, url }; };

    // Load-bearing rather than defensive. An allowed page never calls
    // markHandled(), because there is nothing to handle — so without this
    // check the backstop reads "no overlay" as "the overlay failed" and
    // navigates every allowed page to the coach three seconds in.
    it('stands down on an address the rule leaves open', async () => {
      const { ctx, chrome } = loadBackground({ seed: ONLY_REELS() });
      const url = 'https://www.instagram.com/direct/inbox/';
      withTab(chrome, 4, url);
      await ctx.enforceGateBackstop(4, url);
      expect(chrome.tabs._updates).toHaveLength(0);
    });

    it('still fires on the part the rule names', async () => {
      const { ctx, chrome } = loadBackground({ seed: ONLY_REELS() });
      const url = 'https://www.instagram.com/reels/abc/';
      withTab(chrome, 4, url);
      await ctx.enforceGateBackstop(4, url);
      expect(chrome.tabs._updates).toHaveLength(1);
    });
  });

  describe('domainsNeedingRedirect', () => {
    // A urlFilter of ||instagram.com^ cannot see a path, so it would redirect
    // the sections the user explicitly left open. The overlay takes the host
    // over instead — which is exactly how Safari gates every site today.
    it('drops a host that carries a part rule', async () => {
      const { ctx } = loadBackground({
        seed: {
          ...CONFIGURED,
          setupComplete: true,
          blockedDomains: ['instagram.com', 'reddit.com'],
          domainLimits: { 'instagram.com': { scope: 'only', parts: ['instagram:reels'] } }
        }
      });
      expect(await ctx.domainsNeedingRedirect()).toEqual(['reddit.com']);
    });

    // hasPartRule and resolvePartVerdict have to agree about the same entry,
    // or the redirect and the overlay would disagree about the same page. An
    // empty list gates everything, so the host keeps its rule.
    it('keeps a host whose rule names nothing', async () => {
      const { ctx } = loadBackground({
        seed: {
          ...CONFIGURED,
          setupComplete: true,
          blockedDomains: ['instagram.com'],
          domainLimits: { 'instagram.com': { scope: 'only', parts: [] } }
        }
      });
      expect(await ctx.domainsNeedingRedirect()).toEqual(['instagram.com']);
    });
  });

  describe('saveSettings', () => {
    // The bug this exists to prevent: a scope change writes only domainLimits,
    // and which domains get a redirect rule now depends on it — so without the
    // re-sync the rule would stay stale, and a rule that looks saved and is not
    // is the worst state this page can be in.
    //
    // Arranged as a rule being REMOVED rather than added, because saveSettings
    // no longer accepts the other direction: adding a carve-out leaves less of
    // the site blocked, and every loosening of a part rule now goes through the
    // coach (holdPartRuleDirection, and the suite below). The re-sync is the
    // same code either way, and the direction that still comes through here is
    // the one worth pinning.
    it('re-syncs the blocking rules when only domainLimits changed', async () => {
      const { ctx, chrome } = loadBackground({
        seed: {
          ...CONFIGURED,
          setupComplete: true,
          blockedDomains: ['instagram.com'],
          domainLimits: { 'instagram.com': { maxGrants: 3, scope: 'only', parts: ['instagram:reels'] } }
        }
      });
      const dnr = statefulDnr(chrome);
      await ctx.syncBlockingRules();
      // A domain with a part rule carries no redirect: the content script has
      // to see the address before anything can decide.
      expect(dnr.redirectedDomains()).toEqual([]);

      await ctx.saveSettings({
        domainLimits: { 'instagram.com': { maxGrants: 3 } }
      });
      expect(dnr.redirectedDomains()).toEqual(['||instagram.com^']);
    });

    it('sanitises a part rule on its way in, and deletes one that names nothing', async () => {
      const { ctx, chrome } = loadBackground({
        seed: {
          ...CONFIGURED,
          setupComplete: true,
          // The same rule already stored, so what is being tested here is the
          // sanitiser and not the direction guard: an edit that resolves to the
          // rule already in force is not a loosening.
          domainLimits: { 'instagram.com': { maxGrants: 3, scope: 'only', parts: ['instagram:reels'] } }
        }
      });
      await ctx.saveSettings({
        domainLimits: {
          'instagram.com': { maxGrants: 3, scope: 'only', parts: ['instagram:reels', 'not a part id', 'instagram:reels'] },
          'reddit.com': { maxGrants: 3, scope: 'wat', parts: ['reddit:home'] }
        }
      });
      const stored = chrome.storage._store.domainLimits;
      expect(stored['instagram.com'].parts).toEqual(['instagram:reels']);
      // An unrecognised scope is no scope, so both keys go rather than being
      // written as 'all' — an entry with no rule must stay byte-identical to
      // what shipped before this feature existed.
      expect('scope' in stored['reddit.com']).toBe(false);
      expect('parts' in stored['reddit.com']).toBe(false);
    });

    it('leaves an entry with no part rule exactly as it was', async () => {
      const { ctx, chrome } = loadBackground({ seed: { ...CONFIGURED, setupComplete: true, domainLimits: {} } });
      const entry = { maxGrants: 3, passMinutes: 10 };
      await ctx.saveSettings({ domainLimits: { 'instagram.com': entry } });
      expect(chrome.storage._store.domainLimits['instagram.com']).toEqual(entry);
    });
  });

  // Which direction a part rule may move through the two whole-key writers.
  //
  // The options page runs this same test (partEditIsLoosening) before it
  // decides whether to save or to open the coach gate — and until this suite
  // existed that was the ONLY place it ran. saveSettings wrote whatever map it
  // was handed, so one runtime message from the extension's own devtools
  // console opened whatever the user liked. The gate on widening a rule has to
  // be a rule at this end, for the reason the leaveDelayMinutes clamp states
  // outright: "the only caller is careful" is how a guarded field stops being
  // guarded.
  describe('the direction a part rule may move through saveSettings', () => {
    const SEED = (extra = {}) => ({
      ...CONFIGURED,
      setupComplete: true,
      blockedDomains: ['instagram.com'],
      blockedApps: ['com.instagram.android'],
      ...extra
    });

    it('refuses a first carve-out in a site that was blocked whole', async () => {
      const { ctx, chrome } = loadBackground({
        seed: SEED({ domainLimits: { 'instagram.com': { maxGrants: 3, maxMinutes: 45 } } })
      });
      await ctx.saveSettings({
        domainLimits: { 'instagram.com': { maxGrants: 3, maxMinutes: 45, scope: 'only', parts: ['instagram:dms'] } }
      });
      const entry = chrome.storage._store.domainLimits['instagram.com'];
      // Both keys gone, not written as 'all': an entry with no rule stays
      // byte-identical to what shipped before the feature existed.
      expect('scope' in entry).toBe(false);
      expect('parts' in entry).toBe(false);
      // ...and the rest of the entry still lands. Only the rule is held back,
      // because one save carries the whole map and refusing it outright would
      // throw away unrelated edits made in the same breath.
      expect(entry.maxMinutes).toBe(45);
    });

    it('refuses a wider except-list, and keeps the stored one', async () => {
      const { ctx, chrome } = loadBackground({
        seed: SEED({ appLimits: { 'com.instagram.android': { maxGrants: 3, scope: 'except', parts: ['instagram:dms'] } } })
      });
      await ctx.saveSettings({
        appLimits: {
          'com.instagram.android': { maxGrants: 3, scope: 'except', parts: ['instagram:dms', 'instagram:reels'] }
        }
      });
      expect(chrome.storage._store.appLimits['com.instagram.android'].parts).toEqual(['instagram:dms']);
    });

    it('refuses a part dropped from an only-list', async () => {
      const { ctx, chrome } = loadBackground({
        seed: SEED({ domainLimits: { 'instagram.com': { maxGrants: 3, scope: 'only', parts: ['instagram:reels', 'instagram:explore'] } } })
      });
      await ctx.saveSettings({
        domainLimits: { 'instagram.com': { maxGrants: 3, scope: 'only', parts: ['instagram:reels'] } }
      });
      expect(chrome.storage._store.domainLimits['instagram.com'].parts)
        .toEqual(['instagram:reels', 'instagram:explore']);
    });

    // The mirror, so this is a direction check and not a refusal to write.
    it('still takes a part ADDED to an only-list, which blocks more', async () => {
      const { ctx, chrome } = loadBackground({
        seed: SEED({ domainLimits: { 'instagram.com': { maxGrants: 3, scope: 'only', parts: ['instagram:reels'] } } })
      });
      await ctx.saveSettings({
        domainLimits: { 'instagram.com': { maxGrants: 3, scope: 'only', parts: ['instagram:reels', 'instagram:explore'] } }
      });
      expect(chrome.storage._store.domainLimits['instagram.com'].parts)
        .toEqual(['instagram:reels', 'instagram:explore']);
    });

    it('still takes a return to "all of it", which blocks everything', async () => {
      const { ctx, chrome } = loadBackground({
        seed: SEED({ domainLimits: { 'instagram.com': { maxGrants: 3, scope: 'only', parts: ['instagram:reels'] } } })
      });
      await ctx.saveSettings({ domainLimits: { 'instagram.com': { maxGrants: 3 } } });
      const entry = chrome.storage._store.domainLimits['instagram.com'];
      expect('scope' in entry).toBe(false);
      expect('parts' in entry).toBe(false);
    });

    // 'only' and 'except' cannot be compared by list membership — the same ids
    // mean opposite things on either side of the switch — so parts.js answers
    // "unprovable", and unprovable has to mean refused here.
    it('refuses a switch between the two scopes', async () => {
      const { ctx, chrome } = loadBackground({
        seed: SEED({ domainLimits: { 'instagram.com': { maxGrants: 3, scope: 'only', parts: ['instagram:reels'] } } })
      });
      await ctx.saveSettings({
        domainLimits: { 'instagram.com': { maxGrants: 3, scope: 'except', parts: ['instagram:reels'] } }
      });
      expect(chrome.storage._store.domainLimits['instagram.com'].scope).toBe('only');
    });

    // The second whole-key writer. Finishing the wizard again must not be the
    // way around a rule the coach refused an hour ago.
    it('holds the same line through saveSetup', async () => {
      const { ctx, chrome } = loadBackground({
        seed: SEED({ domainLimits: { 'instagram.com': { maxGrants: 3 } } })
      });
      await ctx.handleMessage({
        action: 'saveSetup',
        config: {
          blockedDomains: ['instagram.com'],
          domainLimits: { 'instagram.com': { maxGrants: 3, scope: 'except', parts: ['instagram:reels'] } }
        }
      }, EXT_PAGE);
      const entry = chrome.storage._store.domainLimits['instagram.com'];
      expect('scope' in entry).toBe(false);
      expect('parts' in entry).toBe(false);
    });

    // The coach-approved path is the one thing that can widen a rule, and it
    // does not come through saveSettings at all — otherwise approval would
    // mean nothing.
    it('leaves the approved path alone', async () => {
      const { ctx, chrome } = loadBackground({
        seed: SEED({ domainLimits: { 'instagram.com': { maxGrants: 3 } } })
      });
      await ctx.applySettingChange({
        changeType: 'narrow_block_scope',
        domain: 'instagram.com',
        newValue: { scope: 'only', parts: ['instagram:dms'] }
      });
      expect(chrome.storage._store.domainLimits['instagram.com'].parts).toEqual(['instagram:dms']);
    });
  });

  // Neither writer is reachable from a web page today — a page cannot send us
  // a runtime message at all — and both carry the check anyway. Every other
  // privileged action in handleMessage has one, and the asymmetry was the only
  // thing that made an unguarded whole-config write look deliberate: one
  // message with { blockedDomains: [] } and the product is off.
  describe('the whole-config writers refuse a content sender', () => {
    const CONTENT = { url: 'https://instagram.com/', tab: { id: 4 } };

    it('refuses saveSettings, and changes nothing', async () => {
      const { ctx, chrome } = loadBackground({
        seed: { ...CONFIGURED, setupComplete: true, blockedDomains: ['instagram.com'] }
      });
      const res = await ctx.handleMessage({ action: 'saveSettings', config: { blockedDomains: [] } }, CONTENT);
      expect(res.error).toBeTruthy();
      expect(chrome.storage._store.blockedDomains).toEqual(['instagram.com']);
    });

    it('refuses saveSetup, and changes nothing', async () => {
      const { ctx, chrome } = loadBackground({
        seed: { ...CONFIGURED, setupComplete: true, blockedDomains: ['instagram.com'] }
      });
      const res = await ctx.handleMessage({ action: 'saveSetup', config: { blockedDomains: [] } }, CONTENT);
      expect(res.error).toBeTruthy();
      expect(chrome.storage._store.blockedDomains).toEqual(['instagram.com']);
    });

    // ...while our own pages and the native hosts still write, which is the
    // only reason the settings page works at all. The native shape matters on
    // its own: on Android and iOS EVERY message from our settings page arrives
    // with an empty sender.
    it('still lets an extension page and a native host through', async () => {
      for (const sender of [EXT_PAGE, NATIVE]) {
        const { ctx, chrome } = loadBackground({
          seed: { ...CONFIGURED, setupComplete: true, blockedDomains: ['instagram.com'] }
        });
        await ctx.handleMessage({ action: 'saveSettings', config: { blockedDomains: ['reddit.com'] } }, sender);
        expect(chrome.storage._store.blockedDomains).toEqual(['reddit.com']);
      }
    });
  });

  describe('applySettingChange', () => {
    const SEED = () => ({
      ...CONFIGURED,
      setupComplete: true,
      blockedDomains: ['instagram.com'],
      blockedApps: ['com.instagram.android'],
      domainLimits: { 'instagram.com': { maxGrants: 3, maxMinutes: 45 } },
      appLimits: { 'com.instagram.android': { maxGrants: 3 } }
    });

    it('writes the scope and the parts on a site, and re-syncs the rules', async () => {
      const { ctx, chrome } = loadBackground({ seed: SEED() });
      const dnr = statefulDnr(chrome);
      await ctx.syncBlockingRules();
      expect(dnr.redirectedDomains()).toEqual(['||instagram.com^']);

      const res = await ctx.applySettingChange({
        changeType: 'narrow_block_scope',
        domain: 'instagram.com',
        newValue: { scope: 'only', parts: ['instagram:reels'] }
      });
      expect(res.parts).toEqual(['instagram:reels']);
      const entry = chrome.storage._store.domainLimits['instagram.com'];
      expect(entry.scope).toBe('only');
      expect(entry.parts).toEqual(['instagram:reels']);
      // Nothing else on the entry moves.
      expect(entry.maxMinutes).toBe(45);
      expect(dnr.redirectedDomains()).toEqual([]);
    });

    it('deletes both keys when the new rule resolves to no rule at all', async () => {
      const { ctx, chrome } = loadBackground({
        seed: {
          ...SEED(),
          domainLimits: { 'instagram.com': { maxGrants: 3, scope: 'only', parts: ['instagram:reels'] } }
        }
      });
      await ctx.applySettingChange({
        changeType: 'narrow_block_scope',
        domain: 'instagram.com',
        newValue: { scope: 'all', parts: [] }
      });
      const entry = chrome.storage._store.domainLimits['instagram.com'];
      expect('scope' in entry).toBe(false);
      expect('parts' in entry).toBe(false);
      expect(entry.maxGrants).toBe(3);
    });

    it('sanitises a hostile value rather than storing it', async () => {
      const { ctx, chrome } = loadBackground({ seed: SEED() });
      await ctx.applySettingChange({
        changeType: 'narrow_block_scope',
        domain: 'instagram.com',
        newValue: { scope: 'only', parts: Array.from({ length: 40 }, (_, i) => `path:/p${i}/*`).concat(['../etc']) }
      });
      const entry = chrome.storage._store.domainLimits['instagram.com'];
      expect(entry.parts).toHaveLength(20);
      expect(entry.parts.every(p => p.startsWith('path:/p'))).toBe(true);
    });

    it('writes an app rule to appLimits and leaves the DNR rules alone', async () => {
      const { ctx, chrome } = loadBackground({ seed: SEED() });
      const dnr = statefulDnr(chrome);
      await ctx.syncBlockingRules();
      await ctx.applySettingChange({
        changeType: 'narrow_app_block_scope',
        domain: 'com.instagram.android',
        newValue: { scope: 'except', parts: ['instagram:dms'] }
      });
      expect(chrome.storage._store.appLimits['com.instagram.android'].scope).toBe('except');
      // An app target has no redirect rule to re-sync, and the site's is
      // untouched by an app-side change.
      expect(dnr.redirectedDomains()).toEqual(['||instagram.com^']);
    });

    // The app change types are listed once (APP_CHANGE_TYPES), because several
    // places have to agree about which targets are apps: page context is
    // meaningless for one, the display name comes from appLabels, and the app
    // context block replaces the page one. Asserted through the consequence —
    // a package name that reached the coach as a hostname would be quoted back
    // to the user as one.
    it('is treated as an app target by the coach, not as a hostname', async () => {
      const fetch = makeMockFetch({ content: [{ type: 'text', text: 'ok' }] });
      const { ctx } = loadBackground({
        seed: { ...SEED(), appLabels: { 'com.instagram.android': 'Instagram' } },
        fetch
      });
      await ctx.handleMessage({
        action: 'chat',
        mode: 'settings_gate',
        domain: 'com.instagram.android',
        changeType: 'narrow_app_block_scope',
        currentValue: { scope: 'all', parts: [] },
        newValue: { scope: 'except', parts: ['instagram:dms'] },
        userMessage: 'please'
      }, EXT_PAGE);
      const system = systemPromptOf(fetch);
      expect(system).toContain('the Instagram app');
      expect(system).not.toContain('com.instagram.android');
    });
  });

  describe('what the coach is told', () => {
    it('names the part they are on and the parts they left open', async () => {
      const fetch = makeMockFetch({ content: [{ type: 'text', text: 'ok' }] });
      const { ctx } = loadBackground({
        seed: {
          ...CONFIGURED,
          setupComplete: true,
          blockedDomains: ['instagram.com'],
          domainLimits: { 'instagram.com': { scope: 'only', parts: ['instagram:reels', 'instagram:explore'] } }
        },
        fetch
      });
      await ctx.handleMessage({
        action: 'chat',
        mode: 'gate',
        domain: 'instagram.com',
        userMessage: 'hi',
        pageContext: { url: 'https://www.instagram.com/reels/abc/', contentType: 'Instagram Reel' }
      }, tab(3));
      const system = systemPromptOf(fetch);
      expect(system).toContain('they block only these parts: Reels, Explore');
      expect(system).toContain('Right now they are on: Reels');
    });

    it('says nothing about parts for a target with no rule', async () => {
      const fetch = makeMockFetch({ content: [{ type: 'text', text: 'ok' }] });
      const { ctx } = loadBackground({
        seed: { ...CONFIGURED, setupComplete: true, blockedDomains: ['instagram.com'] },
        fetch
      });
      await ctx.handleMessage({
        action: 'chat',
        mode: 'gate',
        domain: 'instagram.com',
        userMessage: 'hi',
        pageContext: { url: 'https://www.instagram.com/reels/abc/' }
      }, tab(3));
      expect(systemPromptOf(fetch)).not.toContain('Which part of the site they are on');
    });

    // {{current_value}} is a token a user's own coach instructions may use, and
    // an object rendered through it reads as "[object Object]" — the coach
    // quoting a JavaScript artefact at the exact moment it asks them to
    // justify a change.
    it('hands the settings gate two sentences, never two objects', async () => {
      const fetch = makeMockFetch({ content: [{ type: 'text', text: 'ok' }] });
      const { ctx } = loadBackground({
        seed: {
          ...CONFIGURED,
          setupComplete: true,
          blockedDomains: ['instagram.com'],
          domainLimits: { 'instagram.com': { maxGrants: 3 } }
        },
        fetch
      });
      await ctx.handleMessage({
        action: 'chat',
        mode: 'settings_gate',
        domain: 'instagram.com',
        changeType: 'narrow_block_scope',
        currentValue: { scope: 'all', parts: [] },
        newValue: { scope: 'only', parts: ['instagram:reels'] },
        userMessage: 'please'
      }, EXT_PAGE);
      const system = systemPromptOf(fetch);
      expect(system).not.toContain('[object Object]');
      expect(system).toContain('Right now: all of instagram.com');
      expect(system).toContain('They want: only Reels on instagram.com');
    });
  });
});

// ===========================================================================
// Leaving Intention (WP9)
// ===========================================================================
//
// Two halves, tested separately because they fail differently. The pure
// half — isRemovalSurfaceUrl and leaveInterposeAllowed — is the whole policy
// of the feature written down; the stateful half is what the browser and the
// options page can actually make happen.
//
// The property every one of these is ultimately protecting: there is always a
// working way out, and nothing here can loop.

describe('isRemovalSurfaceUrl', () => {
  const { ctx } = loadBackground();

  it.each([
    ['chrome://extensions'],
    ['chrome://extensions/'],
    ['chrome://extensions/?id=abcdef'],
    ['chrome://extensions/shortcuts'],
    ['chrome://Extensions'],
    ['edge://extensions'],
    ['brave://extensions/'],
    ['about:addons'],
    ['about:addons#detail/something']
  ])('recognises %s', (url) => {
    expect(ctx.isRemovalSurfaceUrl(url)).toBe(true);
  });

  // The prefix cases are the ones a naive startsWith() gets wrong.
  // chrome://extensions-internals is a debugging page with nothing to do with
  // removal, and the two https ones are a hostile page trying to make the
  // worker open a tab by putting our own string in its address.
  it.each([
    ['chrome://settings'],
    ['chrome://extensions-internals'],
    ['chrome://extensionsomething'],
    ['about:addonsfoo'],
    ['https://example.com/chrome://extensions'],
    ['https://chrome.extensions.example.com/'],
    [''],
    [undefined],
    [null],
    [{}],
    [42]
  ])('refuses %s', (url) => {
    expect(ctx.isRemovalSurfaceUrl(url)).toBe(false);
  });
});

describe('leaveInterposeAllowed', () => {
  const { ctx } = loadBackground();
  const NOW = 1_800_000_000_000;
  const ready = { setupComplete: true, blockedDomains: ['instagram.com'] };

  it('allows an ordinary first visit', () => {
    expect(ctx.leaveInterposeAllowed(ready, NOW)).toBe(true);
  });

  it.each([
    [{ ...ready, setupComplete: false }, 'setup was never finished'],
    [{ ...ready, blockedDomains: [] }, 'the blocklist is empty'],
    [{ ...ready, blockedDomains: 'instagram.com' }, 'the blocklist is not even a list'],
    [null, 'there is no state at all'],
    [undefined, 'the read came back empty']
  ])('stays quiet when %#: %s', (state) => {
    expect(ctx.leaveInterposeAllowed(state, NOW)).toBe(false);
  });

  // THE anti-loop property, and the one thing to point a store reviewer at: a
  // decline silences the interposition exactly as hard as an approval does.
  // Talk to the coach, decide to stay, go back to chrome://extensions for
  // whatever you actually opened it for — and Intention says nothing.
  it.each([['approved'], ['declined'], ['cancelled'], ['anyway']])(
    'stays quiet inside a stand-down written with reason "%s"', (reason) => {
      const state = { ...ready, leaveStandDown: { until: NOW + 60_000, reason } };
      expect(ctx.leaveInterposeAllowed(state, NOW)).toBe(false);
    });

  it('speaks again once the stand-down has lapsed', () => {
    const state = { ...ready, leaveStandDown: { until: NOW - 1, reason: 'declined' } };
    expect(ctx.leaveInterposeAllowed(state, NOW)).toBe(true);
  });

  // A stand-down can never suppress for longer than its own length. Without
  // the cap, a clock that jumped forward once — or a hand-edited value —
  // could write a silence lasting years, and the user would have no way to
  // tell why the feature had stopped working.
  it('ignores a stand-down further out than a stand-down can possibly be', () => {
    const state = { ...ready, leaveStandDown: { until: NOW + ctx.LEAVE_STAND_DOWN_MS + 1, reason: 'declined' } };
    expect(ctx.leaveInterposeAllowed(state, NOW)).toBe(true);
  });

  it('stays quiet inside the plain debounce', () => {
    expect(ctx.leaveInterposeAllowed({ ...ready, leaveInterposedAt: NOW - 1000 }, NOW)).toBe(false);
    expect(ctx.leaveInterposeAllowed({ ...ready, leaveInterposedAt: NOW - ctx.LEAVE_INTERPOSE_DEBOUNCE_MS - 1 }, NOW)).toBe(true);
  });

  // A timestamp in the future means the clock moved backwards. Treating it as
  // a live debounce would silence the feature until the clock caught up.
  it('does not let a future timestamp silence it', () => {
    expect(ctx.leaveInterposeAllowed({ ...ready, leaveInterposedAt: NOW + 86_400_000 }, NOW)).toBe(true);
  });

  // They already asked and the coach already agreed. Opening the conversation
  // again would be asking somebody to re-justify a decision we accepted.
  it('stays quiet for the whole life of a pending request', () => {
    const state = { ...ready, leaveRequest: { requestedAt: NOW, availableAt: NOW + 86_400_000, delayMinutes: 1440 } };
    expect(ctx.leaveInterposeAllowed(state, NOW)).toBe(false);
  });

  it('and after that request matures, because the answer was still yes', () => {
    const state = { ...ready, leaveRequest: { requestedAt: NOW - 90_000_000, availableAt: NOW - 1000, delayMinutes: 1440 } };
    expect(ctx.leaveInterposeAllowed(state, NOW)).toBe(false);
  });
});

describe('the chrome://extensions interposition', () => {
  const seeded = (extra = {}) => loadBackground({
    seed: { ...CONFIGURED, setupComplete: true, blockedDomains: ['instagram.com'], ...extra }
  });

  // The load-bearing assumption of the whole browser half — that tabs.onUpdated
  // is offered a populated URL for a chrome:// page — cannot be proved here;
  // that is what tests/smoke/leaving.smoke.mjs exists for. What CAN be proved
  // here is everything that happens once it is.
  it('opens exactly one tab, beside the extensions page', async () => {
    const { ctx, chrome, listeners } = seeded();
    expect(typeof listeners.tabUpdated).toBe('function');
    listeners.tabUpdated(7, { url: 'chrome://extensions/' }, { id: 7, url: 'chrome://extensions/' });
    await vi.waitFor(() => expect(chrome.tabs._creates.length).toBe(1));
    expect(chrome.tabs._creates[0].url).toBe('chrome-extension://test/options.html?leave=1');
    void ctx;
  });

  // The Chrome Web Store's "must be easily reversible" clause lives here. The
  // user may well have opened that page to manage a DIFFERENT extension — no
  // API tells us whose row they are looking at — so taking the page away from
  // them is not ours to do.
  it('never navigates or closes the extensions tab', async () => {
    const { chrome, listeners } = seeded();
    listeners.tabUpdated(7, { url: 'chrome://extensions/' }, { id: 7, url: 'chrome://extensions/' });
    await vi.waitFor(() => expect(chrome.tabs._creates.length).toBe(1));
    expect(chrome.tabs._updates.filter(u => u.id === 7)).toEqual([]);
  });

  it('says nothing at all about an unrelated chrome:// page', async () => {
    const { chrome, listeners } = seeded();
    listeners.tabUpdated(7, { url: 'chrome://settings/' }, { id: 7, url: 'chrome://settings/' });
    await new Promise(r => setTimeout(r, 20));
    expect(chrome.tabs._creates).toEqual([]);
  });

  it('says nothing before setup, or with an empty blocklist', async () => {
    for (const seed of [{ setupComplete: false }, { blockedDomains: [] }]) {
      const { chrome, listeners } = seeded(seed);
      listeners.tabUpdated(7, { url: 'chrome://extensions/' }, { id: 7, url: 'chrome://extensions/' });
      await new Promise(r => setTimeout(r, 20));
      expect(chrome.tabs._creates).toEqual([]);
    }
  });

  it('opens nothing on a second visit inside the debounce', async () => {
    const { chrome, listeners } = seeded();
    listeners.tabUpdated(7, { url: 'chrome://extensions/' }, { id: 7, url: 'chrome://extensions/' });
    await vi.waitFor(() => expect(chrome.tabs._creates.length).toBe(1));
    listeners.tabUpdated(8, { url: 'chrome://extensions/' }, { id: 8, url: 'chrome://extensions/' });
    await new Promise(r => setTimeout(r, 20));
    expect(chrome.tabs._creates.length).toBe(1);
  });

  // tabs.onUpdated fires more than once for one visit (the url change, then
  // status 'complete'). Both would otherwise read the stored debounce before
  // either had written it, and the user would get two tabs for one page load.
  it('opens one tab for the two events a single navigation raises', async () => {
    const { chrome, listeners } = seeded();
    listeners.tabUpdated(7, { url: 'chrome://extensions/' }, { id: 7, url: 'chrome://extensions/' });
    listeners.tabUpdated(7, { status: 'complete' }, { id: 7, url: 'chrome://extensions/' });
    await new Promise(r => setTimeout(r, 30));
    expect(chrome.tabs._creates.length).toBe(1);
  });

  it('stays quiet inside a stand-down, including one written by a decline', async () => {
    const { chrome, listeners } = seeded({
      leaveStandDown: { until: Date.now() + 60_000, reason: 'declined' }
    });
    listeners.tabUpdated(7, { url: 'chrome://extensions/' }, { id: 7, url: 'chrome://extensions/' });
    await new Promise(r => setTimeout(r, 20));
    expect(chrome.tabs._creates).toEqual([]);
  });

  it('ignores an event that carries no navigation and no completion', async () => {
    const { chrome, listeners } = seeded();
    listeners.tabUpdated(7, { favIconUrl: 'x' }, { id: 7, url: 'chrome://extensions/' });
    await new Promise(r => setTimeout(r, 20));
    expect(chrome.tabs._creates).toEqual([]);
  });
});

describe('the farewell page', () => {
  it('is registered, and points away from our own backend', () => {
    const { chrome } = loadBackground();
    expect(chrome.runtime._uninstallURL).toMatch(/^https:\/\/github\.com\//);
    // Pointing it at api.intention.* would make every removal a request the
    // backend logs — an uninstall ping, which PRIVACY.md forbids.
    expect(chrome.runtime._uninstallURL).not.toMatch(/intention\.maybeitssoftware/);
    expect(chrome.runtime._uninstallURL).toContain('LEAVING.md');
  });
});

describe("applySettingChange: the user's way out", () => {
  const seeded = (extra = {}) => loadBackground({
    seed: { ...CONFIGURED, setupComplete: true, blockedDomains: ['instagram.com'], ...extra }
  });

  it('with no cool-off, clears the way now and writes a stand-down', async () => {
    const { ctx, chrome } = seeded({ leaveDelayMinutes: 0 });
    const before = Date.now();
    const result = await ctx.applySettingChange({ changeType: 'uninstall', domain: null });
    expect(result.removalReady).toBe(true);
    expect(result.delayMinutes).toBe(0);
    expect(chrome.storage._store.leaveStandDown.reason).toBe('approved');
    expect(chrome.storage._store.leaveStandDown.until).toBeGreaterThanOrEqual(before + ctx.LEAVE_STAND_DOWN_MS);
    expect(chrome.storage._store.leaveRequest).toBe(null);
  });

  it('with a cool-off, starts the clock and removes nothing', async () => {
    const { ctx, chrome } = seeded({ leaveDelayMinutes: 1440 });
    const before = Date.now();
    const result = await ctx.applySettingChange({ changeType: 'uninstall', domain: null });
    expect(result.removalReady).toBe(false);
    expect(result.availableAt).toBeGreaterThanOrEqual(before + 86_400_000);
    expect(chrome.storage._store.leaveRequest.delayMinutes).toBe(1440);
    // The blocklist is untouched. Approving a departure is not a teardown —
    // Intention keeps working, unchanged, for the whole of the cool-off.
    expect(chrome.storage._store.blockedDomains).toEqual(['instagram.com']);
  });

  // The design this came from wrote a stand-down only on the no-delay path.
  // Writing one on both makes "every outcome of the leaving conversation
  // writes a stand-down" a rule with no exceptions — much easier to state to
  // a reviewer, and it can only ever add silence.
  it('writes a stand-down on the delayed path too', async () => {
    const { ctx, chrome } = seeded({ leaveDelayMinutes: 60 });
    await ctx.applySettingChange({ changeType: 'uninstall', domain: null });
    expect(chrome.storage._store.leaveStandDown.reason).toBe('approved');
  });

  it('snaps a corrupt stored delay DOWN before acting on it', async () => {
    const { ctx } = seeded({ leaveDelayMinutes: 1439 });
    const result = await ctx.applySettingChange({ changeType: 'uninstall', domain: null });
    expect(result.delayMinutes).toBe(60);
  });

  it('shortens the cool-off when the new value is genuinely smaller', async () => {
    const { ctx, chrome } = seeded({ leaveDelayMinutes: 1440 });
    const result = await ctx.applySettingChange({ changeType: 'decrease_leave_delay', newValue: 60 });
    expect(result.leaveDelayMinutes).toBe(60);
    expect(chrome.storage._store.leaveDelayMinutes).toBe(60);
  });

  // A "decrease" that raises the number would launder a free change through
  // the gate; one equal to the current value would let the coach be talked
  // into approving a no-op, which reads to the user as their cool-off having
  // moved when nothing did.
  it.each([[1440], [4320], [99999]])('refuses %i, which is not a decrease', async (newValue) => {
    const { ctx, chrome } = seeded({ leaveDelayMinutes: 1440 });
    expect(await ctx.applySettingChange({ changeType: 'decrease_leave_delay', newValue })).toBe(null);
    expect(chrome.storage._store.leaveDelayMinutes).toBe(1440);
  });

  it('refuses a decrease when there is no cool-off to decrease', async () => {
    const { ctx } = seeded({ leaveDelayMinutes: 0 });
    expect(await ctx.applySettingChange({ changeType: 'decrease_leave_delay', newValue: 0 })).toBe(null);
  });
});

describe('saveSettings guards the direction of the cool-off', () => {
  const seeded = (extra = {}) => loadBackground({ seed: { ...CONFIGURED, ...extra } });

  it('lets it be lengthened for free — that is a tightening', async () => {
    const { ctx, chrome } = seeded({ leaveDelayMinutes: 60 });
    await ctx.saveSettings({ leaveDelayMinutes: 4320 });
    expect(chrome.storage._store.leaveDelayMinutes).toBe(4320);
  });

  // The choke point, not a UI convention: every extension page can reach
  // saveSettings, so without this the gate on shortening is decoration.
  it('refuses to shorten it, whatever the caller asked for', async () => {
    const { ctx, chrome } = seeded({ leaveDelayMinutes: 1440 });
    await ctx.saveSettings({ leaveDelayMinutes: 0 });
    expect(chrome.storage._store.leaveDelayMinutes).toBe(1440);
  });

  it('and normalises whatever it does write', async () => {
    const { ctx, chrome } = seeded({ leaveDelayMinutes: 0 });
    await ctx.saveSettings({ leaveDelayMinutes: 4319 });
    expect(chrome.storage._store.leaveDelayMinutes).toBe(1440);
  });
});

describe('the leaving message actions', () => {
  const seeded = (extra = {}) => loadBackground({
    seed: { ...CONFIGURED, setupComplete: true, blockedDomains: ['instagram.com'], ...extra }
  });

  // A page that could call beginLeave would buy fifteen minutes of silence
  // from the interposition; one that could call completeRemoval would
  // uninstall a self-control tool out from under its user without a word.
  it.each([['getLeaveState'], ['beginLeave'], ['completeRemoval']])(
    'refuses %s from a content script', async (action) => {
      const { ctx, chrome } = seeded();
      const result = await ctx.handleMessage({ action }, tab(3));
      expect(result.error).toMatch(/Not allowed/);
      expect(chrome.management._uninstallCalls).toEqual([]);
      expect(chrome.storage._store.leaveStandDown).toBe(undefined);
    });

  it.each([['uninstall'], ['decrease_leave_delay']])(
    'refuses applySettingChange(%s) from a content script', async (changeType) => {
      const { ctx, chrome } = seeded({ leaveDelayMinutes: 1440 });
      const result = await ctx.handleMessage({ action: 'applySettingChange', changeType, newValue: 0 }, tab(3));
      expect(result.error).toMatch(/Not allowed/);
      expect(chrome.storage._store.leaveDelayMinutes).toBe(1440);
    });

  // Leaving has its own cool-off, so asking to leave from our own page starts
  // it at once — it is never deferred behind a second, overnight wait.
  it('starts the leaving flow at once from our own page', async () => {
    const { ctx, chrome } = seeded({ leaveDelayMinutes: 0 });
    const result = await ctx.handleMessage({ action: 'applySettingChange', changeType: 'uninstall' }, EXT_PAGE);
    expect(result.removalReady).toBe(true);
    expect(chrome.storage._store.leaveStandDown.reason).toBe('approved');
    expect(chrome.storage._store.pendingChanges).toBeUndefined();
  });

  it('queues a shorter cool-off rather than applying it', async () => {
    const { ctx, chrome } = seeded({ leaveDelayMinutes: 1440 });
    const result = await ctx.handleMessage({ action: 'applySettingChange', changeType: 'decrease_leave_delay', newValue: 0 }, EXT_PAGE);
    expect(result.scheduled).toBe(true);
    expect(chrome.storage._store.leaveDelayMinutes).toBe(1440);
  });

  it('reports the state the settings card paints from', async () => {
    const now = Date.now();
    const { ctx } = seeded({
      leaveDelayMinutes: 1440,
      leaveRequest: { requestedAt: now - 1000, availableAt: now + 60_000, delayMinutes: 1440 }
    });
    const state = await ctx.handleMessage({ action: 'getLeaveState' }, EXT_PAGE);
    expect(state.leaveDelayMinutes).toBe(1440);
    expect(state.ready).toBe(false);
    expect(state.canSelfUninstall).toBe(true);
  });

  it('calls a matured request ready', async () => {
    const now = Date.now();
    const { ctx } = seeded({ leaveRequest: { requestedAt: now - 90_000, availableAt: now - 1, delayMinutes: 60 } });
    const state = await ctx.handleMessage({ action: 'getLeaveState' }, EXT_PAGE);
    expect(state.ready).toBe(true);
  });

  // An unreadable request reads as "nobody has asked", which costs one more
  // conversation. Reading it the other way would let a corrupt value hold the
  // door open forever.
  it.each([[{}], [{ availableAt: 'soon' }], [{ availableAt: 0 }], ['nonsense'], [42]])(
    'treats the unreadable request %j as no request', async (leaveRequest) => {
      const { ctx } = seeded({ leaveRequest });
      const state = await ctx.handleMessage({ action: 'getLeaveState' }, EXT_PAGE);
      expect(state.leaveRequest).toBe(null);
      expect(state.ready).toBe(false);
    });

  it('records every outcome as a stand-down, including a decline', async () => {
    for (const reason of ['approved', 'declined', 'cancelled', 'anyway']) {
      const { ctx, chrome } = seeded();
      const before = Date.now();
      const result = await ctx.handleMessage({ action: 'beginLeave', reason }, EXT_PAGE);
      expect(result.reason).toBe(reason);
      expect(chrome.storage._store.leaveStandDown.reason).toBe(reason);
      expect(chrome.storage._store.leaveStandDown.until).toBeGreaterThanOrEqual(before + ctx.LEAVE_STAND_DOWN_MS);
    }
  });

  it('files an unrecognised outcome as a decline rather than storing it', async () => {
    const { ctx, chrome } = seeded();
    await ctx.handleMessage({ action: 'beginLeave', reason: 'sneaky' }, EXT_PAGE);
    expect(chrome.storage._store.leaveStandDown.reason).toBe('declined');
  });

  // The ordering is the point: if the user says no to the browser's own
  // confirmation dialog, Intention is still running and must not greet them
  // with the same conversation the moment they look at the page again.
  it('writes the stand-down BEFORE it attempts the uninstall', async () => {
    const { ctx, chrome } = seeded();
    const result = await ctx.handleMessage({ action: 'completeRemoval' }, EXT_PAGE);
    expect(result.ok).toBe(true);
    expect(chrome.storage._store.leaveStandDown.reason).toBe('anyway');
    expect(chrome.management._uninstallCalls).toEqual([{ showConfirmDialog: true }]);
  });

  it('reports a declined confirmation dialog as a cancellation, not an error', async () => {
    const { ctx, chrome } = seeded();
    chrome.management.uninstallSelf = async () => { throw new Error('User cancelled uninstall'); };
    const result = await ctx.handleMessage({ action: 'completeRemoval' }, EXT_PAGE);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('cancelled');
    // Still stood down: they went as far as the dialog, and being asked again
    // thirty seconds later would be the loop this feature must not become.
    expect(chrome.storage._store.leaveStandDown.reason).toBe('anyway');
  });

  // uninstallSelf() would remove the SAFARI EXTENSION and leave the Intention
  // app exactly where it was — technically a removal, not the one the button
  // promises. The options page shows directions there instead.
  it('will not self-uninstall on an Apple build', async () => {
    const { ctx, chrome } = loadBackground({
      seed: { ...CONFIGURED, setupComplete: true, blockedDomains: ['instagram.com'] },
      userAgent: 'Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15'
    });
    expect((await ctx.handleMessage({ action: 'getLeaveState' }, EXT_PAGE)).canSelfUninstall).toBe(false);
    const result = await ctx.handleMessage({ action: 'completeRemoval' }, EXT_PAGE);
    expect(result).toEqual({ ok: false, reason: 'unsupported' });
    expect(chrome.management._uninstallCalls).toEqual([]);
  });
});

describe('what the leaving conversation tells the coach', () => {
  it('hands it the aggregate picture and the removal tool', async () => {
    const fetch = makeMockFetch({ content: [{ type: 'text', text: 'ok' }] });
    const { ctx } = loadBackground({
      seed: {
        ...CONFIGURED,
        setupComplete: true,
        blockedDomains: ['instagram.com', 'reddit.com'],
        blockedApps: ['com.instagram.android'],
        leaveDelayMinutes: 1440,
        setupCompletedAt: Date.now() - 10 * 86_400_000
      },
      fetch
    });
    await ctx.handleMessage({
      action: 'chat', mode: 'settings_gate', changeType: 'uninstall', userMessage: 'I am done'
    }, EXT_PAGE);
    const system = systemPromptOf(fetch);
    expect(system).toContain('2 sites and 1 app');
    expect(system).toContain('10 days ago');
    expect(system).toContain('The cool-off they put on leaving: 24 hours.');
    expect(system).not.toContain('Your default answer is NO');
    // The tool description carries half the stance, so it has to be the
    // stance-free one or the branch above is undone from the outside.
    const tools = JSON.parse(fetch.calls.at(-1).init.body).tools;
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe('approve_setting_change');
    expect(tools[0].description).not.toContain('default answer is NO');
  });

  // Anyone who set Intention up before setupCompletedAt existed has no such
  // key, and the earliest day they have usage for is the same answer reached
  // from data that was already on the device.
  it('falls back to the earliest day in the stats for an older install', async () => {
    const fetch = makeMockFetch({ content: [{ type: 'text', text: 'ok' }] });
    const old = new Date(Date.now() - 30 * 86_400_000);
    const key = `${old.getFullYear()}-${String(old.getMonth() + 1).padStart(2, '0')}-${String(old.getDate()).padStart(2, '0')}`;
    const { ctx } = loadBackground({
      seed: {
        ...CONFIGURED,
        setupComplete: true,
        blockedDomains: ['instagram.com'],
        dailyStats: { [key]: { 'instagram.com': { minutes: 5 } } }
      },
      fetch
    });
    await ctx.handleMessage({
      action: 'chat', mode: 'settings_gate', changeType: 'uninstall', userMessage: 'bye'
    }, EXT_PAGE);
    expect(systemPromptOf(fetch)).toContain('30 days ago');
  });

  it('keeps the ordinary sceptical tool for shortening the cool-off', async () => {
    const fetch = makeMockFetch({ content: [{ type: 'text', text: 'ok' }] });
    const { ctx } = loadBackground({
      seed: { ...CONFIGURED, setupComplete: true, blockedDomains: ['instagram.com'], leaveDelayMinutes: 1440 },
      fetch
    });
    await ctx.handleMessage({
      action: 'chat', mode: 'settings_gate', changeType: 'decrease_leave_delay',
      currentValue: 1440, newValue: 60, userMessage: 'please'
    }, EXT_PAGE);
    const system = systemPromptOf(fetch);
    expect(system).toContain('Your default answer is NO');
    expect(system).toContain('from 24 hours to an hour');
    expect(JSON.parse(fetch.calls.at(-1).init.body).tools[0].description).toContain('default answer is NO');
  });

  it('closes with the cool-off in the acceptance line, not a farewell', async () => {
    const fetch = makeMockFetch({
      content: [{ type: 'tool_use', id: 't1', name: 'approve_setting_change', input: { reason: 'done with it' } }]
    });
    const { ctx } = loadBackground({
      seed: { ...CONFIGURED, setupComplete: true, blockedDomains: ['instagram.com'], leaveDelayMinutes: 1440 },
      fetch
    });
    const result = await ctx.handleMessage({
      action: 'chat', mode: 'settings_gate', changeType: 'uninstall', userMessage: 'I am done'
    }, EXT_PAGE);
    expect(result.approved).toBe(true);
    expect(result.assistantText).toContain('Your 24 hours starts now');
  });

  it('and with a farewell when there is no cool-off', async () => {
    const fetch = makeMockFetch({
      content: [{ type: 'tool_use', id: 't1', name: 'approve_setting_change', input: { reason: 'done' } }]
    });
    const { ctx } = loadBackground({
      seed: { ...CONFIGURED, setupComplete: true, blockedDomains: ['instagram.com'], leaveDelayMinutes: 0 },
      fetch
    });
    const result = await ctx.handleMessage({
      action: 'chat', mode: 'settings_gate', changeType: 'uninstall', userMessage: 'I am done'
    }, EXT_PAGE);
    expect(result.assistantText).toContain("I've stepped out of the way");
  });
});

describe('the config the leaving card reads', () => {
  it('carries the cool-off and when setup happened', async () => {
    const { ctx } = loadBackground({ seed: { setupComplete: true, leaveDelayMinutes: 1439, setupCompletedAt: 12345 } });
    const config = await ctx.handleMessage({ action: 'getConfig' }, EXT_PAGE);
    // Normalised on the way OUT too, so a drifted value paints as the rung
    // below it rather than as no choice selected at all.
    expect(config.leaveDelayMinutes).toBe(60);
    expect(config.setupCompletedAt).toBe(12345);
  });

  it('stamps the setup date on the way through the wizard', async () => {
    const { ctx, chrome } = loadBackground();
    const before = Date.now();
    await ctx.handleMessage({ action: 'saveSetup', config: { blockedDomains: ['instagram.com'] } }, EXT_PAGE);
    expect(chrome.storage._store.setupCompletedAt).toBeGreaterThanOrEqual(before);
  });
});

// ---------------------------------------------------------------------------
// Always-allowed accounts
// ---------------------------------------------------------------------------
//
// An account on the list opens its own pages and nothing else: no gate, no
// open spent, no backstop. Adding one is a loosening like any other — it waits
// for tomorrow unless the coach agrees — and a whole-map write cannot sneak
// one in. A YouTube video needs one lookup to know its channel, and every way
// that lookup can fail leaves the video gated.
describe('always-allowed accounts in the worker', () => {
  const ALLOW = (entry = {}) => ({
    ...CONFIGURED,
    setupComplete: true,
    blockedDomains: ['instagram.com', 'youtube.com'],
    domainLimits: {
      ...CONFIGURED.domainLimits,
      'instagram.com': { maxGrants: 3, allowedAccounts: ['natgeo'], ...entry },
      'youtube.com': { maxGrants: 3, allowedAccounts: ['veritasium'] }
    }
  });
  const WATCH = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
  const oembed = (authorUrl, status = 200) => makeMockFetch((url) =>
    (String(url).startsWith('https://www.youtube.com/oembed') ? { status, json: { author_url: authorUrl } } : { status: 404, json: {} }));
  const lookupsIn = (fetch) => fetch.calls.filter(c => String(c.url).includes('/oembed?format=json&url='));

  it('does not gate the account\'s profile, and hands the page the rule to watch', async () => {
    const { ctx } = loadBackground({ seed: ALLOW() });
    const res = await ctx.checkPageMatch('www.instagram.com', 3, null, 'https://www.instagram.com/natgeo/');
    expect(res.isBlocked).toBe(false);
    expect(res.matchedDomain).toBe('instagram.com');
    expect(res.partRule).toEqual({ scope: 'all', parts: [], allowedAccounts: ['natgeo'] });
  });

  it('still gates everyone else, and a post whose address names nobody', async () => {
    const { ctx } = loadBackground({ seed: ALLOW() });
    expect((await ctx.checkPageMatch('www.instagram.com', 3, null, 'https://www.instagram.com/someone/')).isBlocked).toBe(true);
    expect((await ctx.checkPageMatch('www.instagram.com', 3, null, 'https://www.instagram.com/p/C1aBcDeF/')).isBlocked).toBe(true);
  });

  it('drops the host redirect, since the address decides now', async () => {
    const { ctx, chrome } = loadBackground({ seed: { ...ALLOW(), blockedDomains: ['instagram.com', 'reddit.com'] } });
    const dnr = statefulDnr(chrome);
    await ctx.syncBlockingRules();
    expect(dnr.redirectedDomains()).toEqual(['||reddit.com^']);
  });

  it('stands the backstop down on the account\'s page, and not elsewhere', async () => {
    const { ctx, chrome } = loadBackground({ seed: ALLOW() });
    chrome.tabs._byId[4] = { id: 4, url: 'https://www.instagram.com/natgeo/' };
    await ctx.enforceGateBackstop(4, 'https://www.instagram.com/natgeo/');
    expect(chrome.tabs._updates).toHaveLength(0);
    chrome.tabs._byId[4] = { id: 4, url: 'https://www.instagram.com/explore/' };
    await ctx.enforceGateBackstop(4, 'https://www.instagram.com/explore/');
    expect(chrome.tabs._updates).toHaveLength(1);
  });

  describe('a YouTube video', () => {
    it('opens once YouTube says the channel is on the list, and asks only once', async () => {
      const fetch = oembed('https://www.youtube.com/@Veritasium');
      const { ctx } = loadBackground({ seed: ALLOW(), fetch });
      const res = await ctx.checkPageMatch('www.youtube.com', 3, null, WATCH);
      expect(res.isBlocked).toBe(false);
      expect(lookupsIn(fetch)).toHaveLength(1);
      expect(lookupsIn(fetch)[0].init.credentials).toBe('omit');
      // The next check of the same video reuses the answer.
      await ctx.checkPageMatch('www.youtube.com', 3, null, `${WATCH}&t=5`);
      expect(lookupsIn(fetch)).toHaveLength(1);
    });

    it.each([
      ['another channel', () => oembed('https://www.youtube.com/@someoneelse')],
      ['no handle in the answer', () => oembed('https://www.youtube.com/channel/UC123')],
      ['an error status', () => oembed('https://www.youtube.com/@veritasium', 500)],
      ['a network failure', () => makeMockFetch(() => { throw new Error('offline'); })]
    ])('stays gated on %s', async (_why, makeFetch) => {
      const { ctx } = loadBackground({ seed: ALLOW(), fetch: makeFetch() });
      expect((await ctx.checkPageMatch('www.youtube.com', 3, null, WATCH)).isBlocked).toBe(true);
    });

    it('never asks when there is no list', async () => {
      const fetch = oembed('https://www.youtube.com/@veritasium');
      const seed = ALLOW();
      delete seed.domainLimits['youtube.com'].allowedAccounts;
      const { ctx } = loadBackground({ seed, fetch });
      expect((await ctx.checkPageMatch('www.youtube.com', 3, null, WATCH)).isBlocked).toBe(true);
      expect(lookupsIn(fetch)).toHaveLength(0);
    });
  });

  describe('writing the list', () => {
    it('lets saveSettings take an account off, and holds back one put on', async () => {
      const { ctx, chrome } = loadBackground({ seed: ALLOW({ allowedAccounts: ['natgeo', 'nasa'] }) });
      await ctx.saveSettings({
        domainLimits: { 'instagram.com': { maxGrants: 3, allowedAccounts: ['nasa', 'someoneelse'] } }
      });
      expect(chrome.storage._store.domainLimits['instagram.com'].allowedAccounts).toEqual(['nasa']);
    });

    it('stores an emptied list as no key at all', async () => {
      const { ctx, chrome } = loadBackground({ seed: ALLOW() });
      await ctx.saveSettings({ domainLimits: { 'instagram.com': { maxGrants: 3, allowedAccounts: [] } } });
      expect('allowedAccounts' in chrome.storage._store.domainLimits['instagram.com']).toBe(false);
    });

    it('queues an addition from settings for tomorrow', async () => {
      const { ctx, chrome } = loadBackground({ seed: ALLOW() });
      const resp = await ctx.handleMessage(
        { action: 'applySettingChange', changeType: 'allow_accounts', domain: 'instagram.com', newValue: ['nasa'] },
        EXT_PAGE
      );
      expect(resp.scheduled).toBe(true);
      expect(chrome.storage._store.domainLimits['instagram.com'].allowedAccounts).toEqual(['natgeo']);
      const [pending] = chrome.storage._store.pendingChanges;
      expect(pending).toMatchObject({ changeType: 'allow_accounts', domain: 'instagram.com', newValue: ['nasa'] });
      expect(pending.effectiveAt).toBe(ctx.nextDayStart(pending.requestedAt));
    });

    it('merges an approved addition with whatever is stored when it applies', async () => {
      const { ctx, chrome } = loadBackground({ seed: ALLOW() });
      const dnr = statefulDnr(chrome);
      const res = await ctx.applySettingChange({ changeType: 'allow_accounts', domain: 'instagram.com', newValue: ['@NASA', 'natgeo', '../bad'] });
      expect(res.allowedAccounts).toEqual(['natgeo', 'nasa']);
      const entry = chrome.storage._store.domainLimits['instagram.com'];
      expect(entry.allowedAccounts).toEqual(['natgeo', 'nasa']);
      expect(entry.maxGrants).toBe(3);
      expect(dnr.redirectedDomains()).toEqual([]);
    });

    it('refuses an addition for a site it cannot read accounts on, or with nothing usable', async () => {
      const { ctx, chrome } = loadBackground({ seed: { ...ALLOW(), blockedDomains: ['instagram.com', 'reddit.com'] } });
      expect(await ctx.applySettingChange({ changeType: 'allow_accounts', domain: 'reddit.com', newValue: ['spez'] })).toBe(null);
      expect(await ctx.applySettingChange({ changeType: 'allow_accounts', domain: 'instagram.com', newValue: ['not a handle'] })).toBe(null);
      expect(chrome.storage._store.domainLimits['reddit.com']).toEqual(SPENT);
    });
  });
});
