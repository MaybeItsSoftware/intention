// parts.js — the two verdicts that decide whether a blocked site opens, and
// the guard that keeps them in one file.
//
// Both halves are wired up now: the background worker and the content script
// read the page-scope verdict (sessionCoversUrl, dnrUrlFilterFor), and the gate
// and the options row read the part-rule half. This file is no longer the only
// consumer, so a change here can break a caller — parts.js is loaded into
// content, background and options, but NOT coaching (scripts/script-contexts.mjs).
//
// Four things are checked here:
//   1. that the two matchers answer correctly;
//   2. that they NEVER throw, and that every way of failing fails in the
//      direction that keeps the block on;
//   3. that a pass granted before any of this existed still works;
//   4. that no other shared file has grown a second copy of either verdict.

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadSource, VARIANTS, REPO_ROOT } from './load.js';

let P;
beforeAll(() => {
  P = loadSource('parts.js');
});

// ---------------------------------------------------------------------------
// 1. Part ids
// ---------------------------------------------------------------------------

describe('PART_ID_RE and parsePartId', () => {
  it('accepts the two catalogue shapes', () => {
    expect(P.PART_ID_RE.test('instagram:reels')).toBe(true);
    expect(P.PART_ID_RE.test('reddit:sub:rust')).toBe(true);
    // The raw pattern is lowercase-only; parsePartId lowercases first, which
    // is why a typed 'Reels' still resolves.
    expect(P.PART_ID_RE.test('Instagram:Reels')).toBe(false);
    expect(P.parsePartId('instagram:reels')).toEqual({ service: 'instagram', key: 'reels', arg: '' });
    expect(P.parsePartId('reddit:sub:rust')).toEqual({ service: 'reddit', key: 'sub', arg: 'rust' });
  });

  it('reads a custom address rule as its own service with no key', () => {
    expect(P.parsePartId('path:/reels/*')).toEqual({ service: 'path', key: '', arg: '/reels/*' });
  });

  it.each([
    ['', 'empty'],
    ['instagram', 'no colon'],
    ['instagram:', 'a missing key'],
    ['instagram:reels:a:b', 'too many segments'],
    ['instagram:reels!', 'punctuation'],
    ['path:reels', 'an address that starts with neither / nor *'],
    ['path:/a/../b', 'a traversal'],
    [`instagram:${'x'.repeat(200)}`, 'absurdly long'],
    [null, 'null'],
    [42, 'a number'],
    [{}, 'an object']
  ])('rejects %s (%s)', (input) => {
    expect(P.parsePartId(input)).toBe(null);
  });

  it('lowercases a catalogue id but leaves an address alone', () => {
    // Paths are case-sensitive on plenty of servers; catalogue ids are not.
    expect(P.parsePartId('INSTAGRAM:REELS')).toEqual({ service: 'instagram', key: 'reels', arg: '' });
    expect(P.parsePartId('path:/Reels/*').arg).toBe('/Reels/*');
  });
});

describe('partLabel', () => {
  it('names a fixed part, a parameterised one and an address', () => {
    expect(P.partLabel('instagram:reels')).toBe('Reels');
    expect(P.partLabel('reddit:sub:rust')).toBe('r/rust');
    expect(P.partLabel('youtube:channel:veritasium')).toBe('@veritasium');
    expect(P.partLabel('x:profile:jack')).toBe('@jack');
    expect(P.partLabel('path:/reels/*')).toBe('address /reels/*');
  });

  // A newer build's id is a real rule this build cannot describe. Showing it
  // raw is honest; showing nothing is a gap the user cannot act on.
  it('falls back to the id itself for a well-formed id it does not know', () => {
    expect(P.partLabel('bluesky:feed')).toBe('bluesky:feed');
  });

  it('returns empty for junk rather than throwing', () => {
    expect(P.partLabel(null)).toBe('');
    expect(P.partLabel({ toString() { throw new Error('boom'); } })).toBe('');
  });
});

describe('partsForService', () => {
  it('offers the catalogue for a service, with the picker prompt for the parameterised ones', () => {
    const reddit = P.partsForService('reddit.com');
    expect(reddit.map(p => p.id)).toContain('reddit:sub');
    const sub = reddit.find(p => p.id === 'reddit:sub');
    expect(sub.param).toBe('subreddit');
    expect(sub.label).toBe('Subreddit');
    const popular = reddit.find(p => p.id === 'reddit:popular');
    expect(popular.param).toBe(null);
    expect(popular.label).toBe('Popular');
  });

  it('is empty for a service with no parts, and for junk', () => {
    expect(P.partsForService('example.com')).toEqual([]);
    expect(P.partsForService(null)).toEqual([]);
    expect(P.partsForService({})).toEqual([]);
  });
});

describe('normalizePartInput', () => {
  it.each([
    ['reels', 'instagram.com', 'instagram:reels'],
    ['Reels', 'instagram.com', 'instagram:reels'],
    ['rust', 'reddit.com', 'reddit:sub:rust'],
    ['r/rust', 'reddit.com', 'reddit:sub:rust'],
    ['reddit.com/r/rust', 'reddit.com', 'reddit:sub:rust'],
    ['https://reddit.com/r/rust/', 'reddit.com', 'reddit:sub:rust'],
    ['@veritasium', 'youtube.com', 'youtube:channel:veritasium'],
    ['/reels/*', 'instagram.com', 'path:/reels/*'],
    ['*/reels/*', 'instagram.com', 'path:*/reels/*'],
    ['instagram:explore', 'instagram.com', 'instagram:explore']
  ])('reads %s on %s as %s', (raw, service, expected) => {
    expect(P.normalizePartInput(raw, service)).toBe(expected);
  });

  it.each([
    ['', 'instagram.com'],
    ['   ', 'instagram.com'],
    ['nonsense', 'instagram.com'],
    ['r/rust', 'instagram.com'],
    ['/a/../b', 'instagram.com'],
    ['reels', null],
    [null, 'instagram.com'],
    [{}, 'reddit.com']
  ])('returns null for %o on %o', (raw, service) => {
    expect(P.normalizePartInput(raw, service)).toBe(null);
  });
});

// ---------------------------------------------------------------------------
// 2. The catalogue actually matches
// ---------------------------------------------------------------------------
//
// An offered part whose rule silently never matches is strictly worse than no
// part at all: the user believes something is blocked and it is not. So every
// entry names one URL it must match and one sibling it must reject, and the
// table below is asserted to cover the catalogue exhaustively — adding an
// entry without adding a case fails here rather than in the field.

const CATALOGUE_CASES = {
  'instagram:reels': ['instagram:reels', 'https://www.instagram.com/reels/', 'https://www.instagram.com/direct/t/17'],
  'instagram:explore': ['instagram:explore', 'https://www.instagram.com/explore/', 'https://www.instagram.com/reels/'],
  'instagram:stories': ['instagram:stories', 'https://www.instagram.com/stories/someone/1/', 'https://www.instagram.com/p/abc/'],
  'instagram:dms': ['instagram:dms', 'https://www.instagram.com/direct/inbox/', 'https://www.instagram.com/explore/'],
  'instagram:feed': ['instagram:feed', 'https://www.instagram.com/', 'https://www.instagram.com/reels/'],
  'instagram:posts': ['instagram:posts', 'https://www.instagram.com/p/abc123/', 'https://www.instagram.com/reels/'],

  'reddit:home': ['reddit:home', 'https://www.reddit.com/', 'https://www.reddit.com/r/rust/'],
  'reddit:popular': ['reddit:popular', 'https://www.reddit.com/r/popular/', 'https://www.reddit.com/r/all/'],
  'reddit:all': ['reddit:all', 'https://www.reddit.com/r/all/', 'https://www.reddit.com/r/popular/'],
  'reddit:sub': ['reddit:sub:rust', 'https://www.reddit.com/r/rust/comments/abc/title/', 'https://www.reddit.com/r/kotlin/'],
  'reddit:user': ['reddit:user:spez', 'https://www.reddit.com/user/spez/', 'https://www.reddit.com/r/rust/'],

  'youtube:shorts': ['youtube:shorts', 'https://www.youtube.com/shorts/abc123', 'https://www.youtube.com/watch?v=abc123'],
  'youtube:home': ['youtube:home', 'https://www.youtube.com/', 'https://www.youtube.com/shorts/abc123'],
  'youtube:subs': ['youtube:subs', 'https://www.youtube.com/feed/subscriptions', 'https://www.youtube.com/feed/history'],
  'youtube:watch': ['youtube:watch', 'https://www.youtube.com/watch?v=abc123', 'https://www.youtube.com/shorts/abc123'],
  'youtube:channel': ['youtube:channel:veritasium', 'https://www.youtube.com/@veritasium/videos', 'https://www.youtube.com/@mkbhd'],

  'x:home': ['x:home', 'https://x.com/home', 'https://x.com/messages'],
  'x:dms': ['x:dms', 'https://x.com/messages', 'https://x.com/home'],
  'x:explore': ['x:explore', 'https://x.com/explore', 'https://x.com/home'],
  'x:notifications': ['x:notifications', 'https://x.com/notifications', 'https://x.com/home'],
  'x:profile': ['x:profile:jack', 'https://x.com/jack', 'https://x.com/elonmusk'],

  'tiktok:foryou': ['tiktok:foryou', 'https://www.tiktok.com/', 'https://www.tiktok.com/following'],
  'tiktok:following': ['tiktok:following', 'https://www.tiktok.com/following', 'https://www.tiktok.com/explore'],
  'tiktok:dms': ['tiktok:dms', 'https://www.tiktok.com/messages', 'https://www.tiktok.com/explore'],
  'tiktok:explore': ['tiktok:explore', 'https://www.tiktok.com/explore', 'https://www.tiktok.com/following'],

  'facebook:reels': ['facebook:reels', 'https://www.facebook.com/reel/123', 'https://www.facebook.com/marketplace/'],
  'facebook:messages': ['facebook:messages', 'https://www.facebook.com/messages/t/1', 'https://www.facebook.com/marketplace/'],
  'facebook:marketplace': ['facebook:marketplace', 'https://www.facebook.com/marketplace/', 'https://www.facebook.com/messages/t/1'],
  'facebook:feed': ['facebook:feed', 'https://www.facebook.com/', 'https://www.facebook.com/marketplace/'],

  'linkedin:feed': ['linkedin:feed', 'https://www.linkedin.com/feed/', 'https://www.linkedin.com/jobs/'],
  'linkedin:messaging': ['linkedin:messaging', 'https://www.linkedin.com/messaging/', 'https://www.linkedin.com/jobs/'],
  'linkedin:jobs': ['linkedin:jobs', 'https://www.linkedin.com/jobs/', 'https://www.linkedin.com/feed/']
};

describe('PART_CATALOGUE', () => {
  it('has a case in this file for every entry, and no case for an entry that is gone', () => {
    expect(Object.keys(CATALOGUE_CASES).sort()).toEqual(Object.keys(P.PART_CATALOGUE).sort());
  });

  it('names a service for every entry', () => {
    for (const [id, entry] of Object.entries(P.PART_CATALOGUE)) {
      expect(typeof entry.service, id).toBe('string');
      expect(entry.service.length, id).toBeGreaterThan(0);
    }
  });

  it.each(Object.entries(CATALOGUE_CASES))('%s matches its own page and rejects a sibling', (_key, [id, hit, miss]) => {
    expect(P.resolvePartVerdict({ scope: 'only', parts: [id] }, hit)).toEqual({ gated: true, partId: id, scope: 'only' });
    expect(P.resolvePartVerdict({ scope: 'only', parts: [id] }, miss).gated).toBe(false);
  });

  // The one the design calls out by name: a rule meaning "block Reels" must
  // not swallow the DMs the user deliberately left open.
  it('instagram:reels rejects /direct/ and /explore/', () => {
    const rule = { scope: 'only', parts: ['instagram:reels'] };
    expect(P.resolvePartVerdict(rule, 'https://www.instagram.com/direct/t/17').gated).toBe(false);
    expect(P.resolvePartVerdict(rule, 'https://www.instagram.com/explore/').gated).toBe(false);
  });
});

describe('partMatchesUrl over custom address rules', () => {
  const at = (path) => ({ pathname: path.split('?')[0], search: path.includes('?') ? `?${path.split('?')[1]}` : '' });

  it.each([
    ['path:/reels/*', '/reels/abc', true],
    ['path:/reels/*', '/reels/', true],
    ['path:/reels/*', '/explore/', false],
    ['path:*/video/*', '/@someone/video/123', true],
    ['path:/watch*', '/watch?v=abc', true],
    ['path:/watch?v=abc', '/watch?v=abc', true],
    ['path:/watch?v=abc', '/watch?v=xyz', false],
    ['path:/exact', '/exact', true],
    ['path:/exact', '/exactly', false]
  ])('%s over %s is %s', (id, path, expected) => {
    expect(P.partMatchesUrl(id, at(path))).toBe(expected);
  });

  // A glob of nothing but wildcards is the textbook catastrophic-backtracking
  // input, and it is reachable by holding down a key in a settings field. The
  // matcher is a two-pointer scan precisely so this is linear; if it ever goes
  // back to compiling a RegExp, this test hangs instead of failing, which is
  // its own kind of signal.
  it('survives a pathological wildcard glob quickly', () => {
    const glob = `path:${'*a'.repeat(40)}`;
    const subject = at(`/${'a'.repeat(400)}b`);
    const started = Date.now();
    expect(P.partMatchesUrl(glob, subject)).toBe(false);
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('returns false rather than throwing on junk', () => {
    expect(P.partMatchesUrl('instagram:reels', null)).toBe(false);
    expect(P.partMatchesUrl(null, at('/reels/'))).toBe(false);
    expect(P.partMatchesUrl('path:/a/../b', at('/a/../b'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. resolvePartVerdict fails closed
// ---------------------------------------------------------------------------

describe('resolvePartVerdict', () => {
  const CLOSED = { gated: true, partId: null, scope: 'all' };

  // The dozen real URLs. An entry with no scope is what every blocked site
  // carries today, and this is the assertion that the feature changed nothing
  // for anybody who never touches it.
  const REAL_URLS = [
    'https://www.instagram.com/',
    'https://www.instagram.com/reels/',
    'https://www.reddit.com/r/rust/comments/abc/title/',
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://www.youtube.com/shorts/abc123',
    'https://x.com/home',
    'https://x.com/jack/status/20',
    'https://www.tiktok.com/@someone/video/123',
    'https://www.facebook.com/marketplace/',
    'https://www.linkedin.com/feed/',
    'https://github.com/nodejs/node/issues/1',
    'https://news.ycombinator.com/item?id=1'
  ];

  it.each(REAL_URLS)('an entry with no scope gates %s, exactly as before the feature existed', (url) => {
    expect(P.resolvePartVerdict({ maxGrants: 3, maxMinutes: 30 }, url)).toEqual(CLOSED);
    expect(P.resolvePartVerdict({}, url)).toEqual(CLOSED);
  });

  it.each([
    [null, 'a null entry'],
    [undefined, 'an absent entry'],
    ['nonsense', 'a string entry'],
    [42, 'a number entry'],
    [{ scope: 'only' }, 'a scope with no parts key'],
    [{ scope: 'only', parts: 'instagram:reels' }, 'parts that is not an array'],
    [{ scope: 'only', parts: {} }, 'parts that is an object'],
    [{ scope: 'only', parts: [] }, 'an empty only list'],
    [{ scope: 'except', parts: [] }, 'an empty except list'],
    [{ scope: 'only', parts: [null, 7, {}] }, 'a list of non-strings'],
    [{ scope: 'except', parts: [null, 7, {}] }, 'an except list of non-strings'],
    [{ scope: 'sideways', parts: ['instagram:reels'] }, 'a garbage scope'],
    [{ scope: 'only', parts: Array.from({ length: 21 }, () => 'instagram:reels') }, 'a list longer than anything this extension writes'],
    [{ scope: 'all', parts: ['instagram:reels'] }, 'the never-written scope all']
  ])('gates everything for %o (%s)', (entry) => {
    expect(P.resolvePartVerdict(entry, 'https://www.instagram.com/reels/')).toEqual(CLOSED);
  });

  it.each([
    [undefined, 'no url'],
    ['', 'an empty url'],
    ['not a url', 'an unparseable url'],
    ['javascript:alert(1)', 'a javascript: url'],
    ['data:text/html,<b>x', 'a data: url'],
    ['about:blank', 'about:blank'],
    [{ href: 'https://www.instagram.com/reels/' }, 'an object pretending to be a url']
  ])('gates everything for %o (%s)', (url) => {
    expect(P.resolvePartVerdict({ scope: 'only', parts: ['instagram:reels'] }, url)).toEqual(CLOSED);
  });

  it('survives an entry whose prototype was tampered with', () => {
    const hostile = Object.create({ scope: 'only', parts: ['instagram:reels'] });
    // Inherited values are still values; the point is that reading them does
    // not throw and the verdict is still one of the three legal shapes.
    expect(P.resolvePartVerdict(hostile, 'https://www.instagram.com/reels/').gated).toBe(true);

    const explosive = {
      get scope() { throw new Error('boom'); },
      get parts() { throw new Error('boom'); }
    };
    expect(P.resolvePartVerdict(explosive, 'https://www.instagram.com/reels/')).toEqual(CLOSED);
  });

  it('survives an id full of regex metacharacters', () => {
    const rule = { scope: 'only', parts: ['reddit:sub:.*', 'path:/(a|b)+$'] };
    expect(() => P.resolvePartVerdict(rule, 'https://www.reddit.com/r/rust/')).not.toThrow();
    // `reddit:sub:.*` is not a legal argument, so the 'only' list is void and
    // the whole site is gated — the fail-closed direction.
    expect(P.resolvePartVerdict(rule, 'https://www.reddit.com/r/rust/')).toEqual(CLOSED);
  });

  // The asymmetry, stated twice because it is the part that is easy to get
  // backwards. An id this build cannot evaluate can only ever fail to match.
  it('gates the whole site when an only list holds an id this build does not know', () => {
    const rule = { scope: 'only', parts: ['instagram:reels', 'instagram:notebook'] };
    expect(P.resolvePartVerdict(rule, 'https://www.instagram.com/direct/')).toEqual(CLOSED);
    expect(P.resolvePartVerdict(rule, 'https://www.instagram.com/reels/')).toEqual(CLOSED);
  });

  it('drops an id it does not know from an except list and keeps going', () => {
    const rule = { scope: 'except', parts: ['instagram:notebook', 'instagram:dms'] };
    expect(P.resolvePartVerdict(rule, 'https://www.instagram.com/direct/'))
      .toEqual({ gated: false, partId: 'instagram:dms', scope: 'except' });
    expect(P.resolvePartVerdict(rule, 'https://www.instagram.com/reels/'))
      .toEqual({ gated: true, partId: null, scope: 'except' });
  });

  it('gates everything when every id in an except list is unknown', () => {
    expect(P.resolvePartVerdict({ scope: 'except', parts: ['instagram:notebook'] }, 'https://www.instagram.com/direct/'))
      .toEqual(CLOSED);
  });

  it('reports which part matched, so the gate can name it', () => {
    expect(P.resolvePartVerdict({ scope: 'only', parts: ['instagram:explore', 'instagram:reels'] },
      'https://www.instagram.com/reels/'))
      .toEqual({ gated: true, partId: 'instagram:reels', scope: 'only' });
  });
});

describe('hasPartRule', () => {
  it.each([
    [null, false],
    [{}, false],
    [{ maxGrants: 3 }, false],
    [{ scope: 'only' }, false],
    [{ scope: 'only', parts: [] }, false],
    [{ scope: 'only', parts: ['garbage!'] }, false],
    [{ scope: 'all', parts: ['instagram:reels'] }, false],
    [{ scope: 'only', parts: ['instagram:reels'] }, true],
    [{ scope: 'except', parts: ['instagram:dms'] }, true]
  ])('%o has a rule: %s', (entry, expected) => {
    expect(P.hasPartRule(entry)).toBe(expected);
  });
});

describe('sanitizePartRule', () => {
  it('drops ids that are not ids, and keeps ones it simply does not recognise', () => {
    const out = P.sanitizePartRule({
      scope: 'only',
      parts: ['instagram:reels', 'garbage!', 42, null, 'bluesky:feed']
    });
    expect(out).toEqual({ scope: 'only', parts: ['instagram:reels', 'bluesky:feed'] });
  });

  it('collapses to all when the list empties, so the caller deletes both keys', () => {
    expect(P.sanitizePartRule({ scope: 'only', parts: ['garbage!'] })).toEqual({ scope: 'all', parts: [] });
    expect(P.sanitizePartRule({ scope: 'except', parts: [] })).toEqual({ scope: 'all', parts: [] });
    expect(P.sanitizePartRule({ scope: 'all', parts: ['instagram:reels'] })).toEqual({ scope: 'all', parts: [] });
  });

  it('caps the list at twenty and de-duplicates', () => {
    const many = Array.from({ length: 40 }, (_, i) => `reddit:sub:sub${i}`);
    expect(P.sanitizePartRule({ scope: 'only', parts: many }).parts).toHaveLength(20);
    expect(P.sanitizePartRule({ scope: 'only', parts: ['instagram:reels', 'INSTAGRAM:REELS'] }).parts)
      .toEqual(['instagram:reels']);
  });

  it('rejects an over-long id', () => {
    expect(P.sanitizePartRule({ scope: 'only', parts: [`reddit:sub:${'a'.repeat(120)}`] }))
      .toEqual({ scope: 'all', parts: [] });
  });

  it.each([null, undefined, 'nonsense', 42, []])('returns the empty rule for %o', (raw) => {
    expect(P.sanitizePartRule(raw)).toEqual({ scope: 'all', parts: [] });
  });
});

describe('describeScopeForHuman', () => {
  it('says all, only and except the way settings and the coach both say them', () => {
    expect(P.describeScopeForHuman({}, 'instagram.com')).toBe('all of instagram.com');
    expect(P.describeScopeForHuman({ scope: 'only', parts: ['instagram:reels', 'instagram:explore'] }, 'instagram.com'))
      .toBe('only Reels and Explore on instagram.com');
    expect(P.describeScopeForHuman({ scope: 'except', parts: ['reddit:sub:rust', 'reddit:sub:kotlin'] }, 'reddit.com'))
      .toBe('all of reddit.com except r/rust, r/kotlin');
  });

  it('never throws and always says something', () => {
    expect(P.describeScopeForHuman(null, null)).toBe('all of this site');
    expect(P.describeScopeForHuman({ scope: 'only', parts: ['instagram:reels'] }, { toString() { throw new Error('x'); } }))
      .toBe('this site');
  });
});

describe('partEditIsLoosening', () => {
  const ALL = { scope: 'all', parts: [] };
  const ONLY_ONE = { scope: 'only', parts: ['instagram:reels'] };
  const ONLY_TWO = { scope: 'only', parts: ['instagram:reels', 'instagram:explore'] };
  const EXCEPT_ONE = { scope: 'except', parts: ['instagram:dms'] };
  const EXCEPT_TWO = { scope: 'except', parts: ['instagram:dms', 'instagram:posts'] };

  it.each([
    // One sentence covers the whole table: an edit that leaves less of the
    // site blocked goes through the coach.
    [ALL, ALL, false, 'all to all is no change'],
    [ALL, ONLY_ONE, true, 'all to a carve-out leaves less blocked'],
    [ALL, EXCEPT_ONE, true, 'all to an exception leaves less blocked'],
    [ONLY_ONE, ALL, false, 'back to blocking everything is tightening'],
    [EXCEPT_ONE, ALL, false, 'back to blocking everything is tightening'],
    [ONLY_ONE, EXCEPT_ONE, true, 'a scope switch cannot be proved tightening'],
    [EXCEPT_ONE, ONLY_ONE, true, 'nor can the other way round'],
    [ONLY_ONE, ONLY_TWO, false, 'blocking one more part is tightening'],
    [ONLY_TWO, ONLY_ONE, true, 'blocking one fewer part is loosening'],
    [ONLY_ONE, ONLY_ONE, false, 'no change'],
    [EXCEPT_ONE, EXCEPT_TWO, true, 'excepting one more part is loosening'],
    [EXCEPT_TWO, EXCEPT_ONE, false, 'excepting one fewer part is tightening'],
    [EXCEPT_ONE, EXCEPT_ONE, false, 'no change'],
    // A list that sanitises away is the empty rule, which is `all`.
    [ONLY_ONE, { scope: 'only', parts: ['garbage!'] }, false, 'an unsaveable edit reads as all'],
    [{ scope: 'only', parts: ['garbage!'] }, ONLY_ONE, true, 'and back out of it is loosening']
  ])('%o -> %o is loosening: %s (%s)', (before, after, expected) => {
    expect(P.partEditIsLoosening(before, after)).toBe(expected);
  });

  it('answers yes when it cannot answer at all — the coach is the safe default', () => {
    const explosive = { get scope() { throw new Error('boom'); } };
    expect(P.partEditIsLoosening(explosive, ONLY_ONE)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. Page scope
// ---------------------------------------------------------------------------

describe('DESTINATION_SPECIFICITY and destinationSpecificity', () => {
  it('classifies over page_context.js\'s own vocabulary, with no second classifier', () => {
    expect(P.DESTINATION_SPECIFICITY['YouTube Video']).toBe('item');
    expect(P.DESTINATION_SPECIFICITY['Instagram Home Feed']).toBe('feed');
    expect(P.DESTINATION_SPECIFICITY['GitHub Repository']).toBe('surface');
  });

  it.each([
    [{ contentType: 'YouTube Video' }, 'item'],
    [{ contentType: 'Reddit Post' }, 'item'],
    [{ contentType: 'Instagram Home Feed' }, 'feed'],
    [{ contentType: 'Subreddit Feed' }, 'feed'],
    [{ contentType: 'TikTok Search' }, 'surface'],
    [{ contentType: 'YouTube Page (search)' }, 'surface'],
    [{ contentType: 'Web Page', url: 'https://example.com/' }, 'feed'],
    [{ contentType: 'Web Page', url: 'https://example.com/some-article', title: 'Some Article' }, 'item'],
    [{ contentType: 'Web Page', url: 'https://example.com/x', title: 'https://example.com/x' }, 'unknown'],
    [null, 'unknown'],
    [{}, 'unknown'],
    [{ contentType: 'Web Page', url: 'javascript:alert(1)' }, 'unknown']
  ])('reads %o as %s', (ctx, expected) => {
    expect(P.destinationSpecificity(ctx)).toBe(expected);
  });
});

describe('pageScopeKeyFor', () => {
  it('collapses the query noise that makes the same page look like a different one', () => {
    const plain = P.pageScopeKeyFor('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    expect(plain).toBe('yt:video:dQw4w9WgXcQ');
    expect(P.pageScopeKeyFor('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=90')).toBe(plain);
    expect(P.pageScopeKeyFor('https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLabc&index=3')).toBe(plain);
    expect(P.pageScopeKeyFor('https://www.youtube.com/watch?v=dQw4w9WgXcQ&utm_source=newsletter')).toBe(plain);
    expect(P.pageScopeKeyFor('https://youtu.be/dQw4w9WgXcQ?t=90')).toBe(plain);
    expect(P.pageScopeKeyFor('https://m.youtube.com/watch?v=dQw4w9WgXcQ#comments')).toBe(plain);
  });

  it('keeps two different videos apart', () => {
    expect(P.pageScopeKeyFor('https://www.youtube.com/watch?v=aaaaaaaaaaa'))
      .not.toBe(P.pageScopeKeyFor('https://www.youtube.com/watch?v=bbbbbbbbbbb'));
  });

  it.each([
    ['https://www.youtube.com/shorts/abc123', 'yt:video:abc123'],
    ['https://www.reddit.com/r/rust/comments/abc123/some_slug/', 'reddit:post:abc123'],
    ['https://www.reddit.com/r/rust/comments/abc123/a_different_slug/?sort=new', 'reddit:post:abc123'],
    ['https://x.com/jack/status/20', 'x:status:20'],
    ['https://twitter.com/jack/status/20?s=46', 'x:status:20'],
    ['https://www.instagram.com/p/Cabc123/?img_index=2', 'ig:p:Cabc123'],
    ['https://www.tiktok.com/@someone/video/7123456789', 'tt:video:7123456789'],
    ['https://github.com/nodejs/node/issues/42', 'gh:nodejs/node/issues/42'],
    ['https://github.com/nodejs/node/pull/42/files', 'gh:nodejs/node/pull/42'],
    ['https://example.com/some-article?utm_source=x#top', 'url:https://example.com/some-article'],
    ['https://example.com/some-article/', 'url:https://example.com/some-article'],
    ['https://example.com/', 'url:https://example.com/']
  ])('reads %s as %s', (url, expected) => {
    expect(P.pageScopeKeyFor(url)).toBe(expected);
  });

  it.each([
    [undefined, 'nothing'],
    ['', 'an empty string'],
    ['not a url', 'junk'],
    ['javascript:alert(1)', 'a javascript: url'],
    ['https://www.youtube.com/feed/subscriptions', 'a YouTube page with no video'],
    ['https://www.reddit.com/r/rust/', 'a subreddit front page'],
    [{}, 'an object']
  ])('has no key for %o (%s)', (url) => {
    expect(P.pageScopeKeyFor(url)).toBe('');
  });
});

// ---------------------------------------------------------------------------
// A KEY MAY ONLY BE MINTED BY THE PAGE IT NAMES.
// ---------------------------------------------------------------------------
//
// The key IS the enforcement mechanism: sessionCoversUrl grants everything that
// mints the same string. So any address that can mint an item's key without
// being that item is not a mis-identified page — it is a pass for everything
// that address can reach, obtained by editing the address bar, which on this
// product is the adversary's only tool and their favourite one.
//
// Each row below is a decoy: a real address on the host that used to mint the
// canonical page's key, or a sibling that must not share one.

describe('pageScopeKeyFor mints a key only from the item it names', () => {
  const YT = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';

  // THE DEFEAT THIS DESCRIBE EXISTS FOR. `v` was read on any path at all, so
  // one scoped pass plus one pasted parameter covered search, subscriptions and
  // every channel page — inside the SPA, where no network rule ever sees it.
  it.each([
    'https://www.youtube.com/feed/subscriptions?v=dQw4w9WgXcQ',
    'https://www.youtube.com/results?search_query=cats&v=dQw4w9WgXcQ',
    'https://www.youtube.com/@mkbhd?v=dQw4w9WgXcQ',
    'https://www.youtube.com/playlist?list=PLabc&v=dQw4w9WgXcQ',
    'https://www.youtube.com/?v=dQw4w9WgXcQ'
  ])('does not read `v` off %s', (decoy) => {
    expect(P.pageScopeKeyFor(YT)).toBe('yt:video:dQw4w9WgXcQ');
    expect(P.pageScopeKeyFor(decoy)).toBe('');
    expect(P.pageScopeKeyFor(decoy)).not.toBe(P.pageScopeKeyFor(YT));
  });

  it('still reads the watch page, the short and the live stream', () => {
    expect(P.pageScopeKeyFor('https://m.youtube.com/watch/?v=dQw4w9WgXcQ&t=90')).toBe('yt:video:dQw4w9WgXcQ');
    expect(P.pageScopeKeyFor('https://www.youtube.com/shorts/abc123')).toBe('yt:video:abc123');
    expect(P.pageScopeKeyFor('https://www.youtube.com/live/abc123')).toBe('yt:video:abc123');
    expect(P.pageScopeKeyFor('https://youtu.be/dQw4w9WgXcQ')).toBe('yt:video:dQw4w9WgXcQ');
  });

  // The same audit, host by host. reddit, x and tiktok all matched their id
  // anywhere in the path; instagram matched a segment that was not the item.
  it.each([
    ['reddit', 'https://www.reddit.com/r/rust/comments/abc123/some_slug/', 'https://www.reddit.com/anything/comments/abc123'],
    ['reddit', 'https://www.reddit.com/r/rust/comments/abc123/some_slug/', 'https://www.reddit.com/r/rust/wiki/comments/abc123'],
    ['x', 'https://x.com/jack/status/20', 'https://x.com/i/lists/status/20'],
    ['x', 'https://x.com/jack/status/20', 'https://x.com/i/spaces/1/status/20'],
    ['tiktok', 'https://www.tiktok.com/@someone/video/7123456789', 'https://www.tiktok.com/foryou/video/7123456789'],
    ['tiktok', 'https://www.tiktok.com/@someone/video/7123456789', 'https://www.tiktok.com/tag/cats/video/7123456789'],
    ['instagram', 'https://www.instagram.com/reels/Cabc123/', 'https://www.instagram.com/reels/audio/1234567890/'],
    ['youtube', 'https://youtu.be/dQw4w9WgXcQ', 'https://youtu.be/dQw4w9WgXcQ/extra']
  ])('%s: %s is not %s', (host, canonical, decoy) => {
    const key = P.pageScopeKeyFor(canonical);
    expect(key).not.toBe('');
    expect(P.pageScopeKeyFor(decoy)).toBe('');
  });

  // Still the same page by any of its own addresses — the other half of the
  // rule, and the half a tightening breaks if nobody pins it.
  it.each([
    ['https://www.reddit.com/r/rust/comments/abc123/some_slug/', 'reddit:post:abc123'],
    ['https://www.reddit.com/user/spez/comments/abc123/slug/', 'reddit:post:abc123'],
    ['https://www.reddit.com/comments/abc123', 'reddit:post:abc123'],
    ['https://x.com/jack/status/20/photo/1', 'x:status:20'],
    ['https://x.com/i/web/status/20', 'x:status:20'],
    ['https://github.com/nodejs/node/pull/42/files', 'gh:nodejs/node/pull/42'],
    ['https://www.instagram.com/p/Cabc123/liked_by/', 'ig:p:Cabc123'],
    ['https://www.tiktok.com/@someone/video/7123456789?is_from_webapp=1', 'tt:video:7123456789']
  ])('%s still reads as %s', (url, expected) => {
    expect(P.pageScopeKeyFor(url)).toBe(expected);
  });

  // One story is not every story that account posts, and one highlight reel is
  // not all of them — `/stories/<user>` alone was the whole key, so both
  // collapsed. Instagram is inert today (SCOPE_HOSTS_TO_VERIFY), which is why
  // this is asserted on the key rather than on a granted pass.
  it('keeps two stories and two highlight reels apart', () => {
    expect(P.pageScopeKeyFor('https://www.instagram.com/stories/someone/1111/'))
      .not.toBe(P.pageScopeKeyFor('https://www.instagram.com/stories/someone/2222/'));
    expect(P.pageScopeKeyFor('https://www.instagram.com/stories/highlights/1111/'))
      .not.toBe(P.pageScopeKeyFor('https://www.instagram.com/stories/highlights/2222/'));
  });

  // github was already right, and an audit is only worth having if the result
  // is written down where the next tightening can see it.
  it('github reads every segment from a fixed position', () => {
    expect(P.pageScopeKeyFor('https://github.com/nodejs/node/issues/42'))
      .not.toBe(P.pageScopeKeyFor('https://github.com/nodejs/node/issues/43'));
    expect(P.pageScopeKeyFor('https://github.com/nodejs/node/issues/42'))
      .not.toBe(P.pageScopeKeyFor('https://github.com/other/node/issues/42'));
    expect(P.pageScopeKeyFor('https://github.com/nodejs/node/issues?q=is%3Aopen')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// THE GENERIC KEY KEEPS WHAT IDENTIFIES A PAGE.
// ---------------------------------------------------------------------------
//
// Dropping the query and the fragment was described as collapsing "slightly
// more than it should", and on most of the web it is. On a query-routed site it
// is the whole site: Hacker News is `item?id=` and is in COMMON_SITES, MediaWiki
// is `index.php?title=`, phpBB is `viewtopic.php?t=`, a great many blogs are
// `?p=`, and a hash-routed app is nothing but fragment. One "this page only"
// pass covered all of it and the drift screen could never fire.

describe('the generic key on a query-routed or hash-routed site', () => {
  it.each([
    ['https://news.ycombinator.com/item?id=1', 'https://news.ycombinator.com/item?id=99999'],
    ['https://en.wikipedia.org/w/index.php?title=Cat', 'https://en.wikipedia.org/w/index.php?title=Dog'],
    ['https://forum.example.com/viewtopic.php?t=12', 'https://forum.example.com/viewtopic.php?t=13'],
    ['https://blog.example.com/?p=7', 'https://blog.example.com/?p=8'],
    ['https://example.com/app#/feed', 'https://example.com/app#/video/9'],
    ['https://example.com/app#!/feed', 'https://example.com/app#!/video/9']
  ])('tells %s from %s', (a, b) => {
    expect(P.pageScopeKeyFor(a)).not.toBe('');
    expect(P.pageScopeKeyFor(a)).not.toBe(P.pageScopeKeyFor(b));
    // And the pass granted for one does not cover the other, which is the
    // sentence the key exists to make true.
    const session = { domain: 'example.com', scope: { kind: 'page', key: P.pageScopeKeyFor(a) } };
    expect(P.sessionCoversUrl(session, a)).toBe(true);
    expect(P.sessionCoversUrl(session, b)).toBe(false);
  });

  // The corollary the reviewer flagged: no key read the hash, so content.js's
  // hashchange listener could never change a verdict. Now it can.
  it('a hash-routed move off the page a pass was granted for stops being covered', () => {
    const scope = P.pageScopeFor('https://example.com/app#/video/9', {
      contentType: 'Web Page', url: 'https://example.com/app#/video/9', title: 'Episode 9'
    });
    expect(scope.key).toBe('url:https://example.com/app#/video/9');
    // The "back to your page" link has to keep the route, or the one way out of
    // the drift screen lands the user straight back on it.
    expect(scope.url).toBe('https://example.com/app#/video/9');
    const session = { domain: 'example.com', scope };
    expect(P.sessionCoversUrl(session, 'https://example.com/app#/video/9')).toBe(true);
    expect(P.sessionCoversUrl(session, 'https://example.com/app#/feed')).toBe(false);
  });

  it('still collapses the noise the original comment was right to strip', () => {
    const plain = P.pageScopeKeyFor('https://example.com/some-article');
    for (const noisy of [
      'https://example.com/some-article?utm_source=newsletter&utm_medium=email',
      'https://example.com/some-article?fbclid=abc',
      'https://example.com/some-article?gclid=abc',
      'https://example.com/some-article?ref=hn',
      'https://example.com/some-article?igshid=abc&si=xyz',
      'https://example.com/some-article#top',
      'https://example.com/some-article/#cite_note-3'
    ]) {
      expect(P.pageScopeKeyFor(noisy)).toBe(plain);
    }
  });

  // `t` and `list` read like YouTube resume parameters and are identity on
  // every phpBB forum and mailing-list archive on the web. Keeping them costs a
  // re-gate on a timestamped re-share of an unclassified host — annoying,
  // visible, recoverable. Dropping them opens the forum. YouTube's own branch
  // still ignores both, because it reads `v` and nothing else.
  it('keeps the parameters that are noise on one host and identity on another', () => {
    expect(P.pageScopeKeyFor('https://forum.example.com/viewtopic.php?t=12'))
      .not.toBe(P.pageScopeKeyFor('https://forum.example.com/viewtopic.php'));
    expect(P.pageScopeKeyFor('https://www.youtube.com/watch?v=abc&t=90&list=PLx'))
      .toBe(P.pageScopeKeyFor('https://www.youtube.com/watch?v=abc'));
  });

  it('does not care what order the query was written in', () => {
    expect(P.pageScopeKeyFor('https://example.com/x?a=1&b=2'))
      .toBe(P.pageScopeKeyFor('https://example.com/x?b=2&a=1'));
  });

  // A decoded `&` in a value would otherwise be indistinguishable from a
  // parameter boundary, which is one address forging another's key.
  it('cannot have one page\'s key forged out of another page\'s value', () => {
    expect(P.pageScopeKeyFor('https://example.com/x?a=b%26c=d'))
      .not.toBe(P.pageScopeKeyFor('https://example.com/x?a=b&c=d'));
  });
});

describe('pageScopeFor', () => {
  it('pins a named YouTube video, with the hash stripped', () => {
    const scope = P.pageScopeFor('https://www.youtube.com/watch?v=dQw4w9WgXcQ#t=30', {
      contentType: 'YouTube Video',
      url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      videoTitle: 'Never Gonna Give You Up'
    });
    expect(scope).toEqual({
      kind: 'page',
      key: 'yt:video:dQw4w9WgXcQ',
      url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      label: 'Never Gonna Give You Up',
      verb: 'Watching'
    });
  });

  it('never quotes page_context.js\'s placeholder title back at the user', () => {
    const scope = P.pageScopeFor('https://www.youtube.com/watch?v=dQw4w9WgXcQ', {
      contentType: 'YouTube Video',
      url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      videoTitle: 'YouTube Video (dQw4w9WgXcQ)',
      title: 'YouTube Video (dQw4w9WgXcQ)'
    });
    expect(scope.label).toBe('this video');
  });

  it('clamps a long label rather than letting it wrap the badge', () => {
    const scope = P.pageScopeFor('https://example.com/article', {
      contentType: 'Web Page',
      url: 'https://example.com/article',
      title: 'x'.repeat(200)
    });
    expect(scope.label.length).toBeLessThanOrEqual(60);
  });

  it.each([
    [{ contentType: 'Instagram Home Feed', url: 'https://www.instagram.com/' }, 'https://www.instagram.com/', 'a feed'],
    [{ contentType: 'Subreddit Feed', url: 'https://www.reddit.com/r/rust/' }, 'https://www.reddit.com/r/rust/', 'a subreddit front page'],
    [{ contentType: 'YouTube Page', url: 'https://www.youtube.com/' }, 'https://www.youtube.com/', 'the YouTube front page'],
    [null, 'https://www.youtube.com/watch?v=abc', 'no page context at all'],
    [{ contentType: 'YouTube Video' }, 'javascript:alert(1)', 'a javascript: url']
  ])('refuses to scope %o (%s)', (ctx, url) => {
    expect(P.pageScopeFor(url, ctx)).toBe(null);
  });

  // The two hosts nobody has been able to check on a device. They are present,
  // named, and inert; flipping one on is moving a string between two arrays.
  it('refuses the hosts that have not been verified on a device', () => {
    expect(P.SCOPE_HOSTS_TO_VERIFY).toEqual(['instagram.com', 'tiktok.com']);
    expect(P.pageScopeFor('https://www.instagram.com/p/Cabc123/', {
      contentType: 'Instagram Post', url: 'https://www.instagram.com/p/Cabc123/'
    })).toBe(null);
    expect(P.pageScopeFor('https://www.tiktok.com/@someone/video/7123456789', {
      contentType: 'TikTok Video', url: 'https://www.tiktok.com/@someone/video/7123456789'
    })).toBe(null);
  });

  it('lets an ordinary host through on the generic key, without being listed', () => {
    expect(P.SCOPE_SUPPORTED_HOSTS).not.toContain('example.com');
    const scope = P.pageScopeFor('https://example.com/some-article', {
      contentType: 'Web Page', url: 'https://example.com/some-article', title: 'Some Article'
    });
    expect(scope.key).toBe('url:https://example.com/some-article');
    expect(scope.verb).toBe('On');
  });

  it('names every verified host it grants a site-specific key to', () => {
    for (const host of P.SCOPE_SUPPORTED_HOSTS) {
      expect(P.SCOPE_HOSTS_TO_VERIFY).not.toContain(host);
    }
  });
});

describe('sessionCoversUrl', () => {
  // ------------------------------------------------------------------------
  // THE BACKWARD-COMPATIBILITY ASSERTION. Every pass granted before this
  // feature existed, every site pass granted after it, and every simple-mode
  // grant has no `scope`. If this stops being true, all of them turn into a
  // gate the user did not ask for on a site they already paid a conversation
  // for. It is one line in parts.js and it is the whole story.
  // ------------------------------------------------------------------------
  it.each([
    'https://www.youtube.com/',
    'https://www.youtube.com/watch?v=abc',
    'https://www.youtube.com/shorts/xyz',
    'https://www.instagram.com/reels/',
    'https://example.com/anything/at/all?q=1#x',
    'not a url',
    'javascript:alert(1)',
    ''
  ])('a session with no scope covers %s', (url) => {
    expect(P.sessionCoversUrl({ domain: 'youtube.com', startTime: 1 }, url)).toBe(true);
    expect(P.sessionCoversUrl({ domain: 'youtube.com', scope: null }, url)).toBe(true);
    expect(P.sessionCoversUrl({ domain: 'youtube.com', scope: {} }, url)).toBe(true);
    expect(P.sessionCoversUrl({ domain: 'youtube.com', scope: { kind: 'page' } }, url)).toBe(true);
  });

  const SCOPED = { domain: 'youtube.com', scope: { kind: 'page', key: 'yt:video:dQw4w9WgXcQ' } };

  it('covers the same page however it was reached', () => {
    expect(P.sessionCoversUrl(SCOPED, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe(true);
    expect(P.sessionCoversUrl(SCOPED, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=90')).toBe(true);
    expect(P.sessionCoversUrl(SCOPED, 'https://youtu.be/dQw4w9WgXcQ')).toBe(true);
  });

  it('does not cover the next video, which is the point of the feature', () => {
    expect(P.sessionCoversUrl(SCOPED, 'https://www.youtube.com/watch?v=somethingelse')).toBe(false);
    expect(P.sessionCoversUrl(SCOPED, 'https://www.youtube.com/')).toBe(false);
  });

  // Re-gating is never a safety failure: it is the state the user was in ten
  // seconds ago, and the state they chose when they blocked the site.
  it('does not cover a URL whose key cannot be computed', () => {
    expect(P.sessionCoversUrl(SCOPED, 'not a url')).toBe(false);
    expect(P.sessionCoversUrl(SCOPED, 'javascript:alert(1)')).toBe(false);
    expect(P.sessionCoversUrl(SCOPED, undefined)).toBe(false);
  });

  it('does not cover anything when reading the session throws', () => {
    const explosive = { get scope() { throw new Error('boom'); } };
    expect(P.sessionCoversUrl(explosive, 'https://www.youtube.com/watch?v=abc')).toBe(false);
  });
});

describe('dnrUrlFilterFor', () => {
  it('anchors an ordinary page, query and all', () => {
    expect(P.dnrUrlFilterFor('https://www.youtube.com/watch?v=abc'))
      .toBe('|https://www.youtube.com/watch?v=abc|');
    expect(P.dnrUrlFilterFor('https://example.com/a/b#frag'))
      .toBe('|https://example.com/a/b|');
  });

  // THE TRAILING ANCHOR IS THE WHOLE RULE. Without it `|https://example.com/a`
  // is a prefix, and a rule that ALLOWS traffic past a block matched every
  // address that merely starts like the page it was built for. Worse than a
  // wrong verdict: the domain redirect kept for a scoped pass does not fire on
  // those URLs either, so the page loads fully live and nothing but the drift
  // screen, a round trip later, is left to stop it.
  it('matches the page it was built for and not its neighbours', () => {
    const filter = P.dnrUrlFilterFor('https://example.com/a');
    expect(filter).toBe('|https://example.com/a|');
    // urlFilter semantics, applied by hand: a leading `|` anchors the start, a
    // trailing `|` anchors the end, and this filter contains no `*` or `^`, so
    // it is an equality test on the URL.
    const matches = (url) => filter === `|${url}|`;
    expect(matches('https://example.com/a')).toBe(true);
    for (const sibling of [
      'https://example.com/about',
      'https://example.com/archive/2024',
      'https://example.com/a?anything',
      'https://example.com/a/b'
    ]) {
      expect(matches(sibling)).toBe(false);
    }
  });

  // THE CONTRACT: '' or a filter that matches the address it was built from.
  // Never a third thing. The middle answer this replaces — drop the query and
  // anchor what is left — could not match ANY url it was ever handed, because
  // a query is the only reason that branch was reached and `|origin/path|` is
  // anchored at both ends. registerSessionRule reads a non-empty string as
  // "the narrow rule worked" and stops falling back, while the priority-1
  // domain redirect stays live for a scoped pass: the allow rule never fired,
  // the redirect always did, and the granted page bounced to coaching.html
  // forever on a live pass. '' is the way out; a rule that cannot fire is not.
  it('gives up on an unsafe query rather than emitting a rule that can never match', () => {
    expect(P.dnrUrlFilterFor('https://example.com/a?q=a*b')).toBe('');
    expect(P.dnrUrlFilterFor('https://example.com/a?q=a^b')).toBe('');
    expect(P.dnrUrlFilterFor('https://example.com/a?q=a|b')).toBe('');
  });

  // The invariant behind that verdict, stated so a future narrowing has to
  // keep it: whatever comes back non-empty has to match its own input.
  it('never returns a filter that fails to match the url it was built from', () => {
    // urlFilter semantics applied by hand: `|` anchors an end, `*` is a
    // wildcard, `^` a separator, everything else literal. None of the urls
    // below produce a filter containing `*` or `^`, so this stays an
    // anchored-substring test.
    const matches = (filter, url) => {
      let f = filter, start = false, end = false;
      if (f.startsWith('|')) { start = true; f = f.slice(1); }
      if (f.endsWith('|')) { end = true; f = f.slice(0, -1); }
      expect(f).not.toMatch(/[*^|]/);
      const body = f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`${start ? '^' : ''}${body}${end ? '$' : ''}`).test(url);
    };
    for (const url of [
      'https://www.youtube.com/watch?v=abc',
      'https://example.com/search?q=a*b',
      'https://example.com/search?q=a^b',
      'https://example.com/search?q=a|b',
      'https://example.com/a?utm_source=x&t=90',
      'https://example.com/plain',
      'https://example.com/a*b',
      'https://example.com/%C3%A9'
    ]) {
      const filter = P.dnrUrlFilterFor(url);
      if (!filter) continue; // '' means "no rule" — the caller widens instead
      // The fragment is not part of what DNR matches, and none of the above
      // carry one, so the filter must match the whole address as given.
      expect(matches(filter, url), `${filter} vs ${url}`).toBe(true);
    }
  });

  it.each([
    ['https://example.com/a*b', 'a wildcard in the path'],
    ['https://example.com/a^b', 'a separator in the path'],
    // The same URL as the line above, as a newer Node hands it back. `^` is in
    // the WHATWG path percent-encode set now, so whether the raw or the encoded
    // form reaches the guard depends on the engine -- CI went red on exactly
    // this while the machine it was written on stayed green. Both are pinned so
    // it cannot drift back.
    ['https://example.com/a%5Eb', 'a percent-encoded separator in the path'],
    ['https://example.com/a%2Ab', 'a percent-encoded wildcard in the path'],
    ['https://example.com/a%7Cb', 'a percent-encoded anchor in the path'],
    ['https://example.com/a|b', 'an anchor in the path'],
    ['javascript:alert(1)', 'a javascript: url'],
    ['not a url', 'junk'],
    ['', 'nothing'],
    [null, 'null'],
    [{}, 'an object']
  ])('gives up on %o (%s)', (url) => {
    expect(P.dnrUrlFilterFor(url)).toBe('');
  });

  it('gives up on a non-ASCII byte rather than taking the whole rule set down', () => {
    // A percent-encoded path is ASCII by the time URL is done with it; a
    // hostname is punycoded. This is the belt for the case neither covers.
    expect(P.dnrUrlFilterFor('https://example.com/é')).toBe('|https://example.com/%C3%A9|');
    expect(P.dnrUrlFilterFor({ toString() { throw new Error('x'); } })).toBe('');
  });
});

// ---------------------------------------------------------------------------
// 4b. Always-allowed accounts
// ---------------------------------------------------------------------------
//
// An allowlist can only ever OPEN an address the part rule gated, and only
// where the address (or, for a YouTube video, a lookup tied to that exact
// video) proves whose page it is. Everything uncertain stays gated.

describe('allowed accounts', () => {
  const IG = { maxGrants: 3, allowedAccounts: ['natgeo'] };
  const X = { maxGrants: 3, allowedAccounts: ['nasa'] };
  const TT = { maxGrants: 3, allowedAccounts: ['natgeo'] };
  const YT = { maxGrants: 3, allowedAccounts: ['veritasium'] };

  describe('sanitizeAllowedAccounts', () => {
    it('lowercases, strips @, dedupes and drops junk', () => {
      expect(P.sanitizeAllowedAccounts(['@NatGeo', 'natgeo', ' nasa ', 7, null, 'a b', '../x', ''])).toEqual(['natgeo', 'nasa']);
    });

    it('caps the list', () => {
      const list = Array.from({ length: 40 }, (_, i) => `user${i}`);
      expect(P.sanitizeAllowedAccounts(list)).toHaveLength(20);
    });

    it.each([null, undefined, 'natgeo', {}, 42])('reads %s as no list', (raw) => {
      expect(P.sanitizeAllowedAccounts(raw)).toEqual([]);
    });
  });

  describe('opening by address', () => {
    it.each([
      ['https://www.instagram.com/natgeo/', IG],
      ['https://www.instagram.com/natgeo/reels/', IG],
      ['https://www.instagram.com/NatGeo/p/C1aBcDeF/', IG],
      ['https://www.instagram.com/natgeo/reel/C1aBcDeF/', IG],
      ['https://www.instagram.com/stories/natgeo/3312345678/', IG],
      ['https://x.com/nasa', X],
      ['https://x.com/NASA/status/1790000000000000000', X],
      ['https://twitter.com/nasa/status/1790000000000000000/photo/1', X],
      ['https://www.tiktok.com/@natgeo', TT],
      ['https://www.tiktok.com/@natgeo/video/7300000000000000000', TT],
      ['https://www.youtube.com/@veritasium', YT],
      ['https://m.youtube.com/@Veritasium/videos', YT]
    ])('opens %s', (url, entry) => {
      const verdict = P.resolvePartVerdict(entry, url);
      expect(verdict.gated).toBe(false);
      expect(verdict.account).toBe(entry.allowedAccounts[0]);
    });

    it.each([
      // Not the account.
      ['https://www.instagram.com/someoneelse/', IG],
      ['https://x.com/spacex/status/1', X],
      ['https://www.tiktok.com/@other/video/1', TT],
      ['https://www.youtube.com/@other', YT],
      // The address names no author.
      ['https://www.instagram.com/p/C1aBcDeF/', IG],
      ['https://www.instagram.com/reel/C1aBcDeF/', IG],
      ['https://www.instagram.com/', IG],
      ['https://www.instagram.com/stories/highlights/1/', IG],
      ['https://x.com/i/web/status/1', X],
      ['https://x.com/home', X],
      ['https://www.tiktok.com/foryou', TT],
      ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', YT],
      ['https://www.youtube.com/shorts/dQw4w9WgXcQ', YT],
      ['https://www.youtube.com/channel/UC1234', YT],
      // Not a web page.
      ['javascript:alert(1)', IG],
      ['not a url', IG]
    ])('keeps %s gated', (url, entry) => {
      expect(P.resolvePartVerdict(entry, url).gated).toBe(true);
    });

    // A route name typed as a handle must never open that route.
    it('never treats a site route as a handle', () => {
      const entry = { allowedAccounts: ['reels', 'explore', 'direct', 'p', 'stories'] };
      for (const path of ['/reels/', '/explore/', '/direct/inbox/', '/p/abc/', '/stories/']) {
        expect(P.resolvePartVerdict(entry, `https://www.instagram.com${path}`).gated).toBe(true);
      }
      expect(P.resolvePartVerdict({ allowedAccounts: ['home', 'i', 'messages'] }, 'https://x.com/home').gated).toBe(true);
      expect(P.resolvePartVerdict({ allowedAccounts: ['home', 'i', 'messages'] }, 'https://x.com/i/bookmarks').gated).toBe(true);
    });

    it('only opens; an address the part rule already leaves open stays open', () => {
      const entry = { scope: 'only', parts: ['instagram:reels'], allowedAccounts: ['natgeo'] };
      expect(P.resolvePartVerdict(entry, 'https://www.instagram.com/direct/inbox/'))
        .toEqual({ gated: false, partId: null, scope: 'only' });
      expect(P.resolvePartVerdict(entry, 'https://www.instagram.com/reels/abc/').gated).toBe(true);
      expect(P.resolvePartVerdict(entry, 'https://www.instagram.com/natgeo/').gated).toBe(false);
    });

    it('reads the list only off the entry itself, never its prototype', () => {
      const hostile = Object.create({ allowedAccounts: ['natgeo'] });
      expect(P.resolvePartVerdict(hostile, 'https://www.instagram.com/natgeo/').gated).toBe(true);
    });
  });

  describe('a YouTube video, which needs a lookup', () => {
    const WATCH = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10';

    it('asks for one only when there is a list and the address names no channel', () => {
      const lookup = P.accountLookupFor(YT, WATCH);
      expect(lookup.key).toBe('youtube:dQw4w9WgXcQ');
      expect(lookup.fetchUrl).toBe(
        'https://www.youtube.com/oembed?format=json&url=' +
        encodeURIComponent('https://www.youtube.com/watch?v=dQw4w9WgXcQ')
      );
      expect(P.accountLookupFor(YT, 'https://www.youtube.com/shorts/dQw4w9WgXcQ').key).toBe('youtube:dQw4w9WgXcQ');
      expect(P.accountLookupFor({ maxGrants: 3 }, WATCH)).toBe(null);
      expect(P.accountLookupFor(YT, 'https://www.youtube.com/@veritasium')).toBe(null);
      expect(P.accountLookupFor(YT, 'https://www.youtube.com/')).toBe(null);
      expect(P.accountLookupFor(YT, 'https://www.youtube.com/watch?v=bad')).toBe(null);
      expect(P.accountLookupFor(IG, 'https://www.instagram.com/p/abc/')).toBe(null);
    });

    it('opens with a verified author for that exact video, and no other', () => {
      const verified = { key: 'youtube:dQw4w9WgXcQ', account: 'veritasium' };
      expect(P.resolvePartVerdict(YT, WATCH, verified).gated).toBe(false);
      // The same answer offered for a different video is ignored.
      expect(P.resolvePartVerdict(YT, 'https://www.youtube.com/watch?v=aaaaaaaaaaa', verified).gated).toBe(true);
      // A verified author who is not on the list.
      expect(P.resolvePartVerdict(YT, WATCH, { key: 'youtube:dQw4w9WgXcQ', account: 'other' }).gated).toBe(true);
      // Garbage in the verified slot.
      expect(P.resolvePartVerdict(YT, WATCH, 'veritasium').gated).toBe(true);
    });

    it('reads the handle out of an oEmbed answer, and nothing else', () => {
      expect(P.accountFromLookupResponse({ author_url: 'https://www.youtube.com/@Veritasium' })).toBe('veritasium');
      expect(P.accountFromLookupResponse({ author_url: 'https://www.youtube.com/channel/UC123' })).toBe(null);
      expect(P.accountFromLookupResponse({ author_url: 'https://evil.example/@veritasium' })).toBe(null);
      expect(P.accountFromLookupResponse({ author_url: 'http://www.youtube.com/@veritasium' })).toBe(null);
      expect(P.accountFromLookupResponse({ author_url: 'https://www.youtube.com/@a/b' })).toBe(null);
      expect(P.accountFromLookupResponse({})).toBe(null);
      expect(P.accountFromLookupResponse(null)).toBe(null);
    });
  });

  describe('normalizeAccountInput', () => {
    it.each([
      ['natgeo', 'instagram.com', 'natgeo'],
      ['@NatGeo', 'instagram.com', 'natgeo'],
      ['https://www.instagram.com/natgeo/?hl=en', 'instagram.com', 'natgeo'],
      ['instagram.com/natgeo', 'instagram.com', 'natgeo'],
      ['https://x.com/NASA', 'x.com', 'nasa'],
      ['https://twitter.com/nasa/status/1', 'x.com', 'nasa'],
      ['https://www.tiktok.com/@natgeo/video/1', 'tiktok.com', 'natgeo'],
      ['https://www.youtube.com/@veritasium/videos', 'youtube.com', 'veritasium'],
      ['@veritasium', 'youtube.com', 'veritasium']
    ])('reads %s on %s as %s', (raw, target, want) => {
      expect(P.normalizeAccountInput(raw, target)).toBe(want);
    });

    it.each([
      ['reels', 'instagram.com'],
      ['https://www.instagram.com/p/abc/', 'instagram.com'],
      ['https://www.youtube.com/natgeo', 'instagram.com'],
      ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'youtube.com'],
      ['this_handle_is_far_too_long_for_x', 'x.com'],
      ['home', 'x.com'],
      ['', 'instagram.com'],
      ['natgeo', 'reddit.com'],
      ['natgeo', 'com.instagram.android']
    ])('refuses %s on %s', (raw, target) => {
      expect(P.normalizeAccountInput(raw, target)).toBe(null);
    });
  });

  it('is offered for the four services it can read, and nothing else', () => {
    for (const t of ['instagram.com', 'x.com', 'twitter.com', 'tiktok.com', 'youtube.com']) {
      expect(P.accountsSupportedFor(t)).toBe(true);
    }
    for (const t of ['reddit.com', 'facebook.com', 'com.instagram.android', '', null]) {
      expect(P.accountsSupportedFor(t)).toBe(false);
    }
  });

  it('counts as a page rule, and rides along in the watched rule', () => {
    expect(P.hasPageRule({ maxGrants: 3 })).toBe(false);
    expect(P.hasPageRule({ allowedAccounts: [] })).toBe(false);
    expect(P.hasPageRule({ allowedAccounts: ['natgeo'] })).toBe(true);
    expect(P.hasPageRule({ scope: 'only', parts: ['instagram:reels'] })).toBe(true);
    expect(P.hasPartRule({ allowedAccounts: ['natgeo'] })).toBe(false);
    expect(P.pageRuleFor({ maxGrants: 3, allowedAccounts: ['@NatGeo'] }))
      .toEqual({ scope: 'all', parts: [], allowedAccounts: ['natgeo'] });
    expect('allowedAccounts' in P.pageRuleFor({ scope: 'only', parts: ['instagram:reels'] })).toBe(false);
  });

  it('calls any addition a loosening, and a removal not', () => {
    expect(P.allowedAccountsEditIsLoosening([], ['natgeo'])).toBe(true);
    expect(P.allowedAccountsEditIsLoosening(['natgeo'], ['natgeo', 'nasa'])).toBe(true);
    expect(P.allowedAccountsEditIsLoosening(['natgeo', 'nasa'], ['nasa'])).toBe(false);
    expect(P.allowedAccountsEditIsLoosening(['natgeo'], ['@NatGeo'])).toBe(false);
    expect(P.allowedAccountsEditIsLoosening(undefined, undefined)).toBe(false);
  });

  it('describes the list the way the row and the coach say it', () => {
    expect(P.describeAllowedAccountsForHuman([], 'instagram.com')).toBe('no accounts are always allowed on instagram.com');
    expect(P.describeAllowedAccountsForHuman(['natgeo'], 'instagram.com')).toBe('@natgeo is always allowed on instagram.com');
    expect(P.describeAllowedAccountsForHuman(['a_1', 'b_2', 'c_3'], 'x.com')).toBe('@a_1, @b_2 and @c_3 are always allowed on x.com');
  });
});

describe('Reddit subreddit and post allowlists', () => {
  const POST = 'https://www.reddit.com/r/rust/comments/abc123/why_is_it_fast/';
  it('accepts a subreddit name or link and a post link, with their identities normalized', () => {
    expect(P.normalizeSubredditInput('r/Rust')).toBe('rust');
    expect(P.normalizeSubredditInput('https://old.reddit.com/r/Rust/')).toBe('rust');
    expect(P.normalizeRedditPostInput(POST)).toBe('rust:abc123');
    expect(P.normalizeRedditPostInput('reddit.com/r/rust/comments/ABC123')).toBe('rust:abc123');
  });

  it('opens the whole allowed subreddit, including its posts, on Reddit hosts only', () => {
    const entry = { allowedSubreddits: ['rust'] };
    expect(P.resolvePartVerdict(entry, POST).gated).toBe(false);
    expect(P.resolvePartVerdict(entry, 'https://old.reddit.com/r/rust/').gated).toBe(false);
    expect(P.resolvePartVerdict(entry, 'https://www.reddit.com/r/cats/').gated).toBe(true);
    expect(P.resolvePartVerdict(entry, 'https://reddit.com.evil.test/r/rust/').gated).toBe(true);
  });

  it('opens one post without opening the subreddit or another post', () => {
    const entry = { allowedRedditPosts: ['rust:abc123'] };
    expect(P.resolvePartVerdict(entry, POST).gated).toBe(false);
    expect(P.resolvePartVerdict(entry, 'https://reddit.com/r/rust/comments/abc123/why_is_it_fast/?sort=new').gated).toBe(false);
    expect(P.resolvePartVerdict(entry, 'https://reddit.com/r/rust/').gated).toBe(true);
    expect(P.resolvePartVerdict(entry, 'https://reddit.com/r/rust/comments/def456/').gated).toBe(true);
    expect(P.resolvePartVerdict(entry, 'https://reddit.com/r/cats/comments/abc123/').gated).toBe(true);
    expect(P.resolvePartVerdict(entry, 'https://reddit.com/comments/abc123/').gated).toBe(true);
  });

  it('rejects broad feeds and malformed lists, and carries the lists into the page watcher', () => {
    expect(P.normalizeSubredditInput('r/all')).toBe(null);
    expect(P.normalizeSubredditInput('https://www.reddit.com/r/popular/')).toBe(null);
    expect(P.normalizeRedditPostInput('https://reddit.com/r/rust/')).toBe(null);
    expect(P.normalizeRedditPostInput('https://reddit.com.evil.test/r/rust/comments/abc123')).toBe(null);
    const entry = { allowedSubreddits: ['RUST', 'rust', 'all', '../cats'], allowedRedditPosts: ['RUST:ABC123', 'cats:bad/id'] };
    expect(P.pageRuleFor(entry)).toEqual({ scope: 'all', parts: [], allowedSubreddits: ['rust'], allowedRedditPosts: ['rust:abc123'] });
    expect(P.hasPageRule(entry)).toBe(true);
    expect(P.hasPartRule(entry)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 5. No copy has come back, and no dependency has crept in
// ---------------------------------------------------------------------------
//
// The same guard tests/rules.test.js carries, for the same reason. The target
// rule resolution was written out three times before rules.js existed, held
// together by "change one, change all three" comments, and had drifted anyway.
// These two verdicts run in three global scopes and would go the same way.

describe('the part and page-scope verdicts live in exactly one file', () => {
  const SHARED = join(REPO_ROOT, 'shared');
  const sources = readdirSync(SHARED)
    .filter(f => f.endsWith('.js'))
    .map(f => ({ file: f, code: readFileSync(join(SHARED, f), 'utf8') }));
  const stripComments = (code) => code.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');

  it('reads the shared sources at all (guards this test against a move)', () => {
    expect(sources.length).toBeGreaterThan(5);
    expect(sources.some(s => s.file === 'parts.js')).toBe(true);
  });

  it.each([
    'PART_CATALOGUE',
    'PART_ID_RE',
    'parsePartId',
    'partLabel',
    'partsForService',
    'normalizePartInput',
    'partMatchesUrl',
    'resolvePartVerdict',
    'hasPartRule',
    'describeScopeForHuman',
    'sanitizePartRule',
    'partEditIsLoosening',
    'DESTINATION_SPECIFICITY',
    'destinationSpecificity',
    'pageScopeKeyFor',
    'pageScopeFor',
    'sessionCoversUrl',
    'dnrUrlFilterFor',
    'SCOPE_SUPPORTED_HOSTS',
    'SCOPE_HOSTS_TO_VERIFY',
    'ACCOUNT_SERVICES',
    'sanitizeAllowedAccounts',
    'normalizeAccountInput',
    'allowedAccountForUrl',
    'accountLookupFor',
    'accountFromLookupResponse',
    'hasPageRule',
    'pageRuleFor',
    'allowedAccountsEditIsLoosening'
  ])('%s is declared only in parts.js', (name) => {
    const declaration = new RegExp(`^\\s*(?:const|let|var|function|async function)\\s+${name}\\b`, 'm');
    const declaring = sources.filter(s => declaration.test(s.code)).map(s => s.file);
    expect(declaring).toEqual(['parts.js']);
  });

  // A re-inlined copy would not reuse the names above, so name the moves that
  // give one away instead. Passing a scope value along ('only' as an argument,
  // in a data attribute, in the options row's three buttons) is fine and
  // expected; COMPARING against one is deciding the semantics, and that
  // decision belongs to resolvePartVerdict alone.
  const SCOPE_DECISION = /(?:[=!]==?\s*['"](?:only|except)['"])|(?:['"](?:only|except)['"]\s*[=!]==?)|(?:case\s+['"](?:only|except)['"])/;

  it('only parts.js decides what a scope value means', () => {
    const offenders = sources
      .filter(s => s.file !== 'parts.js')
      .filter(s => SCOPE_DECISION.test(stripComments(s.code)))
      .map(s => s.file);
    expect(offenders).toEqual([]);
  });

  // The page-scope key is the identity of a page. Minting one anywhere else,
  // or comparing one by hand, is the same mistake in the other vocabulary.
  const KEY_MINTING = /['"`](?:yt:video|reddit:post|x:status|ig:p|tt:video|gh:|url:)/;
  const KEY_COMPARISON = /\.scope\s*(?:\?\.|\.)\s*key\s*[=!]==?/;

  it('only parts.js mints or compares a page-scope key', () => {
    const minting = sources
      .filter(s => s.file !== 'parts.js')
      .filter(s => KEY_MINTING.test(stripComments(s.code)) || KEY_COMPARISON.test(stripComments(s.code)))
      .map(s => s.file);
    expect(minting).toEqual([]);
  });

  // A guard that cannot fail is not a guard: each fingerprint has to still
  // match the code it was written against, and the copies it was written to
  // catch.
  it('would have caught the copies these guards exist to prevent', () => {
    expect(SCOPE_DECISION.test("if (entry.scope === 'only') return !!match;")).toBe(true);
    expect(SCOPE_DECISION.test("switch (scope) { case 'except': return !match; }")).toBe(true);
    expect(SCOPE_DECISION.test("applyScope('only')")).toBe(false);
    expect(KEY_MINTING.test('return `yt:video:${id}`;')).toBe(true);
    expect(KEY_COMPARISON.test("if (session.scope.key === pageKey) return true;")).toBe(true);
    const parts = sources.find(s => s.file === 'parts.js').code;
    expect(SCOPE_DECISION.test(stripComments(parts))).toBe(true);
    expect(KEY_MINTING.test(stripComments(parts))).toBe(true);
  });

  // parts.js runs in a content script on every page the user visits, and in a
  // WebView on Android. It must stay a pure function of its arguments: the
  // moment it reads storage it stops being usable from the one context that
  // has to answer with the worker dead.
  it('reads no storage, touches no chrome API and builds no DOM', () => {
    const code = stripComments(readFileSync(join(VARIANTS.chrome, 'parts.js'), 'utf8'));
    expect(code).not.toMatch(/\bchrome\b/);
    expect(code).not.toMatch(/\bbrowser\b/);
    expect(code).not.toMatch(/\bdocument\b|\bwindow\b|createElement/);
    expect(code).not.toMatch(/\bawait\b|\bfetch\b|\bPromise\b/);
  });

  // The C0 hazard, asserted rather than remembered. options.html loads
  // parts.js but not page_context.js, and the Android background WebView
  // ("Intention Android/app/src/main/assets/background.html") loads neither —
  // so a reference to one of their globals is a ReferenceError on exactly one
  // platform, in the context nobody runs locally. eslint checks one context at
  // a time and cannot see it.
  it.each(['page_context.js', 'sites.js'])('references nothing declared in %s', (file) => {
    const declaration = /^(?:const|let|var|function|async function|class)\s+([A-Za-z_$][\w$]*)/gm;
    const other = readFileSync(join(SHARED, file), 'utf8');
    const mine = stripComments(readFileSync(join(SHARED, 'parts.js'), 'utf8'));
    const offenders = [];
    let m;
    while ((m = declaration.exec(other)) !== null) {
      if (new RegExp(`\\b${m[1]}\\b`).test(mine)) offenders.push(m[1]);
    }
    expect(offenders).toEqual([]);
  });

  // Every context that can gate a page has to be able to reach the verdicts.
  // A file loaded into one of them but not the others is how the copies got
  // written in the first place.
  it('is loaded into content, background and options — and deliberately not coaching', () => {
    const manifest = JSON.parse(readFileSync(join(VARIANTS.chrome, 'manifest.json'), 'utf8'));
    const firefox = JSON.parse(readFileSync(join(VARIANTS.firefox, 'manifest.json'), 'utf8'));

    expect(manifest.content_scripts[0].js).toContain('parts.js');
    expect(firefox.background.scripts).toContain('parts.js');
    expect(readFileSync(join(VARIANTS.chrome, 'options.html'), 'utf8')).toContain('src="parts.js"');
    // Chrome's worker pulls its own dependencies in rather than listing them.
    expect(readFileSync(join(VARIANTS.chrome, 'background.js'), 'utf8'))
      .toMatch(/importScripts\('parts\.js'/);
    // coaching.js never calls any of this, so adding it there would report
    // every export as dead in the cross-file "used" check.
    expect(readFileSync(join(VARIANTS.chrome, 'coaching.html'), 'utf8')).not.toContain('parts.js');
  });

  // The Android background WebView keeps its own hand-maintained page that
  // scripts/sync.sh does not touch, so it is the one registration nothing
  // automatic will do for you.
  it('is loaded by the hand-maintained Android background page', () => {
    const html = readFileSync(
      join(REPO_ROOT, 'Intention Android', 'app', 'src', 'main', 'assets', 'background.html'),
      'utf8'
    );
    expect(html).toMatch(/<script src="parts\.js"><\/script>[\s\S]*<script src="sites\.js">/);
  });
});
