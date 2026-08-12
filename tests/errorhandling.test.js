// End-to-end verification of the error-handling hardening added across
// providers.js, background.js, and tracking.js: timeout classification, HTTP
// error classification, network-error detection, resilience to malformed
// tool calls, and storage failures surfacing instead of vanishing silently.

import { describe, it, expect } from 'vitest';
import { loadProviders, loadBackground, loadTracking, makeMockFetch } from './load.js';

const MESSAGES = [{ role: 'user', content: 'hi' }];
const CONFIGURED = { provider: 'anthropic', apiKey: 'test-key', model: 'claude-sonnet-5' };

describe('providers.js — fetchWithTimeout', () => {
  it('aborts a hung request and classifies it as a timeout + network error', async () => {
    // A fetch that never resolves on its own, but honors the abort signal —
    // stands in for a provider connection that just hangs.
    const hangingFetch = (url, init) => new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        const e = new Error('The operation was aborted');
        e.name = 'AbortError';
        reject(e);
      });
    });
    const { ctx } = loadProviders({ fetch: hangingFetch });

    let caught;
    try {
      await ctx.fetchWithTimeout('https://example.com', {}, 20);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
    expect(caught.code).toBe('timeout');
    expect(ctx.isNetworkError(caught)).toBe(true);
  });
});

describe('providers.js — HTTP error classification', () => {
  it('classifies 401 as auth, without leaking raw provider text', async () => {
    const fetch = makeMockFetch({ status: 401, json: 'unauthorized' });
    const { ctx } = loadProviders({ fetch });
    let caught;
    try {
      await ctx.callAnthropic({ apiKey: 'x', model: 'm', system: 's', messages: MESSAGES });
    } catch (e) { caught = e; }
    expect(caught.code).toBe('auth');
  });

  it('classifies 429 as rate_limit', async () => {
    const fetch = makeMockFetch({ status: 429, json: 'slow down' });
    const { ctx } = loadProviders({ fetch });
    let caught;
    try {
      await ctx.callAnthropic({ apiKey: 'x', model: 'm', system: 's', messages: MESSAGES });
    } catch (e) { caught = e; }
    expect(caught.code).toBe('rate_limit');
  });

  it('classifies 500 as provider_error', async () => {
    const fetch = makeMockFetch({ status: 503, json: 'down for maintenance' });
    const { ctx } = loadProviders({ fetch });
    let caught;
    try {
      await ctx.callAnthropic({ apiKey: 'x', model: 'm', system: 's', messages: MESSAGES });
    } catch (e) { caught = e; }
    expect(caught.code).toBe('provider_error');
  });

  it('treats a bare TypeError (offline/DNS) as a network error', () => {
    const { ctx } = loadProviders();
    expect(ctx.isNetworkError(new TypeError('Failed to fetch'))).toBe(true);
  });

  it('does not throw a raw parse error when the provider returns invalid JSON', async () => {
    // A raw fetch mock (not makeMockFetch, which would normalize `json`/`text`
    // back into plain data) so res.json() actually rejects like a real
    // malformed/truncated response body would.
    const fetch = async () => ({
      ok: true,
      status: 200,
      async json() { throw new SyntaxError('Unexpected token'); },
      async text() { return 'not json'; }
    });
    const { ctx } = loadProviders({ fetch });
    await expect(ctx.callAnthropic({ apiKey: 'x', model: 'm', system: 's', messages: MESSAGES }))
      .rejects.toThrow(/Invalid response/);
  });
});

describe('background.js handleChat — LLM failure surfaces a friendly message', () => {
  it('maps an auth error to a human-readable message instead of raw text', async () => {
    const fetch = makeMockFetch({ status: 401, json: 'unauthorized' });
    const { ctx } = loadBackground({ seed: CONFIGURED, fetch });
    const res = await ctx.handleMessage(
      { action: 'chat', mode: 'gate', domain: 'x.com', userMessage: 'hi' },
      {}
    );
    expect(res.error).toMatch(/API key was rejected/i);
    expect(res.networkError).toBe(false);
    // The chat UI's "Fix API key" button branches on this, not on parsing
    // the message text, so it must survive onto the response.
    expect(res.errorCode).toBe('auth');
  });

  it('marks a timeout as a network error so the UI offers a retry with the right copy', async () => {
    // Simulates the abort firing (rather than waiting out the real 30s
    // provider timeout): fetch itself rejects with the same AbortError shape
    // fetchWithTimeout's internal controller.abort() would produce.
    const abortingFetch = async () => {
      const e = new Error('The operation was aborted');
      e.name = 'AbortError';
      throw e;
    };
    const { ctx } = loadBackground({ seed: CONFIGURED, fetch: abortingFetch });
    const res = await ctx.handleMessage(
      { action: 'chat', mode: 'gate', domain: 'x.com', userMessage: 'hi' },
      {}
    );
    expect(res.error).toMatch(/timed out/i);
    expect(res.networkError).toBe(true);
  });
});

describe('background.js handleChat — malformed tool calls do not lose the turn', () => {
  it('still answers and persists history when grant_access has garbage input', async () => {
    const fetch = makeMockFetch({
      content: [
        { type: 'text', text: 'Sure, here you go.' },
        // `minutes` is not a number and `reason` is missing entirely.
        { type: 'tool_use', id: 't1', name: 'grant_access', input: { minutes: 'lots', reason: undefined } }
      ]
    });
    const { ctx, chrome } = loadBackground({ seed: CONFIGURED, fetch });
    const res = await ctx.handleMessage(
      { action: 'chat', mode: 'gate', domain: 'x.com', userMessage: 'let me in' },
      { tab: { id: 1 } }
    );
    expect(res.error).toBeUndefined();
    expect(res.assistantText).toContain('Sure, here you go.');
    // Garbage `minutes` still coerces to a valid grant (Math.max/min/round of NaN||0 -> 1).
    expect(res.grantedSession).toBeTruthy();
    // Transcripts are keyed per (site, day), not per tab — see transcriptKeyFor.
    const [history] = Object.values(chrome.storage._store.chatHistories);
    expect(history.at(-1).content).toContain('Sure, here you go.');
  });

  it('keeps the turn and history when a tool handler throws outright', async () => {
    // save_onboarding with a domain_limits entry whose `.domain` access would
    // throw if item were null — exercise the try/catch around each tool call.
    const fetch = makeMockFetch({
      content: [
        { type: 'text', text: 'Got it, all set.' },
        { type: 'tool_use', id: 't1', name: 'save_onboarding', input: { domain_limits: [null, { domain: 'y.com' }] } }
      ]
    });
    const { ctx, chrome } = loadBackground({ seed: CONFIGURED, fetch });
    const res = await ctx.handleMessage(
      { action: 'chat', mode: 'setup', userMessage: 'done' },
      {}
    );
    expect(res.error).toBeUndefined();
    expect(res.assistantText).toContain('Got it, all set.');
    const history = chrome.storage._store.chatHistories['setup'];
    expect(history).toBeDefined();
    expect(history.at(-1).content).toContain('Got it, all set.');
  });
});

describe('background.js handleMessage — openOptions section deep-link', () => {
  it('creates a new options tab with the section in the URL when none is open', async () => {
    const { ctx, chrome } = loadBackground({ seed: CONFIGURED });
    let created;
    chrome.tabs.create = async (props) => { created = props; };
    const res = await ctx.handleMessage({ action: 'openOptions', section: 'settings' }, {});
    expect(res.ok).toBe(true);
    expect(created.url).toMatch(/options\.html\?section=settings$/);
  });

  it('navigates and focuses an already-open options tab instead of opening a second one', async () => {
    const { ctx, chrome } = loadBackground({ seed: CONFIGURED });
    chrome.tabs.query = async () => [{ id: 7, windowId: 3 }];
    let updatedId, updatedProps, focusedWindow;
    chrome.tabs.update = async (id, props) => { updatedId = id; updatedProps = props; };
    chrome.windows.update = async (windowId) => { focusedWindow = windowId; };
    const res = await ctx.handleMessage({ action: 'openOptions', section: 'settings' }, {});
    expect(res.ok).toBe(true);
    expect(updatedId).toBe(7);
    expect(updatedProps.active).toBe(true);
    expect(updatedProps.url).toMatch(/options\.html\?section=settings$/);
    expect(focusedWindow).toBe(3);
  });

  it('falls back to focusOrCreateTab/openOptionsPage when no section is given', async () => {
    const { ctx, chrome } = loadBackground({ seed: CONFIGURED });
    let openedPage = false;
    chrome.runtime.openOptionsPage = () => { openedPage = true; };
    const res = await ctx.handleMessage({ action: 'openOptions' }, {});
    expect(res.ok).toBe(true);
    expect(openedPage).toBe(true);
  });
});

describe('tracking.js — storage errors surface instead of vanishing silently', () => {
  it('rejects getStorage when chrome.runtime.lastError is set', async () => {
    const { ctx, chrome } = loadTracking();
    chrome.storage.local.get = (keys, cb) => {
      chrome.runtime.lastError = { message: 'QUOTA_BYTES quota exceeded' };
      cb({});
      chrome.runtime.lastError = null;
    };
    await expect(ctx.getStorage(['blockedDomains'])).rejects.toThrow(/quota exceeded/i);
  });

  it('rejects setStorage when chrome.runtime.lastError is set', async () => {
    const { ctx, chrome } = loadTracking();
    chrome.storage.local.set = (obj, cb) => {
      chrome.runtime.lastError = { message: 'extension context invalidated' };
      cb();
      chrome.runtime.lastError = null;
    };
    await expect(ctx.setStorage({ userContext: 'x' })).rejects.toThrow(/context invalidated/i);
  });
});
