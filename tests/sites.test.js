// The site/app identity layer. `instagram.com` and `com.instagram.android` are
// two independent blocked targets everywhere else in the product — separate
// minute budgets, separate grant counts, separate transcripts — and that
// separation is load-bearing (getLimitsForDomain relies on domainLimits and
// appLimits being a disjoint namespace). The one thing they share is what the
// user said the service is *for*, and this is where that sharing is decided.

import { describe, it, expect, beforeAll } from 'vitest';
import { loadSource } from './load.js';

let S;
beforeAll(() => {
  S = loadSource('sites.js');
});

describe('serviceKeyFor', () => {
  it('folds a known package onto its website', () => {
    expect(S.serviceKeyFor('com.instagram.android')).toBe('instagram.com');
    expect(S.serviceKeyFor('com.zhiliaoapp.musically')).toBe('tiktok.com');
    expect(S.serviceKeyFor('com.twitter.android')).toBe('x.com');
  });

  it('leaves a hostname as itself, so one lookup serves both gate paths', () => {
    expect(S.serviceKeyFor('instagram.com')).toBe('instagram.com');
    expect(S.serviceKeyFor('some-blog.example')).toBe('some-blog.example');
  });

  it('gives an unknown package its own identity rather than a null one', () => {
    expect(S.serviceKeyFor('com.example.unknown')).toBe('com.example.unknown');
  });

  it('never throws on the empty and nullish cases', () => {
    expect(S.serviceKeyFor(undefined)).toBe('');
    expect(S.serviceKeyFor(null)).toBe('');
    expect(S.serviceKeyFor('')).toBe('');
  });
});

describe('buildServiceGroups', () => {
  it('merges a site and its app into one group', () => {
    const groups = S.buildServiceGroups({
      domains: ['instagram.com'],
      apps: ['com.instagram.android'],
      appLabels: { 'com.instagram.android': 'Instagram' }
    });
    expect(groups).toHaveLength(1);
    expect(groups[0].key).toBe('instagram.com');
    expect(groups[0].domains).toEqual(['instagram.com']);
    expect(groups[0].apps).toEqual(['com.instagram.android']);
  });

  it('leaves an unpaired app standing alone', () => {
    const groups = S.buildServiceGroups({
      domains: ['instagram.com'],
      apps: ['com.snapchat.android'],
      appLabels: { 'com.snapchat.android': 'Snapchat' }
    });
    expect(groups.map(g => g.key)).toEqual(['instagram.com', 'com.snapchat.android']);
  });

  it('preserves selection order, apps first where the wizard asks first', () => {
    const args = {
      domains: ['reddit.com', 'x.com'],
      apps: ['com.snapchat.android'],
      appLabels: {}
    };
    expect(S.buildServiceGroups(args).map(g => g.key))
      .toEqual(['reddit.com', 'x.com', 'com.snapchat.android']);
    expect(S.buildServiceGroups({ ...args, appsFirst: true }).map(g => g.key))
      .toEqual(['com.snapchat.android', 'reddit.com', 'x.com']);
  });

  it('does not duplicate a target listed twice', () => {
    const groups = S.buildServiceGroups({ domains: ['x.com', 'x.com'], apps: [] });
    expect(groups).toHaveLength(1);
    expect(groups[0].domains).toEqual(['x.com']);
  });

  it('returns nothing for an empty blocklist, and tolerates no arguments', () => {
    expect(S.buildServiceGroups({ domains: [], apps: [] })).toEqual([]);
    expect(S.buildServiceGroups()).toEqual([]);
  });
});

describe('group labels', () => {
  it('prefers the catalogue name', () => {
    const [g] = S.buildServiceGroups({ domains: ['news.ycombinator.com'], apps: [] });
    expect(g.label).toBe('Hacker News');
  });

  it('falls back to the label the native bridge reported', () => {
    const [g] = S.buildServiceGroups({
      domains: [],
      apps: ['com.example.unknown'],
      appLabels: { 'com.example.unknown': 'Some App' }
    });
    expect(g.label).toBe('Some App');
  });

  it('falls back to the raw key for a hand-typed domain', () => {
    const [g] = S.buildServiceGroups({ domains: ['some-blog.example'], apps: [] });
    expect(g.label).toBe('some-blog.example');
  });
});

// This line is the whole explanation the user gets for why two things they
// picked separately are asking them one set of questions.
describe('serviceMembersLabel', () => {
  it('names both members of a merged service', () => {
    const [g] = S.buildServiceGroups({
      domains: ['instagram.com'],
      apps: ['com.instagram.android'],
      appLabels: { 'com.instagram.android': 'Instagram' }
    });
    expect(S.serviceMembersLabel(g, { 'com.instagram.android': 'Instagram' }))
      .toBe('instagram.com and the Instagram app');
  });

  it('says nothing extra when the service is one thing', () => {
    const [g] = S.buildServiceGroups({ domains: ['reddit.com'], apps: [] });
    expect(S.serviceMembersLabel(g, {})).toBe('reddit.com');
  });

  it('still names an app whose label the bridge never gave us', () => {
    const [g] = S.buildServiceGroups({ domains: [], apps: ['com.example.unknown'] });
    expect(S.serviceMembersLabel(g, {})).toBe('com.example.unknown');
  });
});
