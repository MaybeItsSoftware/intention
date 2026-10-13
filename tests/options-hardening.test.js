// options.js / coaching.js — the page-level guards that are not about any one
// feature: the private-window warning, the settings render not waiting on the
// store, and the gate refusing to run inside someone else's frame.
//
// Like tests/options-domain.test.js, options.js is evaluated in a vm against a
// stub thin enough to get past load. coaching.js runs its whole flow at load
// against a real DOM and a live background, so the guards there are pinned on
// its source text instead.

import { describe, it, expect } from 'vitest';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { evaluateScripts, filesForContext, VARIANTS } from './load.js';

function makeNote() {
  const how = { textContent: '' };
  return {
    hidden: true,
    how,
    querySelector: (sel) => (sel === '[data-incognito-how]' ? how : null)
  };
}

function loadOptions({ window: win = {}, chrome: chromeExtra = {}, browser, baseUrl = 'chrome-extension://abc/' } = {}) {
  const notes = { 'incognito-card': makeNote(), 'setup-incognito-note': makeNote() };
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    document: {
      addEventListener() {},
      getElementById: (id) => notes[id] || null,
      documentElement: { classList: { contains: () => false } }
    },
    window: win,
    navigator: { userAgent: 'Chrome/120' },
    localStorage: { getItem: () => null, setItem() {} },
    chrome: {
      runtime: { getURL: (p) => baseUrl + p, sendMessage() {}, lastError: null },
      storage: { local: { get() {}, set() {}, remove() {} } },
      ...chromeExtra
    },
    Date, Math, JSON, Promise, Error, Object, Array, String, Number, RegExp, isNaN, parseInt,
    setTimeout, clearTimeout, URL, URLSearchParams, fetch: async () => ({ ok: false })
  };
  if (browser) sandbox.browser = browser;
  sandbox.globalThis = sandbox;
  const ctx = vm.createContext(sandbox);
  evaluateScripts(ctx, filesForContext('options', { except: ['billing.js', 'report.js'] }));
  return { ctx, notes };
}

describe('the private-window warning', () => {
  // Every browser runs extensions in private windows only when told to, so out
  // of the box a private window is a browser with no gate in it.
  it('shows Chrome the Allow in Incognito switch when access is off', async () => {
    const { ctx, notes } = loadOptions({
      chrome: { extension: { isAllowedIncognitoAccess: (cb) => cb(false) } }
    });
    await ctx.renderIncognitoNote('incognito-card');
    expect(notes['incognito-card'].hidden).toBe(false);
    expect(notes['incognito-card'].how.textContent).toContain('Allow in Incognito');
  });

  it('says nothing when the browser already runs Intention there', async () => {
    const { ctx, notes } = loadOptions({
      chrome: { extension: { isAllowedIncognitoAccess: (cb) => cb(true) } }
    });
    await ctx.renderIncognitoNote('incognito-card');
    expect(notes['incognito-card'].hidden).toBe(true);
  });

  it("asks Firefox through its promise API and names Firefox's setting", async () => {
    const { ctx, notes } = loadOptions({
      baseUrl: 'moz-extension://abc/',
      browser: { extension: { isAllowedIncognitoAccess: async () => false } }
    });
    await ctx.renderIncognitoNote('setup-incognito-note');
    expect(notes['setup-incognito-note'].hidden).toBe(false);
    expect(notes['setup-incognito-note'].how.textContent).toContain('Run in Private Windows');
  });

  it("names Safari's setting in the Safari extension", async () => {
    const { ctx, notes } = loadOptions({
      baseUrl: 'safari-web-extension://abc/',
      browser: { extension: { isAllowedIncognitoAccess: async () => false } }
    });
    await ctx.renderIncognitoNote('incognito-card');
    expect(notes['incognito-card'].how.textContent).toContain('Allow in Private Browsing');
  });

  // The app WebViews have no private mode and no extension API; a shim that
  // happened to answer must not put a browser warning inside an app.
  it.each([
    ['Android', { intentionApps: {} }],
    ['iOS', { intentionScreenTime: {} }],
    ['the Mac app', { intentionExtension: {} }]
  ])('stays silent inside the %s app', async (_name, win) => {
    let asked = false;
    const { ctx, notes } = loadOptions({
      window: win,
      chrome: { extension: { isAllowedIncognitoAccess: (cb) => { asked = true; cb(false); } } }
    });
    await ctx.renderIncognitoNote('incognito-card');
    expect(asked).toBe(false);
    expect(notes['incognito-card'].hidden).toBe(true);
  });

  it('stays silent where the question cannot be asked', async () => {
    const { ctx, notes } = loadOptions();
    await ctx.renderIncognitoNote('incognito-card');
    expect(notes['incognito-card'].hidden).toBe(true);
  });
});

const source = (file) => readFileSync(join(VARIANTS.chrome, file), 'utf8');

function functionBody(text, name) {
  const start = text.indexOf(`function ${name}(`);
  if (start < 0) return null;
  let depth = 0;
  for (let i = text.indexOf('{', start); i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}' && --depth === 0) return text.slice(start, i + 1);
  }
  return null;
}

describe('the settings render does not wait on the store', () => {
  // Awaiting the paywall held the tabs, the usage log and every button bound
  // after it hostage to bridge queries and an unbounded backend check.
  it('starts the AI access render without awaiting it', () => {
    const body = functionBody(source('options.js'), 'showSettingsView');
    expect(body).toBeTruthy();
    expect(body).toContain("refreshAccessUI('access-paywall')");
    expect(body).not.toMatch(/await\s+refreshAccessUI\(/);
    expect(body.indexOf("refreshAccessUI('access-paywall')"))
      .toBeLessThan(body.indexOf('initSettingsTabs()'));
  });
});

describe('the gate page', () => {
  const coaching = source('coaching.js');

  // coaching.html is web-accessible, so any page can frame it: an invisible
  // "Close tab" under someone else's cursor. The guard has to run before the
  // first message to the background.
  it('refuses to run inside a frame, before it sends anything', () => {
    const guard = coaching.indexOf('window.top !== window.self');
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(coaching.indexOf('sendMessage'));
    expect(guard).toBeLessThan(coaching.indexOf('checkDuplicateCoaching'));
  });

  // Ask-to-Buy is waiting on a parent, not failed.
  it("tells a pending purchase it is pending, not that it didn't complete", () => {
    const pending = coaching.indexOf("result.status === 'pending'");
    expect(pending).toBeGreaterThan(-1);
    expect(pending).toBeLessThan(coaching.indexOf("The purchase didn't complete."));
  });

  // The store has already been paid and the purchase consumed; a backend
  // failure must leave the receipt behind for the next check to retry.
  it('keeps the receipt as pending, merged, when verification fails', () => {
    expect(coaching).toMatch(/action: 'mergeEntitlement'/);
    expect(coaching).toContain('pendingReceiptPatch(');
    // Both handlers go through the one guarded path.
    expect(coaching.match(/verifyPurchase\(/g)).toHaveLength(1);
  });
});
