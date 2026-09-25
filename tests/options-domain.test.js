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
import vm from 'node:vm';
import { evaluateScripts, filesForContext } from './load.js';

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
  // Same order options.html loads them in, read from the page itself.
  // billing.js and report.js are dropped: neither is reachable from the
  // pure string work under test, and both want a DOM this stub does not
  // pretend to have. An exclusion rather than a list, so a script added to
  // the page reaches these tests too.
  ctx = vm.createContext(sandbox);
  evaluateScripts(ctx, filesForContext('options', { except: ['billing.js', 'report.js'] }));
});

const normalize = (raw) => ctx.normalizeDomainInput(raw);
const accepts = (raw) => ctx.isBlockableDomain(ctx.normalizeDomainInput(raw));

describe('uninstall flow without settings removal sections', () => {
  it('keeps the unsupported platform exit functional without a removal card', async () => {
    const originalSend = ctx.sendBg;
    const alerts = [];
    ctx.sendBg = async message => {
      expect(message.action).toBe('completeRemoval');
      return { reason: 'unsupported' };
    };
    ctx.window.alert = message => alerts.push(message);
    try {
      await ctx.finishRemoval();
      expect(alerts).toEqual(['Remove Intention from your browser’s Extensions settings.']);
    } finally {
      ctx.sendBg = originalSend;
      delete ctx.window.alert;
    }
  });

  it('goes straight to removal after coach approval without reading a removed card', async () => {
    const originalConfig = ctx.getConfig;
    const originalSend = ctx.sendBg;
    const originalLoosen = ctx.requestLoosening;
    const calls = [];
    let conversation;
    ctx.getConfig = async () => ({ leaveDelayMinutes: 0 });
    ctx.requestLoosening = args => { conversation = args; };
    ctx.sendBg = async message => {
      calls.push(message.action);
      return message.action === 'getLeaveState' ? { leaveRequest: null } : { reason: 'declined' };
    };
    try {
      await ctx.openLeaveConversation();
      expect(conversation.changeType).toBe('uninstall');
      await conversation.onApproved();
      expect(calls).toEqual(['getLeaveState', 'completeRemoval']);
    } finally {
      ctx.getConfig = originalConfig;
      ctx.sendBg = originalSend;
      ctx.requestLoosening = originalLoosen;
    }
  });
});

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
// The page order. One question per page: the intention pages follow the
// blocklist, and the purpose pages exist only once the user says yes to them.
// HAS_APP_BLOCKING and friends are consts captured at load, so the platform is
// whatever the stub said (no window.intentionApps → browser build).
// ---------------------------------------------------------------------------

describe('computeStepOrder', () => {
  const withReasons = (state, wants) => JSON.parse(vm.runInContext(`
    setupBlockedDomains = ${JSON.stringify(state.domains || [])};
    setupBlockedApps = ${JSON.stringify(state.apps || [])};
    setupAppLabels = ${JSON.stringify(state.appLabels || {})};
    setupWantsReasons = ${JSON.stringify(wants)};
    JSON.stringify(computeStepOrder());
  `, ctx));

  it('asks one intention per site, then offers the purpose pages', () => {
    expect(withReasons({ domains: ['reddit.com', 'x.com'] }, null)).toEqual([
      'setup-step-welcome',
      'setup-step-sites',
      'setup-step-intention:reddit.com',
      'setup-step-intention:x.com',
      'setup-step-reasons',
      'setup-step-access',
      'setup-step-done'
    ]);
  });

  it('adds one purpose page per service only after a yes', () => {
    const order = withReasons({ domains: ['reddit.com', 'x.com'] }, true);
    expect(order.filter(id => id.startsWith('setup-step-purpose:'))).toEqual([
      'setup-step-purpose:reddit.com', 'setup-step-purpose:x.com'
    ]);
    expect(order.indexOf('setup-step-purpose:reddit.com')).toBe(order.indexOf('setup-step-reasons') + 1);
    expect(withReasons({ domains: ['reddit.com'] }, false).some(id => id.startsWith('setup-step-purpose:'))).toBe(false);
  });

  // A site and its app are two rules (two intentions) but one service, so
  // the coach is told what it is for once.
  it('gives a site and its app an intention each and one purpose page', () => {
    const order = withReasons({
      domains: ['instagram.com'],
      apps: ['com.instagram.android'],
      appLabels: { 'com.instagram.android': 'Instagram' }
    }, true);
    expect(order.filter(id => id.startsWith('setup-step-purpose:'))).toHaveLength(1);
  });

  it('with nothing picked, skips straight from picking to the end', () => {
    expect(withReasons({}, null)).toEqual([
      'setup-step-welcome', 'setup-step-sites', 'setup-step-access', 'setup-step-done'
    ]);
  });

  it('never repeats a page id, so an id still identifies a page', () => {
    const order = withReasons({ domains: ['reddit.com', 'x.com', 'instagram.com'] }, true);
    expect(new Set(order).size).toBe(order.length);
  });

  it('labels a run of pages by the part of setup, counting only within it', () => {
    const label = vm.runInContext(`
      setupBlockedDomains = ['reddit.com', 'x.com']; setupWantsReasons = null;
      setupStepOrder = computeStepOrder();
      JSON.stringify(setupStepOrder.map(setupProgressLabel));
    `, ctx);
    expect(JSON.parse(label)).toEqual([
      'Intention', 'Pick', 'Intentions · 1 of 2', 'Intentions · 2 of 2', 'Purpose', 'More time', 'Ready'
    ]);
  });
});

// The wizard holds chip ids; storage holds the prose it has always held. This
// is the seam between the two, and the reason changing the input cost no
// migration anywhere downstream.
describe('collectServiceReasons', () => {
  const collect = (state) => vm.runInContext(`
    setupBlockedDomains = ${JSON.stringify(state.domains || [])};
    setupBlockedApps = ${JSON.stringify(state.apps || [])};
    setupAppLabels = {};
    setupServiceAnswers = ${JSON.stringify(state.answers || {})};
    JSON.stringify(collectServiceReasons());
  `, ctx);

  it('composes the chips into the pair every reader downstream expects', () => {
    const out = JSON.parse(collect({
      domains: ['instagram.com'],
      answers: {
        'instagram.com': { needs: ['dm', 'sent'], costs: ['hours', 'auto'], needsNote: 'Only my sister.', costsNote: '' }
      }
    }));
    expect(out['instagram.com'].purpose)
      .toBe('It eats hours I meant to spend elsewhere; I open it without ever deciding to.');
    expect(out['instagram.com'].legitimateUse)
      .toBe('Replying to a specific DM; opening a link someone actually sent me. Only my sister.');
    expect(typeof out['instagram.com'].updatedAt).toBe('number');
  });

  it('keeps a free-text refinement typed with no chips tapped', () => {
    const out = JSON.parse(collect({
      domains: ['reddit.com'],
      answers: { 'reddit.com': { needs: [], costs: [], needsNote: 'Two niche subs.', costsNote: '' } }
    }));
    expect(out['reddit.com'].legitimateUse).toBe('Two niche subs.');
  });

  it('drops a service nothing was tapped or typed for', () => {
    const out = JSON.parse(collect({
      domains: ['reddit.com'],
      answers: { 'reddit.com': { needs: [], costs: [], needsNote: '   ', costsNote: '' } }
    }));
    expect(out).toEqual({});
  });

  // Answer, go back, remove the site, finish: the answer must not survive as a
  // key for something no longer blocked.
  it('drops an answer for a service since removed from the list', () => {
    const out = JSON.parse(collect({
      domains: ['x.com'],
      answers: { 'reddit.com': { needs: ['thread'], costs: [] } }
    }));
    expect(out).toEqual({});
  });

  it('files an app answer under the site it shares an identity with', () => {
    const out = JSON.parse(collect({
      domains: [],
      apps: ['com.instagram.android'],
      answers: { 'instagram.com': { needs: ['dm'], costs: [] } }
    }));
    expect(Object.keys(out)).toEqual(['instagram.com']);
  });

  // The strongest thing this step can be told, and the one answer that is NOT
  // the absence of chips — so it has to reach storage as a sentence rather
  // than being dropped as empty.
  it("turns 'nothing, I just want it gone' into a sentence of its own", () => {
    const out = JSON.parse(collect({
      domains: ['instagram.com'],
      answers: { 'instagram.com': { needs: ['none'], costs: [] } }
    }));
    expect(out['instagram.com'].legitimateUse).toBe("Nothing. I don't actually need it.");
  });
});


// A newly added site starts on a daily budget of minutes, chosen per visit —
// while an entry stored before that (no intentionMode) still means opens.
describe('a newly added website', () => {
  it('is given 30 minutes a day, not opens', async () => {
    const saved = [];
    const orig = { getConfig: ctx.getConfig, sendBg: ctx.sendBg, renderDomains: ctx.renderDomains, doc: ctx.document.getElementById };
    ctx.document.getElementById = (id) => (id === 'setup-view' ? { hidden: true } : null);
    ctx.getConfig = async () => ({ blockedDomains: ['x.com'], domainLimits: { 'x.com': { maxGrants: 3, passMinutes: 10 } } });
    ctx.sendBg = async (m) => { saved.push(m); return { ok: true }; };
    ctx.renderDomains = () => {};
    try {
      expect(await ctx.addDomainToBlocklist('youtube.com')).toBe(true);
    } finally {
      Object.assign(ctx, { getConfig: orig.getConfig, sendBg: orig.sendBg, renderDomains: orig.renderDomains });
      ctx.document.getElementById = orig.doc;
    }
    const limits = saved[0].config.domainLimits;
    expect(limits['youtube.com']).toEqual({ intentionMode: 'dailyTime', dailyTimeMinutes: 30 });
    expect(ctx.resolveIntention(limits['youtube.com'])).toEqual({ mode: 'dailyTime', dailyMinutes: 30, opens: 0, minutesEach: 0 });
    // The existing entry is written back untouched and still reads as opens.
    expect(ctx.resolveIntention(limits['x.com'])).toEqual({ opens: 3, minutesEach: 10 });
  });
});
