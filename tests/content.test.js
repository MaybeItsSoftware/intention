// content.js — deciding whether to gate a page.
//
// The interesting part isn't the overlay markup, it's what happens when the
// background doesn't answer: Safari runs it as a non-persistent page, and a
// suspended one can drop the very first message a document_start content
// script sends. A dropped check used to mean the blocked site simply opened.
// These tests drive that path with a DOM stub thin enough to stay readable —
// they assert *whether* the page was gated, never how it looks.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { join } from 'node:path';
import vm from 'node:vm';
import { VARIANTS, makeMockChrome, scriptsForContext, bundleForContext } from './load.js';

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
// report.js comes first, as it does in the manifest — every assistant bubble
// the gate renders binds its press-and-hold reporting handler.
// `withPageContext` also loads page_context.js first, as the manifest does —
// content.js only extracts page context when that file is present.
function loadContent({ storage = {}, sendMessage, dom: domOptions, withPageContext = false, failStorageReads = 0 } = {}) {
  const chrome = makeMockChrome(storage);
  chrome.runtime.sendMessage = sendMessage || (() => {});
  // Fail the first `failStorageReads` reads the way the browser reports it —
  // through runtime.lastError, with the callback still fired.
  if (failStorageReads) {
    const real = chrome.storage.local.get.bind(chrome.storage.local);
    let failed = 0;
    chrome.storage.local.get = (keys, cb) => {
      if (failed >= failStorageReads) return real(keys, cb);
      failed += 1;
      Promise.resolve().then(() => {
        chrome.runtime.lastError = { message: 'storage unavailable' };
        cb({});
        chrome.runtime.lastError = null;
      });
    };
  }
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
  // The manifest's content-script list, minus page_context.js unless this test
  // asked for it — so anything new the manifest starts injecting is loaded
  // here too, rather than surfacing later as a bare ReferenceError.
  const all = scriptsForContext('content');
  const source = bundleForContext('content', {
    only: withPageContext ? all : all.filter(f => f !== 'page_context.js')
  });
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

  // The fail-safe has to reach the same verdict the background would have,
  // from the same stored settings — that is the entire point of it. It used to
  // do that through its own copy of the resolution; it now calls rules.js, and
  // these are the cases that copy got to decide on its own and untested.
  describe('and the rules have to be resolved without it', () => {
    const gateWith = async (storage) => {
      vi.useFakeTimers();
      const dom = loadContent({
        storage: { setupComplete: true, blockedDomains: ['instagram.com'], ...storage },
        sendMessage: () => {}
      });
      await vi.advanceTimersByTimeAsync(10000);
      return dom;
    };

    // What the overlay was handed is the verdict. `matchedBlockConfig` is a
    // top-level `let`, which lives in the context's lexical scope rather than
    // on its global object, so it has to be read by evaluating it there — and
    // round-tripped, so the comparison is against plain host-realm values.
    const config = (dom) =>
      JSON.parse(vm.runInContext('JSON.stringify(matchedBlockConfig)', dom.context));

    it('resolves the global settings when the site carries no override', async () => {
      const dom = await gateWith({
        blockingMode: 'simple', simpleBehavior: 'hard', simplePassMinutes: 25
      });
      expect(gated(dom)).toBe(true);
      expect(config(dom)).toEqual({
        mode: 'simple', behavior: 'hard', passMinutes: 25, looseUntilMinutes: null
      });
    });

    it('lets a per-site override beat the global setting', async () => {
      const dom = await gateWith({
        blockingMode: 'coach',
        domainLimits: { 'instagram.com': { mode: 'simple', passMinutes: 5 } }
      });
      expect(config(dom).mode).toBe('simple');
      expect(config(dom).passMinutes).toBe(5);
    });

    it('falls back to the built-in defaults when nothing is configured', async () => {
      const dom = await gateWith({});
      expect(config(dom)).toEqual({
        mode: 'coach', behavior: 'pass', passMinutes: 10, looseUntilMinutes: null
      });
    });

    // The one that made the mirrors worth unifying: an unset lenient window
    // must stay unset. Read as 0 it would mean "strict from the first minute".
    it('reads an unset lenient window as no split, not as zero', async () => {
      const dom = await gateWith({
        domainLimits: { 'instagram.com': { mode: 'coach' } }
      });
      expect(config(dom).looseUntilMinutes).toBe(null);
    });

    it('carries a lenient window that was set', async () => {
      const dom = await gateWith({
        domainLimits: { 'instagram.com': { looseUntilMinutes: '20' } }
      });
      expect(config(dom).looseUntilMinutes).toBe(20);
    });
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

  // background.js answers a thrown error with `{ error }`, which is a
  // perfectly truthy response object — so this used to sail into
  // applyCheckResult, trip its `!response.isBlocked` early return, and leave
  // the site open for the whole visit with no retry and no fallback.
  it('treats an errored reply as a failed attempt, not a verdict', async () => {
    vi.useFakeTimers();
    const dom = loadContent({
      storage: { setupComplete: true, blockedDomains: ['instagram.com'] },
      sendMessage: (message, cb) => cb({ error: 'Unknown action: checkPageMatch' })
    });
    await vi.advanceTimersByTimeAsync(10000);
    expect(gated(dom)).toBe(true);
  });

  it('does not read a reply with no verdict in it as "not blocked"', async () => {
    vi.useFakeTimers();
    const dom = loadContent({
      storage: { setupComplete: true, blockedDomains: ['instagram.com'] },
      sendMessage: (message, cb) => cb({ setupComplete: true })
    });
    await vi.advanceTimersByTimeAsync(10000);
    expect(gated(dom)).toBe(true);
  });

  it('retries a storage read that fails before giving up on it', async () => {
    vi.useFakeTimers();
    const dom = loadContent({
      storage: { setupComplete: true, blockedDomains: ['instagram.com'] },
      sendMessage: () => {},
      failStorageReads: 1
    });
    await vi.advanceTimersByTimeAsync(10000);
    expect(gated(dom)).toBe(true);
  });

  it('tells the background the page is handled, so the backstop stands down', async () => {
    vi.useFakeTimers();
    const sent = [];
    const dom = loadContent({
      storage: { setupComplete: true, blockedDomains: ['instagram.com'] },
      sendMessage: (message) => { sent.push(message); }
    });
    await vi.advanceTimersByTimeAsync(10000);
    expect(gated(dom)).toBe(true);
    expect(sent.some(m => m.action === 'gateShown')).toBe(true);
  });

  // A re-check firing mid-retry used to be dropped by the `checking` guard —
  // and the triggers that fire mid-retry (the tab became visible, the page came
  // back from the cache) are the ones most likely to catch a missed gate.
  it('does not drop a re-check that arrives while one is in flight', async () => {
    const attemptsWith = async (fireRecheck) => {
      vi.useFakeTimers();
      let attempts = 0;
      // Not on the blocklist, so nothing gates and `handled` stays false —
      // the state a dropped re-check used to strand.
      const dom = loadContent({
        storage: { setupComplete: true, blockedDomains: ['reddit.com'] },
        sendMessage: () => { attempts += 1; }
      });
      await vi.advanceTimersByTimeAsync(500);
      if (fireRecheck) dom.fire('visibilitychange');
      await vi.advanceTimersByTimeAsync(10000);
      vi.useRealTimers();
      return attempts;
    };
    expect(await attemptsWith(true)).toBeGreaterThan(await attemptsWith(false));
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
