// options.js — accepting a website onto the blocklist.
//
// Normalisation used to be the whole of it: strip a scheme, a www., a path,
// and whatever was left became a "blocked domain". So "asdf" was accepted
// happily and then never matched a page again, which looks exactly like the
// extension being broken rather than the entry being wrong.
//
// options.js is a browser script with no exports, so it is evaluated in a vm
// against a stub thin enough to get past load — the functions under test are
// pure string work and touch none of it.

import { describe, it, expect, beforeAll } from 'vitest';
import { join } from 'node:path';
import vm from 'node:vm';
import { VARIANTS, bundleForContext } from './load.js';

let ctx;

beforeAll(() => {
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    document: { addEventListener() {}, getElementById: () => null },
    window: {},
    localStorage: { getItem: () => null, setItem() {} },
    chrome: { runtime: { getURL: (p) => p, sendMessage() {} }, storage: { local: { get() {}, set() {}, remove() {} } } },
    Date, Math, JSON, Promise, Error, Object, Array, String, Number, RegExp, isNaN, parseInt,
    setTimeout, clearTimeout, URL, URLSearchParams, fetch: async () => ({ ok: false })
  };
  sandbox.globalThis = sandbox;
  // Same order options.html loads them in, read from the page itself —
  // options.js resolves service groups through sites.js and target rules
  // through rules.js, so both have to be in scope. billing.js and report.js
  // are dropped: neither is reachable from the pure string work under test,
  // and both want a DOM this stub does not pretend to have.
  const source = bundleForContext('options', {
    only: ['sites.js', 'providers.js', 'rules.js', 'options.js']
  });
  ctx = vm.createContext(sandbox);
  vm.runInContext(source, ctx, { filename: join(VARIANTS.chrome, 'options.js') });
});

const normalize = (raw) => ctx.normalizeDomainInput(raw);
const accepts = (raw) => ctx.isBlockableDomain(ctx.normalizeDomainInput(raw));

// The wizard's own state lives in `let`s at the top of options.js, which a vm
// script keeps in its lexical scope rather than on the context object — so the
// setup has to be assigned from inside the context too.
const withSetupState = (state) => vm.runInContext(`
  setupBlockedDomains = ${JSON.stringify(state.domains || [])};
  setupBlockedApps = ${JSON.stringify(state.apps || [])};
  setupIOSSelectionCount = ${Number(state.iosPicks || 0)};
  setupHasSomethingBlocked();
`, ctx);

describe('finishing the wizard with nothing blocked', () => {
  it('refuses an empty list — the install would silently do nothing', () => {
    expect(withSetupState({})).toBe(false);
  });

  it('accepts one website', () => {
    expect(withSetupState({ domains: ['twitter.com'] })).toBe(true);
  });

  it('accepts apps alone, with no websites', () => {
    expect(withSetupState({ apps: ['com.instagram.android'] })).toBe(true);
  });

  // On iOS the app list is Apple's, and a count is the only thing the web
  // layer is ever told about it.
  it('accepts an iOS Screen Time selection it can only count', () => {
    expect(withSetupState({ iosPicks: 3 })).toBe(true);
  });

  it('still refuses when the iOS picker was opened but nothing was chosen', () => {
    expect(withSetupState({ iosPicks: 0 })).toBe(false);
  });
});

describe('normalizeDomainInput', () => {
  it('strips a scheme, a www. and a path', () => {
    expect(normalize('https://www.twitter.com/home')).toBe('twitter.com');
  });

  it('strips a query string, a fragment and a port', () => {
    expect(normalize('http://reddit.com:8080/r/all?sort=new#top')).toBe('reddit.com');
  });

  it('trims and lowercases', () => {
    expect(normalize('  YouTube.COM  ')).toBe('youtube.com');
  });
});

describe('which entries are accepted onto the blocklist', () => {
  it.each([
    'twitter.com',
    'https://www.youtube.com/feed/subscriptions',
    'news.ycombinator.com',
    'x.co',
    'my-site.co.uk'
  ])('accepts %s', (raw) => {
    expect(accepts(raw)).toBe(true);
  });

  it.each([
    ['asdf', 'no dot at all — the case that used to sail through'],
    ['', 'empty'],
    ['   ', 'whitespace only'],
    ['.com', 'no label before the dot'],
    ['twitter.', 'trailing dot, no TLD'],
    ['twitter..com', 'empty label'],
    ['-twitter.com', 'label starting with a hyphen'],
    ['twitter.c', 'one-character TLD'],
    ['twitter.123', 'numeric TLD'],
    ['spaced out.com', 'a space inside the hostname']
  ])('rejects %s (%s)', (raw) => {
    expect(accepts(raw)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The step order stopped being a fixed list of section ids the moment the
// wizard grew a screen per selected service. These are the seams that broke
// when it did: an id that now repeats, a length that depends on the
// blocklist, and a draft that used to store a bare index.
// ---------------------------------------------------------------------------

// HAS_APP_BLOCKING and friends are consts captured at load, so the platform is
// whatever the stub said (no window.intentionApps → browser build).
const orderFor = (state) => vm.runInContext(`
  setupBlockedDomains = ${JSON.stringify(state.domains || [])};
  setupBlockedApps = ${JSON.stringify(state.apps || [])};
  setupAppLabels = ${JSON.stringify(state.appLabels || {})};
  JSON.stringify(computeStepOrder());
`, ctx);

describe('computeStepOrder', () => {
  it('adds one purpose step per service, between the global why and the mode', () => {
    const order = JSON.parse(orderFor({ domains: ['reddit.com', 'x.com'] }));
    expect(order.map(s => s.id)).toEqual([
      'setup-step-welcome',
      'setup-step-sites',
      'setup-step-why',
      'setup-step-purpose',
      'setup-step-purpose',
      'setup-step-mode',
      'setup-step-access',
      'setup-step-done'
    ]);
    expect(order.filter(s => s.group).map(s => s.group)).toEqual(['reddit.com', 'x.com']);
  });

  it('asks once for a site and its app, not twice', () => {
    const order = JSON.parse(orderFor({
      domains: ['instagram.com'],
      apps: ['com.instagram.android'],
      appLabels: { 'com.instagram.android': 'Instagram' }
    }));
    expect(order.filter(s => s.group).map(s => s.group)).toEqual(['instagram.com']);
  });

  it('has no purpose steps at all for an empty blocklist', () => {
    const order = JSON.parse(orderFor({}));
    expect(order.some(s => s.group)).toBe(false);
  });

  // The wizard's own guard is that the access step is unconditionally in the
  // order, so toggling Coach/Simple can't move the denominator. The purpose
  // steps have to hold the same line.
  it('keeps the questions in simple mode, where nothing will read them', () => {
    const coach = JSON.parse(vm.runInContext(`
      setupBlockedDomains = ['reddit.com']; setupBlockedApps = [];
      setupBlockingMode = 'coach'; JSON.stringify(computeStepOrder());
    `, ctx));
    const simple = JSON.parse(vm.runInContext(`
      setupBlockingMode = 'simple'; JSON.stringify(computeStepOrder());
    `, ctx));
    expect(simple).toEqual(coach);
  });

  it('every id it can emit is one the wizard test already checks exists', () => {
    const order = JSON.parse(orderFor({ domains: ['reddit.com'] }));
    for (const step of order) expect(step.id).toMatch(/^setup-step-[a-z-]+$/);
  });
});

describe('collectServiceReasons', () => {
  const collect = (state) => vm.runInContext(`
    setupBlockedDomains = ${JSON.stringify(state.domains || [])};
    setupBlockedApps = ${JSON.stringify(state.apps || [])};
    setupAppLabels = {};
    setupServiceReasons = ${JSON.stringify(state.reasons || {})};
    JSON.stringify(collectServiceReasons());
  `, ctx);

  it('keeps what was written', () => {
    const out = JSON.parse(collect({
      domains: ['reddit.com'],
      reasons: { 'reddit.com': { purpose: 'Two niche subs.', legitimateUse: '' } }
    }));
    expect(out['reddit.com'].purpose).toBe('Two niche subs.');
  });

  it('drops an answer left blank — no answer and a blank answer are the same', () => {
    const out = JSON.parse(collect({
      domains: ['reddit.com'],
      reasons: { 'reddit.com': { purpose: '   ', legitimateUse: '' } }
    }));
    expect(out).toEqual({});
  });

  // Answer, go back, remove the site, finish: the answer must not survive as a
  // key for something no longer blocked.
  it('drops an answer for a service since removed from the list', () => {
    const out = JSON.parse(collect({
      domains: ['x.com'],
      reasons: { 'reddit.com': { purpose: 'Two niche subs.' } }
    }));
    expect(out).toEqual({});
  });

  it('files an app answer under the site it shares an identity with', () => {
    const out = JSON.parse(collect({
      domains: [],
      apps: ['com.instagram.android'],
      reasons: { 'instagram.com': { purpose: 'DMs only.' } }
    }));
    expect(Object.keys(out)).toEqual(['instagram.com']);
  });
});

// The brand suggestion chips used to sit permanently in the Blocked sites
// card, with no minutes field anywhere near them, so every chip added at a
// hard-coded 10 min/day. They now live in the Add-website dialog, beside the
// field the Add button already reads — so a chip and the button have to agree
// on the number that was just typed.
describe('currentAddSiteLimit', () => {
  const withField = (value) => {
    const previous = ctx.document.getElementById;
    ctx.document.getElementById = (id) => (id === 'domain-limit-input' ? { value } : null);
    try {
      return ctx.currentAddSiteLimit();
    } finally {
      ctx.document.getElementById = previous;
    }
  };

  it("takes the dialog's minutes field at its word", () => {
    expect(withField('25')).toBe(25);
    expect(withField('1')).toBe(1);
  });

  // The same fallback addDomain() applies on the typed path, so the two routes
  // into the blocklist can't disagree about what an empty box means.
  it('falls back to 10 on anything blank, junk or non-positive', () => {
    for (const value of ['', '   ', 'abc', '0', '-5']) {
      expect(withField(value), value).toBe(10);
    }
  });

  // The setup wizard renders its own chip grid inline, and the dialog's field
  // is not always in the document the wizard is looking at; reading a missing
  // field must not throw there.
  it('falls back to 10 when the field is not on the page at all', () => {
    expect(ctx.currentAddSiteLimit()).toBe(10);
  });
});
