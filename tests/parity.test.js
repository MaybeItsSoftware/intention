// Parity / sync guard: load prompts.js AND tracking.js from ALL THREE variant
// directories and assert identical behavior on identical inputs. This doubles
// as a guard that the byte-identical shared sources stay in sync (the same
// invariant build.sh and ci.yml enforce by diff).

import { describe, it, expect } from 'vitest';
import { loadSource, loadTracking, VARIANTS } from './load.js';

const VARIANT_KEYS = ['chrome', 'firefox', 'apple'];

describe('variant directories exist', () => {
  it('all three resolve', () => {
    for (const k of VARIANT_KEYS) expect(VARIANTS[k]).toBeTruthy();
  });
});

describe('prompts.js parity across variants', () => {
  const gateArgs = {
    domain: 'twitter.com',
    contextProjects: 'Write the report',
    contextReasons: 'I get scattered',
    coachInstructions: 'Usage: {{usage}}\nQ: {{questions}}\nReasons: {{reasons_today}}\nUnknown: {{nope}}',
    grantsToday: 2, grantsCap: 3, minutesCap: 30,
    minutesTodaySite: 18, minutesTodayAll: 50, minutesWeekAll: 300,
    reasonsToday: ['check DMs', 'reply']
  };

  const settingsArgs = {
    domain: 'reddit.com', changeType: 'increase_limit',
    currentValue: 30, newValue: 60,
    coachInstructions: 'S: {{usage}}',
    minutesTodaySite: 5, minutesTodayAll: 9, minutesWeekAll: 60, reasonsToday: []
  };

  it('buildGateSystemPrompt is identical across variants', () => {
    const outputs = VARIANT_KEYS.map(v => {
      const ctx = loadSource('prompts.js', { variant: v });
      return ctx.buildGateSystemPrompt(gateArgs);
    });
    // strip the volatile {{time}}/{{day}} substitutions are absent here since
    // the test instructions don't use them, so outputs should match exactly.
    expect(outputs[1]).toBe(outputs[0]);
    expect(outputs[2]).toBe(outputs[0]);
  });

  it('buildSettingsGateSystemPrompt is identical across variants', () => {
    const outputs = VARIANT_KEYS.map(v => {
      const ctx = loadSource('prompts.js', { variant: v });
      return ctx.buildSettingsGateSystemPrompt(settingsArgs);
    });
    expect(outputs[1]).toBe(outputs[0]);
    expect(outputs[2]).toBe(outputs[0]);
  });

  it('composeSystemPrompt unknown-placeholder stripping is identical', () => {
    const outputs = VARIANT_KEYS.map(v => {
      const ctx = loadSource('prompts.js', { variant: v });
      return ctx.composeSystemPrompt('A {{missing}} B', { questions: 'q', usage: 'u' });
    });
    expect(outputs[1]).toBe(outputs[0]);
    expect(outputs[2]).toBe(outputs[0]);
    expect(outputs[0]).not.toMatch(/\{\{/);
  });

  it('DEFAULT_COACH_INSTRUCTIONS and tool schemas are identical', () => {
    const ctxs = VARIANT_KEYS.map(v => loadSource('prompts.js', { variant: v }));
    expect(ctxs[1].DEFAULT_COACH_INSTRUCTIONS).toBe(ctxs[0].DEFAULT_COACH_INSTRUCTIONS);
    expect(ctxs[2].DEFAULT_COACH_INSTRUCTIONS).toBe(ctxs[0].DEFAULT_COACH_INSTRUCTIONS);
    expect(JSON.stringify(ctxs[1].GRANT_TOOL)).toBe(JSON.stringify(ctxs[0].GRANT_TOOL));
    expect(JSON.stringify(ctxs[2].APPROVE_CHANGE_TOOL)).toBe(JSON.stringify(ctxs[0].APPROVE_CHANGE_TOOL));
  });
});

describe('tracking.js parity across variants', () => {
  const seedToday = (ctx) => ({
    dailyStats: {
      [ctx.dateKey()]: {
        'twitter.com': { minutes: 25, grants: 2, sessions: [{ reason: 'r1' }, { reason: 'r2' }] }
      }
    }
  });

  it('getStatsForDomain returns identical results across variants', async () => {
    const results = [];
    for (const v of VARIANT_KEYS) {
      // build a seed using that variant's own dateKey
      const probe = loadSource('tracking.js', { variant: v });
      const { ctx } = loadTracking({ variant: v, seed: seedToday(probe) });
      results.push(await ctx.getStatsForDomain('twitter.com'));
    }
    expect(results[1]).toEqual(results[0]);
    expect(results[2]).toEqual(results[0]);
    expect(results[0].minutesToday).toBe(25);
    expect(results[0].grantsToday).toBe(2);
    expect(results[0].reasonsToday).toEqual(['r1', 'r2']);
  });

  it('dateKey + daysAgoKeys identical across variants', () => {
    const ctxs = VARIANT_KEYS.map(v => loadSource('tracking.js', { variant: v }));
    const d = new Date(2026, 5, 23);
    expect(ctxs[1].dateKey(d)).toBe(ctxs[0].dateKey(d));
    expect(ctxs[2].dateKey(d)).toBe(ctxs[0].dateKey(d));
    expect(ctxs[1].daysAgoKeys(5)).toEqual(ctxs[0].daysAgoKeys(5));
    expect(ctxs[2].daysAgoKeys(5)).toEqual(ctxs[0].daysAgoKeys(5));
  });

  it('recordGrant + getStatsForDomain identical across variants', async () => {
    const results = [];
    for (const v of VARIANT_KEYS) {
      const { ctx } = loadTracking({ variant: v });
      await ctx.recordGrant('x.com', 10, 'focus task');
      await ctx.recordSessionMinutes('x.com', 12);
      results.push(await ctx.getStatsForDomain('x.com'));
    }
    expect(results[1]).toEqual(results[0]);
    expect(results[2]).toEqual(results[0]);
  });
});
