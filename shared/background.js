try {
  importScripts('sites.js', 'providers.js', 'prompts.js', 'tracking.js', 'page_context.js');
} catch (e) {
  // Firefox loads these via manifest scripts array; globals already present.
}

const INT_LOG = '[Intention]';

// Track active tab navigation context for sites visited before overlay loads.
//
// The in-memory object is a synchronous write-through cache: a coaching
// conversation easily outlives the MV3 worker's ~30s idle teardown (Safari
// tears its non-persistent background page down too), and losing this map
// meant getIntendedUrl came back empty and the user who argued for a specific
// video landed on the site's front door. Every write is mirrored to
// chrome.storage.session where it exists (Chrome MV3, Firefox 140+, Safari
// 16.4+), falling back to .local on older Safari; reads rehydrate from there
// when the worker has restarted. Android's hand-written chrome shim has
// neither tabs nor webNavigation, so navStore stays null and this is inert.
const tabNavContext = {};
const NAV_CONTEXT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const navStore = (typeof chrome !== 'undefined' && (chrome.storage?.session || chrome.storage?.local)) || null;

// Age-bounding on every persist is what keeps the .local fallback from
// growing without limit when a tab closes while the worker is asleep.
function prunedNavContext(map) {
  const cutoff = Date.now() - NAV_CONTEXT_MAX_AGE_MS;
  const out = {};
  for (const [id, entry] of Object.entries(map)) {
    if (entry && typeof entry.timestamp === 'number' && entry.timestamp > cutoff) out[id] = entry;
  }
  return out;
}

function persistNavContext() {
  if (!navStore) return;
  try {
    navStore.set({ tabNavContext: prunedNavContext(tabNavContext) }, () => {
      void chrome.runtime.lastError; // best-effort; nothing to do on failure
    });
  } catch (e) {}
}

// Synchronous cache hit first; on a miss (fresh worker) pull the persisted map
// back into the cache before answering.
function readNavContext(tabId) {
  const cached = tabNavContext[tabId];
  if (cached || !navStore) return Promise.resolve(cached || null);
  return new Promise((resolve) => {
    try {
      navStore.get(['tabNavContext'], (result) => {
        void chrome.runtime.lastError;
        const stored = prunedNavContext(result?.tabNavContext || {});
        for (const [id, entry] of Object.entries(stored)) {
          if (!(id in tabNavContext)) tabNavContext[id] = entry;
        }
        resolve(tabNavContext[tabId] || null);
      });
    } catch (e) {
      resolve(null);
    }
  });
}

// The content script's DOM extraction is the only look at the page anyone
// gets: on the redirect path the blocked page is never loaded at all, and by
// the time the gate's chat opens the overlay has already emptied the document.
// So whatever the content script saw at document_start is kept here, beside
// the recorded URL, where a chat opened later — including one from
// coaching.html, which has no access to the blocked page — can still read it.
function recordTabPageContext(tabId, pageCtx) {
  if (tabId == null || !pageCtx || typeof pageCtx !== 'object') return;
  const existing = tabNavContext[tabId] || {};
  tabNavContext[tabId] = {
    url: pageCtx.url || existing.url || '',
    pageCtx,
    timestamp: Date.now()
  };
  persistNavContext();
}

if (typeof chrome !== 'undefined' && chrome.webNavigation?.onBeforeNavigate) {
  try {
    // Our own pages are skipped by extension origin rather than by the
    // `chrome-extension://` scheme: Safari serves them from
    // `safari-web-extension://`, so matching on the scheme let the gate's own
    // URL overwrite the very address the user was heading for.
    const extensionOrigin = chrome.runtime.getURL('');
    chrome.webNavigation.onBeforeNavigate.addListener((details) => {
      if (details.frameId === 0 && details.url && !details.url.startsWith(extensionOrigin) && !details.url.startsWith('chrome-extension://') && !details.url.startsWith('about:')) {
        tabNavContext[details.tabId] = {
          url: details.url,
          timestamp: Date.now()
        };
        persistNavContext();
      }
    });
  } catch (e) {
    console.warn(INT_LOG, 'webNavigation listener warning:', e);
  }
}
if (typeof chrome !== 'undefined' && chrome.tabs?.onRemoved) {
  try {
    chrome.tabs.onRemoved.addListener((tabId) => {
      delete tabNavContext[tabId];
      persistNavContext();
    });
  } catch (e) {}
}

// Sessions, chat history and check-in alarms are keyed per (tab, target) in
// the extensions. The native ports (Android, iOS) have no tabs — their bridges
// deliver messages with no sender.tab — so they key per blocked target alone.
// Without a key per target, every site and app on the device shares one slot:
// a second grant silently evicts the first, declining one target ends
// another's pass, and every coaching conversation appends to the same
// transcript.
//
// The target is in the key, not just the tab id, because a tab outlives the
// site in it. Keying on the tab alone meant a pass earned on one blocked site
// unlocked every other blocked site visited in that tab for the rest of the
// pass — no conversation required — and handed the next site's gate the
// previous site's chat transcript.
const LEGACY_TAB_KEY = /^\d+$/;

function sessionKeyFor(tabId, target) {
  if (!target) return null;
  return tabId != null ? `tab:${tabId}:${target}` : `target:${target}`;
}

// The tab id a session key belongs to, or null for a target-only (native) key.
// Understands the legacy bare-tab-id form so alarms and sessions written before
// the key change are still routed correctly.
function tabIdFromSessionKey(sessionKey) {
  const composite = /^tab:(\d+):/.exec(sessionKey || '');
  if (composite) return Number(composite[1]);
  return LEGACY_TAB_KEY.test(sessionKey || '') ? Number(sessionKey) : null;
}

// Every session key belonging to a tab, including any legacy bare-tab-id key.
// A tab can legitimately hold more than one: earn a pass on one blocked site,
// navigate to another and earn a second, and both are live.
function sessionKeysForTab(activeSessions, tabId) {
  if (tabId == null) return [];
  const prefix = `tab:${tabId}:`;
  return Object.keys(activeSessions).filter(
    key => key.startsWith(prefix) || key === String(tabId)
  );
}

// The one place sessions are looked up. Reads are funnelled through here so the
// "a session only counts for its own domain" rule is enforced once rather than
// re-derived at each call site — which is exactly how the cross-domain hole
// appeared. `live: false` returns a banked session too, which the check-in
// coach needs so it can quote the reason the user originally gave.
function readSession(activeSessions, tabId, domain, { live = true } = {}) {
  if (!domain) return null;
  const candidates = [
    activeSessions[sessionKeyFor(tabId, domain)],
    activeSessions[`target:${domain}`]
  ];
  // Back-compat for a pass in flight across the upgrade. Domain-checked, so
  // this path cannot itself reopen the hole it is bridging.
  if (tabId != null) {
    const legacy = activeSessions[String(tabId)];
    if (legacy && legacy.domain === domain) candidates.push(legacy);
  }
  for (const session of candidates) {
    if (!session) continue;
    const resolved = live ? activeSession(session) : session;
    if (resolved) return resolved;
  }
  return null;
}

// A session that has been banked by the check-in alarm is kept around on the
// native ports so the check-in coach can quote its original reason, but it
// must never read as a live pass — nor must one whose time has simply run out
// while nothing was around to close it (a restarted service worker, or iOS,
// where the shields re-arm natively and no alarm ever fires).
function activeSession(session) {
  if (!session || session.endedAt) return null;
  const expiresAt = session.startTime + (session.intervalMinutes * 60000);
  return Date.now() < expiresAt ? session : null;
}

// Whether this session's minutes still need recording. Distinct from
// activeSession: an expired-but-unbanked session is no longer a pass, but its
// time on the site is real and must not be dropped.
function isBanked(session) {
  return !!(session && session.endedAt);
}

async function focusOrCreateTab(urlPattern, createFn) {
  try {
    const tabs = await chrome.tabs.query({ url: urlPattern });
    if (tabs.length > 0) {
      await chrome.tabs.update(tabs[0].id, { active: true });
      try { await chrome.windows.update(tabs[0].windowId, { focused: true }); } catch (e) {}
      return tabs[0];
    }
  } catch (e) {
    console.warn(INT_LOG, 'focusOrCreateTab query error:', e);
  }
  return createFn();
}

// Which blocked domains currently need a redirect rule. A domain with a live
// pass gets none, on top of the per-tab session allow rule registered below:
// belt and braces, because WebKit does not reliably honour a session rule's
// `tabIds` condition, and when it doesn't the redirect wins and throws the
// user straight back into the gate they just talked their way through — the
// "granted, then stuck on the gate forever" loop. The rule comes back when the
// pass ends (see the callers of syncBlockingRules), and, should the background
// have been suspended by then, on the next visit to the domain.
async function domainsNeedingRedirect() {
  // Safari takes the rule, honours it, and then can't complete the load:
  // redirecting to `safari-web-extension://…/coaching.html` fails the
  // provisional navigation with NSURLErrorFileDoesNotExist (-1100), so every
  // blocked visit ends on "Safari Can't Find the File" instead of the gate.
  // The page is there and loads fine when a tab navigates to it — only WebKit's
  // DNR engine can't reach it — and `redirect.url` is rejected outright for a
  // non-HTTP target, so there is no other way to name the page from a rule.
  // Safari gates from the content script's overlay instead, as it did while
  // these rules were still malformed enough for WebKit to throw them out.
  if (hasNativeMessaging()) return [];
  const { blockedDomains = [], activeSessions = {} } = await getStorage(['blockedDomains', 'activeSessions']);
  const passed = new Set(
    Object.values(activeSessions).filter(s => activeSession(s)).map(s => s.domain)
  );
  return blockedDomains.filter(domain => !passed.has(domain));
}

// Rule updates are read-modify-write against the browser's rule store, and
// several things can ask for one at once (a grant, a tab closing, a visit to a
// blocked domain). Run them one at a time so a sync can't read a rule set
// another is halfway through replacing.
let blockingRuleQueue = Promise.resolve();
function syncBlockingRules() {
  blockingRuleQueue = blockingRuleQueue.then(applyBlockingRules, applyBlockingRules);
  return blockingRuleQueue;
}

// Sync DNR rules based on blocked domains setting
async function applyBlockingRules() {
  try {
    const blockedDomains = await domainsNeedingRedirect();
    const currentRules = await chrome.declarativeNetRequest.getDynamicRules();
    const removeRuleIds = currentRules.map(r => r.id);

    const addRules = blockedDomains.map((domain, index) => {
      const ruleId = 1000 + index;
      return {
        id: ruleId,
        priority: 1,
        action: {
          type: 'redirect',
          redirect: {
            extensionPath: `/coaching.html?domain=${encodeURIComponent(domain)}`
          }
        },
        condition: {
          urlFilter: `||${domain}^`,
          resourceTypes: ['main_frame']
        }
      };
    });

    // Called on every visit to a blocked domain, so don't rewrite a rule set
    // that already says what it should. Compare where each rule *sends* the
    // user as well as what it catches: a check that only read `urlFilter` called
    // a rule set with a stale or broken redirect target correct, and left it in
    // place for as long as the blocked list didn't change — which is how a
    // whole platform's gate can break with no way back.
    const ruleSummary = rules => rules
      .map(r => `${r.condition?.urlFilter || ''} -> ${r.action?.redirect?.extensionPath || r.action?.redirect?.url || ''}`)
      .sort()
      .join('\n');
    if (ruleSummary(currentRules) === ruleSummary(addRules)) return;

    try {
      await chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds,
        addRules
      });
      console.log(INT_LOG, 'Synced dynamic blocking rules:', addRules.length);
    } catch (e) {
      console.error(INT_LOG, 'Error syncing dynamic blocking rules:', e, 'rules:', JSON.stringify(addRules));
      // WebKit's DNR validator sometimes rejects the whole batch on one bad rule, and the
      // call is atomic — so the old rule IDs were never removed. Clear them out first,
      // otherwise stale/broken rules (e.g. pre-fix redirect targets) keep firing and no
      // new rule can reuse the same ID. Then retry adds one at a time so we can tell which
      // rule (and which field) is invalid.
      try {
        await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds });
      } catch (e3) {
        console.error(INT_LOG, 'Failed to remove stale rules:', e3);
      }
      for (const rule of addRules) {
        try {
          await chrome.declarativeNetRequest.updateDynamicRules({ addRules: [rule] });
          console.log(INT_LOG, 'Rule OK:', JSON.stringify(rule));
        } catch (e2) {
          console.error(INT_LOG, 'Rule FAILED:', JSON.stringify(rule), e2);
        }
      }
    }
  } catch (e) {
    console.error(INT_LOG, 'Error syncing dynamic blocking rules:', e);
  }
}

// Session rules to temporarily allow a tab to visit a domain
async function registerSessionRule(tabId, domain, minutes) {
  try {
    const ruleId = tabId;
    const addRules = [{
      id: ruleId,
      priority: 2,
      action: {
        type: 'allow'
      },
      condition: {
        urlFilter: `||${domain}^`,
        tabIds: [tabId],
        resourceTypes: ['main_frame']
      }
    }];
    
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [ruleId],
      addRules
    });
    console.log(INT_LOG, 'Registered session allow rule for tab', tabId, 'domain', domain);
  } catch (e) {
    console.error(INT_LOG, 'Error registering session rule:', e);
  }
}

async function removeSessionRule(tabId) {
  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [tabId]
    });
    console.log(INT_LOG, 'Removed session allow rule for tab', tabId);
  } catch (e) {
    console.error(INT_LOG, 'Error removing session rule:', e);
  }
}

// Sync rules on load and install
chrome.runtime.onInstalled.addListener((details) => {
  syncBlockingRules();
  if (details.reason === 'install') {
    chrome.runtime.openOptionsPage();
  }
});
syncBlockingRules();
// Carries any pass written under the pre-(tab, domain) key format across, so a
// grant in flight when the extension updated isn't stranded. Idempotent, and a
// no-op once there is nothing left in the old shape. The native hosts get here
// via their own reconcileSessions call on start.
migrateSessionKeys();
// No-op outside the Safari Web Extension runtime — see tracking.js.
syncConfigFromNative();

chrome.action.onClicked.addListener(async () => {
  const optionsUrl = chrome.runtime.getURL('options.html');
  await focusOrCreateTab(optionsUrl, () => chrome.runtime.openOptionsPage());
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  // A closing tab carries no domain, and a tab can hold a pass on more than
  // one blocked site, so every session belonging to it has to be swept.
  await endAllSessionsForTab(tabId, 'closed');
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (!alarm.name.startsWith('checkin-')) return;
  const sessionKey = alarm.name.slice('checkin-'.length);
  const tabId = tabIdFromSessionKey(sessionKey);

  if (tabId == null) {
    // Native ports: there is no content script to interrupt. The platform
    // relaunches the coach in check-in mode off its own timer (Android's
    // accessibility service), so bank the minutes now — they'd be lost if the
    // user never came back — but leave the session in place, marked ended, so
    // the check-in prompt can still quote what they said they came for.
    await bankExpiredSession(sessionKey);
    return;
  }

  // Expiration of session time -> remove DNR allow rule for this tab, and put
  // back the domain redirect rule the grant dropped.
  removeSessionRule(tabId);
  await syncBlockingRules();

  try {
    await chrome.tabs.sendMessage(tabId, { action: 'showCheckin' });
  } catch (e) {
    // Tab is gone, or has no content script to show the check-in in — bank the
    // pass before dropping it. Deleting without banking silently lost every
    // minute of a pass whose tab disappeared before its check-in: nothing else
    // ever records a deleted session's time. Sequential awaits on purpose —
    // bankExpiredSession runs its own mutateStorage, and nesting it inside the
    // delete's mutator would deadlock the storage queue.
    await bankExpiredSession(sessionKey);
    await mutateStorage('activeSessions', (activeSessions) => {
      delete activeSessions[sessionKey];
    });
  }
});

async function bankExpiredSession(sessionKey) {
  const { activeSessions = {} } = await getStorage(['activeSessions']);
  const session = activeSessions[sessionKey];
  if (!session || isBanked(session)) return;
  const elapsed = (Date.now() - session.startTime) / 60000;
  await recordSessionMinutes(session.domain, Math.min(elapsed, session.intervalMinutes), 'ran_out');
  await mutateStorage('activeSessions', (sessions) => {
    if (sessions[sessionKey]) sessions[sessionKey].endedAt = Date.now();
  });
  // The pass is over: this domain needs its redirect rule back.
  await syncBlockingRules();
}

// Rebuilds the half of session state that lives in a one-shot OS timer rather
// than in storage. A device restart wipes every pending check-in alarm —
// Android's AlarmManager drops them all on reboot, and the iOS host can't run
// at all while the app is closed — and nothing re-arms them, so the check-in
// for a granted pass never fires: its minutes are never banked into
// dailyStats/allTimeStats, and the session sits in activeSessions unbanked
// forever. Gating itself is unaffected (activeSession recomputes from
// timestamps), so this is purely a bookkeeping catch-up:
//
//   * a pass that ran out while the device was off is banked now
//   * a pass with time left has its check-in re-armed for the original expiry,
//     so the rest of its minutes are still accounted for
//
// Storage already holds every timestamp needed, so this needs no state of its
// own. Idempotent — banking is guarded by isBanked() and chrome.alarms.create
// replaces any alarm of the same name — so the native hosts can call it on
// every start.
// Rewrites sessions written under the old bare-tab-id key ("42") into the
// per-(tab, domain) form ("tab:42:instagram.com"), carrying the transcript and
// the check-in alarm across. Every session stores its own domain, so this is
// lossless. Idempotent, and runs from reconcileSessions, which every platform
// already calls on start.
async function migrateSessionKeys() {
  const { activeSessions = {}, chatHistories = {} } = await getStorage(['activeSessions', 'chatHistories']);
  const renames = [];
  for (const [key, session] of Object.entries(activeSessions)) {
    if (!LEGACY_TAB_KEY.test(key) || !session?.domain) continue;
    renames.push([key, `tab:${key}:${session.domain}`, session]);
  }
  // Transcripts under a legacy key whose session is gone have nothing to name
  // them any more, and chat history is disposable.
  const orphanHistories = Object.keys(chatHistories).filter(
    key => LEGACY_TAB_KEY.test(key) && !activeSessions[key]
  );
  if (!renames.length && !orphanHistories.length) return { migrated: 0 };

  await mutateStorage('activeSessions', (sessions) => {
    for (const [oldKey, newKey, session] of renames) {
      sessions[newKey] = session;
      delete sessions[oldKey];
    }
  });
  await mutateStorage('chatHistories', (histories) => {
    for (const [oldKey, newKey] of renames) {
      if (histories[oldKey]) {
        histories[newKey] = histories[oldKey];
        delete histories[oldKey];
      }
    }
    for (const key of orphanHistories) delete histories[key];
  });
  for (const [oldKey, newKey, session] of renames) {
    chrome.alarms.clear(`checkin-${oldKey}`);
    if (!isBanked(session)) {
      chrome.alarms.create(`checkin-${newKey}`, {
        when: session.startTime + session.intervalMinutes * 60000
      });
    }
  }
  console.log(INT_LOG, 'migrateSessionKeys: rekeyed', renames.length);
  return { migrated: renames.length };
}

async function reconcileSessions() {
  await migrateSessionKeys();
  const { activeSessions = {} } = await getStorage(['activeSessions']);
  const banked = [];
  const rearmed = [];
  for (const [sessionKey, session] of Object.entries(activeSessions)) {
    if (!session || isBanked(session)) continue;
    const expiresAt = session.startTime + (session.intervalMinutes * 60000);
    if (Date.now() >= expiresAt) {
      await bankExpiredSession(sessionKey);
      banked.push(sessionKey);
    } else {
      chrome.alarms.create(`checkin-${sessionKey}`, { when: expiresAt });
      rearmed.push(sessionKey);
    }
  }
  if (banked.length || rearmed.length) {
    console.log(INT_LOG, 'reconcileSessions: banked', banked.length, 're-armed', rearmed.length);
  }
  // Redirect rules follow the sessions that were just settled either way.
  await syncBlockingRules();
  return { banked, rearmed };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then(sendResponse)
    .catch(err => sendResponse({ error: String(err?.message || err) }));
  return true;
});

// Classifies who sent a runtime message. Three shapes exist in practice:
// extension pages (options/coaching) carry a sender.url under our own origin
// (and on Safari no sender.tab); the native hosts (Android BackgroundJsHelper,
// iOS BackgroundJSHost) deliver a literally empty sender; everything else is a
// content script running inside an arbitrary web page and gets no privilege.
function senderTrust(sender) {
  if (sender?.url && sender.url.startsWith(chrome.runtime.getURL(''))) return 'extension';
  if (sender && !sender.url && !sender.tab && !sender.id) return 'native';
  return 'content';
}

// The page host a content-script sender is actually running in, or '' when it
// has none. Used to stop a hostile page acting on some other site's behalf.
function senderPageHost(sender) {
  try {
    return new URL(sender.url).hostname;
  } catch (e) {
    return '';
  }
}

function hostMatchesDomain(host, domain) {
  return !!host && !!domain && (host === domain || host.endsWith('.' + domain));
}

// Where a conversation's transcript lives.
//
// Sessions, alarms and DNR rules are per (tab, target) — they have to be, a
// pass belongs to one tab. Memory doesn't. Keying transcripts the same way
// meant the coach forgot an argument it had two minutes earlier the moment you
// opened the site in a second tab, and forgot it again every time a pass
// ended, so "you already told me that" was unsayable. Per (target, day)
// instead: continuous within the day the usage stats are also scoped to, and
// gone the next morning, which is the fresh start the user actually wants.
//
// The UI never renders stored history — it opens on an empty chat window — so
// this changes what the coach remembers, not what the user sees.
function transcriptKeyFor(mode, { domain, changeType }) {
  if (mode === 'context' || mode === 'setup') return mode;
  if (mode === 'settings_gate') return `settings_gate:${changeType}:${domain || 'all'}`;
  if (!domain) return null;
  return `site:${domain}:${dateKey()}`;
}

// Yesterday's conversations are never read again — the key has the date in it
// — so they would otherwise accumulate in storage forever.
const TRANSCRIPT_KEY = /^site:(.+):(\d{4}-\d{2}-\d{2})$/;
function pruneStaleTranscripts(histories) {
  const today = dateKey();
  for (const key of Object.keys(histories)) {
    const match = TRANSCRIPT_KEY.exec(key);
    if (match && match[2] !== today) delete histories[key];
  }
}

function pageContextMatchesDomain(pageCtx, domain) {
  const url = pageCtx && typeof pageCtx.url === 'string' ? pageCtx.url : '';
  if (!url || !domain) return false;
  try {
    return hostMatchesDomain(new URL(url).hostname, domain);
  } catch (e) {
    return false;
  }
}

async function handleMessage(message, sender) {
  // `sender.tab` is the trustworthy source and always wins — content scripts
  // can't opt out of it. Safari doesn't populate it for extension pages
  // (coaching.html, options.html) the way Chrome does, so those send their own
  // id from chrome.tabs.getCurrent(); without it every session opened from the
  // coaching page lands under a different key than the one the content script
  // looks under, and the site re-gates the moment the pass is granted.
  const tabId = sender.tab?.id ?? (typeof message.tabId === 'number' ? message.tabId : undefined);
  switch (message.action) {
    case 'checkPageMatch': return checkPageMatch(message.host, tabId, message.pageContext);
    case 'getConfig': {
      const config = await getFullConfig();
      // Only extension pages (options, coaching) may read the API key —
      // never content scripts, which run inside arbitrary web pages.
      if (senderTrust(sender) !== 'extension') config.apiKey = '';
      return config;
    }
    case 'saveSetup': return saveSetup(message.config);
    case 'saveSettings': return saveSettings(message.config);
    case 'getAccess': return getAccess();
    case 'saveEntitlement': return saveEntitlement(message.entitlement);
    case 'getSession': {
      if (!message.domain) return { session: null };
      const { activeSessions = {} } = await getStorage(['activeSessions']);
      return { session: readSession(activeSessions, tabId, message.domain) };
    }
    case 'chat':
      return handleChat({
        tabId,
        mode: message.mode,
        domain: message.domain,
        isApp: message.isApp,
        appLabel: message.appLabel,
        userMessage: message.userMessage,
        changeType: message.changeType,
        currentValue: message.currentValue,
        newValue: message.newValue,
        pageContext: message.pageContext
      });
    case 'clearChatHistory': {
      // A caller-supplied key is honoured only for the fixed namespaces the
      // options page uses — otherwise a content script could wipe another
      // site's transcript by naming its key. Everything else clears the
      // transcript for the site the caller is actually on.
      const requested = message.historyKey;
      const namespaced = requested === 'context' || requested === 'setup' ||
        (typeof requested === 'string' && requested.startsWith('settings_gate:'));
      return clearChatHistory(namespaced
        ? requested
        : transcriptKeyFor('gate', { domain: message.domain }));
    }
    case 'getHistory': {
      // Reading is held to a stricter bar than clearChatHistory's: clearing a
      // guessed key destroys disposable history, but reading one leaks what
      // the user told their coach. So the fixed namespaces (context/setup/
      // settings gates) are only readable by our own extension pages, and a
      // content script can only ever read the transcript of the site it is
      // actually running on.
      const requested = message.historyKey;
      const namespaced = requested === 'context' || requested === 'setup' ||
        (typeof requested === 'string' && requested.startsWith('settings_gate:'));
      let key;
      if (namespaced && senderTrust(sender) === 'extension') {
        key = requested;
      } else {
        if (senderTrust(sender) === 'content' &&
            !hostMatchesDomain(senderPageHost(sender), message.domain)) {
          return { turns: [] };
        }
        key = transcriptKeyFor('gate', { domain: message.domain });
      }
      if (!key) return { turns: [] };
      const { chatHistories = {} } = await getStorage(['chatHistories']);
      // The open markers and "(Intention: …)" correction turns are machinery,
      // not conversation — rendering them would show the user words they
      // never typed under their own name.
      const turns = (chatHistories[key] || [])
        .filter(t => t && !isSyntheticUserTurn(t.content))
        .map(t => ({ role: t.role, content: t.content }));
      return { turns };
    }
    case 'endSession':
      // A hostile page must not inflate another site's walk-away streak — the
      // prompt trusts that number as evidence. Content senders may only end
      // sessions for the site they are running on, the same bar simpleGrant
      // applies.
      if (senderTrust(sender) === 'content' &&
          !hostMatchesDomain(senderPageHost(sender), message.domain)) {
        return { ok: true };
      }
      return endSession({ tabId, domain: message.domain, reason: message.reason });
    case 'simpleGrant': {
      // Simple-mode passes skip the coach entirely, so they must only exist
      // where simple mode actually applies — otherwise any page could mint a
      // pass for a coach-mode domain and bypass the gate. And a content script
      // may only ask for the site it is running on, not burn another domain's
      // daily grants.
      if (senderTrust(sender) === 'content' &&
          !hostMatchesDomain(senderPageHost(sender), message.domain)) {
        return { denied: 'not available' };
      }
      const { mode } = await getEffectiveMode(message.domain);
      if (mode !== 'simple') return { denied: 'this site requires the coach' };
      return simpleGrant({ tabId, domain: message.domain, isApp: message.isApp });
    }
    case 'applySettingChange': {
      // Loosening blocking rules without a coach conversation is only ever
      // legitimate from our own UI, and only where simple mode applies (the
      // global mode for disable_all, the item's mode otherwise). The
      // coach-approved path goes through handleChat's approve_setting_change,
      // which calls applySettingChange() directly and never hits this guard.
      if (senderTrust(sender) === 'content') {
        return { error: 'Not allowed from a web page' };
      }
      const { mode } = await getEffectiveMode(
        message.changeType === 'disable_all' ? null : message.domain
      );
      if (mode !== 'simple') return { error: 'This change requires the coach' };
      return applySettingChange({
        changeType: message.changeType,
        domain: message.domain,
        newValue: message.newValue
      });
    }
    case 'getBlockInfo':
      return { blockConfig: await getEffectiveMode(message.domain) };
    // The redirect that opens the gate carries only the domain, so the deep
    // link the user actually clicked is lost by the time they've talked their
    // way through it. webNavigation recorded it a moment earlier — hand it
    // back so the pass returns them to the page they asked for instead of the
    // site's front door.
    case 'getIntendedUrl': {
      const recorded = tabId != null ? (await readNavContext(tabId))?.url : null;
      if (!recorded || !message.domain) return { url: '' };
      try {
        const host = new URL(recorded).hostname;
        if (host === message.domain || host.endsWith('.' + message.domain)) {
          return { url: recorded };
        }
      } catch (e) {}
      return { url: '' };
    }
    // Sent by the native hosts (Android BackgroundJsHelper / BootReceiver, iOS
    // BackgroundJSHost) once the background page is up, since a device restart
    // leaves them with sessions in storage but no timers. Not used by the
    // extensions, where the browser owns alarm persistence.
    case 'reconcileSessions':
      return reconcileSessions();
    case 'getStatsForDomain':
      return getStatsForDomain(message.domain);
    case 'getStatsSummary':
      return getStatsSummary();
    case 'getUsageLog':
      return getUsageLog(message.days);
    case 'getSiteVisits':
      return getCandidateVisits();
    case 'openOptions': {
      const optionsUrl = chrome.runtime.getURL('options.html');
      if (!message.section) {
        await focusOrCreateTab(optionsUrl, () => chrome.runtime.openOptionsPage());
        return { ok: true };
      }
      // A section deep-link (e.g. from the chat's "invalid API key" error)
      // needs to navigate — reusing an already-open options tab as-is via
      // focusOrCreateTab would leave it stuck wherever it last was.
      const targetUrl = `${optionsUrl}?section=${encodeURIComponent(message.section)}`;
      const tabs = await chrome.tabs.query({ url: optionsUrl + '*' });
      if (tabs.length > 0) {
        await chrome.tabs.update(tabs[0].id, { active: true, url: targetUrl });
        try { await chrome.windows.update(tabs[0].windowId, { focused: true }); } catch (e) {}
      } else {
        await chrome.tabs.create({ url: targetUrl });
      }
      return { ok: true };
    }
    case 'closeCurrentTab': {
      if (tabId != null) {
        try { chrome.tabs.remove(tabId); } catch (e) {}
      }
      return { ok: true };
    }
    case 'checkDuplicateCoaching': {
      const coachingUrl = chrome.runtime.getURL('coaching.html');
      try {
        const tabs = await chrome.tabs.query({ url: coachingUrl + '*' });
        const dupes = tabs.filter(t => {
          try {
            const u = new URL(t.url);
            return u.searchParams.get('domain') === message.domain && t.id !== tabId;
          } catch (e) { return false; }
        });
        if (dupes.length > 0) {
          await chrome.tabs.update(dupes[0].id, { active: true });
          try { await chrome.windows.update(dupes[0].windowId, { focused: true }); } catch (e) {}
          return { duplicate: true, existingTabId: dupes[0].id };
        }
      } catch (e) {
        console.warn(INT_LOG, 'checkDuplicateCoaching error:', e);
      }
      return { duplicate: false };
    }
    default:
      throw new Error('Unknown action: ' + message.action);
  }
}

async function checkPageMatch(host, tabId, pageContext) {
  // Throttled no-op outside the Safari Web Extension runtime — see tracking.js.
  await syncConfigFromNative();
  const { blockedDomains = [], setupComplete = false, activeSessions = {} } = await getStorage(['blockedDomains', 'setupComplete', 'activeSessions']);
  const matchedDomain = blockedDomains.find(d => host === d || host.endsWith('.' + d)) || null;
  // This is the one moment the page is still intact — the gate has not yet
  // emptied it — so bank what the content script saw before it goes. Only for
  // a blocked page: this is material for the coach, not a browsing log, and
  // the store it lands in is disk-backed on Safari before 16.4.
  if (matchedDomain) recordTabPageContext(tabId, pageContext);
  // Not blocked, but on the suggestion shortlist: bank it so the Blocking tab
  // can lead with the sites this person actually opens (see
  // recordCandidateVisit). Never awaited — the content script is waiting on
  // this reply to decide whether to gate, and a tally is not worth a frame of
  // that. Anything not in COMMON_SITES falls straight back out.
  if (!matchedDomain) recordCandidateVisit(host).catch(() => {});
  // readSession also covers the target-only key, the fallback for a pass
  // granted where no tab id was available (the coaching page on Safari, or a
  // native port). Without it the grant is invisible here and the page gates
  // again straight away.
  const session = readSession(activeSessions, tabId, matchedDomain);
  // A pass that has since expired leaves the domain's redirect rule dropped
  // (see syncBlockingRules) — visiting it again is the moment to notice and
  // put the rule back. Not awaited: the content script is holding this page's
  // gate decision open, and the rule only matters from the next load on.
  if (matchedDomain && !session) syncBlockingRules();
  const access = await resolveAIRoute();
  const blockConfig = matchedDomain ? await getEffectiveMode(matchedDomain) : null;
  return {
    isBlocked: !!matchedDomain,
    matchedDomain,
    setupComplete: !!setupComplete,
    accessRoute: access.route,
    session,
    blockConfig
  };
}

async function getLimitsForDomain(domain) {
  // Apps and sites can't collide: appLimits is keyed by Android package name,
  // domainLimits by hostname, so a single lookup across both is safe.
  const { domainLimits = {}, appLimits = {} } = await getStorage(['domainLimits', 'appLimits']);
  const defaults = { maxGrants: 3, maxMinutes: -1 };
  const entry = domain ? (domainLimits[domain] || appLimits[domain]) : null;
  if (entry) {
    const limits = entry;
    const maxGrants = Number(limits.maxGrants);
    const maxMinutes = Number(limits.maxMinutes);
    return {
      maxGrants: isNaN(maxGrants) ? defaults.maxGrants : maxGrants,
      maxMinutes: isNaN(maxMinutes) ? defaults.maxMinutes : maxMinutes,
      quickCheck: normalizeQuickCheck(limits.quickCheck)
    };
  }
  return { ...defaults, quickCheck: normalizeQuickCheck(undefined) };
}

// ---------------------------------------------------------------------------
// AI access routing
// ---------------------------------------------------------------------------
//
// Three states, checked in this order:
//
//   byok    a custom provider key is configured (Settings -> Advanced). Calls
//           go straight from this device to that provider, and the hosted
//           coaching-credit balance doesn't apply.
//   hosted  a coaching-credit balance is available. Calls go to Intention's
//           backend, which holds the provider key. This is the default path.
//   locked  neither — every coaching entry point shows the paywall instead of
//           a chat.
//
// BYOK wins when present because it is an explicit, deliberate override; it is
// never what a fresh install lands on.
async function resolveAIRoute() {
  const { provider, apiKey, model, entitlement, backendUrl } = await getStorage([
    'provider', 'apiKey', 'model', 'entitlement', 'backendUrl'
  ]);

  if (provider && provider !== HOSTED_PROVIDER && apiKey) {
    return { route: 'byok', provider, apiKey, model: model || '' };
  }
  if (entitlementIsActive(entitlement)) {
    return {
      route: 'hosted',
      provider: HOSTED_PROVIDER,
      accessToken: entitlement.token || '',
      model: '',
      backendUrl: backendUrl || ''
    };
  }
  return { route: 'locked' };
}

// An entitlement the backend has rejected must stop counting as access, or
// every coaching attempt keeps failing with the same error instead of offering
// the user the way back in.
async function markEntitlementStale(code) {
  await mutateStorage('entitlement', (entitlement) => {
    if (!entitlement || typeof entitlement !== 'object') return entitlement;
    return { ...entitlement, active: false, lastError: code || 'entitlement_invalid', updatedAt: Date.now() };
  }, null);
}

async function saveEntitlement(entitlement) {
  if (!entitlement || typeof entitlement !== 'object') {
    await setStorage({ entitlement: null });
    return { ok: true, entitlement: null };
  }
  const clean = {
    active: !!entitlement.active,
    productId: String(entitlement.productId || ''),
    expiresAt: entitlement.expiresAt ? Number(entitlement.expiresAt) : null,
    source: String(entitlement.source || ''),
    token: String(entitlement.token || ''),
    receipt: entitlement.receipt || null,
    balanceMicros: Number(entitlement.balanceMicros || 0),
    balanceGbp: Number(entitlement.balanceGbp || 0),
    balanceCredits: Number(entitlement.balanceCredits || 0),
    pendingVerification: !!entitlement.pendingVerification,
    lastError: String(entitlement.lastError || ''),
    updatedAt: Date.now()
  };
  await setStorage({ entitlement: clean });
  return { ok: true, entitlement: clean };
}

async function getAccess() {
  const { entitlement, provider, apiKey } = await getStorage(['entitlement', 'provider', 'apiKey']);
  const resolved = await resolveAIRoute();
  return {
    route: resolved.route,
    entitlement: entitlement || null,
    hasCustomKey: !!(apiKey && provider && provider !== HOSTED_PROVIDER),
    customProvider: provider && provider !== HOSTED_PROVIDER ? provider : ''
  };
}

// Per-item mode/behavior override falls back to the global default, so most
// domains carry no mode/behavior/passMinutes fields at all.
async function getEffectiveMode(domain) {
  const { blockingMode = 'coach', simpleBehavior = 'pass', simplePassMinutes = 10, domainLimits = {}, appLimits = {} } = await getStorage(['blockingMode', 'simpleBehavior', 'simplePassMinutes', 'domainLimits', 'appLimits']);
  const entry = domain ? (domainLimits[domain] || appLimits[domain]) : null;
  const mode = entry?.mode || blockingMode || 'coach';
  const behavior = entry?.behavior || simpleBehavior || 'pass';
  const globalPassMinutes = Number(simplePassMinutes) > 0 ? Number(simplePassMinutes) : 10;
  const passMinutes = Number(entry?.passMinutes) > 0 ? Number(entry.passMinutes) : globalPassMinutes;
  return { mode, behavior, passMinutes };
}

async function getFullConfig() {
  const keys = ['provider', 'apiKey', 'model', 'userContext', 'contextProjects', 'contextReasons', 'coachInstructions', 'blockedDomains', 'domainLimits', 'blockedApps', 'appLimits', 'appLabels', 'setupComplete', 'entitlement', 'backendUrl', 'blockingMode', 'simpleBehavior', 'simplePassMinutes'];
  const stored = await getStorage(keys);
  const access = await resolveAIRoute();
  return {
    setupComplete: !!stored.setupComplete,
    accessRoute: access.route,
    entitlement: stored.entitlement || null,
    backendUrl: stored.backendUrl || '',
    provider: stored.provider || '',
    apiKey: stored.apiKey || '',
    model: stored.model || '',
    userContext: stored.userContext || '',
    contextProjects: stored.contextProjects || '',
    contextReasons: stored.contextReasons || '',
    coachInstructions: stored.coachInstructions || DEFAULT_COACH_INSTRUCTIONS,
    defaultCoachInstructions: DEFAULT_COACH_INSTRUCTIONS,
    blockedDomains: stored.blockedDomains || [],
    domainLimits: stored.domainLimits || {},
    blockedApps: stored.blockedApps || [],
    appLimits: stored.appLimits || {},
    appLabels: stored.appLabels || {},
    blockingMode: stored.blockingMode || 'coach',
    simpleBehavior: stored.simpleBehavior || 'pass',
    simplePassMinutes: Number(stored.simplePassMinutes) > 0 ? Number(stored.simplePassMinutes) : 10,
    providers: PROVIDERS
  };
}

async function saveSetup({ provider, apiKey, model, userContext, contextProjects, contextReasons, blockedDomains, domainLimits, blockedApps, appLimits, appLabels, blockingMode, simpleBehavior, simplePassMinutes }) {
  await setStorage({
    provider: provider || '',
    apiKey: apiKey || '',
    model: model || (provider ? PROVIDERS[provider]?.defaultModel : '') || '',
    userContext: userContext || '',
    contextProjects: contextProjects || '',
    contextReasons: contextReasons || '',
    blockedDomains: blockedDomains || [],
    domainLimits: domainLimits || {},
    blockedApps: blockedApps || [],
    appLimits: appLimits || {},
    appLabels: appLabels || {},
    blockingMode: blockingMode || 'coach',
    simpleBehavior: simpleBehavior === 'hard' ? 'hard' : 'pass',
    simplePassMinutes: Number(simplePassMinutes) > 0 ? Number(simplePassMinutes) : 10,
    setupComplete: true
  });
  await syncBlockingRules();
  return { ok: true };
}

async function saveSettings(partial) {
  await setStorage(partial);
  if (partial.blockedDomains) {
    await syncBlockingRules();
  }
  return { ok: true };
}

// Keeps a "credit remaining" indicator live after every message, rather than
// only updating the next time the settings page reconciles. Called after each
// successful hosted LLM call — a coaching turn can now involve two.
async function applyHostedBalance(access, llmResponse) {
  if (access.route !== 'hosted') return;
  await mutateStorage('entitlement', (entitlement) => {
    if (!entitlement || typeof entitlement !== 'object') return entitlement;
    return {
      ...entitlement,
      balanceMicros: llmResponse.balanceMicros,
      balanceGbp: llmResponse.balanceGbp,
      balanceCredits: llmResponse.balanceCredits,
      updatedAt: Date.now()
    };
  }, null);
}

async function handleChat({ tabId, mode, domain, isApp, appLabel, userMessage, changeType, currentValue, newValue, pageContext }) {
  const { userContext, contextProjects, contextReasons, coachInstructions, coachObservations = [] } = await getStorage(['userContext', 'contextProjects', 'contextReasons', 'coachInstructions', 'coachObservations']);
  const access = await resolveAIRoute();
  if (access.route === 'locked') {
    return { error: 'You need coaching credit to talk to your coach.', locked: true };
  }

  // Resolve and enrich page context (video title, duration, Reddit thread, etc.)
  const isAppTarget = isApp || changeType === 'remove_app' || changeType === 'increase_app_limit' || changeType === 'increase_app_quick_check';
  let pageCtx = pageContext || null;
  if (!pageCtx && tabId != null) {
    const nav = await readNavContext(tabId);
    // What the content script actually saw beats anything we can infer from
    // the address alone.
    if (nav?.pageCtx) pageCtx = nav.pageCtx;
    else if (nav?.url && typeof extractPageContextFromUrl === 'function') pageCtx = extractPageContextFromUrl(nav.url);
  }
  // Whatever the source, it has to describe the site actually being gated. A
  // recorded navigation lives for a day and the tab may have moved on since;
  // telling the coach about the wrong site is worse than telling it nothing,
  // because it will confidently quote it back to the user. getIntendedUrl
  // makes the same check before it hands a URL out.
  if (pageCtx && !isAppTarget && !pageContextMatchesDomain(pageCtx, domain)) pageCtx = null;
  if (pageCtx && typeof enrichPageContext === 'function') {
    try {
      pageCtx = await enrichPageContext(pageCtx);
    } catch (e) {}
  }

  // For apps, `domain` is the storage/stats key (an Android package name, or
  // the pseudo-target "apps" for the iOS Screen Time pass); prompts get a
  // human-readable display name instead.
  let displayName = domain;
  // Apps get their own context block in place of the page one — there is no
  // page to describe, and saying nothing let the coach invent a screen it
  // cannot see. See renderAppContextBlock.
  let appCtx = null;
  if (isApp || changeType === 'remove_app' || changeType === 'increase_app_limit' || changeType === 'increase_app_quick_check') {
    const { appLabels = {} } = await getStorage(['appLabels']);
    const label = appLabel || appLabels[domain];
    displayName = label ? `the ${label} app` : 'a blocked app';
    appCtx = { appId: domain, appLabel: label || '' };
  }

  const sessionKey = sessionKeyFor(tabId, domain);

  const historyKey = transcriptKeyFor(mode, { domain, changeType });
  if (!historyKey) return { error: 'No history context' };
  const { chatHistories = {} } = await getStorage(['chatHistories']);
  const history = chatHistories[historyKey] || [];

  let systemPrompt = '';
  let tools = [];

  if (mode === 'gate') {
    const stats = await getStatsForDomain(domain);
    const limits = await getLimitsForDomain(domain);
    systemPrompt = buildGateSystemPrompt({
      domain: displayName,
      userContext,
      contextProjects,
      contextReasons,
      coachInstructions,
      grantsToday: stats.grantsToday,
      grantsCap: limits.maxGrants,
      minutesCap: limits.maxMinutes,
      minutesTodaySite: stats.minutesToday,
      minutesTodayAll: stats.minutesTodayAll,
      minutesWeekAll: stats.minutesWeekAll,
      minutesWeekSite: stats.minutesWeek,
      reasonsToday: stats.reasonsToday,
      sessionsToday: stats.sessionsToday,
      recentDays: stats.recentDays,
      walkedAwayToday: stats.walkedAwayToday,
      walkedAwayWeek: stats.walkedAwayWeek,
      observations: coachObservations,
      pageContext: pageCtx,
      appContext: appCtx,
      quickCheck: limits.quickCheck,
      quickChecksToday: stats.quickChecksToday
    });
    tools = [GRANT_TOOL, NOTE_OBSERVATION_TOOL];
  } else if (mode === 'checkin') {
    const { activeSessions = {} } = await getStorage(['activeSessions']);
    // Deliberately live: false — by check-in time the native ports have
    // already marked this one ended, and its reason is what we're after.
    // Still domain-scoped, so the coach can't quote another site's reason.
    const session = readSession(activeSessions, tabId, domain, { live: false }) || {};
    const stats = await getStatsForDomain(domain);
    const limits = await getLimitsForDomain(domain);
    systemPrompt = buildCheckinSystemPrompt({
      domain: displayName,
      userContext,
      contextProjects,
      contextReasons,
      coachInstructions,
      originalReason: session.reason,
      grantsToday: stats.grantsToday,
      grantsCap: limits.maxGrants,
      minutesCap: limits.maxMinutes,
      minutesTodaySite: stats.minutesToday,
      minutesTodayAll: stats.minutesTodayAll,
      minutesWeekSite: stats.minutesWeek,
      reasonsToday: stats.reasonsToday,
      sessionsToday: stats.sessionsToday,
      recentDays: stats.recentDays,
      walkedAwayToday: stats.walkedAwayToday,
      walkedAwayWeek: stats.walkedAwayWeek,
      observations: coachObservations,
      pageContext: pageCtx,
      appContext: appCtx,
      quickCheck: limits.quickCheck,
      quickChecksToday: stats.quickChecksToday
    });
    tools = [GRANT_TOOL, NOTE_OBSERVATION_TOOL];
  } else if (mode === 'settings_gate') {
    const stats = await getStatsForDomain(domain);
    systemPrompt = buildSettingsGateSystemPrompt({
      domain: displayName,
      changeType,
      currentValue,
      newValue,
      userContext,
      contextProjects,
      contextReasons,
      coachInstructions,
      minutesTodaySite: stats.minutesToday,
      minutesTodayAll: stats.minutesTodayAll,
      minutesWeekAll: stats.minutesWeekAll,
      reasonsToday: stats.reasonsToday
    });
    tools = [APPROVE_CHANGE_TOOL];
  } else if (mode === 'context') {
    systemPrompt = buildContextSystemPrompt({ currentContext: userContext });
    tools = [UPDATE_CONTEXT_TOOL];
  } else if (mode === 'setup') {
    systemPrompt = buildSetupSystemPrompt();
    tools = [SAVE_ONBOARDING_TOOL];
  } else {
    return { error: `Unknown chat mode: ${mode}` };
  }

  if (userMessage) {
    history.push({ role: 'user', content: userMessage });
  } else {
    // The coach speaks first now: an empty send means Intention opened the
    // conversation, and the marker tells the model which situation it is
    // opening into. Guarded against stacking — an LLM failure below returns
    // before persistence, so a retry re-reads a clean transcript, but a
    // client retrying against un-persisted in-memory state must not send the
    // same marker twice in a row.
    const opener = mode === 'checkin' ? CHECKIN_OPEN_MARKER : CHAT_OPEN_MARKER;
    if (history.length === 0 || history[history.length - 1].content !== opener) {
      history.push({ role: 'user', content: opener });
    }
  }

  // Split once and reuse for both calls below: the cacheable prefix has to be
  // byte-identical between them or the second call re-writes the cache.
  const systemBlocks = splitSystemForCache(systemPrompt);

  let llmResponse;
  try {
    llmResponse = await callLLM({
      provider: access.provider,
      apiKey: access.apiKey,
      model: access.model,
      accessToken: access.accessToken,
      backendUrl: access.backendUrl,
      system: systemBlocks,
      messages: history,
      tools
    });
  } catch (e) {
    if (isEntitlementError(e)) {
      await markEntitlementStale(e.code);
      return { error: e.message, locked: true, errorCode: e.code };
    }
    return { error: friendlyLlmErrorMessage(e), networkError: isNetworkError(e), errorCode: e && e.code };
  }

  await applyHostedBalance(access, llmResponse);

  let grantedSession = null;
  let contextUpdated = null;
  let settingApproved = null;
  // Two channels, deliberately separate: systemNote is a short user-facing
  // fact the UI renders outside the chat bubble; correction is a message FOR
  // THE MODEL, sent back in a second turn so the coach's own spoken words
  // match what actually happened instead of promising minutes it never gave.
  let systemNote = '';
  let correction = '';

  // Each tool call is processed independently: a malformed/unexpected input on
  // one call must not prevent the others from running, and must never abort
  // before the history persistence below, or the user's message (already sent
  // to and answered by the LLM) would silently vanish from their chat.
  for (const tc of llmResponse.toolCalls || []) {
    const input = tc.input || {};
    try {
      if (tc.name === 'approve_setting_change' && mode === 'settings_gate') {
        settingApproved = await applySettingChange({ domain, changeType, newValue });
        continue;
      }
      if (tc.name === 'grant_access' && (mode === 'gate' || mode === 'checkin')) {
        const stats = await getStatsForDomain(domain);
        const limits = await getLimitsForDomain(domain);
        const qc = limits.quickCheck;

        const grantsLimitReached = stats.grantsToday >= limits.maxGrants;
        const minutesLimitReached = limits.maxMinutes > 0 && stats.minutesToday >= limits.maxMinutes;

        // The quick check bypasses the grants cap, never the minutes cap —
        // and it only exists at the gate: a check-in grant is an extension by
        // definition, and the lane must never extend. The flag is the model's
        // attestation that the first message named one small specific check;
        // when the lane can't honour it, the call is DOWNGRADED to a normal
        // grant attempt rather than dropped — the user gave a real reason —
        // and the correction turn makes the coach say which lane it came from.
        const qcRequested = input.quick_check === true;
        const qcUsable = qcRequested && qc.enabled && stats.quickChecksToday < qc.usesPerDay && mode === 'gate';
        let downgradeNote = '';
        if (qcRequested && !qcUsable) {
          downgradeNote = mode !== 'gate' ? 'the quick check cannot be used to extend a session'
            : !qc.enabled ? 'quick checks are turned off for this site'
            : "today's quick check is already used";
        }

        // The number the model actually asked for, kept before clamping so the
        // correction below can name the gap instead of pretending it granted
        // what was requested.
        const requested = Math.round(Number(input.minutes) || 0);

        if (qcUsable) {
          if (minutesLimitReached) {
            systemNote = `Absolute max of ${limits.maxMinutes} minutes reached — no more time can be granted today.`;
            correction = `Your grant_access call was NOT applied: absolute max of ${limits.maxMinutes} minutes reached. Not even a quick check fits — no time can be granted today.`;
            continue;
          }
          let minutes = Math.max(1, Math.min(qc.minutes, requested));
          let clampCause = minutes < requested ? `the ${qc.minutes}-minute quick-check budget` : '';
          if (limits.maxMinutes > 0) {
            const remainingMinutes = Math.max(0, limits.maxMinutes - stats.minutesToday);
            if (minutes > remainingMinutes) {
              minutes = remainingMinutes;
              clampCause = "the user's daily minutes cap";
            }
          }
          if (minutes <= 0) {
            systemNote = `Absolute max of ${limits.maxMinutes} minutes reached — no more time can be granted today.`;
            correction = `Your grant_access call was NOT applied: the user's daily minutes cap is already used up. No time can be granted today.`;
            continue;
          }
          if (minutes < requested) {
            correction = `You asked for ${requested} minutes, but only ${minutes} were available under ${clampCause}. The quick check was granted for ${minutes} minutes.`;
            systemNote = clampCause === "the user's daily minutes cap"
              ? `Only ${minutes} minutes were available under your daily cap — your quick check is ${minutes} minutes.`
              : `Quick checks top out at ${qc.minutes} minutes — your pass is ${minutes} minutes.`;
          }
          const reason = String(input.reason || '').slice(0, 240);
          grantedSession = await grantSession({ sessionKey, tabId, domain, isApp, minutes, reason, quickCheck: true });
          continue;
        }

        if (grantsLimitReached || minutesLimitReached) {
          // Told to the model but never auto-taken: spending the once-a-day
          // lane on a grant the model did NOT attest as a quick check would
          // let sweet-talk drain it. The honesty turn carries no tools, so
          // the invitation is honestly framed as a later turn.
          const qcStillOpen = mode === 'gate' && qc.enabled && stats.quickChecksToday < qc.usesPerDay && !minutesLimitReached;
          const reasonStr = grantsLimitReached ? 'daily grant cap reached' : `absolute max of ${limits.maxMinutes} minutes reached`;
          systemNote = grantsLimitReached
            ? (qcStillOpen
                ? `Daily grant cap reached — only the ${qc.minutes}-minute quick check is still available today.`
                : 'Daily grant cap reached — no more time can be granted today.')
            : `Absolute max of ${limits.maxMinutes} minutes reached — no more time can be granted today.`;
          correction = downgradeNote
            ? `Your grant_access call was NOT applied: ${downgradeNote}, and the ${reasonStr}. No time can be granted today.`
            : `Your grant_access call was NOT applied: ${reasonStr}.` + (qcStillOpen
                ? ` Their quick check (up to ${qc.minutes} minutes) is still available: if they name one small, specific thing to check, call grant_access with quick_check set to true on a later turn.`
                : ' No time can be granted today.');
          continue;
        }

        let minutes = Math.max(1, Math.min(60, requested));
        // Which constraint actually bound matters for the correction below: a
        // no-cap user whose 90-minute ask hits the 60-minute ceiling must not
        // be told about a "daily cap" they never set.
        let clampCause = minutes < requested ? 'the 60-minute ceiling on any single pass' : '';
        if (limits.maxMinutes > 0) {
          const remainingMinutes = Math.max(0, limits.maxMinutes - stats.minutesToday);
          if (minutes > remainingMinutes) {
            minutes = remainingMinutes;
            clampCause = "the user's daily minutes cap";
          }
        }

        if (minutes <= 0) {
          systemNote = `Absolute max of ${limits.maxMinutes} minutes reached — no more time can be granted today.`;
          correction = `Your grant_access call was NOT applied: the user's daily minutes cap is already used up. No time can be granted today.`;
          continue;
        }

        if (minutes < requested) {
          correction = `You asked for ${requested} minutes, but only ${minutes} were available under ${clampCause}. The pass was granted for ${minutes} minutes.`;
          systemNote = clampCause === "the user's daily minutes cap"
            ? `Only ${minutes} minutes were available under your daily cap — your pass is ${minutes} minutes.`
            : `Passes top out at 60 minutes — your pass is ${minutes} minutes.`;
        }

        if (downgradeNote) {
          // Fires the honesty turn even when the grant lands unclamped: the
          // coach's spoken words likely promised "your quick check", and the
          // pass actually spent one of the normal grants.
          correction = `You marked this grant as a quick check, but ${downgradeNote} — it was granted as one of their ${limits.maxGrants} normal daily grants instead.` + (correction ? ` ${correction}` : '');
        }

        const reason = String(input.reason || '').slice(0, 240);
        // Must go through grantSession, not a copy of it: recordGrant is what
        // feeds stats.grantsToday and reasonsToday, so an inlined version that
        // skips it silently disables both the daily cap checked above and the
        // escalating skepticism the check-in prompt is built on.
        grantedSession = await grantSession({ sessionKey, tabId, domain, isApp, minutes, reason });
      } else if (tc.name === 'note_observation' && (mode === 'gate' || mode === 'checkin')) {
        // The coach's cross-day memory. Capped, deduplicated, and readable in
        // settings — a bounded notepad, not a dossier.
        const text = String(input.observation || '').trim().slice(0, 300);
        if (text) {
          await mutateStorage('coachObservations', (list) => {
            if (list.some(o => o && o.text === text)) return list;
            list.push({ text, domain, at: Date.now() });
            return list.slice(-10);
          }, []);
        }
      } else if (tc.name === 'update_context' && mode === 'context') {
        const newContext = String(input.new_context || '').slice(0, 5000).trim();
        if (newContext) {
          await setStorage({ userContext: newContext });
          contextUpdated = { new_context: newContext, diff_summary: String(input.diff_summary || '').slice(0, 240) };
        }
      } else if (tc.name === 'save_onboarding' && mode === 'setup') {
        const userContext = String(input.user_context || '').slice(0, 5000).trim();
        const blockedDomains = (input.blocked_domains || []).map(d =>
          String(d).trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0]
        ).filter(Boolean);

        const domainLimits = {};
        for (const item of input.domain_limits || []) {
          if (item?.domain) {
            const dom = String(item.domain).trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
            domainLimits[dom] = {
              maxGrants: Number(item.max_grants_per_day) || 3,
              // `Number(undefined) ?? -1` was NaN — Number() never yields the
              // nullish value ?? tests for — so an omitted per-day cap stored
              // NaN instead of the -1 "unlimited" sentinel.
              maxMinutes: Number.isFinite(Number(item.max_minutes_per_day)) ? Number(item.max_minutes_per_day) : -1
            };
          }
        }

        await setStorage({
          userContext,
          blockedDomains,
          domainLimits,
          setupComplete: true
        });
        await syncBlockingRules();
        contextUpdated = { onboardingComplete: true };
      }
    } catch (e) {
      console.warn(`Intention: tool call "${tc.name}" failed`, e);
      // systemNote only, no correction: an executor bug is ours to surface to
      // the user, not something to spend a second LLM turn explaining. A
      // correction set before the throw (the clamp path assigns it before
      // grantSession runs) must be cleared too, or the honesty turn would
      // assert a grant that never actually landed.
      correction = '';
      systemNote = 'Something went wrong applying that — try describing what you want again.';
    }
  }

  // Never let the coach accept silently: if the model emitted only a tool call
  // with no spoken text, supply a default acceptance message so the user always
  // sees the coach acknowledge before being let through / having a change applied.
  const rawText = (llmResponse.text || '').trim();
  let acceptanceFallback = '';
  if (!rawText) {
    if (grantedSession) {
      const mins = grantedSession.intervalMinutes;
      const r = grantedSession.reason ? ` for "${grantedSession.reason}"` : '';
      acceptanceFallback = `Okay — you've got ${mins} minute${mins === 1 ? '' : 's'}${r}. Make it count; I'll check in when the time's up.`;
    } else if (settingApproved) {
      if (changeType === 'remove' || changeType === 'remove_app') acceptanceFallback = `Alright, I'm convinced — I've removed ${displayName} from your blocklist.`;
      else if (changeType === 'increase_limit' || changeType === 'increase_app_limit') acceptanceFallback = `Okay, you've made your case — I've raised your absolute max on ${displayName}.`;
      else if (changeType === 'increase_quick_check' || changeType === 'increase_app_quick_check') acceptanceFallback = `Okay, you've made your case — I've loosened the daily quick check on ${displayName}.`;
      else if (changeType === 'disable_all') acceptanceFallback = `Understood — I've turned off blocking for now. Be intentional with it.`;
      else acceptanceFallback = `Okay, I'm convinced — I've made that change.`;
    }
  }
  const firstText = rawText || acceptanceFallback;

  // When a grant was rejected or clamped, the model's spoken text still
  // promises whatever it asked for — and silently shipping that text is a lie
  // in the coach's own voice. One extra turn (never more) tells the model what
  // actually happened and lets it say so itself. On failure the synthetic user
  // turn is popped so the transcript keeps alternating roles (Gemini rejects
  // two consecutive same-role turns).
  let secondText = '';
  if (correction && (mode === 'gate' || mode === 'checkin')) {
    history.push({ role: 'assistant', content: firstText || '(…)' });
    history.push({ role: 'user', content: `(Intention: ${correction} Tell the user what actually happened, honestly and in your own words, and keep coaching. Do not repeat the request.)` });
    try {
      const second = await callLLM({
        provider: access.provider,
        apiKey: access.apiKey,
        model: access.model,
        accessToken: access.accessToken,
        backendUrl: access.backendUrl,
        system: systemBlocks,
        messages: history,
        tools: []
      });
      await applyHostedBalance(access, second);
      // Tool calls from the correction turn are ignored wholesale: the state
      // has already been settled above, and honouring a fresh grant here
      // would reopen the loop this turn exists to close.
      secondText = (second.text || '').trim();
      history.push({ role: 'assistant', content: secondText || '(…)' });
    } catch (e) {
      console.warn('Intention: correction turn failed', e);
      secondText = '';
      history.pop();
    }
  } else {
    history.push({ role: 'assistant', content: firstText || '(…)' });
  }

  const assistantText = [firstText, secondText].filter(Boolean).join('\n\n');
  // Re-read under the lock: the LLM call above took seconds, and writing back
  // the copy of chatHistories read before it would drop any other
  // conversation's turns committed in the meantime.
  //
  // This is best-effort: the LLM has already replied and any grant/setting
  // change above already landed, so a storage hiccup here should not turn
  // into an error response — it would just make this turn missing from
  // history on next open, not undo anything the user was told happened.
  try {
    await mutateStorage('chatHistories', (histories) => {
      histories[historyKey] = history.slice(-40);
      pruneStaleTranscripts(histories);
    });
  } catch (e) {
    console.warn('Intention: failed to persist chat history', e);
  }

  return {
    assistantText: assistantText || '(…)',
    grantedSession,
    contextUpdated,
    approved: settingApproved ? true : false,
    systemNote: systemNote || undefined
  };
}

// Maps provider.js's stable err.code classifications to messages a user can
// actually act on, instead of surfacing raw HTTP bodies or stack traces.
function friendlyLlmErrorMessage(e) {
  switch (e && e.code) {
    case 'auth':
      return 'Your API key was rejected. Check it in settings.';
    case 'rate_limit':
      return "The AI provider is rate-limiting requests. Wait a moment and try again.";
    case 'provider_error':
      return "The AI provider is having issues right now. Try again shortly.";
    case 'timeout':
      return "The request timed out. Try again.";
    default:
      return (e && e.message) || 'Something went wrong talking to the AI provider.';
  }
}

// Perform the actual loosening mutation once the coach approves it, then
// persist and re-sync the blocking rules. Returns the resulting state.
async function applySettingChange({ domain, changeType, newValue }) {
  const { blockedDomains = [], domainLimits = {}, blockedApps = [], appLimits = {}, appLabels = {} } = await getStorage(['blockedDomains', 'domainLimits', 'blockedApps', 'appLimits', 'appLabels']);

  if (changeType === 'remove') {
    const domains = blockedDomains.filter(x => x !== domain);
    const limits = { ...domainLimits };
    if (limits[domain]) delete limits[domain];
    await setStorage({ blockedDomains: domains, domainLimits: limits });
    await syncBlockingRules();
    return { changeType, domain, blockedDomains: domains, domainLimits: limits };
  }

  if (changeType === 'increase_limit') {
    const limits = { ...domainLimits };
    if (!limits[domain]) limits[domain] = { maxGrants: 3 };
    const parsed = Number(newValue);
    // -1 (or any non-positive sentinel) means unlimited.
    limits[domain] = { ...limits[domain], maxMinutes: (isNaN(parsed) || parsed <= 0) ? -1 : Math.round(parsed) };
    await setStorage({ domainLimits: limits });
    await syncBlockingRules();
    return { changeType, domain, domainLimits: limits, maxMinutes: limits[domain].maxMinutes };
  }

  if (changeType === 'remove_app') {
    const apps = blockedApps.filter(x => x !== domain);
    const limits = { ...appLimits };
    const labels = { ...appLabels };
    delete limits[domain];
    delete labels[domain];
    await setStorage({ blockedApps: apps, appLimits: limits, appLabels: labels });
    return { changeType, domain, blockedApps: apps, appLimits: limits };
  }

  if (changeType === 'increase_app_limit') {
    const limits = { ...appLimits };
    if (!limits[domain]) limits[domain] = { maxGrants: 3 };
    const parsed = Number(newValue);
    limits[domain] = { ...limits[domain], maxMinutes: (isNaN(parsed) || parsed <= 0) ? -1 : Math.round(parsed) };
    await setStorage({ appLimits: limits });
    return { changeType, domain, appLimits: limits, maxMinutes: limits[domain].maxMinutes };
  }

  if (changeType === 'increase_quick_check' || changeType === 'increase_app_quick_check') {
    const forApp = changeType === 'increase_app_quick_check';
    const limits = { ...(forApp ? appLimits : domainLimits) };
    if (!limits[domain]) limits[domain] = { maxGrants: 3 };
    const m = Math.round(Number(newValue && newValue.minutes));
    const u = Math.round(Number(newValue && newValue.usesPerDay));
    // Anything not a positive pair is stored as the explicit off shape — with
    // the lane on by default, only an explicit zero means disabled.
    const quickCheck = (Number.isFinite(m) && m > 0 && Number.isFinite(u) && u > 0)
      ? { minutes: Math.min(m, 60), usesPerDay: u }
      : { minutes: 0, usesPerDay: 0 };
    limits[domain] = { ...limits[domain], quickCheck };
    await setStorage(forApp ? { appLimits: limits } : { domainLimits: limits });
    if (!forApp) await syncBlockingRules();
    return { changeType, domain, ...(forApp ? { appLimits: limits } : { domainLimits: limits }), quickCheck };
  }

  if (changeType === 'disable_all') {
    await setStorage({ blockedDomains: [], blockedApps: [], appLimits: {}, appLabels: {} });
    await syncBlockingRules();
    return { changeType, blockedDomains: [], blockedApps: [] };
  }

  return null;
}

// Shared by the LLM's grant_access tool call and the no-AI simpleGrant path:
// records the grant, banks whatever session previously held this key, opens
// the new session, and arms the check-in alarm / DNR rule.
async function grantSession({ sessionKey, tabId, domain, isApp, minutes, reason, quickCheck }) {
  await recordGrant(domain, minutes, reason, { quickCheck });

  // Granting replaces whatever session held this key (a check-in extending
  // time, or a native port reusing the target's slot), so bank the old
  // one's minutes before it's overwritten and lost.
  const { activeSessions = {} } = await getStorage(['activeSessions']);
  const previous = activeSessions[sessionKey];
  if (previous && !isBanked(previous)) {
    const elapsed = (Date.now() - previous.startTime) / 60000;
    await recordSessionMinutes(previous.domain, Math.min(elapsed, previous.intervalMinutes), 'extended');
  }

  // Present (false) on non-quick sessions too: coach-path and simple-path
  // session objects must keep identical key sets.
  const session = { domain, reason, intervalMinutes: minutes, startTime: Date.now(), quickCheck: !!quickCheck };
  await mutateStorage('activeSessions', (sessions) => { sessions[sessionKey] = session; });
  chrome.alarms.create(`checkin-${sessionKey}`, { delayInMinutes: minutes });
  // Apps have no network rules to allow — the Android accessibility
  // service reads activeSessions directly to let the app through — and
  // neither do the native ports, which have no tab to scope a rule to.
  if (!isApp && tabId != null) await registerSessionRule(tabId, domain, minutes);
  // Drops this domain's redirect rule for the life of the pass.
  if (!isApp) await syncBlockingRules();
  return session;
}

// No-AI equivalent of the grant_access tool call: same limits and bookkeeping,
// just without a coach conversation. Used by simple-mode gate/checkin UIs.
async function simpleGrant({ tabId, domain, isApp }) {
  const sessionKey = sessionKeyFor(tabId, domain);
  if (!sessionKey) return { denied: 'no session target' };

  const stats = await getStatsForDomain(domain);
  const limits = await getLimitsForDomain(domain);
  const grantsLimitReached = stats.grantsToday >= limits.maxGrants;
  const minutesLimitReached = limits.maxMinutes > 0 && stats.minutesToday >= limits.maxMinutes;
  if (grantsLimitReached || minutesLimitReached) {
    return { denied: grantsLimitReached ? 'daily grant cap reached' : `absolute max of ${limits.maxMinutes} minutes reached` };
  }

  const { passMinutes } = await getEffectiveMode(domain);
  let minutes = Math.max(1, Math.round(passMinutes));
  if (limits.maxMinutes > 0) {
    minutes = Math.min(minutes, Math.max(0, limits.maxMinutes - stats.minutesToday));
  }
  if (minutes <= 0) return { denied: 'absolute max reached' };

  const grantedSession = await grantSession({ sessionKey, tabId, domain, isApp, minutes, reason: 'simple mode pass' });
  return { grantedSession };
}

async function clearChatHistory(historyKey) {
  if (!historyKey) return { ok: true };
  await mutateStorage('chatHistories', (chatHistories) => {
    delete chatHistories[historyKey];
  });
  return { ok: true };
}

// Retires one session key: banks whatever time it earned and drops its
// check-in alarm. The transcript deliberately survives — it is keyed per
// (site, day) now, so the next visit continues the same conversation instead
// of meeting a coach with no memory of the last one. Deliberately does no DNR
// or redirect-rule work — the callers below own that, because a tab's allow
// rule is shared by every session on that tab and must only be touched once
// the sweep is complete.
async function retireSessionKey(sessionKey, outcome) {
  const { activeSessions = {} } = await getStorage(['activeSessions']);
  const session = activeSessions[sessionKey];
  if (session) {
    // An already-banked session (see bankExpiredSession) must not be counted
    // twice — drop it, but don't re-record its minutes.
    if (!isBanked(session)) {
      const elapsed = (Date.now() - session.startTime) / 60000;
      const used = Math.min(elapsed, session.intervalMinutes);
      // Closing the tab with time still on the clock is the win the coach is
      // told to celebrate, so only claim it when they genuinely left time
      // unused — otherwise this was just the pass running its course.
      const resolved = outcome === 'ended'
        ? (used < session.intervalMinutes - 0.5 ? 'closed_early' : 'finished')
        : outcome;
      await recordSessionMinutes(session.domain, used, resolved);
    }
    await mutateStorage('activeSessions', (sessions) => { delete sessions[sessionKey]; });
  }
  // Legacy per-session transcripts (and any written before this key change)
  // still need clearing out; the live one is per (site, day) and stays.
  await mutateStorage('chatHistories', (chatHistories) => { delete chatHistories[sessionKey]; });
  chrome.alarms.clear(`checkin-${sessionKey}`);
}

// The DNR allow rule is keyed by tab id alone (one rule per tab), but a tab can
// hold a live pass on more than one blocked site. So ending one session must
// not strip the rule out from under another that is still running — hand the
// rule to whichever session is still live instead of removing it.
async function settleTabRule(tabId) {
  if (tabId == null) return;
  const { activeSessions = {} } = await getStorage(['activeSessions']);
  const stillLive = sessionKeysForTab(activeSessions, tabId)
    .map(key => activeSession(activeSessions[key]))
    .find(Boolean);
  if (stillLive) {
    const remainingMinutes = Math.max(
      1,
      Math.ceil((stillLive.startTime + stillLive.intervalMinutes * 60000 - Date.now()) / 60000)
    );
    await registerSessionRule(tabId, stillLive.domain, remainingMinutes);
  } else {
    removeSessionRule(tabId);
  }
}

async function endSession({ tabId, domain, reason }) {
  const sessionKey = sessionKeyFor(tabId, domain);
  if (!sessionKey) return { ok: true };

  if (reason === 'walked_away') {
    // Closing the gate without ever taking time is the exact habit this tool
    // exists to build, so it is counted — but only when no session exists
    // (live OR banked): with one, this "walk away" is really an early close
    // and falls through to the normal retire path below. No retire and no tab
    // close here — the client shows its walk-away moment first and owns the
    // close timing, so closing the tab from this side would cut it off.
    const { activeSessions = {} } = await getStorage(['activeSessions']);
    if (!readSession(activeSessions, tabId, domain, { live: false })) {
      await recordWalkAway(domain);
      return { ok: true };
    }
  }

  await retireSessionKey(sessionKey, 'ended');
  await settleTabRule(tabId);
  // The pass is over: this domain needs its redirect rule back.
  await syncBlockingRules();

  if (reason === 'fulfilled' && tabId != null) {
    try { chrome.tabs.remove(tabId); } catch (e) {}
  }
  return { ok: true };
}

// Tab-close path. onRemoved gives us a tab id and nothing else, so there is no
// domain to build a key from — and with per-(tab, domain) keys a tab may own
// several sessions. Missing any of them would leak it forever: its minutes
// never banked, its redirect rule never restored.
async function endAllSessionsForTab(tabId, reason) {
  if (tabId == null) return { ok: true };
  const { activeSessions = {} } = await getStorage(['activeSessions']);
  const keys = sessionKeysForTab(activeSessions, tabId);
  for (const key of keys) {
    await retireSessionKey(key, reason === 'closed' ? 'tab_closed' : 'ended');
  }
  removeSessionRule(tabId);
  if (keys.length) await syncBlockingRules();
  return { ok: true };
}
