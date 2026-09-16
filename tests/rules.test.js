// rules.js — how a blocked target's rules are resolved, and the guard that
// keeps that answer in one place.
//
// This resolution used to be written out three times, in background.js,
// content.js and options.js. Each copy carried a comment saying "change one,
// change all three", none of them was tested, and they had drifted anyway.
// The copies are gone; these tests are what stops them coming back.
//
// Three things are checked here:
//   1. what the resolution actually answers (nobody tested this before);
//   2. that every context which resolves rules gets the same answer;
//   3. that no shared file has quietly re-grown its own copy.

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadSource, loadBackground, VARIANTS, REPO_ROOT } from './load.js';

let R;
beforeAll(() => {
  R = loadSource('rules.js');
});

// ---------------------------------------------------------------------------
// 1. What it answers
// ---------------------------------------------------------------------------

describe('the leaving cool-off', () => {
  it('offers exactly four rungs, off first and longest last', () => {
    expect(R.LEAVE_DELAY_CHOICES).toEqual([0, 60, 1440, 4320]);
  });

  it.each([
    [0, 0],
    [60, 60],
    [1440, 1440],
    [4320, 4320]
  ])('leaves the choice %i alone', (input, expected) => {
    expect(R.normalizeLeaveDelay(input)).toBe(expected);
  });

  // The direction is the entire point of the function, so it gets its own
  // test rather than a line in a table. Rounding to the NEAREST rung would let
  // a hand-edited or corrupted 900 become a 24-hour wait nobody agreed to —
  // this number stands between a person and the exit, and the only safe way
  // for it to be wrong is short.
  it.each([
    [1, 0, 'a minute'],
    [59, 0, 'just under an hour'],
    [61, 60, 'just over an hour'],
    [900, 60, 'most of a day'],
    [1439, 60, 'a minute under a day'],
    [4319, 1440, 'a minute under three days'],
    [99999, 4320, 'far beyond the longest choice']
  ])('snaps %i DOWN to %i (%s), never up', (input, expected) => {
    expect(R.normalizeLeaveDelay(input)).toBe(expected);
  });

  it.each([
    [undefined, 'never written'],
    [null, 'explicitly cleared'],
    ['', 'an emptied input'],
    ['soon', 'prose'],
    [NaN, 'a failed parse'],
    [Infinity, 'an overflow'],
    [-60, 'a negative'],
    [{}, 'an object']
  ])('reads %s (%s) as no delay at all', (input) => {
    expect(R.normalizeLeaveDelay(input)).toBe(0);
  });

  // A string is what a dataset attribute hands back, and the settings card
  // reads the choice straight off one.
  it('reads a numeric string the way the pill supplies it', () => {
    expect(R.normalizeLeaveDelay('1440')).toBe(1440);
  });

  it.each([
    [60, 'an hour'],
    [1440, '24 hours'],
    [4320, '3 days']
  ])('formats %i as "%s"', (input, expected) => {
    expect(R.formatLeaveDelay(input)).toBe(expected);
  });

  // Empty, not "no delay": every caller either has its own sentence for that
  // case or has nothing to say, and both want a falsy value to test.
  it.each([[0], [undefined], [null], ['nonsense'], [-5]])(
    'formats %s as the empty string, so a caller can test it', (input) => {
      expect(R.formatLeaveDelay(input)).toBe('');
    });

  // Formatting runs through the same snap, so a stored value that drifted off
  // the ladder still reads as a real duration rather than as nothing.
  it('formats an off-ladder value as the rung below it', () => {
    expect(R.formatLeaveDelay(2000)).toBe('24 hours');
  });
});

describe('limitEntryFor', () => {
  const stored = {
    domainLimits: { 'instagram.com': { maxGrants: 1 } },
    appLimits: { 'com.instagram.android': { maxGrants: 2 } }
  };

  it('finds a site by hostname and an app by package name', () => {
    expect(R.limitEntryFor('instagram.com', stored).maxGrants).toBe(1);
    expect(R.limitEntryFor('com.instagram.android', stored).maxGrants).toBe(2);
  });

  it('answers null for a target with no entry', () => {
    expect(R.limitEntryFor('example.com', stored)).toBe(null);
  });

  it.each([[''], [null], [undefined]])('answers null for %s as a target', (target) => {
    expect(R.limitEntryFor(target, stored)).toBe(null);
  });

  // The content script reads domainLimits and nothing else — it never sees
  // apps. A caller holding only one of the two maps must not throw.
  it('treats a missing map as empty, not as an error', () => {
    expect(R.limitEntryFor('instagram.com', { domainLimits: stored.domainLimits })).toBeTruthy();
    expect(R.limitEntryFor('instagram.com', {})).toBe(null);
    expect(R.limitEntryFor('instagram.com', null)).toBe(null);
  });
});

describe('resolveIntention', () => {
  it('answers the defaults for a target with no entry', () => {
    expect(R.resolveIntention(null)).toEqual({ opens: 3, minutesEach: 10 });
    expect(R.resolveIntention(undefined)).toEqual({ opens: 3, minutesEach: 10 });
  });

  it('reads the fields an entry carries', () => {
    expect(R.resolveIntention({ maxGrants: 2, passMinutes: 15 })).toEqual({ opens: 2, minutesEach: 15 });
  });

  // Zero opens is a hard block. It has to survive as zero — a corrupt or
  // missing value falls back to the default, but a real zero never does.
  it('keeps zero opens as a block rather than folding it to the default', () => {
    expect(R.resolveIntention({ maxGrants: 0 }).opens).toBe(0);
    expect(R.resolveIntention({ maxGrants: '0' }).opens).toBe(0);
  });

  it('falls back per field when a value is unreadable', () => {
    expect(R.resolveIntention({ maxGrants: 'lots', passMinutes: 15 })).toEqual({ opens: 3, minutesEach: 15 });
    expect(R.resolveIntention({ maxGrants: 2, passMinutes: 'long' })).toEqual({ opens: 2, minutesEach: 10 });
  });

  it('clamps opens into range', () => {
    expect(R.resolveIntention({ maxGrants: -4 }).opens).toBe(0);
    expect(R.resolveIntention({ maxGrants: 999 }).opens).toBe(R.MAX_OPENS);
    expect(R.resolveIntention({ maxGrants: 2.9 }).opens).toBe(2);
  });

  it('keeps individual whole minutes, rounds fractions down and clamps the range', () => {
    expect(R.resolveIntention({ passMinutes: 12 }).minutesEach).toBe(12);
    expect(R.resolveIntention({ passMinutes: 29.9 }).minutesEach).toBe(29);
    expect(R.resolveIntention({ passMinutes: 90 }).minutesEach).toBe(30);
    expect(R.resolveIntention({ passMinutes: 2 }).minutesEach).toBe(2);
    expect(R.resolveIntention({ passMinutes: 0.5 }).minutesEach).toBe(1);
  });

  it('ignores the fields of the retired model', () => {
    expect(R.resolveIntention({ maxMinutes: 45, looseUntilMinutes: 10, mode: 'simple', behavior: 'hard' }))
      .toEqual({ opens: 3, minutesEach: 10 });
  });
});

describe('isLoosening', () => {
  it('reads more opens or longer opens as loosening', () => {
    expect(R.isLoosening({ maxGrants: 2, passMinutes: 10 }, { maxGrants: 3, passMinutes: 10 })).toBe(true);
    expect(R.isLoosening({ maxGrants: 2, passMinutes: 10 }, { maxGrants: 2, passMinutes: 15 })).toBe(true);
  });

  it('reads fewer, shorter or the same as not loosening', () => {
    expect(R.isLoosening({ maxGrants: 2, passMinutes: 10 }, { maxGrants: 1, passMinutes: 10 })).toBe(false);
    expect(R.isLoosening({ maxGrants: 2, passMinutes: 10 }, { maxGrants: 2, passMinutes: 5 })).toBe(false);
    expect(R.isLoosening({ maxGrants: 2, passMinutes: 10 }, { maxGrants: 2, passMinutes: 10 })).toBe(false);
  });

  // A trade — one fewer open, but each one longer — still gives time back, so
  // it waits like any other loosening.
  it('reads a trade that lengthens either number as loosening', () => {
    expect(R.isLoosening({ maxGrants: 3, passMinutes: 10 }, { maxGrants: 2, passMinutes: 30 })).toBe(true);
  });

  it('compares a raw stored entry and an edited one like for like', () => {
    expect(R.isLoosening(null, { maxGrants: 3, passMinutes: 10 })).toBe(false);
    expect(R.isLoosening({ maxGrants: 0 }, { maxGrants: 1 })).toBe(true);
  });
});

describe('daily time intention', () => {
  it('resolves a daily allowance independently of visit count', () => {
    expect(R.resolveIntention({ intentionMode: 'dailyTime', dailyTimeMinutes: 60 }))
      .toEqual({ mode: 'dailyTime', dailyMinutes: 60, opens: 0, minutesEach: 0 });
    expect(R.resolveIntention({ intentionMode: 'dailyTime', dailyTimeMinutes: 77 }).dailyMinutes).toBe(77);
  });

  it('supports a one-minute budget, zero as blocked, and the daily upper bound', () => {
    const daily = minutes => R.resolveIntention({ intentionMode: 'dailyTime', dailyTimeMinutes: minutes }).dailyMinutes;
    expect(daily(1)).toBe(1);
    expect(daily(0)).toBe(0);
    expect(daily(47.8)).toBe(47);
    expect(daily(999)).toBe(240);
    expect(daily('invalid')).toBe(30);
  });

  it('defers increases and flexible switches that allow at least the old total', () => {
    const visits = { maxGrants: 3, passMinutes: 10 };
    const daily = { intentionMode: 'dailyTime', dailyTimeMinutes: 30 };
    expect(R.isLoosening(visits, daily)).toBe(true);
    expect(R.isLoosening(daily, { intentionMode: 'dailyTime', dailyTimeMinutes: 60 })).toBe(true);
    expect(R.isLoosening(daily, visits)).toBe(false);
    expect(R.isLoosening(visits, { intentionMode: 'dailyTime', dailyTimeMinutes: 15 })).toBe(false);
  });
});

describe('nextDayStart', () => {
  it('is local midnight at the start of the next day', () => {
    const at = new Date(2026, 8, 13, 23, 55).getTime();
    const next = new Date(R.nextDayStart(at));
    expect([next.getFullYear(), next.getMonth(), next.getDate(), next.getHours(), next.getMinutes()])
      .toEqual([2026, 8, 14, 0, 0]);
  });

  it('is still tomorrow, not today, from the first minute of a day', () => {
    const at = new Date(2026, 8, 13, 0, 0).getTime();
    expect(new Date(R.nextDayStart(at)).getDate()).toBe(14);
  });
});

// ---------------------------------------------------------------------------
// 2. Every context agrees
// ---------------------------------------------------------------------------
//
// The reason the old copies were dangerous was never one of them being wrong
// on its own — it was two of them disagreeing about the same site. So drive the
// real entry points over one matrix of inputs.

describe('every context resolves a target the same way', () => {
  const CASES = [
    { name: 'no entry', entry: undefined },
    { name: 'an intention set on the site', entry: { maxGrants: 2, passMinutes: 15 } },
    { name: 'a hard block', entry: { maxGrants: 0 } },
    { name: 'a custom minute duration', entry: { maxGrants: 4, passMinutes: 12 } }
  ];

  const DOMAIN = 'instagram.com';

  it.each(CASES)('$name', async ({ entry }) => {
    const seed = { domainLimits: entry ? { [DOMAIN]: entry } : {} };
    const { ctx: bg } = loadBackground({ seed });
    const fromBackground = await bg.getIntention(DOMAIN);
    const fromRules = R.resolveIntention(R.limitEntryFor(DOMAIN, seed));
    expect({ opens: fromBackground.opens, minutesEach: fromBackground.minutesEach }).toEqual(fromRules);
  });

  it('agrees on an app package too', async () => {
    const seed = { appLimits: { 'com.instagram.android': { maxGrants: 1, passMinutes: 5 } } };
    const { ctx: bg } = loadBackground({ seed });
    const fromBackground = await bg.getIntention('com.instagram.android');
    expect({ opens: fromBackground.opens, minutesEach: fromBackground.minutesEach })
      .toEqual(R.resolveIntention(R.limitEntryFor('com.instagram.android', seed)));
  });
});

// ---------------------------------------------------------------------------
// 3. No copy has come back
// ---------------------------------------------------------------------------
//
// The tests above only compare the callers that exist today. This is what
// catches the next well-meaning paste — the one that adds a fourth context, or
// re-inlines the normalisation "just here" because importing felt awkward.

describe('the resolution lives in exactly one file', () => {
  const SHARED = join(REPO_ROOT, 'shared');
  const sources = readdirSync(SHARED)
    .filter(f => f.endsWith('.js'))
    .map(f => ({ file: f, code: readFileSync(join(SHARED, f), 'utf8') }));

  it('reads the shared sources at all (guards this test against a move)', () => {
    expect(sources.length).toBeGreaterThan(5);
    expect(sources.some(s => s.file === 'rules.js')).toBe(true);
  });

  it.each([
    'limitEntryFor',
    'resolveIntention',
    'isLoosening',
    'nextDayStart'
  ])('%s is declared only in rules.js', (name) => {
    const declaration = new RegExp(`^\\s*(?:const|let|var|function|async function)\\s+${name}\\b`, 'm');
    const declaring = sources.filter(s => declaration.test(s.code)).map(s => s.file);
    expect(declaring).toEqual(['rules.js']);
  });

  // The retired model must not come back under its old names.
  it.each([
    'resolveMode',
    'resolveBlockConfig',
    'resolveLimits',
    'normalizeLooseUntil',
    'getEffectiveMode',
    'simpleGrant'
  ])('%s is declared nowhere', (name) => {
    const declaration = new RegExp(`^\\s*(?:const|let|var|function|async function)\\s+${name}\\b`, 'm');
    expect(sources.filter(s => declaration.test(s.code)).map(s => s.file)).toEqual([]);
  });

  // Every context that can gate a page has to be able to reach the resolution.
  // A file loaded into one of them but not the others is how the copies got
  // written in the first place.
  it('is loaded into every context that resolves a target', () => {
    const manifest = JSON.parse(readFileSync(join(VARIANTS.chrome, 'manifest.json'), 'utf8'));
    const firefox = JSON.parse(readFileSync(join(VARIANTS.firefox, 'manifest.json'), 'utf8'));
    const optionsHtml = readFileSync(join(VARIANTS.chrome, 'options.html'), 'utf8');

    expect(manifest.content_scripts[0].js).toContain('rules.js');
    expect(firefox.background.scripts).toContain('rules.js');
    expect(optionsHtml).toContain('src="rules.js"');
    // Chrome's worker pulls its own dependencies in rather than listing them.
    expect(readFileSync(join(VARIANTS.chrome, 'background.js'), 'utf8'))
      .toMatch(/importScripts\([^)]*'rules\.js'/);
  });

  // rules.js runs in a content script, on every page the user visits. It must
  // stay a pure function of its arguments — the moment it reads storage it
  // stops being usable from the one context that has to answer without it.
  it('reads no storage and touches no chrome API', () => {
    const code = readFileSync(join(VARIANTS.chrome, 'rules.js'), 'utf8')
      .replace(/\/\/[^\n]*/g, '');
    expect(code).not.toMatch(/\bchrome\b/);
    expect(code).not.toMatch(/\bbrowser\b/);
    expect(code).not.toMatch(/\bawait\b|\bfetch\b|\bPromise\b/);
  });
});
