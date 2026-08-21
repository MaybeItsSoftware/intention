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
