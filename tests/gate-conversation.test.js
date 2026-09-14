// gate-ui.js — the conversation the gate has with the coach.
//
// This loop used to exist twice, once in content.js and once in coaching.js,
// and the copies had already drifted: one of them had grown a stale-response
// guard the other lacked, and their offline opener lines differed by a
// character. It is one function now, and this is where its behaviour is
// pinned — every branch that decides what the user sees when a request
// succeeds, fails, times out, or is superseded.
//
// The two hosts differ only in the five things they hand in as `host`, so a
// stub host is not a simplification here: it is the seam the real hosts use.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import vm from 'node:vm';
import { evaluateScripts, filesForContext } from './load.js';

// A DOM stub with just enough behaviour for a transcript: nodes that can be
// appended, removed, classed, and clicked.
function makeElement(tag = 'div') {
  const node = {
    tagName: tag,
    className: '',
    textContent: '',
    value: '',
    type: '',
    style: {},
    children: [],
    parent: null,
    removed: false,
    handlers: {},
    scrollTop: 0,
    scrollHeight: 0,
    classList: {
      add(name) { node.className = `${node.className} ${name}`.trim(); },
      remove(name) {
        node.className = node.className.split(' ').filter(c => c && c !== name).join(' ');
      },
      contains(name) { return node.className.split(' ').includes(name); }
    },
    appendChild(child) {
      child.parent = node;
      node.children.push(child);
      return child;
    },
    remove() {
      node.removed = true;
      if (node.parent) node.parent.children = node.parent.children.filter(c => c !== node);
    },
    attributes: {},
    setAttribute(name, value) { node.attributes[name] = String(value); },
    addEventListener(type, fn) { (node.handlers[type] = node.handlers[type] || []).push(fn); },
    removeEventListener() {},
    focus() {},
    // What a real click does to the handlers report.js and the retry row bind.
    click() { (node.handlers.click || []).forEach(fn => fn({ preventDefault() {} })); }
  };
  return node;
}

function makeDocument() {
  const body = makeElement('body');
  return {
    body,
    documentElement: makeElement('html'),
    createElement: makeElement,
    getElementById: () => null,
    querySelector: () => null,
    addEventListener() {},
    removeEventListener() {}
  };
}

// Stand up gate-ui.js over report.js — the two files the manifest injects
// before content.js — and hand createGateConversation a host that records
// what it was asked to do.
function makeGate({ sendChat, openerFallback = 'FALLBACK LINE' } = {}) {
  const document = makeDocument();
  const sandbox = {
    document,
    window: { location: { href: '' }, addEventListener() {}, removeEventListener() {} },
    console: { log() {}, warn() {}, error() {} },
    chrome: { runtime: { sendMessage() {}, lastError: null } },
    navigator: { userAgent: 'Chrome/120' },
    // Resolved at call time so vitest's fake timers are the ones that run.
    setTimeout: (...args) => setTimeout(...args),
    clearTimeout: (...args) => clearTimeout(...args),
    setInterval: (...args) => setInterval(...args),
    clearInterval: (...args) => clearInterval(...args),
    Math, JSON, Promise, Error, Object, Array, String, Number, Date
  };
  sandbox.globalThis = sandbox;
  const context = vm.createContext(sandbox);
  // A deliberately minimal context: the conversation, and the report handler
  // every assistant bubble binds. Nothing else in the gate is under test here.
  evaluateScripts(context, filesForContext('content', { only: ['report.js', 'gate-ui.js'] }));

  const messages = makeElement();
  const input = makeElement('input');
  const sendButton = makeElement('button');
  const host = {
    messages,
    input,
    sendButton,
    openerFallback,
    sendChat: sendChat || (() => Promise.resolve({ assistantText: 'ok' })),
    locked: 0,
    granted: [],
    settingsOpened: 0,
    onLocked() { host.locked += 1; },
    onGranted(session) { host.granted.push(session); },
    onOpenSettings() { host.settingsOpened += 1; }
  };
  const conversation = sandbox.createGateConversation(host);
  return { conversation, host, messages, input, sendButton, sandbox };
}

// Everything currently in the transcript, in order, as text.
const transcript = (messages) => messages.children.map(c => c.textContent);
// The bubbles only — the retry row is a child of the transcript too.
const bubbles = (messages) => messages.children.filter(c => c.className.startsWith('int-msg'));
const retryRow = (messages) => messages.children.find(c => c.className === 'int-retry-row');
const button = (row, label) => row && row.children.find(b => b.textContent === label);

// Long enough for any request to settle and any reveal to finish: typeMessage
// paints in 24 steps of 12ms, and the host promises here resolve immediately.
const settle = () => vi.advanceTimersByTimeAsync(1000);

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('the coach speaks first', () => {
  it('opens the conversation without a user turn', async () => {
    const sent = [];
    const g = makeGate({ sendChat: (m) => { sent.push(m); return Promise.resolve({ assistantText: 'Hey.' }); } });
    g.conversation.attemptOpen();
    await settle();
    // null, not '': the background reads a missing userMessage as "no user
    // turn yet" and records its own marker instead.
    expect(sent).toEqual([null]);
    expect(transcript(g.messages)).toEqual(['Hey.']);
  });

  it('types the reply into the thinking bubble rather than a second one', async () => {
    const g = makeGate({ sendChat: () => Promise.resolve({ assistantText: 'A whole sentence, revealed.' }) });
    g.conversation.attemptOpen();
    // Before the reply lands there is one bubble, and it is the placeholder.
    expect(transcript(g.messages)).toEqual(['…']);
    expect(bubbles(g.messages)[0].classList.contains('int-thinking')).toBe(true);
    await settle();
    expect(transcript(g.messages)).toEqual(['A whole sentence, revealed.']);
    expect(bubbles(g.messages)[0].classList.contains('int-thinking')).toBe(false);
  });

  it('falls back to the hardcoded line when the opener cannot be fetched', async () => {
    const g = makeGate({ sendChat: () => Promise.reject(new Error('timeout')) });
    g.conversation.attemptOpen();
    await settle();
    // No retry row: the composer stays live, so the first reply retries it.
    expect(transcript(g.messages)).toEqual(['FALLBACK LINE']);
    expect(retryRow(g.messages)).toBeUndefined();
  });

  it('falls back when the reply comes back empty', async () => {
    const g = makeGate({ sendChat: () => Promise.resolve({ assistantText: '' }) });
    g.conversation.attemptOpen();
    await settle();
    expect(transcript(g.messages)).toEqual(['FALLBACK LINE']);
  });
});

describe('sending a reply', () => {
  it('shows what was typed, clears the composer, and sends it', async () => {
    const sent = [];
    const g = makeGate({ sendChat: (m) => { sent.push(m); return Promise.resolve({ assistantText: 'Noted.' }); } });
    g.input.value = '  five minutes  ';
    g.conversation.send();
    expect(g.input.value).toBe('');
    await settle();
    expect(sent).toEqual(['five minutes']);
    expect(transcript(g.messages)).toEqual(['five minutes', 'Noted.']);
  });

  it('does nothing on an empty composer', async () => {
    const g = makeGate({ sendChat: () => { throw new Error('should not be called'); } });
    g.input.value = '   ';
    g.conversation.send();
    await settle();
    expect(g.messages.children).toEqual([]);
  });

  it('refuses a second send while one is still in flight', async () => {
    let calls = 0;
    const g = makeGate({ sendChat: () => { calls += 1; return new Promise(() => {}); } });
    g.input.value = 'one';
    g.conversation.send();
    g.input.value = 'two';
    g.conversation.send();
    expect(calls).toBe(1);
    expect(transcript(g.messages)).toEqual(['one', '…']);
  });

  it('wires the composer to the send button and the Enter key', async () => {
    const sent = [];
    const g = makeGate({ sendChat: (m) => { sent.push(m); return Promise.resolve({ assistantText: 'ok' }); } });
    g.conversation.wireComposer();

    g.input.value = 'by button';
    g.sendButton.click();
    await settle();

    g.input.value = 'by key';
    g.input.handlers.keydown.forEach(fn => fn({ key: 'Enter' }));
    await settle();

    g.input.value = 'by some other key';
    g.input.handlers.keydown.forEach(fn => fn({ key: 'a' }));
    await settle();

    expect(sent).toEqual(['by button', 'by key']);
  });
});

describe('what the host is told about the answer', () => {
  it('renders a system note under the reply', async () => {
    const g = makeGate({
      sendChat: () => Promise.resolve({ assistantText: 'Ten minutes.', systemNote: 'Clamped to your cap.' })
    });
    g.conversation.attemptOpen();
    await settle();
    expect(transcript(g.messages)).toEqual(['Ten minutes.', 'Clamped to your cap.']);
    expect(bubbles(g.messages)[1].className).toContain('int-system');
  });

  it('hands a granted session over only once the reply has finished revealing', async () => {
    const g = makeGate({
      sendChat: () => Promise.resolve({
        assistantText: 'Alright — ten minutes.',
        grantedSession: { intervalMinutes: 10 }
      })
    });
    g.conversation.attemptOpen();
    // The reveal is still running; handing off now would cut the coach off.
    await vi.advanceTimersByTimeAsync(1);
    expect(g.host.granted).toEqual([]);
    await settle();
    expect(g.host.granted).toEqual([{ intervalMinutes: 10 }]);
  });

  it('gives the screen to the host when the account is locked, with nothing to retry', async () => {
    const g = makeGate({ sendChat: () => Promise.resolve({ error: 'out of credit', locked: true }) });
    g.input.value = 'please';
    g.conversation.send();
    await settle();
    expect(g.host.locked).toBe(1);
    // Only the user's own bubble is left: no error text, no retry row, and no
    // thinking bubble stranded behind whatever the host puts up.
    expect(transcript(g.messages)).toEqual(['please']);
  });
});

describe('when the request fails', () => {
  it('says so on a timeout, and Try again re-sends the same text', async () => {
    const sent = [];
    let fail = true;
    const g = makeGate({
      sendChat: (m) => {
        sent.push(m);
        if (fail) return Promise.reject(new Error('timeout'));
        return Promise.resolve({ assistantText: 'Got it.' });
      }
    });
    g.input.value = 'ten minutes';
    g.conversation.send();
    await settle();
    expect(transcript(g.messages)[1]).toMatch(/taking too long/);

    fail = false;
    const retry = button(retryRow(g.messages), 'Try again');
    retry.click();
    await settle();
    // The error bubble and its row are gone, and the same text was re-sent.
    expect(sent).toEqual(['ten minutes', 'ten minutes']);
    expect(transcript(g.messages)).toEqual(['ten minutes', 'Got it.']);
  });

  it('uses the connection wording for a network error', async () => {
    const g = makeGate({ sendChat: () => Promise.resolve({ error: 'fetch failed', networkError: true }) });
    g.input.value = 'hi';
    g.conversation.send();
    await settle();
    expect(transcript(g.messages)[1]).toMatch(/Can't reach the coach/);
  });

  it("passes the provider's own message through when it is not a network error", async () => {
    const g = makeGate({ sendChat: () => Promise.resolve({ error: 'The model refused.' }) });
    g.input.value = 'hi';
    g.conversation.send();
    await settle();
    expect(transcript(g.messages)[1]).toBe('The model refused.');
  });

  it('is still retryable when nothing at all comes back', async () => {
    const g = makeGate({ sendChat: () => Promise.resolve(undefined) });
    g.input.value = 'hi';
    g.conversation.send();
    await settle();
    expect(transcript(g.messages)[1]).toMatch(/no response/);
    expect(button(retryRow(g.messages), 'Try again')).toBeDefined();
  });

  it('offers Fix API key on an auth error, and leaves the row up after it is clicked', async () => {
    const g = makeGate({ sendChat: () => Promise.resolve({ error: 'bad key', errorCode: 'auth' }) });
    g.input.value = 'hi';
    g.conversation.send();
    await settle();
    const row = retryRow(g.messages);
    button(row, 'Fix API key').click();
    expect(g.host.settingsOpened).toBe(1);
    // Left standing so the user can come back and hit Try again here after
    // fixing the key in the settings tab it opened.
    expect(row.removed).toBe(false);
    expect(button(retryRow(g.messages), 'Try again')).toBeDefined();
  });

  it('offers no Fix API key route for any other error', async () => {
    const g = makeGate({ sendChat: () => Promise.resolve({ error: 'rate limited', errorCode: 'rate_limit' }) });
    g.input.value = 'hi';
    g.conversation.send();
    await settle();
    expect(button(retryRow(g.messages), 'Fix API key')).toBeUndefined();
  });
});

// The guard content.js was missing and coaching.js had. A reply that arrives
// after the user has given up and retried must not type itself into a
// transcript that has moved on.
describe('a superseded response', () => {
  it('never reaches the transcript', async () => {
    let settleFirst;
    const replies = [
      new Promise((resolve) => { settleFirst = resolve; }),
      Promise.resolve({ assistantText: 'second' })
    ];
    let n = 0;
    const g = makeGate({ sendChat: () => replies[n++] });

    g.conversation.attemptSend('one');
    g.conversation.attemptSend('two');
    settleFirst({ assistantText: 'first' });
    await settle();

    expect(transcript(g.messages)).toContain('second');
    expect(transcript(g.messages)).not.toContain('first');
  });

  // The reveal takes a beat, so a reply can be superseded *while it is being
  // typed out* — which is the case the second guard, inside typeMessage's
  // completion, is there for.
  it('cannot grant a pass once the user has moved on mid-reveal', async () => {
    let n = 0;
    const g = makeGate({
      sendChat: () => (n++ === 0
        ? Promise.resolve({
            assistantText: 'A reply long enough to still be revealing.',
            grantedSession: { intervalMinutes: 30 }
          })
        : new Promise(() => {}))
    });

    g.conversation.attemptSend('one');
    // Landed, and one step into the reveal — not finished.
    await vi.advanceTimersByTimeAsync(12);
    expect(g.host.granted).toEqual([]);

    g.conversation.attemptSend('two');
    await settle();
    expect(g.host.granted).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The seven-day usage strip on the gate.
//
// Both hosts call loadUsageHistory; only the Android app gate hands it a
// device source. What is pinned here is the edge: which source wins, when the
// user is offered a trip to Settings (only on an explicit "not granted"), and
// that coming back from it looks again.
// ---------------------------------------------------------------------------

function makeUsagePage({ stats = null, lastError = null } = {}) {
  const usageEl = makeElement();
  usageEl.hidden = true;
  // A real element drops its children when textContent is set, which is how
  // the strip clears itself before a repaint. The shared stub only stores the
  // string, so model that here.
  let usageText = '';
  Object.defineProperty(usageEl, 'textContent', {
    get: () => usageText,
    set: (value) => { usageText = String(value); usageEl.children = []; }
  });
  const docHandlers = {};
  const sent = [];
  const document = {
    body: makeElement('body'),
    documentElement: makeElement('html'),
    hidden: false,
    createElement: makeElement,
    getElementById: (id) => (id === 'int-usage' ? usageEl : null),
    querySelector: () => null,
    addEventListener(type, fn) { (docHandlers[type] = docHandlers[type] || []).push(fn); },
    removeEventListener(type, fn) {
      docHandlers[type] = (docHandlers[type] || []).filter(h => h !== fn);
    }
  };
  const chrome = {
    runtime: {
      lastError: null,
      sendMessage(message, cb) {
        sent.push(message);
        chrome.runtime.lastError = lastError;
        if (cb) cb(stats);
        chrome.runtime.lastError = null;
      }
    }
  };
  const sandbox = {
    document,
    window: { location: { href: '' }, addEventListener() {}, removeEventListener() {} },
    console: { log() {}, warn() {}, error() {} },
    chrome,
    navigator: { userAgent: 'Chrome/120' },
    setTimeout, clearTimeout, setInterval, clearInterval,
    Math, JSON, Promise, Error, Object, Array, String, Number, Date
  };
  sandbox.globalThis = sandbox;
  const context = vm.createContext(sandbox);
  evaluateScripts(context, filesForContext('content', { only: ['report.js', 'gate-ui.js'] }));
  const fireVisibility = (hidden) => {
    document.hidden = hidden;
    for (const fn of [...(docHandlers.visibilitychange || [])]) fn();
  };
  return { sandbox, usageEl, sent, docHandlers, fireVisibility };
}

// Seven days oldest first ending today, as both sources deliver them.
function week(minutes) {
  const out = [];
  const last = minutes.length - 1;
  minutes.forEach((m, i) => {
    const d = new Date();
    d.setDate(d.getDate() - (last - i));
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    out.push({ date: key, minutes: m });
  });
  return out;
}

const byClass = (node, name) => {
  const found = [];
  const walk = (n) => {
    if (n.className && n.className.split(' ').includes(name)) found.push(n);
    (n.children || []).forEach(walk);
  };
  walk(node);
  return found;
};
const labelOf = (el) => byClass(el, 'int-usage-label')[0].textContent;

describe('formatting the usage line', () => {
  it('formats minutes as hours and minutes', () => {
    const { sandbox } = makeUsagePage();
    expect(sandbox.formatUsageMinutes(0)).toBe('0m');
    expect(sandbox.formatUsageMinutes(45)).toBe('45m');
    expect(sandbox.formatUsageMinutes(120)).toBe('2h');
    expect(sandbox.formatUsageMinutes(134.4)).toBe('2h 14m');
    expect(sandbox.formatUsageMinutes(-3)).toBe('0m');
    expect(sandbox.formatUsageMinutes('nope')).toBe('0m');
  });

  it('says today and the daily average across the seven days shown', () => {
    const { sandbox } = makeUsagePage();
    // 700 minutes over 7 days = 100/day; today is 134.
    expect(sandbox.summariseUsage(week([100, 100, 100, 66, 100, 100, 134])))
      .toBe('2h 14m today · 1h 40m/day this week');
  });

  it('leaves the average off when nothing before today has time on it', () => {
    const { sandbox } = makeUsagePage();
    expect(sandbox.summariseUsage(week([0, 0, 0, 0, 0, 0, 14]))).toBe('14m today');
    expect(sandbox.summariseUsage(week([0, 0, 0, 0, 0, 0, 0]))).toBe('Nothing in the last 7 days');
  });
});

describe('the usage strip', () => {
  it('draws seven bars scaled to the busiest day, with today marked', () => {
    const { sandbox, usageEl } = makeUsagePage();
    sandbox.renderUsageHistory(usageEl, { source: 'device', days: week([30, 0, 60, 15, 0, 0, 45]) });

    expect(usageEl.hidden).toBe(false);
    const cols = byClass(usageEl, 'int-usage-day');
    expect(cols).toHaveLength(7);
    expect(cols.map(c => c.className.includes('int-usage-today')))
      .toEqual([false, false, false, false, false, false, true]);
    const heights = byClass(usageEl, 'int-usage-bar').map(b => b.style.height);
    expect(heights[2]).toBe('max(2px, 100%)');
    expect(heights[1]).toBe('0');
    expect(heights[6]).toBe('max(2px, 75%)');
    expect(byClass(usageEl, 'int-usage-dow')[6].textContent).toBe('Today');
    expect(labelOf(usageEl)).toMatch(/^Screen time/);
    // Readable without seeing the bars.
    const bars = byClass(usageEl, 'int-usage-bars')[0];
    expect(bars.attributes.role).toBe('img');
    expect(bars.attributes['aria-label']).toContain('Today 45m');
  });

  it("labels Intention's own record as time on passes", () => {
    const { sandbox, usageEl } = makeUsagePage();
    sandbox.renderUsageHistory(usageEl, { source: 'intention', days: week([0, 0, 0, 0, 0, 10, 5]) });
    expect(labelOf(usageEl)).toMatch(/^Time on passes/);
  });

  // A device reading of zero is a fact worth showing; an empty week of passes
  // is just an empty chart on a screen already asking something.
  it('stays hidden for an empty week of passes, but draws an empty device week', () => {
    const passes = makeUsagePage();
    passes.sandbox.renderUsageHistory(passes.usageEl, { source: 'intention', days: week([0, 0, 0, 0, 0, 0, 0]) });
    expect(passes.usageEl.hidden).toBe(true);

    const device = makeUsagePage();
    device.sandbox.renderUsageHistory(device.usageEl, { source: 'device', days: week([0, 0, 0, 0, 0, 0, 0]) });
    expect(device.usageEl.hidden).toBe(false);
    expect(byClass(device.usageEl, 'int-usage-day')).toHaveLength(7);
  });

  it('offers access with one quiet button, even with no strip to draw', () => {
    const { sandbox, usageEl } = makeUsagePage();
    let asked = 0;
    sandbox.renderUsageHistory(usageEl, { source: 'intention', days: [], onRequestAccess: () => { asked += 1; } });
    expect(usageEl.hidden).toBe(false);
    expect(byClass(usageEl, 'int-usage-day')).toHaveLength(0);
    const grant = byClass(usageEl, 'int-usage-grant');
    expect(grant).toHaveLength(1);
    grant[0].click();
    expect(asked).toBe(1);
  });
});

describe('loadUsageHistory: which source the gate shows', () => {
  it("with no device source, draws Intention's own week from the background", () => {
    const page = makeUsagePage({ stats: { dailyMinutes: week([0, 0, 20, 0, 0, 0, 10]) } });
    page.sandbox.loadUsageHistory('reddit.com');
    expect(page.sent).toEqual([{ action: 'getStatsForDomain', domain: 'reddit.com' }]);
    expect(labelOf(page.usageEl)).toMatch(/^Time on passes/);
    expect(byClass(page.usageEl, 'int-usage-grant')).toHaveLength(0);
  });

  it('prefers the device record when it is granted, without asking the background', () => {
    const page = makeUsagePage({ stats: { dailyMinutes: week([0, 0, 0, 0, 0, 0, 1]) } });
    const reads = [];
    page.sandbox.loadUsageHistory('com.instagram.android', {
      read: (days, done) => { reads.push(days); done({ granted: true, days: week([90, 80, 70, 60, 50, 40, 30]) }); },
      requestAccess() {}
    });
    expect(reads).toEqual([7]);
    expect(page.sent).toEqual([]);
    expect(labelOf(page.usageEl)).toMatch(/^Screen time/);
    expect(byClass(page.usageEl, 'int-usage-summary')[0].textContent).toBe('30m today · 1h/day this week');
    expect(byClass(page.usageEl, 'int-usage-grant')).toHaveLength(0);
  });

  it("falls back to Intention's record and offers access when not granted, then looks again on return", () => {
    const page = makeUsagePage({ stats: { dailyMinutes: week([0, 0, 0, 0, 0, 5, 3]) } });
    let granted = false;
    let opened = 0;
    const device = {
      read: (days, done) => done(granted ? { granted: true, days: week([1, 2, 3, 4, 5, 6, 7]) } : { granted: false }),
      requestAccess: () => { opened += 1; }
    };
    page.sandbox.loadUsageHistory('com.instagram.android', device);

    expect(page.sent).toHaveLength(1);
    expect(labelOf(page.usageEl)).toMatch(/^Time on passes/);
    const grant = byClass(page.usageEl, 'int-usage-grant')[0];
    expect(grant.textContent).toBe('Show full screen time for this app');

    grant.click();
    expect(opened).toBe(1);
    // Leaving for Settings changes nothing; coming back reads again.
    page.fireVisibility(true);
    expect(labelOf(page.usageEl)).toMatch(/^Time on passes/);
    granted = true;
    page.fireVisibility(false);
    expect(labelOf(page.usageEl)).toMatch(/^Screen time/);
    expect(byClass(page.usageEl, 'int-usage-grant')).toHaveLength(0);
    // Once: the listener took itself off.
    expect(page.docHandlers.visibilitychange).toEqual([]);
  });

  it('does not offer Settings when the device read failed for another reason', () => {
    const page = makeUsagePage({ stats: { dailyMinutes: week([0, 0, 0, 0, 0, 0, 4]) } });
    page.sandbox.loadUsageHistory('com.instagram.android', {
      read: (days, done) => done({ error: true }),
      requestAccess() {}
    });
    expect(labelOf(page.usageEl)).toMatch(/^Time on passes/);
    expect(byClass(page.usageEl, 'int-usage-grant')).toHaveLength(0);
  });

  it('survives a device source that throws and a background that cannot answer', () => {
    const page = makeUsagePage({ stats: null, lastError: { message: 'gone' } });
    expect(() => page.sandbox.loadUsageHistory('com.instagram.android', {
      read() { throw new Error('bridge missing'); },
      requestAccess() {}
    })).not.toThrow();
    expect(page.usageEl.hidden).toBe(true);
  });

  it('does nothing on a host that renders no strip', () => {
    const page = makeUsagePage();
    page.sandbox.document.getElementById = () => null;
    expect(() => page.sandbox.loadUsageHistory('reddit.com')).not.toThrow();
    expect(page.sent).toEqual([]);
  });
});
