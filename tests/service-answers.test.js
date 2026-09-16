// The wizard's answer catalogue — ~90 objects of copy, and copy is where this
// will rot. Nothing here tests logic that a reader would call interesting; it
// tests the properties the rendering and the prose composition quietly rely
// on, which is exactly the kind of thing that survives being eyeballed once
// and then breaks the day someone adds a site to COMMON_SITES.
//
// Four of them are load-bearing:
//   * every catalogued site and app has an entry, or a blocked service falls
//     back to four generic chips for no reason;
//   * every needs list ends with exactly one "nothing" chip, because that chip
//     is exclusive and its exclusivity is meaningless if it can be missing,
//     duplicated, or anywhere but last;
//   * labels stay short enough to render on a 320px phone;
//   * `coach` fragments compose into a grammatical sentence, because
//     composeServiceReason joins several of them with "; " and capitalises
//     only the first.

import { describe, it, expect, beforeAll } from 'vitest';
import { loadSource } from './load.js';

let S;
beforeAll(() => {
  S = loadSource('sites.js');
});

// A chip that wraps to two lines makes a wrapping row of them ragged, and at
// 320px that is most of the screen. Measured rather than eyeballed.
const LABEL_MAX = 34;

const allEntries = () => Object.entries(S.SERVICE_ANSWERS)
  .concat([['(fallback)', S.SERVICE_ANSWERS_FALLBACK]]);

// Every chip the catalogue can ever render, needs and costs, including the
// appended "nothing" one.
const allChips = () => {
  const out = [];
  for (const key of Object.keys(S.SERVICE_ANSWERS).concat(['some-blog.example'])) {
    const catalogue = S.serviceAnswerCatalogue(key);
    for (const chip of catalogue.needs) out.push({ key, bucket: 'needs', chip });
    for (const chip of catalogue.costs) out.push({ key, bucket: 'costs', chip });
  }
  return out;
};

describe('catalogue coverage', () => {
  it('has an entry for every site the wizard suggests', () => {
    const missing = S.COMMON_SITES.filter(site => !S.SERVICE_ANSWERS[site]);
    expect(missing).toEqual([]);
  });

  // An Android package resolves through serviceKeyFor, so covering every
  // APP_ICON_SITE *value* is what makes one card ask for a site and its app.
  it('has an entry for every app that folds onto a website', () => {
    const missing = [...new Set(Object.values(S.APP_ICON_SITE))].filter(site => !S.SERVICE_ANSWERS[site]);
    expect(missing).toEqual([]);
  });

  it('resolves an Android package onto its website entry rather than the fallback', () => {
    expect(S.serviceAnswerCatalogue('com.instagram.android'))
      .toEqual(S.serviceAnswerCatalogue('instagram.com'));
  });

  it('falls back for a hand-typed domain and for an app it has never heard of', () => {
    for (const key of ['some-blog.example', 'com.some.unknown']) {
      expect(S.serviceAnswerCatalogue(key).feed, key).toBe(S.SERVICE_ANSWERS_FALLBACK.feed);
    }
  });

  it('gives every entry a feed to push back on', () => {
    for (const [key, entry] of allEntries()) {
      expect(typeof entry.feed, key).toBe('string');
      expect(entry.feed.trim(), key).not.toBe('');
    }
  });
});

describe('the needs list', () => {
  it('ends with exactly one "nothing" chip, everywhere', () => {
    for (const key of Object.keys(S.SERVICE_ANSWERS).concat(['some-blog.example'])) {
      const needs = S.serviceAnswerCatalogue(key).needs;
      const nones = needs.filter(chip => chip.id === S.NEED_NONE_ID);
      expect(nones.length, key).toBe(1);
      expect(needs[needs.length - 1].id, key).toBe(S.NEED_NONE_ID);
    }
  });

  // Two is not a choice and six is a menu. The "nothing" chip is appended on
  // top of these.
  it('offers between two and five real reasons before it', () => {
    for (const key of Object.keys(S.SERVICE_ANSWERS).concat(['some-blog.example'])) {
      const real = S.serviceAnswerCatalogue(key).needs.length - 1;
      expect(real, key).toBeGreaterThanOrEqual(2);
      expect(real, key).toBeLessThanOrEqual(5);
    }
  });

  it('never repeats a chip id within one list', () => {
    for (const key of Object.keys(S.SERVICE_ANSWERS).concat(['some-blog.example'])) {
      const catalogue = S.serviceAnswerCatalogue(key);
      for (const bucket of ['needs', 'costs']) {
        const ids = catalogue[bucket].map(chip => chip.id);
        expect(new Set(ids).size, `${key} ${bucket}`).toBe(ids.length);
      }
    }
  });
});

describe('chip copy', () => {
  it('gives every chip a label short enough to render on a phone', () => {
    const tooLong = allChips()
      .filter(({ chip }) => chip.label.length > LABEL_MAX)
      .map(({ key, chip }) => `${key}: ${chip.label} (${chip.label.length})`);
    expect(tooLong).toEqual([]);
  });

  it('gives every real chip something for the coach to read', () => {
    for (const { key, bucket, chip } of allChips()) {
      if (chip.id === S.NEED_NONE_ID) continue;
      expect(chip.label.trim(), `${key} ${bucket} ${chip.id}`).not.toBe('');
      expect(chip.coach.trim(), `${key} ${bucket} ${chip.id}`).not.toBe('');
    }
  });

  // Only the needs chips feed the preview line; the cost chips are never said
  // back in the second person.
  it('gives every needs chip a second-person phrase for the preview', () => {
    for (const { key, bucket, chip } of allChips()) {
      if (bucket !== 'needs' || chip.id === S.NEED_NONE_ID) continue;
      expect(chip.you.trim(), `${key} ${chip.id}`).not.toBe('');
    }
  });

  // composeServiceReason joins fragments with "; " and capitalises only the
  // first, so a fragment that starts with a capital reads as a new sentence in
  // the middle of one. The pronoun "I" is the one honest exception.
  it('starts every coach fragment lower-case, or with the pronoun I', () => {
    const wrong = allChips()
      .filter(({ chip }) => chip.coach)
      .filter(({ chip }) => /^[A-Z]/.test(chip.coach) && !/^I\b|^I'/.test(chip.coach))
      .map(({ key, chip }) => `${key}: ${chip.coach}`);
    expect(wrong).toEqual([]);
  });

  it('ends no coach fragment with punctuation the join would double up', () => {
    const wrong = allChips()
      .filter(({ chip }) => /[.,;!?]$/.test(chip.coach || ''))
      .map(({ key, chip }) => `${key}: ${chip.coach}`);
    expect(wrong).toEqual([]);
  });
});

describe('composeServiceReason', () => {
  it('joins several taps into one sentence rather than several', () => {
    const { purpose, legitimateUse } = S.composeServiceReason('instagram.com', {
      needs: ['dm', 'sent'], costs: ['hours', 'auto'], needsNote: '', costsNote: ''
    });
    expect(legitimateUse).toBe('Replying to a specific DM; opening a link someone actually sent me.');
    expect(purpose).toBe('It eats hours I meant to spend elsewhere; I open it without ever deciding to.');
  });

  it('adds the free-text refinement as its own sentence, punctuated', () => {
    const { legitimateUse } = S.composeServiceReason('instagram.com', {
      needs: ['dm'], costs: [], needsNote: 'Only my sister', costsNote: ''
    });
    expect(legitimateUse).toBe('Replying to a specific DM. Only my sister.');
  });

  it('does not double a full stop the user typed themselves', () => {
    const { purpose } = S.composeServiceReason('reddit.com', {
      needs: [], costs: [], needsNote: '', costsNote: 'It eats my evening.'
    });
    expect(purpose).toBe('It eats my evening.');
  });

  it('says the "nothing" answer out loud instead of returning empty', () => {
    const { legitimateUse } = S.composeServiceReason('instagram.com', {
      needs: ['none'], costs: [], needsNote: '', costsNote: ''
    });
    expect(legitimateUse).toBe("Nothing. I don't actually need it.");
  });

  it('composes nothing at all from nothing at all, so the key is dropped', () => {
    expect(S.composeServiceReason('instagram.com', { needs: [], costs: [] }))
      .toEqual({ purpose: '', legitimateUse: '' });
    expect(S.composeServiceReason('instagram.com', undefined))
      .toEqual({ purpose: '', legitimateUse: '' });
  });

  // A draft written before a chip was renamed must not compose the id itself
  // into the prose the coach reads.
  it('drops a chip id it no longer recognises', () => {
    const { legitimateUse } = S.composeServiceReason('instagram.com', {
      needs: ['dm', 'chip-that-was-renamed'], costs: []
    });
    expect(legitimateUse).toBe('Replying to a specific DM.');
  });

  // Every catalogued service, every chip, one at a time: the composed sentence
  // has to start with a capital and end with a full stop, or the coach is
  // handed a fragment.
  it('produces a grammatical sentence for every chip in the catalogue', () => {
    for (const { key, bucket, chip } of allChips()) {
      if (chip.id === S.NEED_NONE_ID) continue;
      const field = bucket === 'needs' ? 'legitimateUse' : 'purpose';
      const composed = S.composeServiceReason(key, { needs: [], costs: [], [bucket]: [chip.id] })[field];
      expect(composed, `${key} ${bucket} ${chip.id}`).toMatch(/^[A-Z].*\.$/);
    }
  });
});

describe('serviceAnswerChip', () => {
  it('finds a chip in either bucket', () => {
    expect(S.serviceAnswerChip('instagram.com', 'needs', 'dm').label).toBe('Replying to DMs');
    expect(S.serviceAnswerChip('instagram.com', 'costs', 'hours').label).toBe('It eats hours');
  });

  it('returns null rather than throwing for anything it does not hold', () => {
    expect(S.serviceAnswerChip('instagram.com', 'needs', 'nope')).toBe(null);
    expect(S.serviceAnswerChip('instagram.com', 'costs', 'dm')).toBe(null);
    expect(S.serviceAnswerChip('nothing.example', 'needs', 'creator')).toBe(null);
  });
});
