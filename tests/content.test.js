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
    _attrs: {},
    getAttribute(name) { return node._attrs[name] ?? null; },
    querySelector: () => makeElement(),
    contains: () => true,
    focus() {},
    scrollTop: 0,
    scrollHeight: 0
  };
  return node;
}

function makeDom(href = 'https://www.instagram.com/explore/', { title = '', meta = {}, media = [] } = {}) {
  const url = new URL(href);
  const created = [];
  const byId = {};
  const listeners = [];
  const documentElement = makeElement('html');
  const body = makeElement('body');
  const document = {
    documentElement,
    body,
    title,
    visibilityState: 'visible',
    // Only enough of a selector engine for the page-context extractor: meta
    // tags answer from `meta`, everything else is an empty node. Nodes reached
    // through the body answer as missing once the body has been emptied, which
    // is the whole point — extraction after the gate wipes the page sees
    // nothing, so it has to happen before.
    querySelector(selector) {
      const metaMatch = /meta\[(?:property|name)="([^"]+)"\]/.exec(selector);
      if (metaMatch) {
        if (!(metaMatch[1] in meta)) return null;
        const node = makeElement('meta');
        node._attrs.content = meta[metaMatch[1]];
        return node;
      }
      // ensureBodyAndHush() sets body.innerHTML = "", which is exactly when
      // every body-derived field stops being readable.
      if (body.innerHTML === '') return null;
      return makeElement();
    },
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
    // Only the overlay's own query: whatever the page is playing right now.
    querySelectorAll(selector) {
      return selector === 'video, audio' ? media : [];
    },
    _attach(id) { byId[id] = makeElement(); },
    addEventListener(type, fn) { listeners.push({ type, fn }); },
    removeEventListener() {}
  };
  const window = {
    location: {
      href,
      hostname: url.hostname,
      pathname: url.pathname,
      search: url.search,
      reload() {}
    },
    stopped: false,
    stop() { window.stopped = true; },
    close() {},
    addEventListener() {},
    removeEventListener() {}
  };
  // Dispatches to the listeners the overlay registered on the document, which
  // is how a page that starts playing something behind the gate is simulated.
  const fire = (type, target) => {
    listeners.filter(l => l.type === type).forEach(l => l.fn({ target }));
  };
  return { document, window, created, fire, media };
}

// A media element with just enough of one to be silenced.
function makeMedia({ paused = false, muted = false } = {}) {
  return {
    tagName: 'video',
    paused,
    muted,
    pause() { this.paused = true; }
  };
}

// Load content.js the way the browser does: as a plain script over a DOM.
// `withPageContext` also loads page_context.js first, as the manifest does —
// content.js only extracts page context when that file is present.
function loadContent({ storage = {}, sendMessage, dom: domOptions, withPageContext = false } = {}) {
  const chrome = makeMockChrome(storage);
  chrome.runtime.sendMessage = sendMessage || (() => {});
  const dom = domOptions ? makeDom(domOptions.href, domOptions) : makeDom();
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
    clearInterval,
    URL,
    AbortController,
    fetch: async () => { throw new Error('offline'); }
  };
  sandbox.globalThis = sandbox;
  const files = withPageContext ? ['page_context.js', 'content.js'] : ['content.js'];
  const source = files
    .map(f => readFileSync(join(VARIANTS.chrome, f), 'utf8'))
    .join('\n;\n');
  const path = join(VARIANTS.chrome, 'content.js');
  const context = vm.createContext(sandbox);
  vm.runInContext(source, context, { filename: path });
  return { ...dom, chrome, observers, context };
}

// Whether the page was replaced by the overlay — i.e. the user was gated.
const gated = (dom) =>
  dom.document.body.children.some(c => c.id === 'intention-root');

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

  // This script runs at document_start on <all_urls>, and before setup there
  // is no blocklist for anything to match — so an unfinished wizard used to
  // mean every page on the web got replaced by the "finish setup" card.
  it('leaves an unblocked page alone even when setup is unfinished', async () => {
    const dom = loadContent({
      sendMessage: (message, cb) => cb({ setupComplete: false, isBlocked: false })
    });
    await new Promise(r => setTimeout(r, 20));
    expect(gated(dom)).toBe(false);
  });

  it('still shows the setup card on a blocked site when setup is unfinished', async () => {
    const dom = loadContent({
      sendMessage: (message, cb) => cb({ setupComplete: false, isBlocked: true, matchedDomain: 'instagram.com' })
    });
    await vi.waitFor(() => expect(gated(dom)).toBe(true));
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

// Safari runs a cross-site navigation in a fresh process and keeps the old
// page on screen until that load commits to the browser. window.stop() before
// then cancels the swap outright: the tab hangs on the page you came from with
// the progress bar stuck, the address bar naming a site that never arrives,
// and the gate built inside a document nobody is ever shown. Typing a blocked
// domain into the address bar hit this every time. Waiting for a frame or two
// doesn't help — those frames run in the process that hasn't been swapped in.
describe('the gate does not cancel the navigation it is gating', () => {
  const withGate = (dom) => loadContent({
    dom,
    sendMessage: (message, cb) => cb({
      setupComplete: true,
      isBlocked: true,
      matchedDomain: 'instagram.com',
      accessRoute: 'hosted',
      session: null
    })
  });

  it('never stops the load', async () => {
    const dom = withGate();
    await vi.waitFor(() => expect(gated(dom)).toBe(true));
    expect(dom.window.stopped).toBe(false);
  });

  // Letting the page arrive behind the gate is only tolerable if it can't be
  // heard: the overlay covers the picture, nothing covers the sound.
  it('silences what the page was already playing', async () => {
    const playing = makeMedia();
    const dom = withGate({ href: 'https://www.instagram.com/explore/', media: [playing] });
    await vi.waitFor(() => expect(gated(dom)).toBe(true));
    expect(playing.paused).toBe(true);
    expect(playing.muted).toBe(true);
  });

  it('silences what the rest of the load starts playing', async () => {
    const dom = withGate();
    await vi.waitFor(() => expect(gated(dom)).toBe(true));

    const late = makeMedia();
    dom.fire('play', late);
    expect(late.paused).toBe(true);
    expect(late.muted).toBe(true);
  });
});

// When a pass runs out the background sends showCheckin. That used to render
// the panel and nothing else -- no body wipe, nothing silenced, no re-attach
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

// The gate empties the document before it opens the chat, so a page context
// extracted at send time — which is what the chat used to do — is extracted
// from a blank page. Everything the coach could have said about the video,
// thread or post the user was actually opening was lost that way.
describe('page context is captured before the page is wiped', () => {
  const REEL = {
    href: 'https://www.instagram.com/reel/Cabc123/',
    title: 'Sourdough starter in 30 seconds • Instagram',
    meta: { 'og:title': 'Sourdough starter in 30 seconds' }
  };

  it('sends what the page said about itself along with the block check', async () => {
    let sent = null;
    loadContent({
      withPageContext: true,
      dom: REEL,
      sendMessage: (message, cb) => {
        if (message.action === 'checkPageMatch') sent = message;
        cb({ setupComplete: true, isBlocked: true, matchedDomain: 'instagram.com', accessRoute: 'hosted', session: null });
      }
    });
    await vi.waitFor(() => expect(sent).not.toBeNull());
    expect(sent.pageContext.contentType).toBe('Instagram Reel');
    expect(sent.pageContext.threadTitle).toBe('Sourdough starter in 30 seconds');
  });

  it('still knows what the page was after the gate has emptied it', async () => {
    const dom = loadContent({
      withPageContext: true,
      dom: REEL,
      sendMessage: (message, cb) => cb({
        setupComplete: true, isBlocked: true, matchedDomain: 'instagram.com',
        accessRoute: 'hosted', session: null
      })
    });
    await vi.waitFor(() => expect(gated(dom)).toBe(true));

    // The document is now empty — this is precisely the state the chat's own
    // extraction used to run against.
    expect(dom.document.querySelector('h1')).toBeNull();
    const captured = dom.context.capturePageContext();
    expect(captured.threadTitle).toBe('Sourdough starter in 30 seconds');
    expect(captured.contentType).toBe('Instagram Reel');
  });

  it('drops what it captured if the tab has moved to a different page', async () => {
    const dom = loadContent({
      withPageContext: true,
      dom: REEL,
      sendMessage: (message, cb) => cb({ setupComplete: true, isBlocked: false })
    });
    await vi.waitFor(() => expect(dom.context.capturePageContext()).not.toBeNull());

    dom.window.location.href = 'https://www.instagram.com/reel/Zxyz789/';
    dom.window.location.pathname = '/reel/Zxyz789/';
    const captured = dom.context.capturePageContext();

    // Nothing from the previous reel may survive into the new one's context:
    // describing the wrong video is worse than describing none. (A real page
    // would serve its own meta tags here; the stub reuses one set, so the
    // address is what distinguishes them.)
    expect(captured.url).toContain('Zxyz789');
    expect(captured.url).not.toContain('Cabc123');
    expect(captured.title).not.toContain('Cabc123');
  });
});
