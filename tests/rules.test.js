// rules.js — how a blocked target's rules are resolved, and the guard that
// keeps that answer in one place.
//
// This resolution used to be written out three times: getEffectiveMode() and
// normalizeLooseUntil() in background.js, effectiveModeFromStorage() in
// content.js, and effectiveModeFor()/looseUntilFor() in options.js. Each copy
// carried a comment saying "change one, change all three", none of them was
// tested, and they had drifted anyway. The copies are gone; these tests are
// what stops them coming back.
//
// Three things are checked here:
//   1. what the resolution actually answers (nobody tested this before);
//   2. that every context which resolves rules gets the same answer;
//   3. that no shared file has quietly re-grown its own copy.

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadSource, loadBackground, bundleForContext, VARIANTS, REPO_ROOT } from './load.js';

let R;
beforeAll(() => {
  R = loadSource('rules.js');
});

// ---------------------------------------------------------------------------
// 1. What it answers
// ---------------------------------------------------------------------------

describe('normalizeLooseUntil', () => {
  // Absent is a real answer — "no loose/strict split at all" — and the whole
  // reason this isn't a bare Number(): Number(null) is 0, and 0 would read as
  // "strict from the very first minute", the exact opposite of unset.
  it.each([
    [undefined, 'never written'],
    [null, 'explicitly cleared'],
    ['', 'an emptied input field']
  ])('reads %s (%s) as no split, not as zero', (input) => {
    expect(R.normalizeLooseUntil(input)).toBe(null);
  });

  it('keeps a real zero, which means strict immediately', () => {
    expect(R.normalizeLooseUntil(0)).toBe(0);
    expect(R.normalizeLooseUntil('0')).toBe(0);
  });

  it('accepts the string an <input type=number> actually hands over', () => {
    expect(R.normalizeLooseUntil('15')).toBe(15);
  });

  it('rounds, because minutes are whole', () => {
    expect(R.normalizeLooseUntil(15.4)).toBe(15);
    expect(R.normalizeLooseUntil(15.6)).toBe(16);
  });

  it.each([
    [-1, 'negative'],
    [NaN, 'NaN'],
    [Infinity, 'infinite'],
    ['abc', 'unparseable'],
    [{}, 'an object']
  ])('rejects %s (%s) rather than inventing a number', (input) => {
    expect(R.normalizeLooseUntil(input)).toBe(null);
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

describe('resolveBlockConfig', () => {
  it('falls back to the global settings when the target has no override', () => {
    expect(R.resolveBlockConfig(null, {
      blockingMode: 'simple', simpleBehavior: 'hard', simplePassMinutes: 25
    })).toEqual({
      mode: 'simple', behavior: 'hard', passMinutes: 25, looseUntilMinutes: null
    });
  });

  it('falls back to the built-in defaults when there are no globals either', () => {
    expect(R.resolveBlockConfig(null, {})).toEqual({
      mode: 'coach', behavior: 'pass', passMinutes: 10, looseUntilMinutes: null
    });
  });

  it('lets a per-target override win over the global', () => {
    expect(R.resolveBlockConfig(
      { mode: 'simple', behavior: 'hard', passMinutes: 5 },
      { blockingMode: 'coach', simpleBehavior: 'pass', simplePassMinutes: 30 }
    )).toEqual({ mode: 'simple', behavior: 'hard', passMinutes: 5, looseUntilMinutes: null });
  });

  it('overrides field by field — one set field does not blank the others', () => {
    expect(R.resolveBlockConfig(
      { passMinutes: 5 },
      { blockingMode: 'simple', simpleBehavior: 'hard', simplePassMinutes: 30 }
    )).toEqual({ mode: 'simple', behavior: 'hard', passMinutes: 5, looseUntilMinutes: null });
  });

  it.each([
    [0, 'zero'],
    [-5, 'negative'],
    ['', 'blank']
  ])('ignores %s (%s) pass minutes and takes the global instead', (bad) => {
    expect(R.resolveBlockConfig({ passMinutes: bad }, { simplePassMinutes: 30 }).passMinutes).toBe(30);
  });

  it('carries looseUntilMinutes through, normalised', () => {
    expect(R.resolveBlockConfig({ looseUntilMinutes: '20' }, {}).looseUntilMinutes).toBe(20);
    expect(R.resolveBlockConfig({ looseUntilMinutes: null }, {}).looseUntilMinutes).toBe(null);
  });

  // There is no global lenient window: it is a per-site line, or it is nothing.
  it('never takes a lenient window from the globals', () => {
    expect(R.resolveBlockConfig(null, { looseUntilMinutes: 20 }).looseUntilMinutes).toBe(null);
  });
});

describe('resolveLimits', () => {
  it('answers the defaults for a target with no entry', () => {
    expect(R.resolveLimits(null)).toEqual({ maxGrants: 3, maxMinutes: -1, looseUntilMinutes: null });
  });

  it('reads the fields an entry does carry', () => {
    expect(R.resolveLimits({ maxGrants: 1, maxMinutes: 20, looseUntilMinutes: 5 }))
      .toEqual({ maxGrants: 1, maxMinutes: 20, looseUntilMinutes: 5 });
  });

  // -1 is "no daily ceiling", which is emphatically not 0.
  it('keeps -1 maxMinutes as no ceiling rather than folding it to zero', () => {
    expect(R.resolveLimits({ maxMinutes: -1 }).maxMinutes).toBe(-1);
    expect(R.resolveLimits({ maxMinutes: 0 }).maxMinutes).toBe(0);
  });

  it('falls back per field when a value is unreadable', () => {
    expect(R.resolveLimits({ maxGrants: 'abc', maxMinutes: 20 }))
      .toEqual({ maxGrants: 3, maxMinutes: 20, looseUntilMinutes: null });
  });

  it('does not hand back the shared defaults object to be mutated', () => {
    const first = R.resolveLimits(null);
    first.maxGrants = 99;
    expect(R.resolveLimits(null).maxGrants).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// 2. Every context agrees
// ---------------------------------------------------------------------------
//
// The reason the three copies were dangerous was never one of them being wrong
// on its own — it was two of them disagreeing about the same site. So drive the
// real entry points, in the real contexts, over one matrix of inputs.

describe('every context resolves a target the same way', () => {
  const CASES = [
    {
      name: 'no override anywhere',
      globals: { blockingMode: 'coach', simpleBehavior: 'pass', simplePassMinutes: 10 },
      entry: undefined
    },
    {
      name: 'a per-site simple-mode override',
      globals: { blockingMode: 'coach', simpleBehavior: 'pass', simplePassMinutes: 10 },
      entry: { mode: 'simple', behavior: 'hard', passMinutes: 5 }
    },
    {
      name: 'a global simple mode with no per-site entry',
      globals: { blockingMode: 'simple', simpleBehavior: 'hard', simplePassMinutes: 25 },
      entry: undefined
    },
    {
      name: 'a lenient window set on the site',
      globals: { blockingMode: 'coach', simpleBehavior: 'pass', simplePassMinutes: 10 },
      entry: { looseUntilMinutes: '20' }
    },
    {
      name: 'a lenient window explicitly cleared',
      globals: { blockingMode: 'coach', simpleBehavior: 'pass', simplePassMinutes: 10 },
      entry: { looseUntilMinutes: '' }
    },
    {
      name: 'a zero lenient window (strict immediately)',
      globals: { blockingMode: 'coach', simpleBehavior: 'pass', simplePassMinutes: 10 },
      entry: { looseUntilMinutes: 0 }
    }
  ];

  const DOMAIN = 'instagram.com';

  // The options page: given a limits entry it is already rendering a row for.
  let optionsCtx;
  beforeAll(() => {
    optionsCtx = loadSource(join(VARIANTS.chrome, '__options_bundle__.js'), {
      source: bundleForContext('options', {
        only: ['sites.js', 'providers.js', 'rules.js', 'options.js']
      }),
      extraGlobals: {
        document: { addEventListener() {}, getElementById: () => null },
        window: {},
        navigator: { userAgent: 'Chrome/120' },
        localStorage: { getItem: () => null, setItem() {}, removeItem() {} }
      }
    });
  });

  it.each(CASES)('$name', async ({ globals, entry }) => {
    const seed = {
      ...globals,
      domainLimits: entry ? { [DOMAIN]: entry } : {}
    };

    // The background worker, through its storage-reading wrapper.
    const { ctx: bg } = loadBackground({ seed });
    const fromBackground = await bg.getEffectiveMode(DOMAIN);

    // rules.js on its own, which is what the content script's fail-safe runs.
    const fromRules = R.resolveBlockConfig(R.limitEntryFor(DOMAIN, seed), seed);

    // The options page, through the two aliases its row builders call.
    const fromOptions = {
      mode: optionsCtx.effectiveModeFor(entry, globals.blockingMode),
      looseUntilMinutes: optionsCtx.looseUntilFor(entry)
    };

    expect(fromRules).toEqual(fromBackground);
    expect(fromOptions.mode).toBe(fromBackground.mode);
    expect(fromOptions.looseUntilMinutes).toBe(fromBackground.looseUntilMinutes);
  });

  it('agrees on an app package too, which only the background and options see', async () => {
    const seed = {
      blockingMode: 'coach',
      appLimits: { 'com.instagram.android': { mode: 'simple', looseUntilMinutes: 12 } }
    };
    const { ctx: bg } = loadBackground({ seed });
    expect(R.resolveBlockConfig(R.limitEntryFor('com.instagram.android', seed), seed))
      .toEqual(await bg.getEffectiveMode('com.instagram.android'));
  });

  it('agrees on the daily limits, not just the mode', async () => {
    const seed = { domainLimits: { [DOMAIN]: { maxGrants: 1, maxMinutes: 20, looseUntilMinutes: '5' } } };
    const { ctx: bg } = loadBackground({ seed });
    expect(R.resolveLimits(R.limitEntryFor(DOMAIN, seed)))
      .toEqual(await bg.getLimitsForDomain(DOMAIN));
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
    'normalizeLooseUntil',
    'limitEntryFor',
    'resolveMode',
    'resolveBlockConfig',
    'resolveLimits'
  ])('%s is declared only in rules.js', (name) => {
    const declaration = new RegExp(`^\\s*(?:const|let|var|function|async function)\\s+${name}\\b`, 'm');
    const declaring = sources.filter(s => declaration.test(s.code)).map(s => s.file);
    expect(declaring).toEqual(['rules.js']);
  });

  // A re-inlined copy would not reuse the names above, so name the two moves
  // that give one away instead. Both are what the original mirrors did.

  // Deciding the field is absent. This is the whole trap: `Number(null)` is 0,
  // and 0 means "strict from the first minute" — so whether a value counts as
  // absent has to be settled in exactly one place. All four original copies
  // wrote the same fingerprint: one expression ruling out undefined, null and
  // the empty string together. Nothing else in the tree does that.
  const ABSENT_TRIAD = /===\s*undefined[\s\S]{0,120}===\s*null[\s\S]{0,120}===\s*(?:''|"")/;

  it('only rules.js decides whether the field is absent', () => {
    const offenders = sources
      .filter(s => s.file !== 'rules.js')
      .filter(s => ABSENT_TRIAD.test(s.code.replace(/\/\/[^\n]*/g, '')))
      .map(s => s.file);
    expect(offenders).toEqual([]);
  });

  // A guard that cannot fail is not a guard: the fingerprint has to still
  // match the code it was written against.
  it('would have caught the copies that used to exist', () => {
    expect(ABSENT_TRIAD.test(
      "if (raw === undefined || raw === null || raw === '') return null;"
    )).toBe(true);
    expect(ABSENT_TRIAD.test(readFileSync(join(SHARED, 'rules.js'), 'utf8'))).toBe(true);
  });

  // Coercing it to a number. A caller may pass the field around freely; the
  // moment it reaches for Number() on something loose-shaped it has started
  // writing its own parse.
  it('no other shared file coerces a loose-window value itself', () => {
    const coercion = /Number\s*\(\s*[A-Za-z_$][\w$.?]*[Ll]oose[\w$]*\s*\)/;
    const offenders = sources
      .filter(s => s.file !== 'rules.js')
      .filter(s => coercion.test(s.code))
      .map(s => s.file);
    expect(offenders).toEqual([]);
  });

  // prompts.js is the fourth context that reads this field — it renders the
  // loose/strict line for the coach — and it had its own parse too.
  it('the prompt builder reads the field through rules.js', () => {
    const prompts = sources.find(s => s.file === 'prompts.js');
    expect(prompts.code).toMatch(/normalizeLooseUntil\s*\(/);
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
