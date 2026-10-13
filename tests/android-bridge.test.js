// android-bridge.js — the chrome.* shim the Android WebViews run the shared
// extension pages on top of.
//
// Every other file the Android app ships is a copy of shared/ and is tested as
// such; this one is Android's own, and until now was only ever read as text.
// It is the whole of the page side of the bridge: a wrong key format, a
// callback that never fires or fires twice, and the options page or the gate
// hangs on a user's phone with nothing in any log. So it is evaluated here as
// the WebView evaluates it, in a fresh global scope, against a fake
// AndroidInterface standing in for WebAppInterface.kt — which answers by
// calling window.AndroidCallbacks.invoke(id, jsonString), so that is what the
// fake does too.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';
import { REPO_ROOT } from './load.js';

const BRIDGE = join(REPO_ROOT, 'Intention Android', 'app', 'src', 'main', 'assets', 'android-bridge.js');
const SOURCE = readFileSync(BRIDGE, 'utf8');

// A stand-in for WebAppInterface: records every call, and answers
// callback-taking ones later, from the test, as the Kotlin side does.
function makeAndroidInterface() {
  const calls = [];
  const record = name => (...args) => { calls.push([name, ...args]); };
  return {
    calls,
    getStorage: record('getStorage'),
    setStorage: record('setStorage'),
    sendMessage: record('sendMessage'),
    createAlarm: record('createAlarm'),
    clearAlarm: record('clearAlarm'),
    billingProducts: record('billingProducts'),
    billingPurchase: record('billingPurchase'),
    billingRestore: record('billingRestore'),
    billingRedeem: record('billingRedeem'),
    billingAccountToken: record('billingAccountToken'),
    billingStatus: record('billingStatus'),
    billingManage: record('billingManage'),
    getInstalledApps: record('getInstalledApps'),
    launchApp: record('launchApp'),
    hasUsageAccess: () => true,
    openUsageAccessSettings: record('openUsageAccessSettings'),
    getAppUsageStats: record('getAppUsageStats'),
    getAppUsageHistory: record('getAppUsageHistory')
  };
}

function loadBridge({ chrome } = {}) {
  const android = makeAndroidInterface();
  const context = vm.createContext({
    AndroidInterface: android,
    console: { error: vi.fn(), log() {}, warn() {} },
    JSON
  });
  // In a page, `window` is the global object itself.
  context.window = context;
  if (chrome) context.chrome = chrome;
  vm.runInContext(SOURCE, context, { filename: pathToFileURL(BRIDGE).href });
  // Answer a recorded call the way WebAppInterface.kt does.
  const reply = (cbId, json) => context.AndroidCallbacks.invoke(cbId, json);
  return { window: context, android, reply };
}

describe('android-bridge.js', () => {
  let window, android, reply;

  beforeEach(() => {
    ({ window, android, reply } = loadBridge());
  });

  describe('chrome.storage.local', () => {
    it('get with a single key sends it as a one-element JSON array', () => {
      const cb = vi.fn();
      window.chrome.storage.local.get('blockedSites', cb);

      expect(android.calls).toHaveLength(1);
      const [name, keys, cbId] = android.calls[0];
      expect(name).toBe('getStorage');
      expect(JSON.parse(keys)).toEqual(['blockedSites']);
      expect(cbId).toMatch(/^cb_\d+$/);

      reply(cbId, JSON.stringify({ blockedSites: ['example.com'] }));
      expect(cb).toHaveBeenCalledWith({ blockedSites: ['example.com'] });
    });

    it('get with an array or a defaults object passes it through as JSON', () => {
      window.chrome.storage.local.get(['a', 'b'], () => {});
      window.chrome.storage.local.get({ a: 1 }, () => {});
      window.chrome.storage.local.get(null, () => {});

      expect(JSON.parse(android.calls[0][1])).toEqual(['a', 'b']);
      expect(JSON.parse(android.calls[1][1])).toEqual({ a: 1 });
      expect(android.calls[2][1]).toBe('null');
    });

    it('set serialises the items and calls back once Android confirms', () => {
      const cb = vi.fn();
      window.chrome.storage.local.set({ apiKey: 'k', limits: { a: 5 } }, cb);

      const [name, items, cbId] = android.calls[0];
      expect(name).toBe('setStorage');
      expect(JSON.parse(items)).toEqual({ apiKey: 'k', limits: { a: 5 } });
      expect(cb).not.toHaveBeenCalled();

      reply(cbId, '{"ok":true}');
      expect(cb).toHaveBeenCalledTimes(1);
    });

    it('set without a callback registers nothing and still writes', () => {
      window.chrome.storage.local.set({ a: 1 });
      expect(android.calls[0][2]).toBe('');
      expect(Object.keys(window.AndroidCallbacks._registry)).toHaveLength(0);
    });
  });

  describe('chrome.runtime', () => {
    it('sendMessage serialises the message and delivers the parsed response', () => {
      const cb = vi.fn();
      window.chrome.runtime.sendMessage({ action: 'getUsage', domain: 'x.com' }, cb);

      const [name, message, cbId] = android.calls[0];
      expect(name).toBe('sendMessage');
      expect(JSON.parse(message)).toEqual({ action: 'getUsage', domain: 'x.com' });

      reply(cbId, JSON.stringify({ minutes: 12 }));
      expect(cb).toHaveBeenCalledWith({ minutes: 12 });
    });

    it('getURL resolves against the app assets', () => {
      expect(window.chrome.runtime.getURL('options.html')).toBe('file:///android_asset/options.html');
    });

    it('lastError is null, so callers checking it see success', () => {
      expect(window.chrome.runtime.lastError).toBeNull();
    });
  });

  describe('chrome.alarms', () => {
    it('create forwards the name and serialised info', () => {
      window.chrome.alarms.create('checkin', { delayInMinutes: 5 });
      expect(android.calls[0][0]).toBe('createAlarm');
      expect(android.calls[0][1]).toBe('checkin');
      expect(JSON.parse(android.calls[0][2])).toEqual({ delayInMinutes: 5 });
    });

    it('clear forwards the name and calls back synchronously with true', () => {
      const cb = vi.fn();
      window.chrome.alarms.clear('checkin', cb);
      expect(android.calls[0]).toEqual(['clearAlarm', 'checkin']);
      expect(cb).toHaveBeenCalledWith(true);
    });
  });

  describe('AndroidCallbacks', () => {
    it('gives every registration its own id', () => {
      const a = window.AndroidCallbacks.register(() => {});
      const b = window.AndroidCallbacks.register(() => {});
      expect(a).not.toBe(b);
    });

    it('fires a callback once, then forgets it', () => {
      const cb = vi.fn();
      const id = window.AndroidCallbacks.register(cb);
      window.AndroidCallbacks.invoke(id, '{"n":1}');
      window.AndroidCallbacks.invoke(id, '{"n":2}');
      expect(cb).toHaveBeenCalledTimes(1);
      expect(cb).toHaveBeenCalledWith({ n: 1 });
      expect(window.AndroidCallbacks._registry[id]).toBeUndefined();
    });

    it('passes null for an empty result', () => {
      const cb = vi.fn();
      const id = window.AndroidCallbacks.register(cb);
      window.AndroidCallbacks.invoke(id, '');
      expect(cb).toHaveBeenCalledWith(null);
    });

    // Kotlin hands back raw strings in places; a page waiting on its callback
    // must still hear back rather than hang on a JSON.parse that threw.
    it('falls back to the raw string when the result is not JSON', () => {
      const cb = vi.fn();
      const id = window.AndroidCallbacks.register(cb);
      window.AndroidCallbacks.invoke(id, 'not json');
      expect(cb).toHaveBeenCalledWith('not json');
      expect(window.console.error).toHaveBeenCalled();
    });

    it('ignores an id it does not know', () => {
      expect(() => window.AndroidCallbacks.invoke('cb_999', '{}')).not.toThrow();
    });
  });

  describe('window.intentionBilling', () => {
    it.each([
      ['products', 'billingProducts'],
      ['restore', 'billingRestore'],
      ['redeem', 'billingRedeem'],
      ['accountToken', 'billingAccountToken'],
      ['status', 'billingStatus'],
      ['manage', 'billingManage']
    ])('%s goes to %s with a callback id', (method, native) => {
      const cb = vi.fn();
      window.intentionBilling[method](cb);
      const [name, cbId] = android.calls[0];
      expect(name).toBe(native);
      reply(cbId, '{"ok":true}');
      expect(cb).toHaveBeenCalledWith({ ok: true });
    });

    it('purchase passes the product id ahead of the callback', () => {
      window.intentionBilling.purchase('coaching_credit_5', () => {});
      expect(android.calls[0][0]).toBe('billingPurchase');
      expect(android.calls[0][1]).toBe('coaching_credit_5');
      expect(android.calls[0][2]).toMatch(/^cb_\d+$/);
    });
  });

  describe('window.intentionApps', () => {
    it('forwards the app-blocking helpers', () => {
      window.intentionApps.getInstalledApps(() => {});
      window.intentionApps.launchApp('com.example');
      window.intentionApps.requestUsageAccess();
      window.intentionApps.getAppUsageStats(7, () => {});
      window.intentionApps.getAppUsageHistory('com.example', 14, () => {});

      expect(android.calls.map(c => c[0])).toEqual([
        'getInstalledApps', 'launchApp', 'openUsageAccessSettings',
        'getAppUsageStats', 'getAppUsageHistory'
      ]);
      expect(android.calls[1][1]).toBe('com.example');
      expect(android.calls[3][1]).toBe(7);
      expect(android.calls[4].slice(1, 3)).toEqual(['com.example', 14]);
      expect(window.intentionApps.hasUsageAccess()).toBe(true);
    });

    // Removal goes through background.js's completeRemoval on every platform;
    // the bridge must send that message rather than call the uninstaller.
    it('requestUninstall sends completeRemoval through the message bridge', () => {
      const cb = vi.fn();
      window.intentionApps.requestUninstall(cb);
      const [name, message, cbId] = android.calls[0];
      expect(name).toBe('sendMessage');
      expect(JSON.parse(message)).toEqual({ action: 'completeRemoval' });
      reply(cbId, '{"ok":true}');
      expect(cb).toHaveBeenCalledWith({ ok: true });
    });
  });

  it('leaves an existing chrome.runtime alone when injected twice', () => {
    const existing = { runtime: { sendMessage: () => {} } };
    const { window: w } = loadBridge({ chrome: existing });
    expect(w.chrome).toBe(existing);
    expect(w.AndroidCallbacks).toBeUndefined();
    expect(w.intentionBilling).toBeUndefined();
  });
});
