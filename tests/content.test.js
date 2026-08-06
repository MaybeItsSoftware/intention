// content.js — deciding whether to gate a page.
//
// The interesting part isn't the overlay markup, it's what happens when the
// background doesn't answer: Safari runs it as a non-persistent page, and a
// suspended one can drop the very first message a document_start content
// script sends. A dropped check used to mean the blocked site simply opened.
// These tests drive that path with a DOM stub thin enough to stay readable —
// they assert *whether* the page was gated, never how it looks.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { VARIANTS, makeMockChrome } from './load.js';

// A DOM stub: every node answers the handful of calls the overlay makes, and
// records nothing but its own identity.
function makeElement(tag = 'div') {
  const node = {
    tagName: tag,
    id: '',
    className: '',
    textContent: '',
    value: '',
    children: [],
    style: { setProperty() {} },
    classList: { add() {}, remove() {} },
    set innerHTML(html) { this._html = html; },
    get innerHTML() { return this._html || ''; },
    appendChild(child) { node.children.push(child); return child; },
    insertAdjacentElement() {},
    removeChild() {},
    remove() {},
    addEventListener() {},
    removeEventListener() {},
    querySelector: () => makeElement(),
    contains: () => true,
    focus() {},
    scrollTop: 0,
    scrollHeight: 0
  };
  return node;
}

function makeDom(href = 'https://www.instagram.com/explore/') {
  const url = new URL(href);
  const created = [];
  const byId = {};
  const documentElement = makeElement('html');
  const body = makeElement('body');
  const document = {
    documentElement,
    body,
    visibilityState: 'visible',
    createElement(tag) {
      const el = makeElement(tag);
      created.push(el);
      return el;
    },
    getElementById(id) {
      // The overlay looks up its own inner nodes right after setting innerHTML,
      // which this stub does not parse — so unknown ids are auto-created. The
      // one exception is the overlay root: "is it already on the page?" is a
      // real question the code branches on, and auto-creating it would make
      // every such check answer yes.
      if (id === 'intention-root') return byId[id] || null;
      if (!byId[id]) byId[id] = makeElement();
      return byId[id];
    },
    _attach(id) { byId[id] = makeElement(); },
    addEventListener() {},
    removeEventListener() {}
  };
  const window = {
    location: { href, hostname: url.hostname, reload() {} },
    stopped: false,
    stop() { window.stopped = true; },
    close() {},
    addEventListener() {},
    removeEventListener() {}
  };
  return { document, window, created };
}

// Load content.js the way the browser does: as a plain script over a DOM.
function loadContent({ storage = {}, sendMessage } = {}) {
  const chrome = makeMockChrome(storage);
  chrome.runtime.sendMessage = sendMessage || (() => {});
  const dom = makeDom();
  const observers = [];
  const sandbox = {
    chrome,
    console: { log() {}, warn() {}, error() {} },
    document: dom.document,
    window: dom.window,
    // Recorded, not ignored: the check-in path has to stop the badge's
    // observer before it wipes the body, or the badge is re-attached over
    // the overlay still counting an ended session.
    MutationObserver: class {
      constructor(cb) { this.cb = cb; observers.push(this); this.observing = false; }
      observe() { this.observing = true; }
      disconnect() { this.observing = false; }
    },
    Date,
    Math,
    JSON,
    Promise,
    Error,
    Object,
    Array,
    String,
    Number,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval
  };
  sandbox.globalThis = sandbox;
  const path = join(VARIANTS.chrome, 'content.js');
  vm.runInContext(readFileSync(path, 'utf8'), vm.createContext(sandbox), { filename: path });
  return { ...dom, chrome, observers };
}

// Whether the page was stopped and replaced — i.e. the user was gated.
const gated = (dom) => dom.window.stopped;

const LIVE_SESSION = {
  domain: 'instagram.com',
  reason: 'check DMs',
  startTime: Date.now(),
  intervalMinutes: 10
};

afterEach(() => {
  vi.useRealTimers();
});

describe('when the background answers', () => {
  it('gates a blocked page with no live pass', async () => {
    const dom = loadContent({
      sendMessage: (message, cb) => cb({ setupComplete: true, isBlocked: true, matchedDomain: 'instagram.com', accessRoute: 'hosted', session: null })
    });
    await vi.waitFor(() => expect(gated(dom)).toBe(true));
  });

  it('leaves a page that is not blocked alone', async () => {
    const dom = loadContent({
      sendMessage: (message, cb) => cb({ setupComplete: true, isBlocked: false })
    });
    await new Promise(r => setTimeout(r, 20));
    expect(gated(dom)).toBe(false);
  });
});

describe('when the background never answers', () => {
  it('gates from storage rather than letting the site through', async () => {
    vi.useFakeTimers();
    const dom = loadContent({
      storage: { setupComplete: true, blockedDomains: ['instagram.com'] },
      sendMessage: () => {} // callback never fires — a suspended background page
    });
    await vi.advanceTimersByTimeAsync(10000);
    expect(gated(dom)).toBe(true);
  });

  it('still leaves sites that are not on the blocklist alone', async () => {
    vi.useFakeTimers();
    const dom = loadContent({
      storage: { setupComplete: true, blockedDomains: ['reddit.com'] },
      sendMessage: () => {}
    });
    await vi.advanceTimersByTimeAsync(10000);
    expect(gated(dom)).toBe(false);
  });

  it('honours a pass that is still running', async () => {
    vi.useFakeTimers();
    const dom = loadContent({
      storage: {
        setupComplete: true,
        blockedDomains: ['instagram.com'],
        activeSessions: { 'target:instagram.com': { ...LIVE_SESSION, startTime: Date.now() } }
      },
      sendMessage: () => {}
    });
    await vi.advanceTimersByTimeAsync(10000);
    expect(gated(dom)).toBe(false);
  });

  it('gates once a pass has run out', async () => {
    vi.useFakeTimers();
    const dom = loadContent({
      storage: {
        setupComplete: true,
        blockedDomains: ['instagram.com'],
        activeSessions: { '3': { ...LIVE_SESSION, startTime: Date.now() - 30 * 60000 } }
      },
      sendMessage: () => {}
    });
    await vi.advanceTimersByTimeAsync(10000);
    expect(gated(dom)).toBe(true);
  });

  it('retries before giving up on the background', async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const dom = loadContent({
      storage: { setupComplete: true, blockedDomains: ['instagram.com'] },
      sendMessage: (message, cb) => {
        attempts += 1;
        // Answers only once the background page has had time to wake.
        if (attempts < 3) return;
        cb({ setupComplete: true, isBlocked: true, matchedDomain: 'instagram.com', accessRoute: 'hosted', session: null });
      }
    });
    await vi.advanceTimersByTimeAsync(10000);
    expect(attempts).toBeGreaterThanOrEqual(3);
    expect(gated(dom)).toBe(true);
  });
});

// When a pass runs out the background sends showCheckin. That used to render
// the panel and nothing else -- no window.stop(), no body wipe, no re-attach
// observer -- so the site stayed fully live behind it: video playing, page
// scrolling, and an SPA re-render able to drop the panel entirely.
describe('the check-in overlay blocks the page', () => {
  const showCheckin = (dom) => {
    const listener = dom.chrome.runtime._listeners.at(-1);
    listener({ action: 'showCheckin' });
  };

  function withLivePass() {
    return loadContent({
      storage: {
        setupComplete: true,
        blockedDomains: ['instagram.com'],
        activeSessions: { 'target:instagram.com': { ...LIVE_SESSION, startTime: Date.now() } }
      },
      sendMessage: (message, cb) => cb && cb({
        setupComplete: true,
        isBlocked: true,
        matchedDomain: 'instagram.com',
        accessRoute: 'hosted',
        session: { ...LIVE_SESSION, startTime: Date.now() }
      })
    });
  }

  it('stops the page, as the gate does', async () => {
    const dom = withLivePass();
    await vi.waitFor(() => expect(dom.chrome.runtime._listeners.length).toBeGreaterThan(0));
    expect(gated(dom)).toBe(false); // the pass was live, so nothing was blocked yet

    showCheckin(dom);
    expect(gated(dom)).toBe(true);
  });

  it('leaves an observer watching so an SPA cannot drop the overlay', async () => {
    const dom = withLivePass();
    await vi.waitFor(() => expect(dom.chrome.runtime._listeners.length).toBeGreaterThan(0));
    showCheckin(dom);
    expect(dom.observers.some(o => o.observing)).toBe(true);
  });

  it('stops the badge before wiping the body, so it cannot reappear over the overlay', async () => {
    const dom = withLivePass();
    await vi.waitFor(() => expect(dom.chrome.runtime._listeners.length).toBeGreaterThan(0));
    const badgeObserver = dom.observers[0];
    expect(badgeObserver?.observing).toBe(true);

    showCheckin(dom);
    expect(badgeObserver.observing).toBe(false);
  });
});
