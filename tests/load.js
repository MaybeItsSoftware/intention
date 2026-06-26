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
export function makeMockChrome(seed = {}) {
  const store = structuredClone(seed);

  const listeners = [];

  const local = {
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
export function loadSource(file, { variant = 'chrome', chrome, fetch, extraGlobals = {} } = {}) {
  const path = resolveSourcePath(file, variant);
  const code = readFileSync(path, 'utf8');

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
    String,
    Number,
    Object,
    Array,
    Error,
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

// Convenience: load providers.js with a mock fetch.
// Returns { ctx, fetch } so tests can inspect captured requests.
export function loadProviders({ variant = 'chrome', fetch } = {}) {
  const mockFetch = fetch || makeMockFetch({});
  const ctx = loadSource('providers.js', { variant, fetch: mockFetch });
  return { ctx, fetch: mockFetch };
}
