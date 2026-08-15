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

// Minutes alone cannot tell "asked for 10, left after 4" from "asked for 10
// and had to be interrupted at 10" — and that is the only real evidence for
// how many minutes the next grant deserves.
describe('session outcomes', () => {
  it('stamps the outcome onto the grant that opened the session', async () => {
    const { ctx } = fresh();
    await ctx.recordGrant('twitter.com', 10, 'check DMs');
    await ctx.recordSessionMinutes('twitter.com', 4, 'closed_early');

    const [session] = (await ctx.getStatsForDomain('twitter.com')).sessionsToday;
    expect(session.outcome).toBe('closed_early');
    expect(session.usedMinutes).toBe(4);
    expect(session.grantedMinutes).toBe(10);
  });

  it('stamps each grant separately, oldest open one first', async () => {
    const { ctx } = fresh();
    await ctx.recordGrant('twitter.com', 10, 'first');
    await ctx.recordSessionMinutes('twitter.com', 10, 'ran_out');
    await ctx.recordGrant('twitter.com', 5, 'second');
    await ctx.recordSessionMinutes('twitter.com', 2, 'closed_early');

    const sessions = (await ctx.getStatsForDomain('twitter.com')).sessionsToday;
    expect(sessions.map(s => [s.reason, s.outcome])).toEqual([
      ['first', 'ran_out'],
      ['second', 'closed_early']
    ]);
  });

  it('leaves a still-running session unstamped', async () => {
    const { ctx } = fresh();
    await ctx.recordGrant('twitter.com', 10, 'in progress');
    const [session] = (await ctx.getStatsForDomain('twitter.com')).sessionsToday;
    expect(session.outcome).toBeNull();
    expect(session.usedMinutes).toBeNull();
  });

  it('records an outcome even when the pass earned no minutes at all', async () => {
    const { ctx } = fresh();
    await ctx.recordGrant('twitter.com', 10, 'check DMs');
    await ctx.recordSessionMinutes('twitter.com', 0, 'closed_early');

    const stats = await ctx.getStatsForDomain('twitter.com');
    expect(stats.minutesToday).toBe(0);
    expect(stats.sessionsToday[0].outcome).toBe('closed_early');
  });

  it('banks minutes as before when no outcome is given', async () => {
    const { ctx } = fresh();
    await ctx.recordGrant('twitter.com', 10, 'check DMs');
    await ctx.recordSessionMinutes('twitter.com', 6);
    const stats = await ctx.getStatsForDomain('twitter.com');
    expect(stats.minutesToday).toBe(6);
    expect(stats.sessionsToday[0].outcome).toBeNull();
  });
});

// A pattern is only visible across days. The coach used to see today and
// nothing else, so "fourth evening running" was unsayable.
describe('recentDays', () => {
  const dayKey = (ctx, back) => ctx.daysAgoKeys(back + 1)[back];

  it('reports earlier days for this site, most recent first, excluding today', async () => {
    const probe = loadSource('tracking.js');
    const seed = {
      dailyStats: {
        [dayKey(probe, 0)]: { 'reddit.com': { minutes: 5, grants: 1, sessions: [{ reason: 'today' }] } },
        [dayKey(probe, 1)]: { 'reddit.com': { minutes: 30, grants: 2, sessions: [{ reason: 'yesterday' }] } },
        [dayKey(probe, 3)]: { 'reddit.com': { minutes: 12, grants: 1, sessions: [{ reason: 'three days ago' }] } }
      }
    };
    const { ctx } = loadTracking({ seed });
    const { recentDays } = await ctx.getStatsForDomain('reddit.com');

    expect(recentDays.map(d => d.date)).toEqual([dayKey(ctx, 1), dayKey(ctx, 3)]);
    expect(recentDays[0]).toMatchObject({ minutes: 30, grants: 2, reasons: ['yesterday'] });
  });

  it('ignores other domains and days beyond the week', async () => {
    const probe = loadSource('tracking.js');
    const seed = {
      dailyStats: {
        [dayKey(probe, 1)]: { 'twitter.com': { minutes: 10, grants: 1, sessions: [] } },
        [dayKey(probe, 20)]: { 'reddit.com': { minutes: 90, grants: 5, sessions: [] } }
      }
    };
    const { ctx } = loadTracking({ seed });
    expect((await ctx.getStatsForDomain('reddit.com')).recentDays).toEqual([]);
  });

  it('tallies how each earlier day\'s passes ended', async () => {
    const probe = loadSource('tracking.js');
    const seed = {
      dailyStats: {
        [dayKey(probe, 1)]: {
          'reddit.com': {
            minutes: 30, grants: 3,
            sessions: [
              { reason: 'a', outcome: 'ran_out' },
              { reason: 'b', outcome: 'ran_out' },
              { reason: 'c', outcome: 'closed_early' },
              { reason: 'd' } // never stamped — not a completed pass
            ]
          }
        }
      }
    };
    const { ctx } = loadTracking({ seed });
    const { recentDays } = await ctx.getStatsForDomain('reddit.com');
    expect(recentDays[0].outcomes).toEqual({ ran_out: 2, closed_early: 1 });
    expect(recentDays[0].walkedAway).toBe(0);
  });
});

// Walking away from the gate is the habit the whole tool exists to build, and
// until now it left no record at all: gated 12 times / granted 0 looked the
// same as never having visited.
describe('recordWalkAway', () => {
  it('creates the domain entry and counts, touching nothing else', async () => {
    const { ctx } = fresh();
    await ctx.recordWalkAway('twitter.com');
    await ctx.recordWalkAway('twitter.com');
    const stats = await ctx.getStatsForDomain('twitter.com');
    expect(stats.walkedAwayToday).toBe(2);
    expect(stats.minutesToday).toBe(0);
    expect(stats.grantsToday).toBe(0);
    expect(stats.sessionsToday).toEqual([]);
  });

  it('increments alongside an existing record without disturbing it', async () => {
    const { ctx } = fresh();
    await ctx.recordGrant('twitter.com', 10, 'check DMs');
    await ctx.recordSessionMinutes('twitter.com', 4, 'closed_early');
    await ctx.recordWalkAway('twitter.com');
    const stats = await ctx.getStatsForDomain('twitter.com');
    expect(stats.walkedAwayToday).toBe(1);
    expect(stats.grantsToday).toBe(1);
    expect(stats.minutesToday).toBe(4);
    expect(stats.reasonsToday).toEqual(['check DMs']);
    expect(stats.sessionsToday[0].outcome).toBe('closed_early');
  });

  it('ignores a missing domain', async () => {
    const { ctx, chrome } = fresh();
    await ctx.recordWalkAway('');
    expect(chrome.storage._store.dailyStats).toBeUndefined();
  });

  it('sums the week including today and excludes days beyond it', async () => {
    const probe = loadSource('tracking.js');
    const dayKey = (back) => probe.daysAgoKeys(back + 1)[back];
    const seed = {
      dailyStats: {
        [dayKey(0)]: { 'reddit.com': { minutes: 0, grants: 0, sessions: [], walkedAway: 1 } },
        [dayKey(3)]: { 'reddit.com': { minutes: 5, grants: 1, sessions: [], walkedAway: 2 } },
        [dayKey(20)]: { 'reddit.com': { minutes: 5, grants: 1, sessions: [], walkedAway: 9 } }
      }
    };
    const { ctx } = loadTracking({ seed });
    const stats = await ctx.getStatsForDomain('reddit.com');
    expect(stats.walkedAwayToday).toBe(1);
    expect(stats.walkedAwayWeek).toBe(3); // today's 1 + three-days-ago's 2
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
