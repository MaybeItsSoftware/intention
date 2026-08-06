// vm-based loader for the Intention extension source files.
//
// The extension's source files are plain scripts that attach functions and
// consts to the global scope (no module.exports / export). They must stay
// byte-identical across the three browser variants, so we DO NOT add exports.
// Instead we read a source file and evaluate it inside a fresh `vm` context
// with mocked globals (`chrome`, `fetch`, ...), then read the functions and
// consts back off that context's global object.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, isAbsolute } from 'node:path';
import vm from 'node:vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(__dirname, '..');

// The three variant directories that hold byte-identical shared source files.
export const VARIANTS = {
  chrome: join(REPO_ROOT, 'Intention Chrome'),
  firefox: join(REPO_ROOT, 'Intention Firefox'),
  apple: join(REPO_ROOT, 'Intention Apple', 'Shared (Extension)', 'Resources')
};

// Resolve a source file. `file` is a bare filename like 'prompts.js'.
// `variant` may be a key of VARIANTS ('chrome' default) or an absolute dir path.
function resolveSourcePath(file, variant = 'chrome') {
  if (isAbsolute(file)) return file;
  const dir = VARIANTS[variant] || (isAbsolute(variant) ? variant : VARIANTS.chrome);
  return join(dir, file);
}

// ---------------------------------------------------------------------------
// Mock chrome.storage.local backed by an in-memory object.
// ---------------------------------------------------------------------------
//
// Supports the call shapes the extension actually uses:
//   chrome.storage.local.get(keys, cb)   keys: string | string[] | object | null
//   chrome.storage.local.set(obj, cb)
//   chrome.storage.local.remove(keys, cb)
export function makeStorageArea(store) {
  return {
    get(keys, cb) {
      let result = {};
      if (keys == null) {
        result = structuredClone(store);
      } else if (typeof keys === 'string') {
        if (keys in store) result[keys] = structuredClone(store[keys]);
      } else if (Array.isArray(keys)) {
        for (const k of keys) if (k in store) result[k] = structuredClone(store[k]);
      } else if (typeof keys === 'object') {
        // object form: keys are names, values are defaults
        for (const [k, def] of Object.entries(keys)) {
          result[k] = k in store ? structuredClone(store[k]) : structuredClone(def);
        }
      }
      // chrome's API is async-callback; emulate that ordering.
      Promise.resolve().then(() => cb && cb(result));
    },
    set(obj, cb) {
      for (const [k, v] of Object.entries(obj)) store[k] = structuredClone(v);
      Promise.resolve().then(() => cb && cb());
    },
    remove(keys, cb) {
      const arr = Array.isArray(keys) ? keys : [keys];
      for (const k of arr) delete store[k];
      Promise.resolve().then(() => cb && cb());
    },
    clear(cb) {
      for (const k of Object.keys(store)) delete store[k];
      Promise.resolve().then(() => cb && cb());
    }
  };
}

export function makeMockChrome(seed = {}) {
  const store = structuredClone(seed);

  const listeners = [];

  const local = makeStorageArea(store);

  const chrome = {
    storage: {
      local,
      // expose the raw backing store for assertions
      _store: store
    },
    runtime: {
      lastError: null,
      sendMessage: (..._args) => {},
      onMessage: { addListener: (fn) => listeners.push(fn) },
      _listeners: listeners,
      getURL: (p) => `chrome-extension://test/${p}`
    },
    tabs: { query: () => {}, sendMessage: () => {} },
    alarms: { create: () => {}, onAlarm: { addListener: () => {} } }
  };
  return chrome;
}

// ---------------------------------------------------------------------------
// Mock fetch returning canned provider responses.
// ---------------------------------------------------------------------------
//
// Usage: makeMockFetch(handler) where handler(url, init) -> {status?, json?, text?}
// or a plain object/array used as the JSON body of a 200 response.
export function makeMockFetch(handler) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url, init });
    let res = typeof handler === 'function' ? handler(url, init) : handler;
    if (res && typeof res.then === 'function') res = await res;
    res = res || {};
    const status = res.status ?? 200;
    const body = 'json' in res ? res.json : res;
    return {
      ok: status >= 200 && status < 300,
      status,
      async json() { return body; },
      async text() { return typeof body === 'string' ? body : JSON.stringify(body); }
    };
  };
  fn.calls = calls;
  return fn;
}

// ---------------------------------------------------------------------------
// Core loader: evaluate a source file in a fresh vm context.
// ---------------------------------------------------------------------------
//
// Returns the context's global object, on which all top-level functions and
// `const`/`var` declarations from the source are visible (vm hoists top-level
// declarations onto the context global).
// `source` overrides reading from disk (used by loadBackground to evaluate
// several files as one script); `file` then only names the vm frame.
export function loadSource(file, { variant = 'chrome', chrome, fetch, extraGlobals = {}, source } = {}) {
  const path = resolveSourcePath(file, variant);
  const code = source !== undefined ? source : readFileSync(path, 'utf8');

  const sandbox = {
    chrome: chrome || makeMockChrome(),
    fetch: fetch || makeMockFetch({}),
    console,
    Date,
    Math,
    JSON,
    Promise,
    structuredClone,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    encodeURIComponent,
    decodeURIComponent,
    URL,
    URLSearchParams,
    String,
    Number,
    Object,
    Array,
    Error,
    AbortController,
    ...extraGlobals
  };
  // self-reference so `globalThis`/`self` style access works if needed
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;

  // Top-level `function` and `var` declarations are hoisted onto the vm
  // context's global object, but top-level `const`/`let` are NOT — they live
  // in the script's lexical scope and vanish once the script finishes. The
  // source files declare their consts (GRANT_TOOL, PROVIDERS, ...) with
  // `const`, so we append (in the SAME script, where those bindings are still
  // in lexical scope) an epilogue that copies every top-level declared name
  // onto `globalThis`. We do NOT modify the source file on disk — this is
  // string concatenation at load time only.
  const declared = topLevelDeclaredNames(code);
  const epilogue = declared.length
    ? `\n;(function(){${declared
        .map(n => `try{globalThis[${JSON.stringify(n)}]=${n}}catch(e){}`)
        .join('')}})();`
    : '';

  const context = vm.createContext(sandbox);
  vm.runInContext(code + epilogue, context, { filename: path });
  return context;
}

// Find top-level (column-0) const/let/var/function declaration names so we can
// re-expose lexical consts onto globalThis after the script runs. Conservative
// on purpose: only matches declarations starting at the beginning of a line.
function topLevelDeclaredNames(code) {
  const names = new Set();
  const re = /^(?:const|let|var|function|async function)\s+([A-Za-z_$][\w$]*)/gm;
  let m;
  while ((m = re.exec(code)) !== null) names.add(m[1]);
  return [...names];
}

// Convenience: load prompts.js for a variant.
export function loadPrompts(opts = {}) {
  return loadSource('prompts.js', opts);
}

// Convenience: load tracking.js for a variant with seeded storage.
// Returns { ctx, chrome } so tests can inspect the backing store.
export function loadTracking({ variant = 'chrome', seed = {} } = {}) {
  const chrome = makeMockChrome(seed);
  const ctx = loadSource('tracking.js', { variant, chrome });
  return { ctx, chrome };
}

// Convenience: load the whole background worker — providers.js, prompts.js,
// tracking.js and background.js — into ONE vm context, the way the service
// worker (importScripts) and the native background WebViews (four <script>
// tags) both load them. Concatenating is safe because no top-level name is
// declared in more than one of the four.
//
// Returns { ctx, chrome, fetch, listeners } where `listeners` exposes the
// handlers background.js registers, so tests can fire an alarm or a tab close
// the way the browser would. Call ctx.handleMessage(msg, sender) to drive the
// message API — `sender` is {tab:{id}} in the extensions and {} on the native
// ports, which is exactly what the session keying turns on.
export function loadBackground({ seed = {}, fetch, sessionArea = false } = {}) {
  const chrome = makeMockChrome(seed);
  const mockFetch = fetch || makeMockFetch({ content: [{ type: 'text', text: 'ok' }] });

  // Opt-in chrome.storage.session (Chrome MV3 / Firefox 140+ / Safari 16.4+);
  // without it background.js takes its .local fallback path, like old Safari.
  if (sessionArea) {
    const sessionStore = {};
    chrome.storage.session = makeStorageArea(sessionStore);
    chrome.storage._sessionStore = sessionStore;
  }

  const listeners = { alarm: null, tabRemoved: null, message: null, beforeNavigate: null };
  chrome.webNavigation = {
    onBeforeNavigate: { addListener: (fn) => { listeners.beforeNavigate = fn; } }
  };
  const alarms = [];
  chrome.alarms = {
    create: (name, info) => alarms.push({ name, info }),
    clear: (name) => {
      const i = alarms.findIndex(a => a.name === name);
      if (i !== -1) alarms.splice(i, 1);
    },
    _created: alarms,
    onAlarm: { addListener: (fn) => { listeners.alarm = fn; } }
  };
  // background.js registers more than one onRemoved handler (nav-context
  // cleanup and the session sweep); fire them all, as the browser would.
  const tabRemovedListeners = [];
  listeners.tabRemoved = async (tabId) => {
    for (const fn of tabRemovedListeners) await fn(tabId);
  };
  chrome.tabs = {
    query: async () => [],
    update: async () => {},
    create: async () => {},
    remove: () => {},
    sendMessage: async () => { throw new Error('no content script'); },
    onRemoved: { addListener: (fn) => { tabRemovedListeners.push(fn); } }
  };
  chrome.windows = { update: async () => {} };
  chrome.action = { onClicked: { addListener: () => {} } };
  chrome.runtime.onInstalled = { addListener: () => {} };
  chrome.runtime.onMessage = { addListener: (fn) => { listeners.message = fn; } };
  chrome.runtime.openOptionsPage = () => {};
  // Session (allow) rules are recorded rather than dropped: they are keyed by
  // tab id alone, so a tab holding a pass on two blocked sites has one rule
  // covering one of them, and tests need to see which.
  const sessionRules = [];
  chrome.declarativeNetRequest = {
    getDynamicRules: async () => [],
    updateDynamicRules: async () => {},
    updateSessionRules: async ({ removeRuleIds = [], addRules = [] } = {}) => {
      for (const id of removeRuleIds) {
        const i = sessionRules.findIndex(r => r.id === id);
        if (i !== -1) sessionRules.splice(i, 1);
      }
      sessionRules.push(...addRules);
    },
    _sessionRules: sessionRules
  };

  const sources = ['providers.js', 'prompts.js', 'tracking.js', 'page_context.js', 'background.js']
    .map(f => readFileSync(resolveSourcePath(f, 'chrome'), 'utf8'))
    .join('\n;\n');

  const ctx = loadSource(join(VARIANTS.chrome, '__background_bundle__.js'), {
    chrome,
    fetch: mockFetch,
    source: sources
  });
  return { ctx, chrome, fetch: mockFetch, listeners };
}

// Convenience: load billing.js the way a page does — after providers.js, whose
// entitlementIsActive/DEFAULT_INTENTION_BACKEND_URL it builds on (options.html
// and coaching.html load them in that order).
//
// `window` decides what the module thinks this build is: a native store bridge
// present means 'store' mode, a Safari user agent with no bridge means
// 'managed', anything else 'byok'. Pass `window` to pick.
export function loadBilling({ variant = 'chrome', fetch, window: win = {}, userAgent = 'Chrome/120' } = {}) {
  const mockFetch = fetch || makeMockFetch({});
  const navigator = { userAgent };
  const sources = ['providers.js', 'billing.js']
    .map(f => readFileSync(resolveSourcePath(f, variant), 'utf8'))
    .join('\n;\n');

  const ctx = loadSource(join(VARIANTS[variant], '__billing_bundle__.js'), {
    variant,
    fetch: mockFetch,
    source: sources,
    extraGlobals: { window: { ...win, navigator }, navigator, document: undefined }
  });
  return { ctx, fetch: mockFetch };
}

// Convenience: load providers.js with a mock fetch.
// Returns { ctx, fetch } so tests can inspect captured requests.
export function loadProviders({ variant = 'chrome', fetch } = {}) {
  const mockFetch = fetch || makeMockFetch({});
  const ctx = loadSource('providers.js', { variant, fetch: mockFetch });
  return { ctx, fetch: mockFetch };
}
