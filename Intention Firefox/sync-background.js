// Opt-in encrypted sync for the extension/app background.
//
// This file never runs unless the user turned automatic sync on in Settings.
// The sync key is kept only in this device's local storage, is not bridged to
// Apple App Group storage, and is used solely to encrypt before a request.

const AUTO_SYNC_PROFILE_KEYS = [
  'userContext', 'contextProjects', 'contextReasons', 'coachInstructions',
  'blockedDomains', 'domainLimits', 'blockedApps', 'appLimits', 'appLabels',
  'serviceReasons', 'pendingChanges',
  'leaveDelayMinutes'
];
const AUTO_SYNC_KEY_RE = /^SYNC-[A-F0-9]{8}-[A-F0-9]{8}-[A-F0-9]{8}-[A-F0-9]{8}$/;
let automaticSyncQueue = Promise.resolve();

function autoBase64url(bytes) {
  let binary = '';
  for (let start = 0; start < bytes.length; start += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(start, start + 0x8000));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function autoSyncCryptoKey(value) {
  const key = String(value || '').trim().toUpperCase().replace(/\s+/g, '');
  if (!globalThis.crypto?.subtle || !AUTO_SYNC_KEY_RE.test(key)) return null;
  const hex = key.replace('SYNC-', '').replaceAll('-', '');
  const raw = Uint8Array.from(hex.match(/../g), pair => Number.parseInt(pair, 16));
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt']);
}

async function autoSyncRequest(backendUrl, token, path, body) {
  const base = String(backendUrl || DEFAULT_INTENTION_BACKEND_URL).replace(/\/+$/, '');
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body)
  });
  let data = null;
  try { data = await res.json(); } catch (e) {}
  if (!res.ok) {
    const err = new Error(data?.error || `Sync server error ${res.status}`);
    err.code = data?.code || 'backend_error';
    throw err;
  }
  return data || {};
}

async function runAutomaticSync() {
  const keys = [...AUTO_SYNC_PROFILE_KEYS, 'syncAutoEnabled', 'syncAutoKey', 'syncVaultRevision', 'entitlement', 'backendUrl'];
  const stored = await getStorage(keys);
  if (stored.syncAutoEnabled !== true || !stored.entitlement?.token) return;
  const cryptoKey = await autoSyncCryptoKey(stored.syncAutoKey);
  if (!cryptoKey) {
    await setStorage({ syncAutoEnabled: false, syncAutoLastError: 'The saved sync key is unavailable on this device.' });
    return;
  }
  try {
    const latest = await autoSyncRequest(stored.backendUrl, stored.entitlement.token, '/v1/sync/vault/read', {});
    const knownRevision = Number.isSafeInteger(stored.syncVaultRevision) ? stored.syncVaultRevision : 0;
    if (latest.vault && knownRevision !== Number(latest.vault.revision)) {
      await setStorage({
        syncAutoEnabled: false,
        syncVaultUpdatedAt: latest.vault.updatedAt || Date.now(),
        syncAutoLastError: 'Automatic sync paused because another device has a newer encrypted copy. Restore it before saving again.'
      });
      return;
    }
    const profile = {};
    for (const key of AUTO_SYNC_PROFILE_KEYS) profile[key] = stored[key];
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plaintext = new TextEncoder().encode(JSON.stringify({ v: 1, profile }));
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, cryptoKey, plaintext);
    const saved = await autoSyncRequest(stored.backendUrl, stored.entitlement.token, '/v1/sync/vault/write', {
      vault: { iv: autoBase64url(iv), ciphertext: autoBase64url(new Uint8Array(ciphertext)) },
      baseRevision: knownRevision
    });
    await setStorage({
      syncVaultRevision: saved.vault.revision,
      syncVaultUpdatedAt: saved.vault.updatedAt || Date.now(),
      syncLastSuccessAt: Date.now(),
      syncAutoLastError: ''
    });
  } catch (e) {
    // A temporary offline error must not turn a privacy choice off. Keep the
    // last human-readable state locally for the settings screen and retry at
    // the next settings change.
    await setStorage({ syncAutoLastError: String(e.message || e) });
  }
}

function scheduleAutomaticSync() {
  automaticSyncQueue = automaticSyncQueue.then(runAutomaticSync, runAutomaticSync);
  return automaticSyncQueue;
}
