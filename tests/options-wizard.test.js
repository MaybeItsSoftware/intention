// Guard for the setup wizard's weakest seam: the settings page reaches into
// options.html purely by string id, so a section that gets renamed or dropped
// in the markup fails at runtime, not at load. That is exactly how the wizard
// broke once before — the script kept driving a `setup-step-provider` section
// that the markup no longer had, and reading a control off it threw before the
// first step was ever shown, leaving a first-run user staring at whichever
// section happened not to carry `hidden`.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { VARIANTS, bundleForContext, loadSource, filesForContext } from './load.js';

const read = (variant, file) => fs.readFileSync(path.join(VARIANTS[variant], file), 'utf8');

const html = read('chrome', 'options.html');
// Every script the page loads, not just options.js: the ids are looked up from
// whichever of them owns that part of the UI, and a check that reads one file
// silently stops covering the rest the moment the page grows a second.
const js = bundleForContext('options');
const css = read('chrome', 'options.css');

const htmlIds = new Set([...html.matchAll(/id="([^"]+)"/g)].map(m => m[1]));

describe('setup wizard markup and script agree', () => {
  it('every id options.js looks up exists in options.html', () => {
    const missing = [...new Set([...js.matchAll(/getElementById\('([^']+)'\)/g)].map(m => m[1]))]
      .filter(id => !htmlIds.has(id));
    expect(missing).toEqual([]);
  });

  it('every step the wizard can order is a real section', () => {
    const ordered = [...new Set([...js.matchAll(/'(setup-step-[a-z-]+)'/g)].map(m => m[1]))];
    expect(ordered.length).toBeGreaterThan(0);
    expect(ordered.filter(id => !htmlIds.has(id))).toEqual([]);
  });

  it('every step section can be reached by the wizard', () => {
    const sections = [...html.matchAll(/id="(setup-step-[a-z-]+)"/g)].map(m => m[1]);
    const ordered = new Set([...js.matchAll(/'(setup-step-[a-z-]+)'/g)].map(m => m[1]));
    expect(sections.filter(id => !ordered.has(id))).toEqual([]);
  });

  // The per-target pages share a section each, and their page ids carry the
  // target after a colon. The section named before the colon has to exist, or
  // showStep has nothing to show.
  it('every per-target page id names a real section', () => {
    const templated = [...new Set([...js.matchAll(/`(setup-step-[a-z-]+):\$\{/g)].map(m => m[1]))];
    expect(templated.sort()).toEqual(['setup-step-intention', 'setup-step-purpose']);
    expect(templated.filter(id => !htmlIds.has(id))).toEqual([]);
  });

  it('the intention page carries its counter, dots and minutes', () => {
    for (const id of ['setup-intention-question', 'setup-intention-minus', 'setup-intention-plus',
                      'setup-intention-opens', 'setup-intention-dots', 'setup-intention-minutes',
                      'setup-intention-sum', 'setup-intention-same-btn']) {
      expect(htmlIds.has(id), id).toBe(true);
    }
  });

  it('the purpose pages are an offer, with a way past them', () => {
    for (const id of ['setup-reasons-yes-btn', 'setup-reasons-skip-btn',
                      'setup-reason-question', 'setup-reason-body', 'setup-purpose-skip-btn']) {
      expect(htmlIds.has(id), id).toBe(true);
    }
  });

  // A half-finished migration is the failure mode here: a getElementById left
  // behind for a control that no longer exists throws at load, which is how
  // the setup-step-provider bug at the top of this file happened.
  it('keeps nothing of the two-textarea version of the purpose step', () => {
    for (const id of ['setup-purpose-why-input', 'setup-purpose-legit-input',
                      'setup-purpose-title', 'setup-purpose-members', 'setup-purpose-mark']) {
      expect(html.includes(id), `${id} in options.html`).toBe(false);
      expect(js.includes(id), `${id} in the options bundle`).toBe(false);
    }
  });

  it('no step section is left visible for the wizard to fall back onto', () => {
    // showStep() decides what is on screen. A section that ships without
    // `hidden` shows through before it runs, and stays up if it ever throws.
    const unhidden = [...html.matchAll(/<section class="[^"]*\bsetup-step\b[^"]*" id="([^"]+)"(?![^>]*hidden)/g)]
      .map(m => m[1]);
    expect(unhidden).toEqual([]);
  });
});

// The section tabs left a visibly different gap beneath them depending on
// which tab was selected. Not the tabs — the grid: its children were two
// column wrappers, and the one holding none of the selected section's cards
// collapsed to a zero-height grid item that still took a full 16px gutter.
// A card hidden with `display: none` is not a grid item at all, so a FLAT
// grid gives every tab the same gap by construction.
describe('the settings grid stays a flat list of sections', () => {
  // The grid is the last thing inside #settings-view's <main>, so its own
  // closing tag is the one immediately before </main>.
  const gridAt = html.indexOf('<div class="settings-grid">');
  const grid = html.slice(gridAt, html.indexOf('\n    </main>', gridAt));

  it('has no column wrappers left to collapse', () => {
    expect(html).not.toContain('settings-column');
    expect(css).not.toContain('settings-column');
  });

  // Every direct child (8-space indent, inside a 6-space grid) must be
  // section-owned. One that isn't would render on every tab — and, worse,
  // render an empty box plus its gutter on the tabs it has nothing for.
  it('every direct child of the grid belongs to exactly one section', () => {
    const children = [...grid.matchAll(/^ {12}<(?:section|details|div|ul)\b([^>]*)>/gm)].map(m => m[1]);
    expect(children.length).toBeGreaterThan(8);
    expect(children.filter(attrs => !/\bdata-section="/.test(attrs))).toEqual([]);
  });

  it('keeps the tab labels optically centred against their own tracking', () => {
    // 0.12em of tracking is painted after the last glyph as well; the indent
    // cancels it. They have to stay equal — see the rule's comment.
    const rule = css.slice(css.indexOf('.section-tabs .tab-btn {'));
    expect(rule).toMatch(/letter-spacing: 0\.12em;/);
    expect(rule).toMatch(/text-indent: 0\.12em;/);
  });
});

// The suggestion chips belong to the act of adding, not to the list of things
// already added — and inside the dialog they finally have a minutes field to
// read. The wizard keeps its own inline grids, which share the builders.
describe('the suggestion chips live in the add dialogs', () => {
  const block = (id) => {
    const start = html.indexOf(`<div id="${id}"`);
    return html.slice(start, html.indexOf('\n    </div>', start));
  };

  it('the site chips are in the Add-website dialog, not the Blocked sites card', () => {
    expect(block('add-site-modal')).toContain('id="sites-recommend-grid"');
    expect(block('add-site-modal')).toContain('id="sites-recommend-more"');
    expect(block('websites-card')).not.toContain('recommend');
  });

  it('the app chips are in the Add-app dialog, not the Blocked apps card', () => {
    expect(block('add-app-modal')).toContain('id="apps-recommend-grid"');
    expect(block('add-app-modal')).toContain('id="apps-recommend-more"');
    expect(block('apps-card')).not.toContain('recommend');
  });

  it("the wizard's own grids are untouched", () => {
    for (const id of ['setup-sites-recommend-grid', 'setup-sites-recommend-more',
                      'setup-apps-recommend-grid', 'setup-apps-recommend-more']) {
      expect(htmlIds.has(id), id).toBe(true);
    }
  });

  // Every route out has to exist, or the dialog is a trap on a phone where
  // there is no visible page behind the scrim to aim at.
  it('the dialogs can be dismissed three ways and trap focus', () => {
    expect(js).toContain('function wireModalDismissal');
    expect(js).toContain("wireModalDismissal('add-site-modal'");
    expect(js).toContain("wireModalDismissal('add-app-modal'");
    expect(js).toMatch(/e\.key === 'Escape'/);
    expect(js).toMatch(/e\.key !== 'Tab'/);
  });
});

// ---------------------------------------------------------------------------
// The per-service notes, run for real.
//
// Everything above reads the source as text, which is the right shape for
// "does the markup still carry the id the script looks up". It is the wrong
// shape for the bug this covers, which was a sequence: type, tap, repaint,
// lose it. So this block builds an actual card out of a DOM shim and drives
// the handlers in the order a thumb does.
//
// The shim answers exactly what the builders touch — create an element, set
// properties on it, hang handlers off it, and remember which one has focus.
// A full jsdom would answer more and say less about what is being tested; the
// same trade-off tests/options-row.test.js makes, for the same reason.
//
// What is being pinned: a repaint must never destroy text the user has typed
// and not yet blurred out of. On a phone that blur does not come — iOS Safari
// and the Android WebView do not reliably move focus onto a <button> when it
// is tapped — so the textarea is still focused, still holding the sentence,
// at the exact moment a chip tap repaints the card around it.

const activeElement = { el: null };

function makeShimElement(tagName) {
  const classes = new Set();
  const attrs = {};
  const handlers = {};
  const node = {
    tagName,
    children: [],
    style: {},
    hidden: false,
    value: '',
    parentElement: null,
    dataset: {},
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
    removeAttribute: (k) => { delete attrs[k]; },
    appendChild: (child) => { node.children.push(child); child.parentElement = node; return child; },
    append: (...kids) => { for (const k of kids) { node.children.push(k); k.parentElement = node; } },
    addEventListener: (type, fn) => { (handlers[type] = handlers[type] || []).push(fn); },
    querySelector: () => null,
    focus: () => { activeElement.el = node; }
  };
  return node;
}

// Depth-first, in document order, so "the first .setup-service-note" is the
// needs note — the one directly under the first chip row.
function shimFindAll(node, className) {
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
const fireShim = (node, type) => (node._handlers[type] || []).map(fn => fn({ target: node }));

// Typing, as the browser reports it: the value is already updated by the time
// the event runs, and 'change' is nowhere in sight until something blurs.
const typeInto = (area, text) => {
  area.focus();
  area.value = text;
  fireShim(area, 'input');
};

describe('a note the user is still typing', () => {
  let ctx;
  let writes;   // every chrome.storage.local.set, in order
  let removals; // every remove

  beforeEach(() => {
    vi.useFakeTimers();
    activeElement.el = null;
    writes = [];
    removals = [];

    const ids = {};
    const idFor = (id) => {
      if (!ids[id]) {
        // A parent, because refreshPurposeProgress hides the counter's ROW
        // rather than the counter, and reads it through parentElement.
        ids[id] = makeShimElement('div');
        makeShimElement('div').appendChild(ids[id]);
      }
      return ids[id];
    };
    const document = {
      addEventListener() {},
      getElementById: idFor,
      createElement: makeShimElement,
      createElementNS: (_ns, tag) => makeShimElement(tag),
      body: makeShimElement('body'),
      get activeElement() { return activeElement.el; }
    };
    const chrome = {
      runtime: { getURL: (p) => p, lastError: null, sendMessage: (_m, cb) => cb && cb({ ok: true }) },
      storage: {
        local: {
          get: (_k, cb) => cb && cb({}),
          set: (obj, cb) => { writes.push(structuredClone(obj)); cb && cb(); },
          remove: (k, cb) => { removals.push(k); cb && cb(); }
        }
      }
    };

    ctx = loadSource(filesForContext('options', { except: ['billing.js', 'report.js'] }), {
      chrome,
      extraGlobals: {
        document,
        window: { matchMedia: () => ({ matches: false }) },
        navigator: { userAgent: 'Chrome/120' },
        localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
        CSS: { escape: (s) => s }
      }
    });

    // The wizard's state lives in `let`s, which vm keeps in the script's
    // lexical scope rather than on the context object — so it is set from
    // inside the context, the way tests/options-domain.test.js does.
    vm.runInContext(`
      setupBlockedDomains = ['instagram.com'];
      setupBlockedApps = [];
      setupServiceAnswers = {};
      setupDraftReady = true;
    `, ctx);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const buildCard = () => vm.runInContext(
    'buildServiceAnswerCard(currentServiceGroups()[0], 0, currentServiceGroups())', ctx);

  // Reveal the note under the chips and return it. Its own toggle is the only
  // way to it: the textarea ships hidden.
  const openNote = (li, i) => {
    fireShim(shimFindAll(li, 'setup-service-note-toggle')[i], 'click');
    return shimFindAll(li, 'setup-service-note')[i];
  };

  const chips = (li, bucket) =>
    shimFindAll(li, 'answer-chip').filter(btn => btn.dataset.bucket === bucket);

  const answers = () => vm.runInContext("serviceAnswersFor('instagram.com')", ctx);

  it('survives a chip tap in the other row that never moves focus off it', () => {
    const li = buildCard();
    const area = openNote(li, 0);
    typeInto(area, 'Only my sister messages, never the feed');

    fireShim(chips(li, 'costs')[0], 'click');

    expect(ctx.document.activeElement).toBe(area);
    expect(area.value).toBe('Only my sister messages, never the feed');
  });

  it('survives a tap on a chip in its own row', () => {
    const li = buildCard();
    const area = openNote(li, 0);
    typeInto(area, 'Only my sister messages, never the feed');

    fireShim(chips(li, 'needs')[0], 'click');

    expect(area.value).toBe('Only my sister messages, never the feed');
  });

  it('survives the "+ Something else" toggle under the other question', () => {
    const li = buildCard();
    const area = openNote(li, 0);
    typeInto(area, 'Only my sister messages, never the feed');

    fireShim(shimFindAll(li, 'setup-service-note-toggle')[1], 'click');

    expect(area.value).toBe('Only my sister messages, never the feed');
  });

  it('is already in the answers object before anything blurs, so Finish saves it', () => {
    const li = buildCard();
    typeInto(openNote(li, 0), 'Only my sister messages, never the feed');
    expect(answers().needsNote).toBe('Only my sister messages, never the feed');

    typeInto(openNote(li, 1), 'It eats the evening.');
    expect(answers().costsNote).toBe('It eats the evening.');
  });

  // The reason 'change' was chosen in the first place, and it still holds:
  // this field invites a sentence, and a chrome.storage write per letter is
  // far more than it is worth. Only the storage side is deferred.
  it('does not write a draft to storage on every keystroke', () => {
    const li = buildCard();
    const area = openNote(li, 0);
    for (const text of ['O', 'On', 'Onl', 'Only']) typeInto(area, text);

    expect(writes).toEqual([]);
    vi.advanceTimersByTime(1000);
    expect(writes).toHaveLength(1);
    expect(writes[0].setupDraft.serviceAnswers['instagram.com'].needsNote).toBe('Only');
  });

  // A keystroke moments before Finish leaves a deferred write pending. If it
  // landed after the draft was removed it would re-create the draft of a
  // completed wizard, and the next load would reopen setup.
  it('does not resurrect the draft after it has been cleared', () => {
    const li = buildCard();
    typeInto(openNote(li, 0), 'Only my sister messages, never the feed');

    ctx.clearSetupDraft();
    vi.advanceTimersByTime(1000);

    expect(removals).toEqual(['setupDraft']);
    expect(writes).toEqual([]);
  });

  // Trailing whitespace is stored trimmed, so the comparison in sync() has to
  // be trimmed on both sides — otherwise every repaint mid-sentence would
  // reassign the value and drop the caret to the end of it.
  it('leaves a half-typed word alone when the space after it is not stored', () => {
    const li = buildCard();
    const area = openNote(li, 0);
    typeInto(area, 'Only my sister ');

    fireShim(chips(li, 'costs')[0], 'click');

    expect(area.value).toBe('Only my sister ');
  });

  // The one case where a repaint is still allowed to clear the box: "nothing
  // — I just want it gone" empties needsNote on purpose, because a refinement
  // saying when opening it is fair enough contradicts an answer of "never".
  it('still clears the needs note when "nothing" is picked', () => {
    const li = buildCard();
    const area = openNote(li, 0);
    typeInto(area, 'Only my sister messages, never the feed');

    const none = chips(li, 'needs').find(btn => btn.dataset.chip === 'none');
    expect(none).toBeTruthy();
    fireShim(none, 'click');

    expect(area.value).toBe('');
    expect(answers().needsNote).toBe('');
  });
});

// The Mac app's onboarding. Someone who set Intention up in Safari first
// arrives with setupComplete already true, so the wizard alone would never
// show them anything; they get a three-page welcome instead. Someone setting
// up in the app gets the wizard, with the login page before the end.
describe('Mac app onboarding', () => {
  const load = ({ mac }) => {
    const document = {
      addEventListener() {},
      getElementById: () => makeShimElement('div'),
      createElement: makeShimElement,
      createElementNS: (_ns, tag) => makeShimElement(tag),
      body: makeShimElement('body'),
      documentElement: { classList: { contains: (c) => mac && c === 'platform-mac' } },
      get activeElement() { return null; }
    };
    const chrome = {
      runtime: { getURL: (p) => p, lastError: null, sendMessage: (_m, cb) => cb && cb({ ok: true }) },
      storage: { local: { get: (_k, cb) => cb && cb({}), set: (_o, cb) => cb && cb(), remove: (_k, cb) => cb && cb() } }
    };
    const intentionExtension = { status: (cb) => cb({ active: true, platform: 'mac' }), setSetupComplete() {} };
    return loadSource(filesForContext('options', { except: ['billing.js', 'report.js'] }), {
      chrome,
      extraGlobals: {
        document,
        window: { matchMedia: () => ({ matches: false }), intentionExtension },
        navigator: { userAgent: 'Safari/605' },
        localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
        CSS: { escape: (s) => s }
      }
    });
  };

  it('the tour is the Mac welcome, the Safari check and the login switch — nothing that edits the list', () => {
    const ctx = load({ mac: true });
    vm.runInContext(`setupMode = 'mac-tour'`, ctx);
    expect(vm.runInContext('IS_MAC_APP', ctx)).toBe(true);
    expect(vm.runInContext('computeStepOrder()', ctx))
      .toEqual(['setup-step-mac-welcome', 'setup-step-safari', 'setup-step-mac-login']);
  });

  it('the wizard in the Mac app asks about login just before it finishes', () => {
    const ctx = load({ mac: true });
    vm.runInContext(`setupBlockedDomains = ['reddit.com']; setupWantsReasons = false;`, ctx);
    const order = vm.runInContext('computeStepOrder()', ctx);
    expect(order[1]).toBe('setup-step-safari');
    expect(order.slice(-3)).toEqual(['setup-step-access', 'setup-step-mac-login', 'setup-step-done']);
    expect(order).not.toContain('setup-step-mac-welcome');
  });

  it('the iPhone app has neither Mac page', () => {
    const ctx = load({ mac: false });
    vm.runInContext(`setupBlockedDomains = ['reddit.com'];`, ctx);
    const order = vm.runInContext('computeStepOrder()', ctx);
    expect(vm.runInContext('IS_MAC_APP', ctx)).toBe(false);
    expect(order.filter(id => id.startsWith('setup-step-mac'))).toEqual([]);
  });

  it('the tour never writes a setup draft', () => {
    const ctx = load({ mac: true });
    const writes = [];
    vm.runInContext(`setupMode = 'mac-tour'; setupDraftReady = true;`, ctx);
    ctx.chrome.storage.local.set = (obj) => writes.push(obj);
    vm.runInContext('saveSetupDraft()', ctx);
    expect(writes).toEqual([]);
    // The same call in the wizard does write, so the empty list above means
    // something.
    vm.runInContext(`setupMode = 'full'`, ctx);
    vm.runInContext('saveSetupDraft()', ctx);
    expect(writes).toHaveLength(1);
  });
});
