// Parity / sync guard: load prompts.js AND tracking.js from ALL THREE variant
// directories and assert identical behavior on identical inputs. This doubles
// as a guard that the byte-identical shared sources stay in sync (the same
// invariant build.sh and ci.yml enforce by diff).

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadSource, loadTracking, VARIANTS, REPO_ROOT } from './load.js';

const VARIANT_KEYS = ['chrome', 'firefox', 'apple'];

describe('variant directories exist', () => {
  it('all three resolve', () => {
    for (const k of VARIANT_KEYS) expect(VARIANTS[k]).toBeTruthy();
  });
});

// The Apple overlay once replaced the whole permissions array to add one
// entry, so a permission added to the base silently never reached Safari.
// Overlays now append with "permissions+"; this guards the outcome whatever
// the overlays do.
describe('generated manifests carry every base permission', () => {
  const basePermissions = JSON.parse(
    readFileSync(join(REPO_ROOT, 'shared', 'manifest.base.json'), 'utf8')
  ).permissions;

  it.each(VARIANT_KEYS)('%s manifest includes them all', (variant) => {
    const manifest = JSON.parse(
      readFileSync(join(VARIANTS[variant], 'manifest.json'), 'utf8')
    );
    for (const p of basePermissions) {
      expect(manifest.permissions, `${variant} is missing "${p}"`).toContain(p);
    }
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
    reasonsToday: ['check DMs', 'reply'],
    // Fixed timestamps so the rendered clocks are identical across variants;
    // exercises the outcome lines, "back Nm later", the escalation and trust
    // computations, the walk-away line and the observations block.
    sessionsToday: [
      { reason: 'check DMs', grantedMinutes: 10, usedMinutes: 4, outcome: 'closed_early', grantedAt: 1755244800000, endedAt: 1755245100000 },
      { reason: 'reply', grantedMinutes: 5, usedMinutes: 5, outcome: 'ran_out', grantedAt: 1755245400000 }
    ],
    recentDays: [
      { date: '2026-08-11', minutes: 45, grants: 3, reasons: ['just checking'], outcomes: { ran_out: 2, closed_early: 1 }, walkedAway: 1 },
      { date: '2026-08-10', minutes: 20, grants: 3, reasons: ['just checking'] },
      { date: '2026-08-09', minutes: 15, grants: 4, reasons: ['just checking'] }
    ],
    walkedAwayToday: 1,
    walkedAwayWeek: 4,
    observations: [
      { text: 'They tend to reach for Twitter mid-afternoon.', domain: 'twitter.com', at: 1754838000000 }
    ]
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
      await ctx.recordSessionMinutes('x.com', 12, 'closed_early');
      await ctx.recordGrant('x.com', 3, 'grab an address', { quickCheck: true });
      results.push(await ctx.getStatsForDomain('x.com'));
    }
    // Each variant records its own grant a moment after the last, so the
    // wall-clock stamps on today's sessions differ by a millisecond or two.
    // That is the loop, not a parity difference — normalise it away and
    // assert the stamps merely exist.
    const normalise = (stats) => ({
      ...stats,
      sessionsToday: stats.sessionsToday.map(s => ({ ...s, grantedAt: typeof s.grantedAt, endedAt: typeof s.endedAt }))
    });
    expect(normalise(results[1])).toEqual(normalise(results[0]));
    expect(normalise(results[2])).toEqual(normalise(results[0]));
    expect(results[0].sessionsToday[0]).toMatchObject({
      reason: 'focus task', grantedMinutes: 10, usedMinutes: 12, outcome: 'closed_early'
    });
    expect(results[0].grantsToday).toBe(1);
    expect(results[0].quickChecksToday).toBe(1);
    expect(results[0].sessionsToday[1]).toMatchObject({ reason: 'grab an address', quickCheck: true });
  });
});

// content.css is ALSO embedded in content.js as the OVERLAY_CSS template
// string, because the overlay has to style itself on pages whose CSP or
// stylesheet timing can't be relied on. Two copies of the same rules, with
// nothing keeping them honest: scripts/sync.sh copies whole files between
// platforms, but it cannot see a rule edited in one copy and not the other.
//
// The overlay is deliberately a superset (it carries a few rules the injected
// stylesheet has no need for), so the contract is one-way: everything in
// content.css must appear in OVERLAY_CSS, saying the same thing.
describe('the overlay CSS copy does not drift from content.css', () => {
  // Splits a stylesheet into selector -> declarations, flattening one level of
  // at-rule nesting (@keyframes is the only one either copy uses).
  function parseRules(css) {
    const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const rules = new Map();
    const atRule = /(@[\w-]+[^{]*)\{((?:[^{}]*\{[^{}]*\})*[^{}]*)\}/g;
    let remainder = stripped;
    let match;
    while ((match = atRule.exec(stripped)) !== null) {
      const prefix = match[1].trim().replace(/\s+/g, ' ');
      for (const [selector, body] of parseRules(match[2])) {
        rules.set(`${prefix} { ${selector}`, body);
      }
      remainder = remainder.replace(match[0], '');
    }
    const flat = /([^{}]+)\{([^{}]*)\}/g;
    while ((match = flat.exec(remainder)) !== null) {
      const selector = match[1].trim().replace(/\s+/g, ' ');
      const body = match[2]
        .split(';')
        .map(d => d.trim().replace(/\s+/g, ' '))
        .filter(Boolean)
        .sort()
        .join('; ');
      if (selector) rules.set(selector, body);
    }
    return rules;
  }

  const contentCss = parseRules(readFileSync(join(VARIANTS.chrome, 'content.css'), 'utf8'));
  const overlayCss = parseRules(
    /const OVERLAY_CSS = `([\s\S]*?)`;/.exec(
      readFileSync(join(VARIANTS.chrome, 'content.js'), 'utf8')
    )[1]
  );

  it('parses both copies (guards the test itself against a rewrite)', () => {
    expect(contentCss.size).toBeGreaterThan(20);
    expect(overlayCss.size).toBeGreaterThanOrEqual(contentCss.size);
    // Nested at-rules survive the flattening rather than being dropped, which
    // would quietly exempt every rule inside them.
    expect([...contentCss.keys()].some(k => k.startsWith('@keyframes'))).toBe(true);
  });

  // A drift check that passes on identical files proves nothing unless it can
  // fail. Both real failure modes, against synthetic input.
  it('would actually catch drift', () => {
    const base = '.int-btn { color: red; padding: 2px }\n@keyframes k { to { opacity: 1 } }';
    const edited = parseRules('.int-btn { color: blue; padding: 2px }\n@keyframes k { to { opacity: 1 } }');
    const dropped = parseRules('@keyframes k { to { opacity: 1 } }');
    const original = parseRules(base);

    expect(edited.get('.int-btn')).not.toBe(original.get('.int-btn'));
    expect(dropped.has('.int-btn')).toBe(false);
    expect(original.get('@keyframes k { to')).toBe('opacity: 1');
  });

  it('has every content.css rule in OVERLAY_CSS', () => {
    const missing = [...contentCss.keys()].filter(selector => !overlayCss.has(selector));
    expect(missing).toEqual([]);
  });

  it('gives those rules the same declarations in both copies', () => {
    const diverged = [...contentCss.entries()]
      .filter(([selector, body]) => overlayCss.has(selector) && overlayCss.get(selector) !== body)
      .map(([selector, body]) => `${selector}\n  content.css: ${body}\n  OVERLAY_CSS: ${overlayCss.get(selector)}`);
    expect(diverged).toEqual([]);
  });
});
