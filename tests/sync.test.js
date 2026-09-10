// Privacy-preserving cross-device sync. These tests exercise the same browser
// scripts that ship in every extension/app build: key handling stays local,
// a stale device cannot overwrite a newer vault, and diagnostics are safe to
// paste into a support message.

import { describe, it, expect } from 'vitest';
import { webcrypto } from 'node:crypto';
import { loadSource, makeMockChrome, makeMockFetch } from './load.js';

const btoa = value => Buffer.from(value, 'binary').toString('base64');
const atob = value => Buffer.from(value, 'base64').toString('binary');

function syncContext({ chrome = makeMockChrome(), fetch } = {}) {
  return loadSource('sync.js', {
    chrome,
    fetch,
    extraGlobals: {
      crypto: webcrypto,
      btoa,
      atob,
      TextEncoder,
      TextDecoder,
      navigator: { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X) Chrome/120' },
      document: { getElementById: () => null },
      getConfig: async () => ({}),
      setStatus() {},
      sendBg: async () => ({ ok: true }),
      renderCurrentView: async () => {},
      postBackendAuthed: async () => ({})
    }
  });
}

function backgroundContext({ seed, fetch }) {
  const chrome = makeMockChrome(seed);
  const getStorage = keys => new Promise(resolve => chrome.storage.local.get(keys, resolve));
  const setStorage = values => new Promise(resolve => chrome.storage.local.set(values, resolve));
  const ctx = loadSource('sync-background.js', {
    chrome,
    fetch,
    extraGlobals: {
      crypto: webcrypto,
      btoa,
      TextEncoder,
      DEFAULT_INTENTION_BACKEND_URL: 'https://sync.test',
      getStorage,
      setStorage
    }
  });
  return { ctx, chrome };
}

describe('encrypted sync keys and payloads', () => {
  it('creates a separate random key and never includes non-profile data in its encrypted copy', async () => {
    const ctx = syncContext();
    const first = ctx.newSyncKey();
    const second = ctx.newSyncKey();
    expect(first).toMatch(/^SYNC-(?:[A-F0-9]{8}-){3}[A-F0-9]{8}$/);
    expect(second).not.toBe(first);

    const encrypted = await ctx.encryptSyncProfile({
      blockedDomains: ['reddit.com'],
      userContext: 'Write the essay',
      apiKey: 'must-never-sync',
      entitlement: { token: 'must-never-sync' }
    }, first);
    expect(encrypted.ciphertext).not.toContain('reddit');
    const restored = await ctx.decryptSyncProfile(encrypted, first);
    expect(restored).toEqual({ blockedDomains: ['reddit.com'], userContext: 'Write the essay' });
    await expect(ctx.decryptSyncProfile(encrypted, second)).rejects.toThrow('cannot unlock');
  });

  it('makes a safe diagnostic report with no secrets or profile content', () => {
    const ctx = syncContext();
    const report = ctx.syncDiagnosticsText({
      reachable: true,
      remote: { revision: 3, updatedAt: 1700000000000 },
      local: { syncAutoEnabled: true, syncVaultRevision: 3, syncLastSuccessAt: 1700000000000, syncAutoLastError: '' }
    });
    expect(report).toContain('Device: Mac');
    expect(report).toContain('revision 3');
    expect(report).not.toContain('SYNC-');
    expect(report).not.toContain('Write the essay');
    expect(report).not.toContain('must-never-sync');
  });
});

describe('automatic encrypted saves', () => {
  it('pauses a stale device rather than overwriting a newer encrypted copy', async () => {
    const fetch = makeMockFetch(() => ({ vault: { revision: 4, updatedAt: 1700000000000, iv: 'x', ciphertext: 'y' } }));
    const { ctx, chrome } = backgroundContext({
      fetch,
      seed: { syncAutoEnabled: true, syncAutoKey: 'SYNC-00112233-44556677-8899AABB-CCDDEEFF', syncVaultRevision: 3, entitlement: { token: 'token' } }
    });
    await ctx.runAutomaticSync();
    expect(fetch.calls).toHaveLength(1);
    expect(chrome.storage._store.syncAutoEnabled).toBe(false);
    expect(chrome.storage._store.syncAutoLastError).toContain('newer encrypted copy');
  });

  it('uploads only ciphertext when this device has the current revision', async () => {
    const fetch = makeMockFetch((url, init) => {
      if (url.endsWith('/read')) return { vault: { revision: 4, updatedAt: 1700000000000, iv: 'x', ciphertext: 'y' } };
      return { vault: { revision: 5, updatedAt: 1700000001000, iv: 'new-iv', ciphertext: 'new-ciphertext' } };
    });
    const { ctx, chrome } = backgroundContext({
      fetch,
      seed: {
        syncAutoEnabled: true,
        syncAutoKey: 'SYNC-00112233-44556677-8899AABB-CCDDEEFF',
        syncVaultRevision: 4,
        entitlement: { token: 'token' },
        blockedDomains: ['reddit.com'],
        apiKey: 'never-read-by-sync'
      }
    });
    await ctx.runAutomaticSync();
    expect(fetch.calls).toHaveLength(2);
    const sent = JSON.parse(fetch.calls[1].init.body);
    expect(sent.baseRevision).toBe(4);
    expect(JSON.stringify(sent)).not.toContain('reddit');
    expect(JSON.stringify(sent)).not.toContain('never-read-by-sync');
    expect(chrome.storage._store.syncVaultRevision).toBe(5);
    expect(chrome.storage._store.syncAutoLastError).toBe('');
  });
});
