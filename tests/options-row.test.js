// options.js — the blocked-row controls, and the one rule they all obey.
//
// The settings page runs tighten-free / loosen-gated: a change that makes the
// rules stricter saves itself the moment you make it, and a change that makes
// them looser has to be argued with the coach first. Two of the row's controls
// are new to that rule — the loose -> strict split, where LOWERING is the
// tightening, and the two site-specific answers, where the FIRST write is free
// and every edit after it is not — so both directions are covered here.
//
// options.js is a browser script with no exports and no test-only seams, so it
// is evaluated in a vm against a DOM thin enough to build an element tree in.
// The builders under test only ever create elements, set properties on them
// and attach handlers; nothing here needs layout, selectors or a real event
// loop, and a shim that answers exactly that is smaller and more honest about
// what is being tested than a full jsdom would be.

import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadSource, VARIANTS, bundleForContext } from './load.js';

// ---- The DOM shim ---------------------------------------------------------

function makeElement(tagName) {
  const classes = new Set();
  const attrs = {};
  const handlers = {};
  const node = {
    tagName,
    children: [],
    style: {},
    hidden: false,
    _handlers: handlers,
    classList: {
      add: (...c) => c.forEach(x => classes.add(x)),
      remove: (...c) => c.forEach(x => classes.delete(x)),
      contains: (c) => classes.has(c),
      toggle: (c, on) => {
        const want = on === undefined ? !classes.has(c) : !!on;
        if (want) classes.add(c); else classes.delete(c);
        return want;
      }
    },
    setAttribute: (k, v) => { attrs[k] = String(v); },
    getAttribute: (k) => (k in attrs ? attrs[k] : null),
    appendChild: (child) => { node.children.push(child); return child; },
    append: (...kids) => { node.children.push(...kids); },
    addEventListener: (type, fn) => { (handlers[type] = handlers[type] || []).push(fn); },
    querySelector: () => null
  };
  return node;
}

// Depth-first, in document order — which is the order the builders append in,
// so "the first .row-reason-input" is the first question on screen.
function findAll(node, className) {
  const out = [];
  const walk = (n) => {
    if (!n || !n.children) return;
    for (const child of n.children) {
      if (typeof child.className === 'string' && child.className.split(' ').includes(className)) out.push(child);
      walk(child);
    }
  };
  walk(node);
  return out;
}

const find = (node, className) => findAll(node, className)[0];

// Handlers here are async; every caller awaits, so a change that persists is
// settled by the time the assertion runs.
const fire = (node, type) =>
  Promise.all((node._handlers[type] || []).map(fn => fn({ target: node })));

// ---- The context ----------------------------------------------------------

let ctx;
let doc;     // the shim document, so a test can answer getElementById itself
let saved;   // every saveSettings config the page wrote, in order
let gates;   // every coach gate it opened instead
let config;  // what getConfig answers with

function load() {
  saved = [];
  gates = [];

  const chrome = {
    runtime: {
      getURL: (p) => p,
      lastError: null,
      sendMessage: (msg, cb) => {
        if (msg.action === 'getConfig') return cb(structuredClone(config));
        if (msg.action === 'saveSettings') saved.push(structuredClone(msg.config));
        cb({ ok: true });
      }
    },
    storage: { local: { get: (_k, cb) => cb && cb({}), set: (_o, cb) => cb && cb(), remove: (_k, cb) => cb && cb() } }
  };

  doc = {
    addEventListener() {},
    getElementById: () => null,
    createElement: makeElement,
    body: makeElement('body')
  };
  const document = doc;

  // options.html's own <script> list, minus the two the row builders never
  // touch (billing.js needs a paywall DOM, report.js a real event loop). Read
  // from the page rather than restated, so a script added to options.html
  // reaches these tests too.
  const source = bundleForContext('options', {
    only: ['sites.js', 'providers.js', 'rules.js', 'options.js']
  });

  ctx = loadSource(join(VARIANTS.chrome, '__options_bundle__.js'), {
    chrome,
    source,
    extraGlobals: {
      document,
      window: {},
      navigator: { userAgent: 'Chrome/120' },
      localStorage: { getItem: () => null, setItem() {}, removeItem() {} }
    }
  });

  // The coach gate is a modal with a chat in it; all these tests need to know
  // is that it was opened, and what it was asked to approve.
  ctx.openGateModal = (args) => { gates.push(args); };
}

const noop = async () => {};

beforeEach(() => {
  config = {
    blockedDomains: ['instagram.com'],
    blockedApps: [],
    appLabels: {},
    blockingMode: 'coach',
    domainLimits: { 'instagram.com': { maxGrants: 3, maxMinutes: 45, looseUntilMinutes: 15 } },
    appLimits: {},
    serviceReasons: {}
  };
  load();
});

// ---------------------------------------------------------------------------

describe('the loose -> strict timeline', () => {
  const build = (limitInfo, max = 45) =>
    ctx.buildLooseTimelineField('instagram.com', 'instagram.com', limitInfo, ctx.ROW_KINDS.domain, max, noop);

  it('is a real range input, so it is keyboard-operable without any ARIA', () => {
    const field = build({ looseUntilMinutes: 15 });
    const range = find(field, 'row-timeline-range');
    expect(range.tagName).toBe('input');
    expect(range.type).toBe('range');
    expect(range.min).toBe('0');
    expect(range.max).toBe('45');
    expect(range.getAttribute('aria-label')).toContain('before the coach turns strict');
    // A bare "15" doesn't say what it counts.
    expect(range.getAttribute('aria-valuetext')).toBe('15 of 45 minutes lenient, then strict');
  });

  it('hides the painted band from the accessibility tree', () => {
    // The band says the same thing the range already announces. Two voices
    // saying "loose, strict, 15" is one too many.
    const band = find(build({ looseUntilMinutes: 15 }), 'row-timeline-band');
    expect(band.getAttribute('aria-hidden')).toBe('true');
  });

  it('pairs the range with a number box carrying the same value and label', () => {
    const field = build({ looseUntilMinutes: 15 });
    const number = find(field, 'row-timeline-number');
    expect(number.type).toBe('number');
    expect(number.value).toBe('15');
    expect(number.getAttribute('aria-label')).toBe(find(field, 'row-timeline-range').getAttribute('aria-label'));
  });

  // Absent means no split at all, which is lenient all day — so the handle
  // opens at the far right rather than inventing a line the user never drew.
  it('opens at the far right when no split was ever set', () => {
    const field = build({ maxMinutes: 45 });
    expect(find(field, 'row-timeline-number').value).toBe('45');
    expect(find(field, 'row-timeline-range').getAttribute('aria-valuetext'))
      .toBe('lenient all day, no strict phase');
    expect(find(field, 'row-timeline-note').textContent).toContain('never turns strict');
  });

  it('lowering it shortens the lenient window — saved directly, no coach', async () => {
    const field = build({ looseUntilMinutes: 15 });
    const number = find(field, 'row-timeline-number');
    number.value = '5';
    await fire(number, 'change');

    expect(gates).toEqual([]);
    expect(saved).toHaveLength(1);
    expect(saved[0].domainLimits['instagram.com'].looseUntilMinutes).toBe(5);
    expect(number.value).toBe('5');
  });

  it('raising it lengthens the window — gated, and not written meanwhile', async () => {
    const field = build({ looseUntilMinutes: 15 });
    const number = find(field, 'row-timeline-number');
    number.value = '30';
    await fire(number, 'change');

    expect(saved).toEqual([]);
    expect(gates).toHaveLength(1);
    expect(gates[0].changeType).toBe('increase_loose_window');
    expect(gates[0].domain).toBe('instagram.com');
    expect(gates[0].currentValue).toBe(15);
    expect(gates[0].newValue).toBe(30);
    // Reverted on screen until the coach says otherwise.
    expect(number.value).toBe('15');
  });

  it('drawing a first split out of "lenient all day" is a tightening', async () => {
    const field = build({ maxMinutes: 45 });
    const number = find(field, 'row-timeline-number');
    number.value = '20';
    await fire(number, 'change');

    expect(gates).toEqual([]);
    expect(saved[0].domainLimits['instagram.com'].looseUntilMinutes).toBe(20);
  });

  it('the range and the number box are two ways into the same field', async () => {
    const field = build({ looseUntilMinutes: 15 });
    const range = find(field, 'row-timeline-range');
    range.value = '4';
    await fire(range, 'change');
    expect(saved[0].domainLimits['instagram.com'].looseUntilMinutes).toBe(4);
    // Dragging repaints the number too, so the two never disagree on screen.
    expect(find(field, 'row-timeline-number').value).toBe('4');
  });

  it('dragging paints but does not save — only letting go commits', async () => {
    const field = build({ looseUntilMinutes: 15 });
    const range = find(field, 'row-timeline-range');
    range.value = '3';
    await fire(range, 'input');
    expect(saved).toEqual([]);
    expect(find(field, 'row-timeline-number').value).toBe('3');
  });

  it('clamps a typed value to the track and ignores an unreadable one', async () => {
    const field = build({ looseUntilMinutes: 15 });
    const number = find(field, 'row-timeline-number');

    number.value = '900';
    await fire(number, 'change');
    // 900 past a 45-minute max is "lenient all day", which is longer: gated.
    expect(gates).toHaveLength(1);
    expect(gates[0].newValue).toBe(45);

    number.value = 'soon';
    await fire(number, 'change');
    expect(saved).toEqual([]);
    expect(number.value).toBe('15');
  });

  it('a split left beyond a since-lowered max reads as lenient all day', () => {
    // Lowering the daily max is a tightening that saves itself, so a stored
    // split can end up past the end of the track.
    const field = build({ looseUntilMinutes: 40 }, 10);
    expect(find(field, 'row-timeline-number').value).toBe('10');
  });

  it('an app row gates through the app change type', async () => {
    const field = ctx.buildLooseTimelineField(
      'com.instagram.android', 'the Instagram app',
      { looseUntilMinutes: 15 }, ctx.ROW_KINDS.app, 45, noop
    );
    const number = find(field, 'row-timeline-number');
    number.value = '30';
    await fire(number, 'change');
    expect(gates[0].changeType).toBe('increase_app_loose_window');
    expect(gates[0].isApp).toBe(true);
  });
});

describe('the two site-specific answers', () => {
  const build = (target = 'instagram.com', label = 'instagram.com', kind = 'domain') =>
    ctx.buildRowReasonFields(target, label, ctx.ROW_KINDS[kind], config.serviceReasons, [], noop);

  it('is two labelled boxes in the row, not a collapsed disclosure', () => {
    const wrap = build();
    const labels = findAll(wrap, 'row-reason-label').map(l => l.textContent);
    expect(labels).toEqual(["Why you're blocking it", 'Why you need it']);
    expect(findAll(wrap, 'row-reason-input')).toHaveLength(2);
    // The visible caption repeats down the page; the accessible one doesn't.
    expect(findAll(wrap, 'row-reason-input')[1].getAttribute('aria-label'))
      .toBe('Why you need it — instagram.com');
  });

  it('says where an answer is shared, because editing here edits there', () => {
    const wrap = ctx.buildRowReasonFields(
      'instagram.com', 'instagram.com', ctx.ROW_KINDS.domain, {},
      [{ target: 'com.instagram.android', label: 'the Instagram app' }], noop
    );
    expect(find(wrap, 'row-reason-shared').textContent)
      .toContain('Shared with the Instagram app');
  });

  // There is no weak moment to guard against before anything exists, which is
  // the same reason the coach-context card's first write is direct.
  it('the first write of a field is direct', async () => {
    const wrap = build();
    const purpose = findAll(wrap, 'row-reason-input')[0];
    purpose.value = 'It eats my evenings.';
    await fire(purpose, 'change');

    expect(gates).toEqual([]);
    expect(saved).toHaveLength(1);
    expect(saved[0].serviceReasons['instagram.com'].purpose).toBe('It eats my evenings.');
  });

  it('every edit after that goes through the coach', async () => {
    config.serviceReasons = { 'instagram.com': { purpose: 'It eats my evenings.', updatedAt: 1 } };
    load();
    ctx.openGateModal = (args) => { gates.push(args); };

    const wrap = ctx.buildRowReasonFields(
      'instagram.com', 'instagram.com', ctx.ROW_KINDS.domain, config.serviceReasons, [], noop
    );
    const purpose = findAll(wrap, 'row-reason-input')[0];
    expect(purpose.value).toBe('It eats my evenings.');

    purpose.value = 'Actually it is fine.';
    await fire(purpose, 'change');

    expect(saved).toEqual([]);
    expect(gates).toHaveLength(1);
    expect(gates[0].changeType).toBe('edit_site_purpose');
    expect(gates[0].currentValue).toBe('It eats my evenings.');
    expect(gates[0].newValue).toBe('Actually it is fine.');
    // Reverted on screen until the coach says otherwise.
    expect(purpose.value).toBe('It eats my evenings.');
  });

  // The two fields are independent: an answered "why you're blocking it" must
  // not put a gate in front of a blank "why you need it".
  it('the two fields count their first write separately', async () => {
    config.serviceReasons = { 'instagram.com': { purpose: 'It eats my evenings.', updatedAt: 1 } };
    load();
    ctx.openGateModal = (args) => { gates.push(args); };

    const wrap = ctx.buildRowReasonFields(
      'instagram.com', 'instagram.com', ctx.ROW_KINDS.domain, config.serviceReasons, [], noop
    );
    const legitimate = findAll(wrap, 'row-reason-input')[1];
    legitimate.value = 'One specific DM.';
    await fire(legitimate, 'change');

    expect(gates).toEqual([]);
    expect(saved[0].serviceReasons['instagram.com']).toEqual({
      purpose: 'It eats my evenings.',
      legitimateUse: 'One specific DM.',
      updatedAt: expect.any(Number)
    });
  });

  it('does nothing at all when the text comes back unchanged', async () => {
    config.serviceReasons = { 'instagram.com': { purpose: 'It eats my evenings.', updatedAt: 1 } };
    load();
    ctx.openGateModal = (args) => { gates.push(args); };

    const wrap = ctx.buildRowReasonFields(
      'instagram.com', 'instagram.com', ctx.ROW_KINDS.domain, config.serviceReasons, [], noop
    );
    const purpose = findAll(wrap, 'row-reason-input')[0];
    purpose.value = '  It eats my evenings.  ';
    await fire(purpose, 'change');

    expect(gates).toEqual([]);
    expect(saved).toEqual([]);
  });

  it('reads the stored answer through the service key, not the target', () => {
    config.serviceReasons = { 'instagram.com': { legitimateUse: 'One specific DM.', updatedAt: 1 } };
    load();
    // serviceKeyFor folds the app onto the site's answer — same service.
    const wrap = ctx.buildRowReasonFields(
      'com.instagram.android', 'the Instagram app', ctx.ROW_KINDS.app,
      config.serviceReasons, [], noop
    );
    expect(findAll(wrap, 'row-reason-input')[1].value).toBe('One specific DM.');
  });
});

describe('the Coach / Simple toggle', () => {
  const build = (limitInfo, globalMode = 'coach') =>
    ctx.buildRowModeToggle('instagram.com', 'instagram.com', limitInfo, globalMode, 'domainLimits', noop);

  it('shows the mode that is in force, and announces which is chosen', () => {
    // No override, global is coach: the row is a coach row.
    const [coach, simple] = findAll(build({}), 'row-mode-btn');
    expect(coach.getAttribute('aria-pressed')).toBe('true');
    expect(simple.getAttribute('aria-pressed')).toBe('false');
    expect(coach.classList.contains('selected')).toBe(true);
  });

  it('follows a per-row override over the global default', () => {
    const [coach, simple] = findAll(build({ mode: 'simple' }), 'row-mode-btn');
    expect(coach.getAttribute('aria-pressed')).toBe('false');
    expect(simple.getAttribute('aria-pressed')).toBe('true');
  });

  it('names the row it belongs to, so ten of them are not ten bare "Coach"es', () => {
    expect(build({}).getAttribute('aria-label')).toBe('How instagram.com is blocked');
    expect(build({}).getAttribute('role')).toBe('group');
  });

  it('writes an override when the choice disagrees with the global', async () => {
    const [, simple] = findAll(build({}), 'row-mode-btn');
    await fire(simple, 'click');
    expect(saved[0].domainLimits['instagram.com'].mode).toBe('simple');
    // The simple-only fields come with it, defaulted.
    expect(saved[0].domainLimits['instagram.com'].behavior).toBe('pass');
    expect(saved[0].domainLimits['instagram.com'].passMinutes).toBe(10);
  });

  // Two buttons, three stored states. Choosing the mode that already matches
  // the global drops the override rather than freezing it, so the row goes
  // back to following the global blocking-mode card.
  it('drops the override when the choice matches the global again', async () => {
    config.domainLimits['instagram.com'].mode = 'simple';
    load();
    const [coach] = findAll(build({ mode: 'simple' }), 'row-mode-btn');
    await fire(coach, 'click');
    expect('mode' in saved[0].domainLimits['instagram.com']).toBe(false);
  });

  it('clears the simple-only fields on the way back to coach', async () => {
    config.domainLimits['instagram.com'] = { maxGrants: 3, mode: 'simple', behavior: 'hard', passMinutes: 25 };
    load();
    const [coach] = findAll(build({ mode: 'simple', behavior: 'hard', passMinutes: 25 }), 'row-mode-btn');
    await fire(coach, 'click');
    const entry = saved[0].domainLimits['instagram.com'];
    expect('behavior' in entry).toBe(false);
    expect('passMinutes' in entry).toBe(false);
  });

  it('saves nothing when you pick the mode already in force', async () => {
    const [coach] = findAll(build({}), 'row-mode-btn');
    await fire(coach, 'click');
    expect(saved).toEqual([]);
  });
});

describe('the absolute daily max', () => {
  it('is named for what it is, and explains itself on request', () => {
    const field = ctx.buildDailyLimitField(45, 'instagram.com', () => {}, { info: true });
    expect(find(field, 'micro-label').textContent).toBe('Absolute daily max');
    const info = find(field, 'row-info-btn');
    expect(info.getAttribute('aria-expanded')).toBe('false');
    expect(info.getAttribute('aria-controls')).toBe(find(field, 'row-info-note').id);
    expect(find(field, 'row-info-note').textContent).toContain('a ceiling, not a target');
  });

  it('the explanation is a disclosure, not a hover', async () => {
    const field = ctx.buildDailyLimitField(45, 'instagram.com', () => {}, { info: true });
    const info = find(field, 'row-info-btn');
    const note = find(field, 'row-info-note');
    expect(note.hidden).toBe(true);
    await fire(info, 'click');
    expect(note.hidden).toBe(false);
    expect(info.getAttribute('aria-expanded')).toBe('true');
  });

  it('the wizard rows get the field without a second explanation', () => {
    const field = ctx.buildDailyLimitField(10, 'instagram.com', () => {});
    expect(find(field, 'row-info-btn')).toBeUndefined();
  });
});

// The suggestion chips live in the add dialog now, but the wizard's site and
// app steps have always had a chip grid inline under their "+ Add" button — so
// opening the dialog from the wizard drew the same twelve suggestions on top
// of the twelve already on screen.
describe('the add dialog and the wizard do not both show suggestions', () => {
  function openFrom({ inWizard }) {
    const setupView = makeElement('main');
    setupView.hidden = !inWizard;
    const suggestions = makeElement('div');
    const modal = makeElement('div');
    modal.hidden = true;
    modal.querySelector = (sel) => (sel === '.add-modal-suggestions' ? suggestions : null);
    const input = makeElement('input');
    input.focus = () => {};

    doc.getElementById = (id) => ({
      'setup-view': setupView,
      'add-site-modal': modal,
      'domain-input': input
    }[id] || null);
    doc.activeElement = null;

    ctx.openAddModal('add-site-modal', 'domain-input');
    return { modal, suggestions };
  }

  it('hides the dialog copy while the wizard is on screen', () => {
    const { modal, suggestions } = openFrom({ inWizard: true });
    expect(modal.hidden).toBe(false);
    expect(suggestions.hidden).toBe(true);
  });

  it('shows them in settings, where the dialog is the only place they are', () => {
    const { suggestions } = openFrom({ inWizard: false });
    expect(suggestions.hidden).toBe(false);
  });
});
