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
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { VARIANTS } from './load.js';

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
  const source = ['providers.js', 'options.js']
    .map(f => readFileSync(join(VARIANTS.chrome, f), 'utf8'))
    .join('\n;\n');
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
