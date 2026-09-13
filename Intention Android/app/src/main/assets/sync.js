// Encrypted, user-triggered settings sync.
//
// There is deliberately no account, email address, background polling, or
// plaintext profile on the server. Sync has its *own* recovery key, separate
// from the coaching-credit recovery code: rotating one can never make the
// other unreadable. The key is never sent to the backend.
// Its own two storage helpers rather than tracking.js's: this file runs on the
// options page, which does not load tracking.js, and calling getStorage from
// here threw "getStorage is not defined" on every settings open — which also
// stopped everything options.js wires up after setupEncryptedSync.
function syncGetStorage(keys) {
  return new Promise(resolve => chrome.storage.local.get(keys, items => resolve(items || {})));
}

function syncSetStorage(values) {
  return new Promise(resolve => chrome.storage.local.set(values, () => resolve()));
}

const SYNC_PROFILE_KEYS = [
  'userContext', 'contextProjects', 'contextReasons', 'coachInstructions',
  'blockedDomains', 'domainLimits', 'blockedApps', 'appLimits', 'appLabels',
  'serviceReasons', 'pendingChanges',
  'leaveDelayMinutes'
];
const SYNC_KEY_RE = /^SYNC-[A-F0-9]{8}-[A-F0-9]{8}-[A-F0-9]{8}-[A-F0-9]{8}$/;

function syncProfileFrom(state) {
  const profile = {};
  for (const key of SYNC_PROFILE_KEYS) profile[key] = state[key];
  return profile;
}

function base64url(bytes) {
  let binary = '';
  // String.fromCharCode's argument ceiling is lower than the permitted vault
  // size on some mobile WebViews, so turn it into small chunks.
  for (let start = 0; start < bytes.length; start += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(start, start + 0x8000));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64url(value) {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}

function normalizedSyncKey(value) {
  return String(value || '').trim().toUpperCase().replace(/\s+/g, '');
}

async function syncKeyFor(code) {
  if (!globalThis.crypto?.subtle) {
    throw new Error('This version of your browser cannot create an encrypted sync vault.');
  }
  const normalized = normalizedSyncKey(code);
  if (!SYNC_KEY_RE.test(normalized)) {
    throw new Error('Enter a sync key in the form SYNC-XXXXXXXX-XXXXXXXX-XXXXXXXX-XXXXXXXX.');
  }
  const hex = normalized.replace('SYNC-', '').replaceAll('-', '');
  const raw = Uint8Array.from(hex.match(/../g), pair => Number.parseInt(pair, 16));
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

function newSyncKey() {
  const raw = crypto.getRandomValues(new Uint8Array(16));
  const hex = Array.from(raw, byte => byte.toString(16).padStart(2, '0')).join('').toUpperCase();
  return `SYNC-${hex.slice(0, 8)}-${hex.slice(8, 16)}-${hex.slice(16, 24)}-${hex.slice(24)}`;
}

async function encryptSyncProfile(profile, code) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await syncKeyFor(code);
  const plaintext = new TextEncoder().encode(JSON.stringify({ v: 1, profile }));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);
  return { iv: base64url(iv), ciphertext: base64url(new Uint8Array(ciphertext)) };
}

async function decryptSyncProfile(vault, code) {
  if (!vault || typeof vault.iv !== 'string' || typeof vault.ciphertext !== 'string') {
    throw new Error('The encrypted copy is incomplete.');
  }
  const key = await syncKeyFor(code);
  let plaintext;
  try {
    plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64url(vault.iv) }, key,
      fromBase64url(vault.ciphertext));
  } catch (e) {
    throw new Error('That sync key cannot unlock this copy. Check the key and try again.');
  }
  let parsed;
  try {
    parsed = JSON.parse(new TextDecoder().decode(plaintext));
  } catch (e) {
    throw new Error('This encrypted copy could not be read.');
  }
  if (parsed?.v !== 1 || !parsed.profile || typeof parsed.profile !== 'object') {
    throw new Error('This encrypted copy is from an unsupported version of Intention.');
  }
  const profile = {};
  for (const keyName of SYNC_PROFILE_KEYS) {
    if (Object.prototype.hasOwnProperty.call(parsed.profile, keyName)) profile[keyName] = parsed.profile[keyName];
  }
  return profile;
}

async function syncAccess() {
  const state = await getConfig();
  const token = state?.entitlement?.token;
  const backendUrl = state?.backendUrl || '';
  if (!token) throw new Error('Restore your coaching access before using encrypted sync.');
  return { state, token, backendUrl };
}

async function readSyncVault(backendUrl, token) {
  return postBackendAuthed(backendUrl, '/v1/sync/vault/read', token, {});
}

async function writeSyncVault(backendUrl, token, vault, baseRevision) {
  return postBackendAuthed(backendUrl, '/v1/sync/vault/write', token, { vault, baseRevision });
}

function syncStatus(text, variant = '') {
  setStatus('sync-status', text, variant);
}

function syncDate(value) {
  const date = new Date(value || 0);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : 'unknown time';
}

function syncPlatform() {
  const ua = String(globalThis.navigator?.userAgent || '');
  if (/android/i.test(ua)) return 'Android';
  if (/iphone|ipad|ipod/i.test(ua)) return 'iPhone or iPad';
  if (/macintosh|mac os/i.test(ua)) return 'Mac';
  if (/firefox/i.test(ua)) return 'Firefox';
  if (/edg/i.test(ua)) return 'Microsoft Edge';
  if (/chrome|chromium/i.test(ua)) return 'Chrome';
  return 'this device';
}

function syncDiagnosticsText({ remote, local, reachable }) {
  const lines = [
    'Intention sync diagnostics (safe to share)',
    `Device: ${syncPlatform()}`,
    `Encrypted-copy service: ${reachable ? 'reachable' : 'unreachable'}`,
    `Automatic encrypted saves: ${local.syncAutoEnabled === true ? 'on' : 'off'}`,
    `Local encrypted-copy revision: ${Number.isSafeInteger(local.syncVaultRevision) ? local.syncVaultRevision : 'none'}`,
    `Last successful save: ${local.syncLastSuccessAt ? syncDate(local.syncLastSuccessAt) : 'not recorded'}`,
    `Encrypted copy on service: ${remote?.revision ? `revision ${remote.revision}, saved ${syncDate(remote.updatedAt)}` : 'none'}`
  ];
  if (local.syncAutoLastError) lines.push(`Last automatic-sync message: ${String(local.syncAutoLastError).slice(0, 220)}`);
  lines.push('Excluded: settings, recovery code, sync key, API key, credit, activity, and chats.');
  return lines.join('\n');
}

async function refreshSyncDiagnostics() {
  const output = document.getElementById('sync-diagnostics');
  if (!output) return '';
  output.textContent = 'Checking…';
  const local = await syncGetStorage(['syncAutoEnabled', 'syncVaultRevision', 'syncLastSuccessAt', 'syncAutoLastError']);
  try {
    const { token, backendUrl } = await syncAccess();
    const result = await readSyncVault(backendUrl, token);
    const report = syncDiagnosticsText({ remote: result.vault, local, reachable: true });
    output.textContent = report;
    return report;
  } catch (e) {
    const report = syncDiagnosticsText({ local, reachable: false });
    output.textContent = `${report}\nService message: ${String(e.message || e).slice(0, 220)}`;
    return output.textContent;
  }
}

function revealNewerSyncCopy(vault) {
  const button = document.getElementById('sync-restore-newer');
  if (!button) return;
  button.hidden = false;
  button.textContent = `Restore encrypted copy saved ${syncDate(vault?.updatedAt)}`;
}

function hideNewerSyncCopy() {
  const button = document.getElementById('sync-restore-newer');
  if (button) button.hidden = true;
}

function bindSyncOnce(id, handler) {
  const button = document.getElementById(id);
  if (button?.dataset.syncBound) return;
  if (button) {
    button.dataset.syncBound = 'true';
    button.addEventListener('click', handler);
  }
}

function syncKeyInput() {
  return document.getElementById('sync-key');
}

function setupEncryptedSync() {
  syncGetStorage(['syncAutoEnabled', 'syncAutoLastError']).then(({ syncAutoEnabled, syncAutoLastError }) => {
    const toggle = document.getElementById('sync-auto');
    if (toggle) toggle.checked = syncAutoEnabled === true;
    if (syncAutoLastError) syncStatus(syncAutoLastError, 'error');
  }).catch(() => {});
  bindSyncOnce('sync-upload', async () => {
    const button = document.getElementById('sync-upload');
    const code = syncKeyInput()?.value || '';
    try {
      button.disabled = true;
      syncStatus('Encrypting this device’s settings…');
      const { state, token, backendUrl } = await syncAccess();
      const latest = await readSyncVault(backendUrl, token);
      const { syncVaultRevision } = await syncGetStorage(['syncVaultRevision']);
      const knownRevision = Number.isSafeInteger(syncVaultRevision) ? syncVaultRevision : 0;
      if (latest.vault && knownRevision !== Number(latest.vault.revision)) {
        revealNewerSyncCopy(latest.vault);
        throw new Error(`A newer encrypted copy was saved ${syncDate(latest.vault.updatedAt)}. Restore it here before uploading, so nothing is overwritten by surprise.`);
      }
      const vault = await encryptSyncProfile(syncProfileFrom(state), code);
      const saved = await writeSyncVault(backendUrl, token, vault, knownRevision);
      await syncSetStorage({
        syncVaultRevision: saved.vault.revision,
        syncVaultUpdatedAt: saved.vault.updatedAt || Date.now(),
        syncLastSuccessAt: Date.now(),
        syncAutoLastError: ''
      });
      hideNewerSyncCopy();
      syncStatus('Encrypted copy saved. The server received ciphertext, not your settings.', 'success');
    } catch (e) {
      syncStatus(String(e.message || e), 'error');
    } finally {
      button.disabled = false;
    }
  });

  const restoreEncryptedCopy = async () => {
    const button = document.getElementById('sync-restore');
    const code = syncKeyInput()?.value || '';
    try {
      button.disabled = true;
      syncStatus('Getting your encrypted copy…');
      const { token, backendUrl } = await syncAccess();
      const result = await readSyncVault(backendUrl, token);
      if (!result.vault) throw new Error('No encrypted settings copy exists for this sync key yet.');
      const profile = await decryptSyncProfile(result.vault, code);
      // saveSettings schedules the optional automatic uploader. Stamp the
      // revision first so that background task sees this very copy as current,
      // rather than mistaking the restore for a conflicting remote change.
      await syncSetStorage({
        syncVaultRevision: result.vault.revision,
        syncVaultUpdatedAt: result.vault.updatedAt || Date.now(),
        syncLastSuccessAt: Date.now(),
        syncAutoLastError: ''
      });
      const applied = await sendBg({ action: 'saveSettings', config: profile });
      if (applied?.error) throw new Error(applied.error);
      await renderCurrentView();
      hideNewerSyncCopy();
      syncStatus('Encrypted settings restored on this device.', 'success');
    } catch (e) {
      syncStatus(String(e.message || e), 'error');
    } finally {
      button.disabled = false;
    }
  };
  bindSyncOnce('sync-restore', restoreEncryptedCopy);
  bindSyncOnce('sync-restore-newer', restoreEncryptedCopy);

  bindSyncOnce('sync-create-key', () => {
    const input = syncKeyInput();
    if (!input) return;
    if (input.value && !window.confirm('Replace the sync key in this box? Existing copies still need their original key to be restored.')) return;
    input.type = 'text';
    input.value = newSyncKey();
    input.select();
    syncStatus('New sync key created. Copy it somewhere safe before saving an encrypted copy.', 'success');
  });

  bindSyncOnce('sync-auto', async (event) => {
    const enabled = !!event.target.checked;
    const key = normalizedSyncKey(syncKeyInput()?.value || '');
    if (enabled && !SYNC_KEY_RE.test(key)) {
      event.target.checked = false;
      syncStatus('Enter the sync key first. It is kept on this device only when automatic sync is enabled.', 'error');
      return;
    }
    await syncSetStorage(enabled
      ? { syncAutoEnabled: true, syncAutoKey: key }
      : { syncAutoEnabled: false, syncAutoKey: '' });
    if (enabled) await sendBg({ action: 'runAutomaticSync' });
    syncStatus(enabled
      ? 'Automatic encrypted sync is on for this device. It can be turned off here at any time.'
      : 'Automatic encrypted sync is off. Your encrypted copy remains available until replaced.', 'success');
  });

  bindSyncOnce('sync-diagnostics-refresh', async () => {
    try { await refreshSyncDiagnostics(); } catch (e) { syncStatus(String(e.message || e), 'error'); }
  });
  bindSyncOnce('sync-diagnostics-copy', async () => {
    const report = await refreshSyncDiagnostics();
    try {
      if (!globalThis.navigator?.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(report);
      syncStatus('Safe sync support report copied.', 'success');
    } catch (e) {
      syncStatus('Could not copy the report. You can select the diagnostics text instead.', 'error');
    }
  });
}
