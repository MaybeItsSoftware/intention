// content.js — deciding whether to gate a page.
//
// The interesting part isn't the overlay markup, it's what happens when the
// background doesn't answer: Safari runs it as a non-persistent page, and a
// suspended one can drop the very first message a document_start content
// script sends. A dropped check used to mean the blocked site simply opened.
// These tests drive that path with a DOM stub thin enough to stay readable —
// they assert *whether* the page was gated, never how it looks.

import { describe, it, expect, vi, afterEach } from 'vitest';
import vm from 'node:vm';
import { makeMockChrome, scriptsForContext, evaluateScripts } from './load.js';

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
    // Emptying a node empties it. The overlay's one use of this is
    // ensureBodyAndHush(), which wipes the body before rendering over it — and
    // a stub that kept the old children would report every overlay the page
    // ever had as still attached, which is exactly the question these tests
    // ask of it.
    set innerHTML(html) {
      node._html = html;
      if (html === '') {
        node.children.forEach(child => { child._parent = null; });
        node.children.length = 0;
      }
    },
    get innerHTML() { return node._html || ''; },
    _parent: null,
    appendChild(child) {
      if (child._parent) child.remove();
      child._parent = node;
      node.children.push(child);
      return child;
    },
    insertAdjacentElement() {},
    removeChild() {},
    // A real detach, because "is the old overlay still on the page?" is a real
    // question: every render path starts by removing whatever #intention-root
    // it finds, and a no-op here would let a stale one answer for it.
    remove() {
      const parent = node._parent;
      if (!parent) return;
      const at = parent.children.indexOf(node);
      if (at >= 0) parent.children.splice(at, 1);
      node._parent = null;
    },
    // Recorded, so a test can press a button the overlay wired up: the drift
    // screen's three actions are the only way out of it, and what they leave
    // behind is the state the next overlay has to render over.
    _on: {},
    addEventListener(type, fn) { (node._on[type] = node._on[type] || []).push(fn); },
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
      // The overlay sets innerHTML and then reaches back into it with
      // querySelector, which this stub does not parse — so the node it hands
      // back is a fresh one, and anything written to it (the gate's subtitle
      // is the only case) would otherwise be unreachable from a test. Record
      // them alongside everything else the page made.
      el.querySelector = () => {
        const child = makeElement();
        created.push(child);
        return child;
      };
      created.push(el);
      return el;
    },
    getElementById(id) {
      // The overlay looks up its own inner nodes right after setting innerHTML,
      // which this stub does not parse — so unknown ids are auto-created. The
      // one exception is the overlay root: "is it already on the page?" is a
      // real question the code branches on, and auto-creating it would make
      // every such check answer yes. It is answered from the body, because
      // that is where the overlay puts it — a stub that always answered null
      // would let a check-in walk over a conversation in progress here and
      // never in a browser.
      if (id === 'intention-root') {
        return body.children.find(child => child.id === 'intention-root') || null;
      }
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
  const context = vm.createContext(sandbox);
  // Top-level `let`s (matchedBlockConfig and friends) are read back by running
  // more code in the context, not off the global object, so nothing is exposed.
  evaluateScripts(context, withPageContext ? all : all.filter(f => f !== 'page_context.js'),
    { expose: false });
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

    // What the overlay was handed is the verdict. `matchedIntention` is a
    // top-level `let`, which lives in the context's lexical scope rather than
    // on its global object, so it has to be read by evaluating it there — and
    // round-tripped, so the comparison is against plain host-realm values.
    const intention = (dom) =>
      JSON.parse(vm.runInContext('JSON.stringify(matchedIntention)', dom.context));

    it('reads the intention stored on the site', async () => {
      const dom = await gateWith({
        domainLimits: { 'instagram.com': { maxGrants: 2, passMinutes: 5 } }
      });
      expect(gated(dom)).toBe(true);
      expect(intention(dom)).toEqual({ opens: 2, minutesEach: 5 });
    });

    it('falls back to the built-in defaults when nothing is configured', async () => {
      const dom = await gateWith({});
      expect(intention(dom)).toEqual({ opens: 3, minutesEach: 10 });
    });

    // Zero opens is a hard block, and must survive the round trip as zero
    // rather than falling back to a default that would let them in.
    it('keeps zero opens as zero', async () => {
      const dom = await gateWith({
        domainLimits: { 'instagram.com': { maxGrants: 0 } }
      });
      expect(intention(dom).opens).toBe(0);
    });

    // No credit is not a reason to skip the gate any more: the day's opens
    // are free, so the gate itself is what a locked account sees.
    it('shows the intention gate, not an access interstitial, with no credit', async () => {
      const dom = await gateWith({ domainLimits: { 'instagram.com': { maxGrants: 1 } } });
      expect(gated(dom)).toBe(true);
      expect(dom.created.some(el => /needs either coaching credit/.test(el.textContent || ''))).toBe(false);
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

// ---------------------------------------------------------------------------
// Page-scoped passes, enforced from inside the page.
//
// This is where the feature actually lives. The background worker cannot be
// relied on (Safari suspends it, Chrome's service worker stops whenever it
// likes) and, more to the point, the navigation that ends a scoped pass often
// makes no network request at all: YouTube autoplaying into the next video is
// history.pushState and nothing else. So the content script has to reach the
// verdict itself, on both of its paths — the one where the background answers
// and the one where it never does.
// ---------------------------------------------------------------------------

const VIDEO = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
const NEXT_VIDEO = 'https://www.youtube.com/watch?v=oHg5SJYRHA0';

const scopedSession = (url = VIDEO) => ({
  domain: 'youtube.com',
  reason: 'someone sent me this',
  startTime: Date.now(),
  intervalMinutes: 12,
  scope: {
    kind: 'page',
    key: `yt:video:${new URL(url).searchParams.get('v')}`,
    url,
    label: 'Never Gonna Give You Up',
    verb: 'Watching'
  }
});

const siteSession = () => ({
  domain: 'youtube.com',
  reason: 'research',
  startTime: Date.now(),
  intervalMinutes: 12
});

const badged = (dom) => dom.document.body.children.some(c => c.id === 'intention-badge');
// Presses a control the overlay wired up, the way the user would.
const press = (el) => (el && el._on.click ? el._on.click : []).forEach(fn => fn({ preventDefault() {} }));
const drifted = (dom) => dom.created.some(el => el.textContent === 'That pass was for one page');
// The full coach conversation, which the drift screen deliberately is not.
const coachGate = (dom) => dom.created.some(el => (el._html || '').includes('int-composer'));

// Both paths, driven the same way: `answer` is what the background says, or
// null for a background that never answers at all.
// `sessionKey` is how the pass is filed in storage, and it is not decoration:
// 'target:<domain>' is the tab-agnostic key any tab may hold, 'tab:<id>:<domain>'
// belongs to one tab and one tab only. The storage fail-safe cannot know its own
// tab id, so the key is the only thing that tells the two apart.
function withPass({ session, href = VIDEO, answer = 'background', media = [], sessionKey = 'target:youtube.com' }) {
  const storage = {
    setupComplete: true,
    blockedDomains: ['youtube.com'],
    activeSessions: { [sessionKey]: session }
  };
  return loadContent({
    storage,
    dom: { href, media },
    sendMessage: answer === 'background'
      ? (message, cb) => cb && cb({
        setupComplete: true,
        isBlocked: true,
        matchedDomain: 'youtube.com',
        accessRoute: 'hosted',
        session
      })
      : () => {} // suspended worker: the storage fail-safe decides
  });
}

describe('a pass granted for one page', () => {
  for (const path of ['background', 'storage']) {
    describe(`decided from ${path === 'background' ? 'the worker' : 'storage alone'}`, () => {
      const answer = path === 'background' ? 'background' : null;

      it('shows the badge on the page it was granted for', async () => {
        vi.useFakeTimers();
        const dom = withPass({ session: scopedSession(), answer });
        await vi.advanceTimersByTimeAsync(10000);
        expect(badged(dom)).toBe(true);
        expect(gated(dom)).toBe(false);
        expect(drifted(dom)).toBe(false);
      });

      it('shows the drift screen, not the coach, on a different page', async () => {
        vi.useFakeTimers();
        const dom = withPass({ session: scopedSession(), href: NEXT_VIDEO, answer });
        await vi.advanceTimersByTimeAsync(10000);
        expect(drifted(dom)).toBe(true);
        expect(coachGate(dom)).toBe(false);
      });

      // THE backward-compatibility assertion. Every pass in flight across the
      // upgrade, and every whole-site pass granted after it, has no `scope`
      // key — and must keep covering every URL of its domain.
      it('covers any page of the site when it has no scope at all', async () => {
        vi.useFakeTimers();
        const dom = withPass({ session: siteSession(), href: NEXT_VIDEO, answer });
        await vi.advanceTimersByTimeAsync(10000);
        expect(badged(dom)).toBe(true);
        expect(drifted(dom)).toBe(false);
      });
    });
  }

  // The drift screen goes up over a page that is usually already playing the
  // next thing — stopping that is half of what it is for.
  it('silences the video it interrupts', async () => {
    vi.useFakeTimers();
    const playing = makeMedia();
    const dom = withPass({ session: scopedSession(), href: NEXT_VIDEO, media: [playing] });
    await vi.advanceTimersByTimeAsync(10000);
    expect(drifted(dom)).toBe(true);
    expect(playing.paused).toBe(true);
    expect(playing.muted).toBe(true);
  });

  it('names what the pass was for, so the block coming back is not a surprise', async () => {
    vi.useFakeTimers();
    const dom = withPass({ session: scopedSession() });
    await vi.advanceTimersByTimeAsync(10000);
    const badge = dom.document.body.children.find(c => c.id === 'intention-badge');
    const text = badge.children.map(c => c.textContent).join(' | ');
    expect(text).toContain('This page only');
    expect(text).toContain('Watching "Never Gonna Give You Up"');
  });

  it('leaves the badge alone for a site pass', async () => {
    vi.useFakeTimers();
    const dom = withPass({ session: siteSession() });
    await vi.advanceTimersByTimeAsync(10000);
    const badge = dom.document.body.children.find(c => c.id === 'intention-badge');
    const text = badge.children.map(c => c.textContent).join(' | ');
    expect(text).not.toContain('This page only');
    expect(text).toContain('"research"');
  });
});

// The navigation nobody sees: no request, no commit, no re-injected content
// script. Patching history.pushState is not an option — content scripts run in
// an isolated world in all three engines and never see the page call it — so
// the address is polled, and the poll is what these cover.
describe('the URL watcher', () => {
  async function badgedPass(session, extra = {}) {
    vi.useFakeTimers();
    const dom = withPass({ session, ...extra });
    await vi.advanceTimersByTimeAsync(10000);
    return dom;
  }

  it('catches an in-page move off the granted page within a second', async () => {
    const dom = await badgedPass(scopedSession());
    expect(drifted(dom)).toBe(false);

    dom.window.location.href = NEXT_VIDEO;
    await vi.advanceTimersByTimeAsync(1000);

    expect(drifted(dom)).toBe(true);
  });

  it('says nothing while the address is still the granted one', async () => {
    const dom = await badgedPass(scopedSession());
    dom.window.location.href = `${VIDEO}&t=90s`; // a timestamped re-share
    await vi.advanceTimersByTimeAsync(5000);
    expect(drifted(dom)).toBe(false);
  });

  // Injected into every page on the web: a timer for a feature this page is
  // not using is not acceptable, and a site pass is not using it.
  it('is not armed at all by a pass with no scope', async () => {
    const dom = await badgedPass(siteSession());
    dom.window.location.href = NEXT_VIDEO;
    await vi.advanceTimersByTimeAsync(5000);
    expect(drifted(dom)).toBe(false);
    expect(gated(dom)).toBe(false);
  });

  // The background's webNavigation listener is the fast path in front of the
  // poll. Same callback, so there is one verdict.
  it('also answers the background when webNavigation noticed first', async () => {
    const dom = await badgedPass(scopedSession());
    dom.window.location.href = NEXT_VIDEO;
    dom.chrome.runtime._listeners.at(-1)({ action: 'urlChanged', url: NEXT_VIDEO });
    expect(drifted(dom)).toBe(true);
  });

  // The badge's teardown is what the check-in overlay uses to stop the badge
  // re-attaching over itself. A watcher that outlived it would put a drift
  // screen over a check-in, for a pass that has already ended.
  it('dies with the badge, so a stale timer cannot re-cover a check-in', async () => {
    const dom = await badgedPass(scopedSession());
    dom.chrome.runtime._listeners.at(-1)({ action: 'showCheckin' });
    expect(gated(dom)).toBe(true);

    dom.window.location.href = NEXT_VIDEO;
    await vi.advanceTimersByTimeAsync(5000);

    expect(drifted(dom)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Part rules: only some of a blocked site is blocked.
//
// The two paths matter differently here. The worker's verdict is the ordinary
// one; the storage-only verdict is the one that runs on Safari, whose
// background page is suspended most of the time — so a part rule that worked
// through the worker and failed here would be a rule that quietly stopped
// applying on the platform where the overlay is the ONLY enforcement there is.
// ---------------------------------------------------------------------------

const REELS = 'https://www.instagram.com/reels/abc123/';
const INBOX = 'https://www.instagram.com/direct/inbox/';

// `answer` is what the background says, or null for one that never answers.
function withPartRule({ href, entry, answer = 'background' } = {}) {
  const storage = {
    setupComplete: true,
    blockedDomains: ['instagram.com'],
    domainLimits: { 'instagram.com': entry }
  };
  return loadContent({
    storage,
    dom: { href },
    sendMessage: answer === 'background'
      ? (message, cb) => {
        if (!cb) return;
        // The real worker resolves the verdict itself; this stands in for it
        // with the same shape, including the rule it hands the page to watch
        // the address with.
        const url = message.url || href;
        const gatedHere = /\/reels?\//.test(url);
        cb({
          setupComplete: true,
          isBlocked: gatedHere,
          matchedDomain: 'instagram.com',
          partId: gatedHere ? 'instagram:reels' : null,
          partRule: { scope: 'only', parts: ['instagram:reels'] },
          accessRoute: 'hosted',
          session: null
        });
      }
      : () => {}
  });
}

describe('a site where only some parts are blocked', () => {
  for (const path of ['background', 'storage']) {
    describe(`decided from ${path === 'background' ? 'the worker' : 'storage alone'}`, () => {
      const answer = path === 'background' ? 'background' : null;
      const entry = { maxGrants: 3, scope: 'only', parts: ['instagram:reels'] };

      it('leaves an address the rule keeps open alone', async () => {
        vi.useFakeTimers();
        const dom = withPartRule({ href: INBOX, entry, answer });
        await vi.advanceTimersByTimeAsync(10000);
        expect(gated(dom)).toBe(false);
      });

      it('gates the part the rule names', async () => {
        vi.useFakeTimers();
        const dom = withPartRule({ href: REELS, entry, answer });
        await vi.advanceTimersByTimeAsync(10000);
        expect(gated(dom)).toBe(true);
      });
    });
  }

  // Fail closed, and this is the case that decides it: a rule this build
  // cannot evaluate must gate everything rather than open everything. The
  // storage path is the one that matters, because it is the path with no
  // worker behind it to reach a second opinion.
  it('gates the whole site when the stored rule is malformed', async () => {
    vi.useFakeTimers();
    const dom = withPartRule({
      href: INBOX,
      entry: { scope: 'only', parts: [{ trust: 'me' }] },
      answer: null
    });
    await vi.advanceTimersByTimeAsync(10000);
    expect(gated(dom)).toBe(true);
  });

  // An 'only' rule with nothing in it decides nothing, so it is not a rule:
  // hasPartRule answers false (the host keeps its redirect) and
  // resolvePartVerdict gates. The row's empty-state copy says exactly this.
  it('gates the whole site when the rule names no parts at all', async () => {
    vi.useFakeTimers();
    const dom = withPartRule({ href: INBOX, entry: { scope: 'only', parts: [] }, answer: null });
    await vi.advanceTimersByTimeAsync(10000);
    expect(gated(dom)).toBe(true);
  });

  it('names the part in the gate, so the block reads as the one they asked for', async () => {
    vi.useFakeTimers();
    const dom = withPartRule({ href: REELS, entry: { scope: 'only', parts: ['instagram:reels'] } });
    await vi.advanceTimersByTimeAsync(10000);
    const target = dom.created.find(el => el.textContent === 'Reels on instagram.com');
    expect(target && target.textContent).toBe('Reels on instagram.com');
  });

  describe('the URL watcher', () => {
    // The navigation nobody sees. An SPA moving from the inbox to Reels makes
    // no request, commits nothing and re-runs no content script — and it is
    // exactly the move a part rule exists to catch.
    it('gates when an in-page move lands on a blocked part', async () => {
      vi.useFakeTimers();
      const dom = withPartRule({ href: INBOX, entry: { scope: 'only', parts: ['instagram:reels'] } });
      await vi.advanceTimersByTimeAsync(10000);
      expect(gated(dom)).toBe(false);

      dom.window.location.href = REELS;
      await vi.advanceTimersByTimeAsync(1000);

      expect(gated(dom)).toBe(true);
    });

    it('says nothing when the move lands on another open part', async () => {
      vi.useFakeTimers();
      const dom = withPartRule({ href: INBOX, entry: { scope: 'only', parts: ['instagram:reels'] } });
      await vi.advanceTimersByTimeAsync(10000);

      dom.window.location.href = 'https://www.instagram.com/direct/t/17842/';
      await vi.advanceTimersByTimeAsync(5000);

      expect(gated(dom)).toBe(false);
    });

    // Injected into every page on the web: a page with no part rule must run
    // no timer at all.
    it('is not armed on a site with no part rule', async () => {
      vi.useFakeTimers();
      const dom = loadContent({
        storage: { setupComplete: true, blockedDomains: [] },
        dom: { href: INBOX },
        sendMessage: (message, cb) => cb && cb({ setupComplete: true, isBlocked: false })
      });
      await vi.advanceTimersByTimeAsync(10000);
      dom.window.location.href = REELS;
      await vi.advanceTimersByTimeAsync(5000);
      expect(gated(dom)).toBe(false);
    });

    it('answers the background when webNavigation noticed the move first', async () => {
      vi.useFakeTimers();
      const dom = withPartRule({ href: INBOX, entry: { scope: 'only', parts: ['instagram:reels'] } });
      await vi.advanceTimersByTimeAsync(10000);

      dom.window.location.href = REELS;
      dom.chrome.runtime._listeners.at(-1)({ action: 'urlChanged', url: REELS });
      await vi.advanceTimersByTimeAsync(50);

      expect(gated(dom)).toBe(true);
    });

    // A rule tightened in another tab has nothing else to deliver it here: a
    // host with a part rule carries no redirect rule, and the gate backstop
    // only runs on a navigation that commits.
    it('picks up a rule edited in another tab without a reload', async () => {
      vi.useFakeTimers();
      // Driven on the storage path, because that is the one a rule change has
      // to reach: the worker may be suspended, and on Safari usually is.
      const dom = withPartRule({
        href: INBOX,
        entry: { scope: 'only', parts: ['instagram:reels'] },
        answer: null
      });
      await vi.advanceTimersByTimeAsync(10000);
      expect(gated(dom)).toBe(false);

      const tightened = { 'instagram.com': { scope: 'only', parts: ['instagram:dms'] } };
      dom.chrome.storage._store.domainLimits = tightened;
      dom.chrome.storage._fireChange({ domainLimits: { newValue: tightened } }, 'local');
      await vi.advanceTimersByTimeAsync(10000);

      expect(gated(dom)).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// The two features on top of each other: a site that is only PARTLY blocked,
// with a page-scoped pass live on the part that is.
//
// Separately each one is settled. Together they raise a question of order —
// "is this address blocked at all?" or "does the pass still cover it?" — and
// the answer has to be the same one on every path into the page, or the same
// URL gets two different verdicts depending on how the user arrived at it.
// ---------------------------------------------------------------------------

const RUST_POST = 'https://www.reddit.com/r/rust/comments/abc123/why_is_it_fast/';
const NEXT_RUST_POST = 'https://www.reddit.com/r/rust/comments/def456/lifetimes/';
const CATS = 'https://www.reddit.com/r/cats/';

// Only r/rust is blocked. Everything else on reddit.com is the user's own rule
// leaving the site open, and nothing at all may be rendered over it.
const RUST_ONLY = { scope: 'only', parts: ['reddit:sub:rust'] };

const redditPass = () => ({
  domain: 'reddit.com',
  reason: 'someone linked it',
  startTime: Date.now(),
  intervalMinutes: 12,
  scope: {
    kind: 'page',
    key: 'reddit:post:abc123',
    url: RUST_POST,
    label: 'Why is it fast',
    verb: 'Reading'
  }
});

function withScopedPassOnPartRule({ href = RUST_POST, answer = 'background' } = {}) {
  const session = redditPass();
  return loadContent({
    storage: {
      setupComplete: true,
      blockedDomains: ['reddit.com'],
      domainLimits: { 'reddit.com': RUST_ONLY },
      activeSessions: { 'target:reddit.com': session }
    },
    dom: { href },
    sendMessage: answer === 'background'
      ? (message, cb) => {
        if (!cb) return;
        // Stands in for the worker, reaching the same verdict it does: the
        // part rule decides `isBlocked`, and the rule itself rides along for
        // the page to watch the address with.
        const url = message.url || href;
        const gatedHere = /^\/r\/rust(\/|$)/i.test(new URL(url).pathname);
        cb({
          setupComplete: true,
          isBlocked: gatedHere,
          matchedDomain: 'reddit.com',
          partId: gatedHere ? 'reddit:sub:rust' : null,
          partRule: RUST_ONLY,
          accessRoute: 'hosted',
          session
        });
      }
      : () => {}
  });
}

describe('a page-scoped pass on a site where only some parts are blocked', () => {
  for (const path of ['background', 'storage']) {
    const answer = path === 'background' ? 'background' : null;
    const where = path === 'background' ? 'the worker' : 'storage alone';

    // The control: arriving at r/cats by a hard navigation. The part rule
    // leaves it open, so nothing is rendered — this is the verdict the
    // in-page path below has to agree with.
    it(`renders nothing on an open part reached by a real navigation, from ${where}`, async () => {
      vi.useFakeTimers();
      const dom = withScopedPassOnPartRule({ href: CATS, answer });
      await vi.advanceTimersByTimeAsync(10000);
      expect(gated(dom)).toBe(false);
      expect(drifted(dom)).toBe(false);
    });

    // The same address, reached the way Reddit actually gets you there. A
    // pushState off the post the pass was granted for lands on a page the
    // user's own rule leaves entirely open, and a drift screen here is a
    // block they never asked for.
    it(`renders nothing on an open part reached by pushState, from ${where}`, async () => {
      vi.useFakeTimers();
      const dom = withScopedPassOnPartRule({ answer });
      await vi.advanceTimersByTimeAsync(10000);
      expect(badged(dom)).toBe(true);

      dom.window.location.href = CATS;
      await vi.advanceTimersByTimeAsync(5000);

      expect(drifted(dom)).toBe(false);
      expect(gated(dom)).toBe(false);
    });

    // ...and the pass is still a pass. Asking the part question first must not
    // cost the scope question its teeth: another r/rust post is blocked, and
    // the pass was not for it.
    it(`still drifts onto another post in the blocked part, from ${where}`, async () => {
      vi.useFakeTimers();
      const dom = withScopedPassOnPartRule({ answer });
      await vi.advanceTimersByTimeAsync(10000);

      dom.window.location.href = NEXT_RUST_POST;
      await vi.advanceTimersByTimeAsync(5000);

      expect(drifted(dom)).toBe(true);
    });
  }
});

// A hidden tab is not a silent one. The poll used to return early unless the
// tab was visible, on the grounds that a hidden tab cannot autoplay its way
// anywhere the user can SEE — which is true, and beside the point: YouTube
// autoplays the next video's audio just as happily in a background tab, and
// the only other signal is a background message from an event Safari's
// support for is unverified.
describe('the URL watcher in a backgrounded tab', () => {
  it('still catches an in-page move while the tab is hidden', async () => {
    vi.useFakeTimers();
    const dom = withPass({ session: scopedSession() });
    await vi.advanceTimersByTimeAsync(10000);
    expect(badged(dom)).toBe(true);

    dom.document.visibilityState = 'hidden';
    dom.fire('visibilitychange');
    dom.window.location.href = NEXT_VIDEO;
    await vi.advanceTimersByTimeAsync(5000);

    expect(drifted(dom)).toBe(true);
  });

  it('polls a visible tab faster than a hidden one', async () => {
    vi.useFakeTimers();
    const dom = withPass({ session: scopedSession() });
    await vi.advanceTimersByTimeAsync(10000);

    dom.document.visibilityState = 'hidden';
    dom.fire('visibilitychange');
    dom.window.location.href = NEXT_VIDEO;
    // Inside the visible cadence, outside the hidden one: a hidden tab is
    // watched more slowly on purpose, and this is what pins that it is slower
    // rather than accidentally identical.
    await vi.advanceTimersByTimeAsync(700);
    expect(drifted(dom)).toBe(false);

    await vi.advanceTimersByTimeAsync(5000);
    expect(drifted(dom)).toBe(true);
  });
});

// The pass expires while the drift screen is up. The background removes the
// rule, sends showCheckin, and chrome.tabs.sendMessage SUCCEEDS — this
// listener is registered and returns — so nothing on that side notices that
// the check-in was swallowed, and the session goes unbanked.
describe('a check-in that arrives while the drift screen is up', () => {
  const checkedIn = (dom) =>
    dom.created.some(el => /Time's up on/.test(el.textContent || ''));

  async function drifting() {
    vi.useFakeTimers();
    const dom = withPass({ session: scopedSession() });
    await vi.advanceTimersByTimeAsync(10000);
    dom.window.location.href = NEXT_VIDEO;
    await vi.advanceTimersByTimeAsync(1000);
    expect(drifted(dom)).toBe(true);
    return dom;
  }

  it('replaces the drift screen with the check-in conversation', async () => {
    const dom = await drifting();
    dom.chrome.runtime._listeners.at(-1)({ action: 'showCheckin' });
    expect(checkedIn(dom)).toBe(true);
  });

  it('leaves only the check-in attached, not the drift screen under it', async () => {
    const dom = await drifting();
    dom.chrome.runtime._listeners.at(-1)({ action: 'showCheckin' });
    const roots = dom.document.body.children.filter(c => c.id === 'intention-root');
    expect(roots.length).toBe(1);
    expect(roots[0].textContent).not.toBe('That pass was for one page');
  });

  // The drift screen's own re-attach observer is the same hazard the badge's
  // is: left running, it faithfully puts the drift screen back on top of the
  // check-in the moment the body is wiped.
  it('stops the drift screen re-attaching itself over the check-in', async () => {
    const dom = await drifting();
    const before = dom.observers.filter(o => o.observing).length;
    dom.chrome.runtime._listeners.at(-1)({ action: 'showCheckin' });
    const after = dom.observers.filter(o => o.observing).length;
    // One observer went away (the drift screen's) and one arrived (the
    // check-in's), so the count cannot have grown.
    expect(after).toBeLessThanOrEqual(before);
  });

  // ...but only over a drift screen. "Ask about this instead" trades the drift
  // screen for a real coach conversation, and a conversation in progress must
  // not be swept away by a check-in for a pass that has since run out — the
  // guard has to come back on the moment the drift screen is gone.
  it('does not replace the gate the drift screen handed over to', async () => {
    const dom = await drifting();
    const ask = dom.created.find(el => el.textContent === 'Ask about this instead');
    press(ask);
    // The handover waits for endSession to land before it opens the gate, so
    // the two writes to this session key cannot race. One turn is all it takes
    // when the worker answers.
    await vi.advanceTimersByTimeAsync(0);
    expect(coachGate(dom)).toBe(true);

    dom.chrome.runtime._listeners.at(-1)({ action: 'showCheckin' });
    expect(checkedIn(dom)).toBe(false);
  });

  // ...and it must not become a way to trap someone either. If the worker
  // never answers, the gate still opens — late, but it opens, and the drift
  // screen stays up in the meantime rather than leaving a blank page.
  it('opens the gate anyway when the background never answers', async () => {
    vi.useFakeTimers();
    const dom = withPass({ session: scopedSession(), href: NEXT_VIDEO, answer: null });
    await vi.advanceTimersByTimeAsync(10000);
    expect(drifted(dom)).toBe(true);

    press(dom.created.find(el => el.textContent === 'Ask about this instead'));
    expect(coachGate(dom)).toBe(false); // still waiting; the drift screen is still up
    await vi.advanceTimersByTimeAsync(3000);
    expect(coachGate(dom)).toBe(true);
  });
});

// What a check-in is ALLOWED to take over, and what the background is told.
//
// The listener is registered from four places, and one of them is a page the
// user's own part rule leaves open — armed there so an SPA move onto a blocked
// part is still noticed. The showCheckin arm never re-asked whether this
// address was gated, so a check-in for a pass earned on Reels erased the DM
// thread the rule allows and offered a Close tab button.
//
// The second half is the reply. A registered listener that returns still
// RESOLVES chrome.tabs.sendMessage on the background side, so "the message was
// delivered" was never evidence that anything was rendered — and the banking
// that lives in that call's catch was skipped every time this page said no.
describe('a check-in arriving on a page it has no business on', () => {
  const REELS_RULE = { scope: 'only', parts: ['instagram:reels'] };
  const INBOX = 'https://www.instagram.com/direct/inbox/';

  // A page the part rule leaves open: nothing is rendered, but the listener is
  // registered so the URL watcher can be answered.
  async function onAnOpenPart(href = INBOX) {
    vi.useFakeTimers();
    const dom = loadContent({
      storage: {
        setupComplete: true,
        blockedDomains: ['instagram.com'],
        domainLimits: { 'instagram.com': REELS_RULE }
      },
      dom: { href },
      sendMessage: (message, cb) => cb && cb({
        setupComplete: true,
        isBlocked: false,
        matchedDomain: 'instagram.com',
        partRule: REELS_RULE
      })
    });
    await vi.advanceTimersByTimeAsync(10000);
    expect(gated(dom)).toBe(false);
    return dom;
  }

  const checkin = (dom, message = { action: 'showCheckin' }) => {
    let replied = null;
    dom.chrome.runtime._listeners.at(-1)(message, {}, (r) => { replied = r; });
    return replied;
  };

  it('leaves a page the part rule keeps open exactly as it found it', async () => {
    const dom = await onAnOpenPart();
    checkin(dom, { action: 'showCheckin', domain: 'instagram.com' });
    expect(gated(dom)).toBe(false);
    expect(dom.document.body.children.length).toBe(0);
  });

  it('tells the background it did not, so the pass gets banked', async () => {
    const dom = await onAnOpenPart();
    expect(checkin(dom, { action: 'showCheckin', domain: 'instagram.com' })).toEqual({ shown: false });
  });

  // A tab can hold passes on two blocked sites at once. The alarm names one of
  // them, and it may not be the site the tab is looking at now.
  it('declines a check-in for a site this tab is not on', async () => {
    vi.useFakeTimers();
    const dom = withPass({ session: siteSession() });
    await vi.advanceTimersByTimeAsync(10000);
    expect(badged(dom)).toBe(true);
    expect(checkin(dom, { action: 'showCheckin', domain: 'instagram.com' })).toEqual({ shown: false });
    expect(gated(dom)).toBe(false);
  });

  it('says yes, and blocks the page, when the check-in really is for here', async () => {
    vi.useFakeTimers();
    const dom = withPass({ session: siteSession() });
    await vi.advanceTimersByTimeAsync(10000);
    expect(checkin(dom, { action: 'showCheckin', domain: 'youtube.com' })).toEqual({ shown: true });
    expect(gated(dom)).toBe(true);
  });

  // The third "no": a conversation already owns the page. It was always
  // correct to decline; what was missing was saying so.
  it('reports a swallowed check-in when a gate already owns the page', async () => {
    vi.useFakeTimers();
    const dom = withPass({ session: scopedSession(), href: NEXT_VIDEO });
    await vi.advanceTimersByTimeAsync(10000);
    press(dom.created.find(el => el.textContent === 'Ask about this instead'));
    await vi.advanceTimersByTimeAsync(0);
    expect(coachGate(dom)).toBe(true);
    expect(checkin(dom, { action: 'showCheckin', domain: 'youtube.com' })).toEqual({ shown: false });
  });
});

// A pass can run out without the address moving at all — the user sits on the
// granted video until the twelve minutes are up. On Chrome the alarm handles
// it; on Safari the background page is suspended, no alarm fires, and this
// poll is the only thing left that can notice.
describe('a pass that runs out while the page sits still', () => {
  const checkedIn = (dom) =>
    dom.created.some(el => /Time's up on/.test(el.textContent || ''));

  // The two tests below run a pass past its end, and the badge ticks once a
  // second, so 13 minutes of fake time is ~800 real timer callbacks with a
  // microtask flush after each. That is CPU-bound work, not waiting: the file
  // takes under a second on an idle machine but the default 5s timeout has
  // been lost to a parallel Xcode build. A longer limit here keeps a busy
  // machine from reading as a hang — nothing in these tests can actually
  // block, since there is no real clock involved.
  const EXPIRY_TIMEOUT_MS = 30000;

  it('takes the page over when the pass expires under it', async () => {
    vi.useFakeTimers();
    const dom = withPass({ session: scopedSession(), answer: null });
    await vi.advanceTimersByTimeAsync(10000);
    expect(badged(dom)).toBe(true);
    expect(gated(dom)).toBe(false);

    await vi.advanceTimersByTimeAsync(13 * 60000);

    expect(badged(dom)).toBe(false);
    expect(checkedIn(dom)).toBe(true);
  }, EXPIRY_TIMEOUT_MS);

  // The drift screen is a statement about a LIVE pass — "you have got 4:12
  // left, and it was for that video". Rendered off an expired one it froze at
  // "You've got 0:00 left" and offered "Back to it" on a pass that was over.
  it('shows the check-in, not a drift screen quoting 0:00, when the pass is dead', async () => {
    vi.useFakeTimers();
    const dom = withPass({ session: scopedSession(), answer: null });
    await vi.advanceTimersByTimeAsync(10000);
    await vi.advanceTimersByTimeAsync(13 * 60000);

    dom.window.location.href = NEXT_VIDEO;
    await vi.advanceTimersByTimeAsync(1000);

    expect(drifted(dom)).toBe(false);
    expect(dom.created.some(el => /0:00 left/.test(el.textContent || ''))).toBe(false);
    expect(checkedIn(dom)).toBe(true);
  }, EXPIRY_TIMEOUT_MS);

  it('still drifts while the pass is genuinely running', async () => {
    vi.useFakeTimers();
    const dom = withPass({ session: scopedSession(), answer: null });
    await vi.advanceTimersByTimeAsync(10000);
    dom.window.location.href = NEXT_VIDEO;
    await vi.advanceTimersByTimeAsync(1000);
    expect(drifted(dom)).toBe(true);
  });
});

// The badge is one of the things "nothing at all may be put over it" names,
// and the arm that returns on an open address never took it down.
describe('the countdown badge on a page the part rule leaves open', () => {
  const REELS = 'https://www.instagram.com/reels/abc123/';
  const INBOX = 'https://www.instagram.com/direct/inbox/';
  const REEL_PASS = () => ({
    domain: 'instagram.com',
    reason: 'one reel',
    startTime: Date.now(),
    intervalMinutes: 12,
    scope: { kind: 'page', key: 'ig:reel:abc123', url: REELS, label: 'a reel', verb: 'Watching' }
  });

  async function onTheGrantedReel() {
    vi.useFakeTimers();
    const dom = loadContent({
      storage: {
        setupComplete: true,
        blockedDomains: ['instagram.com'],
        domainLimits: { 'instagram.com': { scope: 'only', parts: ['instagram:reels'] } },
        activeSessions: { 'target:instagram.com': REEL_PASS() }
      },
      dom: { href: REELS },
      sendMessage: () => {}
    });
    await vi.advanceTimersByTimeAsync(10000);
    expect(badged(dom)).toBe(true);
    return dom;
  }

  it('comes down when an in-page move lands on an address the rule allows', async () => {
    const dom = await onTheGrantedReel();
    dom.window.location.href = INBOX;
    await vi.advanceTimersByTimeAsync(1000);
    expect(badged(dom)).toBe(false);
    expect(gated(dom)).toBe(false);
  });

  // ...and the watcher survives it, or the next move back onto a blocked part
  // would be the one nothing is left to see.
  it('leaves the watcher running, so a move back onto a blocked part still gates', async () => {
    const dom = await onTheGrantedReel();
    dom.window.location.href = INBOX;
    await vi.advanceTimersByTimeAsync(1000);
    expect(badged(dom)).toBe(false);

    dom.window.location.href = 'https://www.instagram.com/reels/zzz999/';
    await vi.advanceTimersByTimeAsync(1000);
    expect(drifted(dom)).toBe(true);
  });

  // ...and the badge comes BACK. Two things conspire here: badgeTeardown
  // removes the badge and then nulls itself, and the "still the granted page"
  // arm of the watcher used to be a bare return that assumed the badge was
  // wherever it left it. So an excursion onto a page the part rule allows —
  // which MUST take the badge down, nothing may sit over an unblocked page —
  // and back again left a live pass with no timer, no scope label and, the
  // part that actually costs the user something, no "Finished" button. Ending
  // early and keeping the minutes you did not spend is the deal the whole
  // scoped-pass idea is sold on, and closing the tab was the only way left to
  // it.
  it('comes back on the move onto the granted page again, Finished and all', async () => {
    const dom = await onTheGrantedReel();

    dom.window.location.href = INBOX;
    await vi.advanceTimersByTimeAsync(1000);
    expect(badged(dom)).toBe(false);
    // Nothing at all over a page the rule leaves open — not the badge, and
    // not anything put up in its place.
    expect(dom.document.body.children.length).toBe(0);

    dom.window.location.href = REELS;
    await vi.advanceTimersByTimeAsync(1000);

    expect(badged(dom)).toBe(true);
    // The badge, not a screen: this is still the page the pass was granted
    // for, so the pass is simply running again.
    expect(gated(dom)).toBe(false);
    expect(drifted(dom)).toBe(false);
    const badges = dom.document.body.children.filter(c => c.id === 'intention-badge');
    expect(badges).toHaveLength(1);
    // The affordance, by id rather than by label, because it is the control
    // that has to be there and not the word on it.
    expect(badges[0].children.some(c => c.id === 'intention-badge-finish')).toBe(true);
    const text = badges[0].children.map(c => c.textContent).join(' | ');
    expect(text).toContain('This page only');
    expect(text).toContain('a reel');
  });
});

// With the worker dead the fail-safe scans every session on the domain, and
// sessions are per tab — but a content script cannot ask for its own tab id,
// so which of them is "this tab's" is not a question this path can answer.
//
// It used to answer it anyway, and only in one direction: the drift screen
// demanded the tab-agnostic `target:<domain>` key while the badge branch above
// it handed out a FULL PASS off any live session it found. Every pass granted
// from a content-script gate carries a tab id, so the strict half excluded the
// ordinary case: the tab that really did hold a scoped pass met the full coach
// gate instead of the free drift screen, and winning that gate makes
// grantSession bank the running pass as 'extended' and overwrite it.
//
// So both branches read the same session now. What that costs in the tab that
// is NOT the owner is real and is the smaller half: "I'm done here" and "Ask
// about this instead" act on a key that tab does not have, and end nothing.
// Both still block the page.
describe('a pass filed under a tab key, read with the worker dead', () => {
  it('drifts, rather than sending the owning tab through the coach again', async () => {
    vi.useFakeTimers();
    const dom = withPass({
      session: scopedSession(),
      href: NEXT_VIDEO,
      answer: null,
      sessionKey: 'tab:7:youtube.com'
    });
    await vi.advanceTimersByTimeAsync(10000);
    expect(drifted(dom)).toBe(true);
    // The page is taken over either way — that half was never the question.
    expect(gated(dom)).toBe(true);
    expect(coachGate(dom)).toBe(false);
  });

  // The same answer the worker's own path gives for the same session, which is
  // the point: the fail-safe exists to reach the verdict the worker would have.
  it('agrees with the worker, which drifts on the same session', async () => {
    vi.useFakeTimers();
    const dom = withPass({
      session: scopedSession(),
      href: NEXT_VIDEO,
      sessionKey: 'tab:7:youtube.com'
    });
    await vi.advanceTimersByTimeAsync(10000);
    expect(drifted(dom)).toBe(true);
  });

  // The tab-agnostic key is the one any tab may hold — it is what the worker
  // itself falls back to for every tab — so it still drifts.
  it('still drifts on a pass filed under the tab-agnostic key', async () => {
    vi.useFakeTimers();
    const dom = withPass({ session: scopedSession(), href: NEXT_VIDEO, answer: null });
    await vi.advanceTimersByTimeAsync(10000);
    expect(drifted(dom)).toBe(true);
  });

  // Fail closed, not open: a tab-owned pass that DOES cover this page is
  // still honoured, because re-gating someone who has already made their case
  // is the cost this fail-safe has always chosen not to pay.
  it('still honours a tab-owned pass on the page it was granted for', async () => {
    vi.useFakeTimers();
    const dom = withPass({
      session: scopedSession(),
      answer: null,
      sessionKey: 'tab:7:youtube.com'
    });
    await vi.advanceTimersByTimeAsync(10000);
    expect(badged(dom)).toBe(true);
    expect(gated(dom)).toBe(false);
  });

  // Both keys live at once, which is the case a tie-break exists for at all.
  //
  // readSession — the worker's own lookup, and the thing this path exists to
  // agree with — tries sessionKeyFor(tabId, domain), a `tab:<id>:<domain>`
  // key, FIRST, and `target:<domain>` only when that misses. This path had the
  // preference the other way round underneath a comment claiming the two
  // agreed, and the cell it got wrong failed OPEN on Safari, the platform
  // where this is the only enforcement there is: an unscoped `target:` pass —
  // exactly the shape a coaching page writes when it cannot learn its own tab
  // id, which on Safari is every time, because sender.tab is not populated for
  // extension pages — covers every URL of the domain. So the page the scoped
  // pass was never granted for got a running badge instead of the drift
  // screen, and the worker awake would have said the opposite.
  //
  // Driven in both key orders, because Object.entries answers in insertion
  // order: a preference that only holds when the right key happened to be
  // written first is not a preference, it is a coincidence.
  describe('with the tab-agnostic key live alongside it', () => {
    const unscopedPass = () => ({
      domain: 'youtube.com',
      reason: 'the unscoped one',
      startTime: Date.now(),
      intervalMinutes: 12
    });

    const bothKeysIn = (order) => order === 'tab first'
      ? { 'tab:7:youtube.com': scopedSession(), 'target:youtube.com': unscopedPass() }
      : { 'target:youtube.com': unscopedPass(), 'tab:7:youtube.com': scopedSession() };

    const readWithWorkerDead = async (href, order) => {
      vi.useFakeTimers();
      const dom = loadContent({
        storage: {
          setupComplete: true,
          blockedDomains: ['youtube.com'],
          activeSessions: bothKeysIn(order)
        },
        dom: { href },
        sendMessage: () => {}
      });
      await vi.advanceTimersByTimeAsync(10000);
      return dom;
    };

    for (const order of ['tab first', 'target first']) {
      // The tie-break itself, asked where BOTH answers would put a badge up:
      // the scoped pass covers the page it was granted for and the unscoped
      // one covers everything. Only one of them can name what the pass was
      // for, so which pass the badge describes is which key was read.
      it(`reads the tab-scoped pass rather than the unscoped one (${order})`, async () => {
        const dom = await readWithWorkerDead(VIDEO, order);
        expect(badged(dom)).toBe(true);
        const badge = dom.document.body.children.find(c => c.id === 'intention-badge');
        const text = badge.children.map(c => c.textContent).join(' | ');
        expect(text).toContain('This page only');
        expect(text).toContain('Never Gonna Give You Up');
        expect(text).not.toContain('the unscoped one');
      });

      // ...and the symptom that made it worth finding: on an address only the
      // unscoped pass would cover, reading the wrong key is a "this page only"
      // badge over a video nobody ever argued for.
      it(`drifts on an address only the unscoped pass would cover (${order})`, async () => {
        const dom = await readWithWorkerDead(NEXT_VIDEO, order);
        expect(drifted(dom)).toBe(true);
        expect(badged(dom)).toBe(false);
      });
    }
  });
});

// ---------------------------------------------------------------------------
// What the drift screen offers when there is no coach behind it.
// ---------------------------------------------------------------------------
//
// This screen is reached BEFORE applyCheckResult's `locked` branch — a live
// pass that does not cover this page is answered before the question of
// whether there is anything to say to it — so what it offers has to answer for
// that branch itself.
//
// "Ask about this instead" ends the pass FIRST and opens a gate second. On a
// balance that ran out mid-pass that is a button which banks the minutes,
// takes the screen away and "Back to it" with it, and hands over to a coach
// that cannot say anything: the user cannot get back to the page they had
// eight minutes left on. Nothing lied to them about money — the button simply
// spent something it could not deliver.
describe('the drift screen on an account with no coach left', () => {
  // `route` is what the worker's resolveAIRoute answered; `undefined` omits
  // the field entirely, which is what "we have not asked" looks like on the
  // wire. `answer: null` is a worker that never answers at all, and that path
  // never resolves a route, so it is the real "not asked" case.
  const driftWith = async ({ route, answer = 'background' }) => {
    vi.useFakeTimers();
    const session = scopedSession();
    const dom = loadContent({
      storage: {
        setupComplete: true,
        blockedDomains: ['youtube.com'],
        activeSessions: { 'target:youtube.com': session }
      },
      dom: { href: NEXT_VIDEO },
      sendMessage: answer === 'background'
        ? (message, cb) => cb && cb({
          setupComplete: true,
          isBlocked: true,
          matchedDomain: 'youtube.com',
          ...(route === undefined ? {} : { accessRoute: route }),
          session
        })
        : () => {}
    });
    await vi.advanceTimersByTimeAsync(10000);
    expect(drifted(dom)).toBe(true);
    return dom;
  };

  // Read off the ATTACHED tree, not off everything the page created: the
  // button is built either way and only sometimes appended, so `created` would
  // answer yes to a screen that never showed it. The actions row is the whole
  // question — what is on it, and in what order.
  const offered = (dom) => {
    const root = dom.document.body.children.find(c => c.id === 'intention-root');
    let actions = null;
    const walk = (node) => {
      if (node.className === 'int-drift-actions') actions = node;
      (node.children || []).forEach(walk);
    };
    if (root) walk(root);
    return actions && actions.children.map(c => c.textContent);
  };

  it('withholds the ask button when the route is locked, and keeps the other two', async () => {
    const dom = await driftWith({ route: 'locked' });
    expect(offered(dom)).toEqual(['Back to it', "I'm done here"]);
  });

  it('offers it when there is credit behind it', async () => {
    const dom = await driftWith({ route: 'hosted' });
    expect(offered(dom)).toEqual(['Back to it', 'Ask about this instead', "I'm done here"]);
  });

  // Not asked is not the same as asked and refused, and the difference is not
  // pedantic: the storage fail-safe never resolves a route at all — there is
  // no worker there to ask — so reading null as locked would take the escape
  // hatch off the platform that leans on this path hardest.
  it('offers it when no route was ever resolved, the worker being dead', async () => {
    const dom = await driftWith({ route: undefined, answer: null });
    expect(offered(dom)).toEqual(['Back to it', 'Ask about this instead', "I'm done here"]);
  });

  it('offers it when the worker answered without naming a route', async () => {
    const dom = await driftWith({ route: undefined });
    expect(offered(dom)).toEqual(['Back to it', 'Ask about this instead', "I'm done here"]);
  });
});

// ---------------------------------------------------------------------------
// An unfinished setup, on a site where only some parts are blocked.
// ---------------------------------------------------------------------------
//
// Two questions and the order they are asked in, and the two paths have to
// order them the same way. The worker computes `isBlocked` as `!!matchedDomain
// && verdict.gated`, and applyCheckResult returns on `!isBlocked` before it
// ever looks at setupComplete — so with the worker awake, an address the part
// rule leaves open renders nothing whether setup was finished or not. The
// storage fail-safe asked about setup first and blanked that same page with
// the "finish setup" card.
//
// It failed towards blocking, so it was never a hole. It was two answers to
// one question on the two paths that exist to give one, which is the thing
// nobody can reason about the next time either side grows a branch — so both
// paths are asserted here, together, rather than each on its own.
describe('an unfinished setup on a site where only some parts are blocked', () => {
  const REELS_RULE = { scope: 'only', parts: ['instagram:reels'] };
  const OPEN = 'https://www.instagram.com/direct/inbox/';
  const GATED = 'https://www.instagram.com/reels/abc123/';

  const setupCarded = (dom) => {
    const seen = [];
    const walk = (node) => {
      seen.push(node.textContent || '');
      (node.children || []).forEach(walk);
    };
    dom.document.body.children.forEach(walk);
    return seen.some(text => /setup was never finished/.test(text));
  };

  // One storage, two paths over it. The worker's reply is built the way
  // checkPageMatch builds it: the part verdict decides `isBlocked`, the rule
  // rides along, and `setupComplete` is reported on every reply rather than
  // being what the reply is about. A fresh install resolves to a locked route,
  // so that is what it says — and the setup card still has to win over it.
  const unfinished = async (href, path) => {
    vi.useFakeTimers();
    const dom = loadContent({
      storage: {
        setupComplete: false,
        blockedDomains: ['instagram.com'],
        domainLimits: { 'instagram.com': REELS_RULE }
      },
      dom: { href },
      sendMessage: path === 'the worker'
        ? (message, cb) => {
          if (!cb) return;
          const gatedHere = /\/reels?\//.test(message.url || href);
          cb({
            setupComplete: false,
            isBlocked: gatedHere,
            matchedDomain: 'instagram.com',
            partId: gatedHere ? 'instagram:reels' : null,
            partRule: REELS_RULE,
            accessRoute: 'locked',
            session: null
          });
        }
        : () => {}
    });
    await vi.advanceTimersByTimeAsync(10000);
    return dom;
  };

  for (const path of ['the worker', 'storage alone']) {
    it(`renders nothing on an address the rule leaves open, from ${path}`, async () => {
      const dom = await unfinished(OPEN, path);
      expect(gated(dom)).toBe(false);
      expect(setupCarded(dom)).toBe(false);
      expect(dom.document.body.children.length).toBe(0);
    });

    it(`still shows the setup card on an address the rule gates, from ${path}`, async () => {
      const dom = await unfinished(GATED, path);
      expect(gated(dom)).toBe(true);
      expect(setupCarded(dom)).toBe(true);
    });
  }
});
