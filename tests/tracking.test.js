import { describe, it, expect } from 'vitest';
import { loadTracking, makeMockChrome, loadSource } from './load.js';

// Helper: load tracking with fresh empty storage.
function fresh(seed = {}) {
  return loadTracking({ seed });
}

describe('dateKey / daysAgoKeys', () => {
  it('dateKey formats YYYY-MM-DD with zero padding', () => {
    const { ctx } = fresh();
    expect(ctx.dateKey(new Date(2026, 0, 5))).toBe('2026-01-05');
    expect(ctx.dateKey(new Date(2026, 11, 31))).toBe('2026-12-31');
  });

  it('dateKey defaults to today', () => {
    const { ctx } = fresh();
    const now = new Date();
    const expected = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    expect(ctx.dateKey()).toBe(expected);
  });

  it('daysAgoKeys returns n descending consecutive day keys ending today', () => {
    const { ctx } = fresh();
    const keys = ctx.daysAgoKeys(7);
    expect(keys).toHaveLength(7);
    expect(keys[0]).toBe(ctx.dateKey()); // today first
    // each key is one day before the previous
    for (let i = 1; i < keys.length; i++) {
      const prev = new Date(keys[i - 1] + 'T00:00:00');
      const cur = new Date(keys[i] + 'T00:00:00');
      expect((prev - cur) / 86400000).toBe(1);
    }
    // all unique
    expect(new Set(keys).size).toBe(7);
  });
});

describe('recordGrant -> getStatsForDomain', () => {
  it('reflects grantsToday and reasonsToday', async () => {
    const { ctx } = fresh();
    await ctx.recordGrant('twitter.com', 10, 'check DMs');
    await ctx.recordGrant('twitter.com', 5, 'reply to friend');

    const stats = await ctx.getStatsForDomain('twitter.com');
    expect(stats.grantsToday).toBe(2);
    expect(stats.reasonsToday).toEqual(['check DMs', 'reply to friend']);
  });

  it('filters out blank reasons from reasonsToday', async () => {
    const { ctx } = fresh();
    await ctx.recordGrant('x.com', 10, '   ');
    await ctx.recordGrant('x.com', 10, 'real reason');
    const stats = await ctx.getStatsForDomain('x.com');
    expect(stats.grantsToday).toBe(2);
    expect(stats.reasonsToday).toEqual(['real reason']);
  });
});

describe('recordSessionMinutes', () => {
  it('accumulates minutesToday and minutesTodayAll', async () => {
    const { ctx } = fresh();
    await ctx.recordSessionMinutes('twitter.com', 7);
    await ctx.recordSessionMinutes('twitter.com', 3);
    await ctx.recordSessionMinutes('reddit.com', 5);

    const twitter = await ctx.getStatsForDomain('twitter.com');
    expect(twitter.minutesToday).toBe(10);
    expect(twitter.minutesTodayAll).toBe(15); // 10 twitter + 5 reddit

    const reddit = await ctx.getStatsForDomain('reddit.com');
    expect(reddit.minutesToday).toBe(5);
    expect(reddit.minutesTodayAll).toBe(15);
  });

  it('ignores zero / negative / missing domain', async () => {
    const { ctx } = fresh();
    await ctx.recordSessionMinutes('twitter.com', 0);
    await ctx.recordSessionMinutes('', 5);
    await ctx.recordSessionMinutes('twitter.com', -3);
    const stats = await ctx.getStatsForDomain('twitter.com');
    expect(stats.minutesToday).toBe(0);
  });

  it('maintains allTimeStats across sessions', async () => {
    const { ctx, chrome } = fresh();
    await ctx.recordSessionMinutes('twitter.com', 8);
    await ctx.recordSessionMinutes('twitter.com', 4);
    expect(chrome.storage._store.allTimeStats['twitter.com']).toBe(12);
    const stats = await ctx.getStatsForDomain('twitter.com');
    expect(stats.minutesAllTime).toBe(12);
  });
});

describe('aggregation across days and domains', () => {
  it('sums week/month/year correctly when seeded with prior days', async () => {
    // Build a seed using a tracking ctx to get correct day keys.
    const probe = loadSource('tracking.js', { chrome: makeMockChrome() });
    const keys = probe.daysAgoKeys(40); // 0..39 days ago
    const today = keys[0];
    const threeAgo = keys[3];
    const tenAgo = keys[10];
    const fortyAgo = keys[39];

    const dailyStats = {
      [today]: { 'twitter.com': { minutes: 10, grants: 1, sessions: [{ reason: 'a' }] } },
      [threeAgo]: { 'twitter.com': { minutes: 20, grants: 0, sessions: [] } },
      [tenAgo]: { 'twitter.com': { minutes: 30, grants: 0, sessions: [] } },
      [fortyAgo]: { 'twitter.com': { minutes: 40, grants: 0, sessions: [] } }
    };

    const { ctx } = fresh({ dailyStats });
    const stats = await ctx.getStatsForDomain('twitter.com');

    expect(stats.minutesToday).toBe(10);
    // week = today + 3-ago (both within last 7 days) = 30
    expect(stats.minutesWeek).toBe(30);
    // month = within last 30 days = today + 3 + 10 = 60
    expect(stats.minutesMonth).toBe(60);
    // year = all four = 100
    expect(stats.minutesYear).toBe(100);
    // allTime falls back to sum of daily when allTimeStats absent = 100
    expect(stats.minutesAllTime).toBe(100);
    // today's reason surfaced
    expect(stats.reasonsToday).toEqual(['a']);
  });

  it('getStatsSummary aggregates today across sites', async () => {
    const { ctx } = fresh();
    await ctx.recordSessionMinutes('twitter.com', 10);
    await ctx.recordSessionMinutes('reddit.com', 6);
    const summary = await ctx.getStatsSummary();
    expect(summary.minutesToday).toBe(16);
    expect(summary.perSiteToday['twitter.com']).toBe(10);
    expect(summary.perSiteToday['reddit.com']).toBe(6);
  });
});
