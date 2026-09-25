try {
  importScripts('parts.js', 'sites.js', 'providers.js', 'prompts.js', 'tracking.js', 'page_context.js', 'rules.js');
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

// Safari gets no declarativeNetRequest safety net: domainsNeedingRedirect()
// returns nothing there, because WebKit's DNR engine cannot complete a load to
// the gate page (see the note on it). So on Safari the content script's overlay
// is the only thing standing between a blocked site and a full page of it, and
// every way that overlay can fail to appear — the script was never injected,
// the check errored, storage was unreadable — fails open, silently, for the
// whole visit, with nothing in the UI to say so.
//
// This is the second line. It watches what actually committed in the tab, and
// if the page hasn't reported an overlay shortly after, navigates the tab to
// the gate itself. tabs.update is the one route to coaching.html that works
// here: the DNR engine fails that URL with NSURLErrorFileDoesNotExist (-1100),
// but a tab navigating to it loads it fine.
//
// It runs on onCommitted and never earlier, deliberately. Diverting an
// in-flight Safari cross-process navigation strands the tab on the previous
// page with the progress bar stuck — the same failure window.stop() caused in
// content.js — while a page that has already committed can be navigated away
// from safely.
//
// The grace period is longer than the content script's own retry budget
// (CHECK_TOTAL_BUDGET_MS, 2.5s), so this only fires once the page has
// definitively given up, or was never there to try. A background page that
// gets suspended inside the grace period simply loses the timer; the backstop
// is a safety net, not a mechanism anything else depends on.
const GATE_BACKSTOP_GRACE_MS = 3000;
const gateBackstopTimers = new Map();

function cancelGateBackstop(tabId) {
  const timer = gateBackstopTimers.get(tabId);
  if (timer == null) return;
  clearTimeout(timer);
  gateBackstopTimers.delete(tabId);
}

async function enforceGateBackstop(tabId, url) {
  let host = '';
  try {
    host = new URL(url).hostname;
  } catch (e) {
    return;
  }
  const { blockedDomains = [], setupComplete = false, activeSessions = {}, domainLimits = {} } = await getStorage(['blockedDomains', 'setupComplete', 'activeSessions', 'domainLimits']);
  // Before setup there is no blocklist to be on, and the gate page has nothing
  // to coach with. The content script's own setup-needed notice is the right
  // answer there, not a navigation.
  if (!setupComplete) return;
  const matchedDomain = blockedDomains.find(d => hostMatchesDomain(host, d)) || null;
  if (!matchedDomain) return;
  // A part rule can mean this address is not blocked at all — "only Reels on
  // instagram.com" leaves every other page of the site open, and an open page
  // never calls markHandled() because there is nothing to handle.
  //
  // So this check is load-bearing rather than defensive: without it the
  // backstop would read "no overlay reported" as "the overlay failed" on every
  // allowed page, and navigate a page the user was explicitly allowed to be on
  // to the coach three seconds after it loaded. resolvePartVerdict fails
  // closed, so anything it cannot evaluate still gates here.
  //
  // Through resolvePageVerdict rather than straight to parts.js, because an
  // allowed channel's video on YouTube is only known to be open once its
  // channel has been looked up — and the content script, which asked the same
  // question through checkPageMatch, rendered nothing on the strength of it.
  if (!(await resolvePageVerdict(limitEntryFor(matchedDomain, { domainLimits }), url)).gated) return;
  // A live pass stands the backstop down — but only for the page it actually
  // covers. On Safari this is the second line of defence and there is no DNR
  // behind it, so a scoped pass whose page the tab has since left has to leave
  // the backstop armed, or the scope would hold on every platform except the
  // one where the overlay is the only enforcement there is.
  // sessionCoversUrl returns true for any session with no scope, which is
  // every pass granted before this existed and every site pass since.
  const session = readSession(activeSessions, tabId, matchedDomain, { url });
  if (session && sessionCoversUrl(session, url)) return;
  // The tab may have moved on during the grace period — only act if it is
  // still sitting on the page this was scheduled for.
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab || tab.url !== url) return;
  } catch (e) {
    return;
  }
  console.warn(INT_LOG, 'gate backstop firing for', matchedDomain, '- the page never reported an overlay');
  await chrome.tabs.update(tabId, {
    url: chrome.runtime.getURL(`coaching.html?domain=${encodeURIComponent(matchedDomain)}`)
  });
}

if (typeof chrome !== 'undefined' && chrome.webNavigation?.onCommitted) {
  try {
    const extensionOrigin = chrome.runtime.getURL('');
    chrome.webNavigation.onCommitted.addListener((details) => {
      if (details.frameId !== 0 || !details.url) return;
      // Whatever was pending for this tab was for the page it just left.
      cancelGateBackstop(details.tabId);
      if (details.url.startsWith(extensionOrigin) || details.url.startsWith('chrome-extension://') || details.url.startsWith('about:')) return;
      const timer = setTimeout(() => {
        gateBackstopTimers.delete(details.tabId);
        enforceGateBackstop(details.tabId, details.url)
          .catch(e => console.warn(INT_LOG, 'gate backstop failed:', e));
      }, GATE_BACKSTOP_GRACE_MS);
      gateBackstopTimers.set(details.tabId, timer);
    });
  } catch (e) {
    console.warn(INT_LOG, 'webNavigation onCommitted listener warning:', e);
  }
}

// The other half of "the address changed": a single-page app calling
// history.pushState. No request is made, nothing commits, no content script
// re-runs — and for a page-scoped pass that is precisely the navigation that
// matters, because a YouTube autoplay into the next video is exactly this.
//
// The content script cannot see the call either: it runs in an isolated world
// in all three engines, so patching history.pushState from here patches a
// function the page never touches. It polls instead (URL_WATCH_MS in
// content.js), and this listener is the fast path in front of that poll — a
// message that arrives in a few milliseconds instead of up to 600.
//
// Belt to the content script's braces, never the other way round: Safari's
// webNavigation support for this event is not something to depend on, and the
// message is fire-and-forget because a tab with no content script (an
// extension page, a tab still loading) simply has nothing listening.
if (typeof chrome !== 'undefined' && chrome.webNavigation?.onHistoryStateUpdated) {
  try {
    const extensionOrigin = chrome.runtime.getURL('');
    chrome.webNavigation.onHistoryStateUpdated.addListener((details) => {
      if (details.frameId !== 0 || !details.url) return;
      if (details.url.startsWith(extensionOrigin) || details.url.startsWith('chrome-extension://') || details.url.startsWith('about:')) return;
      // The recorded page context is what getIntendedUrl and the coach's page
      // block both read, and onBeforeNavigate does not fire for a pushState —
      // so without this the record still describes the page they left, and the
      // coach would confidently discuss the wrong video.
      //
      // No new category of stored data: this is derived from the address
      // alone, and onBeforeNavigate already records that address for every
      // ordinary navigation. The guard is for the Android background WebView,
      // which does not load page_context.js at all.
      if (typeof extractPageContextFromUrl === 'function') {
        recordTabPageContext(details.tabId, extractPageContextFromUrl(details.url));
      }
      try {
        chrome.tabs.sendMessage(details.tabId, { action: 'urlChanged', url: details.url }, () => {
          void chrome.runtime.lastError;
        });
      } catch (e) {}
    });
  } catch (e) {
    console.warn(INT_LOG, 'webNavigation onHistoryStateUpdated listener warning:', e);
  }
}

if (typeof chrome !== 'undefined' && chrome.tabs?.onRemoved) {
  try {
    chrome.tabs.onRemoved.addListener((tabId) => {
      cancelGateBackstop(tabId);
      delete tabNavContext[tabId];
      persistNavContext();
    });
  } catch (e) {}
}

// ===========================================================================
// LEAVING — noticing that someone has opened the page they remove us from
// ===========================================================================
//
// What this is, stated plainly so nobody has to reverse-engineer the intent:
// when the user opens chrome://extensions (or about:addons), Intention opens
// ONE tab beside it offering a conversation with the coach. It does not
// navigate that page, does not close it, does not repeat, and the button that
// removes Intention is live from the first paint of that conversation. There
// is no mechanism here that can prevent a removal and none is wanted; see
// docs/LEAVING.md, which is also what setUninstallURL points at.
//
// The negative space matters as much as the code:
//
//   * No "management" permission. `chrome.management.onDisabled` /
//     `onUninstalled` fire for OTHER extensions — our own worker is already
//     torn down by the time either would fire for us — so the permission buys
//     a scary install-time warning ("Manage your apps, extensions and themes")
//     for literally zero capability.
//   * No declarativeNetRequest rule and no content script. `chrome://` and
//     `about:` pages are not network requests and cannot be injected into.
//     `tabs.onUpdated` is the only signal that exists, and it only carries
//     `tab.url` because we already hold "tabs" for the gate backstop.
//   * We never touch the extensions tab. The user may well have opened it to
//     manage a DIFFERENT extension — no API tells us whose row they are
//     looking at — and taking a page away from someone is squarely the Chrome
//     Web Store's "must be easily reversible" clause. A second tab is one
//     keystroke to close.
//
// Firefox: about:addons is in the table below and the listener is the same
// one. Whether Firefox populates `tab.url` for about: pages in onUpdated under
// the `tabs` permission is NOT verified — `npm run test:smoke` is Chromium
// only. It is registered, it is guarded, and it fails closed (no match, no
// tab, nothing happens).
const REMOVAL_SURFACES = [
  // Anchored, and each one demands a delimiter or end-of-string after the
  // path. Without that, `chrome://extensions-internals` — a debugging page
  // that has nothing to do with removal — matches by prefix, and so does any
  // future `chrome://extensionsomething`.
  /^chrome:\/\/extensions(?:[/?#]|$)/i,
  /^edge:\/\/extensions(?:[/?#]|$)/i,
  /^brave:\/\/extensions(?:[/?#]|$)/i,
  /^about:addons(?:[/?#]|$)/i
];

// Fifteen minutes of silence after EVERY outcome of the leaving conversation —
// approved, declined, cancelled, or "remove it anyway". Including a decline,
// and that is the point rather than an oversight: it is what makes this a
// speed bump instead of a loop. Talk to the coach, decide to stay, go back to
// the extensions page to do the thing you actually opened it for, and
// Intention says nothing. This is the property to point a store reviewer at.
const LEAVE_STAND_DOWN_MS = 15 * 60 * 1000;

// And ten minutes between interpositions even with no conversation had at all
// — someone toggling another extension on and off, or reloading the page.
const LEAVE_INTERPOSE_DEBOUNCE_MS = 10 * 60 * 1000;

// The farewell page. Deliberately NOT api.intention.maybeitssoftware.co.uk:
// the backend writes an access-log line per request, so pointing an uninstall
// URL at it would make every removal a beacon that told us it happened. That
// is an uninstall ping, PRIVACY.md forbids it, and no amount of "we don't look
// at it" makes it not one. GitHub gets the hit; we are never told.
const LEAVING_DOC_URL = 'https://github.com/MaybeItsSoftware/intention/blob/main/docs/LEAVING.md';

// Pure, so it can be tested without a browser. Anything unparseable is not a
// removal surface — this decides whether to OPEN a tab, so failing closed
// costs nothing and failing open is an unexplained tab.
function isRemovalSurfaceUrl(url) {
  if (typeof url !== 'string' || !url) return false;
  return REMOVAL_SURFACES.some(re => re.test(url));
}

// Whether an interposition is allowed right now, from the stored state alone.
//
// Separate from the listener and pure for the same reason isRemovalSurfaceUrl
// is: this is the whole policy of the feature — every reason Intention stays
// quiet is one line here — and a policy nobody can read back in a test is a
// policy that drifts.
function leaveInterposeAllowed(state, now) {
  try {
    if (!state) return false;
    // Before setup there is nothing to leave, and an empty blocklist means
    // nothing is being enforced, so there is nothing to have a conversation
    // about. Both halves matter: a user who has removed every site has
    // already effectively left, and pestering them about it would be absurd.
    if (!state.setupComplete) return false;
    if (!Array.isArray(state.blockedDomains) || state.blockedDomains.length === 0) return false;

    // A conversation already happened. `- now <= LEAVE_STAND_DOWN_MS` caps how
    // long a stand-down can possibly suppress for: a clock that jumps forward
    // and back, or a hand-edited value, must not be able to write a silence
    // that outlives its own length.
    const standDownUntil = Number(state.leaveStandDown && state.leaveStandDown.until) || 0;
    if (standDownUntil > now && standDownUntil - now <= LEAVE_STAND_DOWN_MS) return false;

    // They already asked and the coach agreed. Whether the cool-off is still
    // running or has run out, the answer was yes — opening the conversation
    // again would be asking someone to justify a decision we have already
    // accepted, which is exactly the loop this feature must not become.
    if (state.leaveRequest && Number(state.leaveRequest.availableAt) > 0) return false;

    // The plain debounce, for a visit with no conversation at all. A timestamp
    // in the future (clock moved back) does not count, or it would silence the
    // feature until the clock caught up.
    const last = Number(state.leaveInterposedAt) || 0;
    if (last > 0 && now >= last && now - last < LEAVE_INTERPOSE_DEBOUNCE_MS) return false;

    return true;
  } catch (e) {
    return false;
  }
}

// One at a time. `tabs.onUpdated` fires more than once for a single visit (the
// url change, then status 'complete'), and both would otherwise read the
// stored debounce timestamp before either had written it.
let leaveInterposeInFlight = false;

async function interposeOnRemovalSurface() {
  if (leaveInterposeInFlight) return false;
  leaveInterposeInFlight = true;
  try {
    const stored = await getStorage(['setupComplete', 'blockedDomains', 'leaveStandDown', 'leaveInterposedAt', 'leaveRequest']);
    const now = Date.now();
    if (!leaveInterposeAllowed(stored, now)) return false;
    // Written BEFORE the tab opens, so a failure to open still spends the
    // debounce. A tab that could not be created is not a reason to try again
    // in two seconds.
    await setStorage({ leaveInterposedAt: now });
    const leaveUrl = chrome.runtime.getURL('options.html?leave=1');
    // Beside the extensions page, never over it. focusOrCreateTab reuses a tab
    // already on this exact address (a second visit after the stand-down
    // lapsed) rather than stacking a third one up.
    await focusOrCreateTab(leaveUrl, () => chrome.tabs.create({ url: leaveUrl }));
    return true;
  } catch (e) {
    console.warn(INT_LOG, 'leave interposition failed:', e);
    return false;
  } finally {
    leaveInterposeInFlight = false;
  }
}

if (typeof chrome !== 'undefined' && chrome.tabs?.onUpdated) {
  try {
    chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
      // Deliberately not webNavigation: its events are not raised for
      // chrome:// URLs, so onCommitted (which this file already listens on for
      // the gate backstop) never sees this navigation at all.
      if (!changeInfo || (!changeInfo.url && changeInfo.status !== 'complete')) return;
      const url = changeInfo.url || (tab && tab.url) || '';
      if (!isRemovalSurfaceUrl(url)) return;
      interposeOnRemovalSurface()
        .catch(e => console.warn(INT_LOG, 'leave interposition error:', e));
    });
  } catch (e) {
    console.warn(INT_LOG, 'tabs onUpdated listener warning:', e);
  }
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
//
// `url` is the page being asked about, when the caller has one. It is what
// lets a page pass reach a second tab — but only a tab on that same page.
function readSession(activeSessions, tabId, domain, { live = true, url = '' } = {}) {
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
  // Site passes share one clock across tabs, whether or not the caller knows
  // which tab it is — coaching.html on Safari sometimes cannot find out, and
  // was re-gating on a live pass. A page pass reaches another tab only for
  // its own page (the same video opened in a new tab), so opening a DIFFERENT
  // page still cannot widen the grant.
  candidates.push(...Object.entries(activeSessions)
    .filter(([key, session]) => tabIdFromSessionKey(key) != null && session.domain === domain &&
      (!session.scope || (!!url && !!session.scope.key && sessionCoversUrl(session, url))))
    .map(([, session]) => session));
  for (const session of candidates) {
    if (!session) continue;
    const resolved = live ? activeSession(session) : session;
    if (resolved) return resolved;
  }
  return null;
}

// A page pass honoured in a tab other than the one it was granted in (the
// same video opened again in a new tab) needs that tab's own allow rule on
// Chrome: the redirect rule stays up for a page pass, and the only allow rule
// was registered for the original tab, so the new one would be sent back to
// the gate on its very next load. Site passes drop the redirect outright and
// need nothing here.
async function adoptPagePass(activeSessions, tabId, session) {
  if (tabId == null || !session || !session.scope) return;
  if (activeSessions[sessionKeyFor(tabId, session.domain)] === session) return;
  await registerSessionRule(tabId, session);
}

async function tabsForSiteSession(session, ownerTabId) {
  const ids = new Set(ownerTabId == null ? [] : [ownerTabId]);
  if (session && !session.scope) {
    try {
      for (const tab of await chrome.tabs.query({})) {
        try {
          if (hostMatchesDomain(new URL(tab.url).hostname, session.domain)) ids.add(tab.id);
        } catch (e) {}
      }
    } catch (e) {}
  }
  return [...ids];
}

async function interruptSessionTabs(session, ownerTabId) {
  let shown = false;
  for (const id of await tabsForSiteSession(session, ownerTabId)) {
    try {
      const reply = await chrome.tabs.sendMessage(id, { action: 'showCheckin', domain: session?.domain });
      shown = !!reply?.shown || shown;
    } catch (e) {}
  }
  return shown;
}

// A session that has been banked by the check-in alarm is kept around on the
// native ports so the check-in coach can quote its original reason, but it
// must never read as a live pass — nor must one whose time has simply run out
// while nothing was around to close it (a restarted service worker, or iOS,
// where the shields re-arm natively and no alarm ever fires).
function activeSession(session) {
  if (!session || session.endedAt) return null;
  const now = Date.now();
  return sessionElapsedMs(session, now) < Number(session.intervalMinutes) * 60000 &&
    (!session.wallExpiresAt || now < Number(session.wallExpiresAt)) ? session : null;
}

// Android records time away from a native target. Sessions without these
// fields retain their original wall-clock behavior on browsers and iOS.
function sessionElapsedMs(session, now = Date.now()) {
  const effectiveNow = session.pausedAt ? Math.min(now, Number(session.pausedAt)) : now;
  return Math.max(0, effectiveNow - Number(session.startTime) -
    Math.max(0, Number(session.pausedDurationMs) || 0));
}

function sessionExpiryTime(session) {
  const foregroundExpiry = session.pausedAt ? Infinity :
    Number(session.startTime) + Number(session.intervalMinutes) * 60000 +
      Math.max(0, Number(session.pausedDurationMs) || 0);
  return session.wallExpiresAt ? Math.min(foregroundExpiry, Number(session.wallExpiresAt)) : foregroundExpiry;
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
// UNSCOPED pass gets none, on top of the per-tab session allow rule registered
// below: belt and braces, because WebKit does not reliably honour a session
// rule's `tabIds` condition, and when it doesn't the redirect wins and throws
// the user straight back into the gate they just talked their way through —
// the "granted, then stuck on the gate forever" loop. The rule comes back when
// the pass ends (see the callers of syncBlockingRules), and, should the
// background have been suspended by then, on the next visit to the domain.
//
// A PAGE-SCOPED pass is the exact opposite case and this filter is the whole
// of the difference: WHERE THE ORDERING CAN BE RELIED ON it keeps the domain's
// redirect rule, because the scope only means anything if every OTHER page on
// that domain still gates. The narrowed allow rule registered for the tab
// (registerSessionRule) lets the one granted page through past it; a hard
// navigation to anything else on the site meets the redirect and opens the
// coach, which is the feature. Dropping the rule here for a scoped pass hands
// the network layer the whole site while the badge says THIS PAGE ONLY — the
// single worst failure this package can have, which is why
// tests/background.test.js pins it.
//
// The qualifier is not hedging: keeping the redirect only works if the allow
// rule beats it, and that ordering is verified on exactly one engine. See
// allowOutranksRedirect() below for what happens on the others and why the
// answer there fails in the safer direction.
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
  const { blockedDomains = [], activeSessions = {}, domainLimits = {} } = await getStorage(['blockedDomains', 'activeSessions', 'domainLimits']);
  // `!s.scope` is what keeps a scoped pass's domain redirect alive — but only
  // where the narrowed allow rule can actually beat it. See
  // allowOutranksRedirect(): where it cannot be shown to, a page-scoped pass
  // drops the redirect exactly as a site pass does, and the scope is enforced
  // by the content script alone.
  const keepRedirectForScoped = allowOutranksRedirect();
  const passed = new Set(
    Object.values(activeSessions)
      .filter(s => activeSession(s) && (!s.scope || !keepRedirectForScoped))
      .map(s => s.domain)
  );
  // A host carrying a part rule drops out of the blanket redirect entirely.
  // The decision on such a host now needs the PATH, and a declarativeNetRequest
  // rule matching `||host^` cannot see one — it would redirect the parts the
  // user explicitly left open. Worse, DNR only ever sees a network request, and
  // instagram.com/reels reached by pushState is not one, so it could never
  // express "only Reels" correctly even with a narrower filter.
  //
  // What replaces it is the content script's overlay plus the backstop above,
  // which is not a downgrade to something unproven: it is exactly how Safari
  // gates every blocked site today (hasNativeMessaging() returns [] up there),
  // so a sectioned host runs on a shipped path rather than a new one.
  //
  // v1.5 would keep the redirect for an 'except' rule whose every part carries
  // a `dnr` filter and add priority-3 `allow` rules beside it, removing the
  // page flash on the commonest shape ("block Reddit except r/rust"). That is
  // gated on tests/smoke/gate.smoke.mjs proving Chromium matches `||host/path`
  // the way the ABP syntax says it does — and, like the scoped-pass construct
  // above, it would stay off wherever allowOutranksRedirect() says no.
  return blockedDomains.filter(domain =>
    !passed.has(domain) && !hasPageRule(limitEntryFor(domain, { domainLimits })));
}

// May a priority-2 `allow` session rule be trusted to out-rank a priority-1
// `redirect` dynamic rule for the same navigation?
//
// This is load-bearing and it is the reason the question is asked at all. A
// page-scoped pass is the only construct in the extension that needs the two
// KINDS of rule to coexist for one host: the domain redirect has to stay up so
// the rest of the site keeps gating, and the narrowed allow rule has to beat
// it on the one granted address. Get the ordering wrong and the pass is not
// merely weak, it is a trap — the granted page redirects to coaching.html,
// coaching.js sends the user back to grantedSession.scope.url, and that
// redirects again, for the whole length of a pass they paid a conversation
// for.
//
// Chromium is the one engine whose answer this repo actually has: the DNR spec
// says a higher-priority `allow` wins, and tests/smoke/gate.smoke.mjs drives a
// real scoped grant through a real Chromium and asserts the user lands on the
// granted page. Firefox's MV3 declarativeNetRequest is a partial
// implementation, this repo runs nothing against it, and the comment that used
// to sit in this function said so in as many words while the construct it
// warned about was switched on unconditionally.
//
// So the engine that says no is named, by the API only it has:
// runtime.getBrowserInfo is Firefox's and exists nowhere else. Safari never
// reaches here (hasNativeMessaging() returns [] above) and Android has no
// declarativeNetRequest at all, which leaves Chromium — the engine the smoke
// suite drives — as the yes.
//
// It is worth recording what this test is NOT, because the obvious version of
// it was wrong and the smoke suite is what said so. "Chromium is the runtime
// with no `browser` namespace" is no longer true: Chrome exposes `browser` as
// an alias of `chrome`, so `typeof browser === 'undefined'` reported Chromium
// as unverified and dropped the redirect on the one engine that has been
// verified. tests/smoke/gate.smoke.mjs now asserts this function's answer
// against a real browser, so the next detector that quietly stops working
// fails there rather than in a release.
//
// What saying no costs is the smaller half of the asymmetry: the domain
// redirect goes away for the life of the pass, so the other pages of that site
// load live and are gated by the content script's overlay instead — which is
// precisely how Safari gates every blocked site today, and how the scope
// itself is enforced there. A block held by the overlay rather than by the
// network layer; not a block dropped. UX-BACKLOG.md carries the item for
// verifying Firefox and turning this back on there.
function allowOutranksRedirect() {
  try {
    const isFirefox = typeof browser !== 'undefined' && browser.runtime &&
      typeof browser.runtime.getBrowserInfo === 'function';
    return !isFirefox;
  } catch (e) {
    // Unreadable runtime: take the answer that degrades rather than the one
    // that leaves a pass resting on an ordering nothing has checked.
    return false;
  }
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
    //
    // The action type and priority are in the summary for the same reason the
    // redirect target is. Once a rule set can contain more than one KIND of
    // rule for the same filter — an allow beside a redirect, a narrowed rule
    // beside a whole-domain one — two rule sets that differ in what they
    // actually DO can agree on every field this compares, and the difference
    // is then never applied. That failure is silent and it fails open.
    const ruleSummary = rules => rules
      .map(r => `${r.condition?.urlFilter || ''} [${r.action?.type || ''} p${r.priority == null ? '' : r.priority}] -> ${r.action?.redirect?.extensionPath || r.action?.redirect?.url || ''}`)
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

// Session rules to temporarily allow a tab to visit a domain. No duration:
// a session rule has no TTL of its own, so the pass ending is what removes it
// (removeSessionRule), not the clock.
//
// Takes the SESSION rather than the domain, because a page-scoped pass allows
// less than the whole domain: its filter names the one granted address, so
// that where the domain's redirect rule stays in place for a scoped pass (see
// domainsNeedingRedirect, and allowOutranksRedirect for the engines where it
// does not) it still catches every other page on the site. Where the redirect
// has been dropped, this rule is simply harmless: it allows exactly the page
// nothing was going to redirect anyway.
//
// dnrUrlFilterFor returns '' for any address that cannot be expressed safely
// as a urlFilter, and '' is the ONLY thing it returns other than a filter that
// matches the address it was built from. Two shapes reach it: a path or query
// carrying the pattern characters `* ^ |`, and a non-ASCII byte Chrome would
// reject the whole batch over. (It used to have a third answer for the second
// shape — drop the query, anchor the path — and that rule could never fire,
// because a query is the only reason the branch was reached and both ends are
// anchored. A filter that cannot match its own URL is worse than none: the
// line below reads any non-empty string as "the narrow rule worked".)
//
// '' is a supported answer, not a failure — but it is worth naming why it is
// SAFE rather than merely tolerated, because the obvious sentence for it ("the
// content script picks up what the rule misses") is false wherever the redirect
// actually fires: a DNR redirect diverts the navigation before any content
// script runs on that origin, so there would be nothing of ours there to pick
// anything up. It works for the opposite reason. The fallback filter is scoped
// to `tabIds: [tabId]`, so it clears the priority-1 domain redirect FOR THIS
// ONE TAB — which is the only thing that lets a content script exist on the
// page at all, and the content script's own check (sessionCoversUrl, which
// runs with the worker dead) is then what enforces the scope. That is already
// how Safari enforces every pass, so it is a shipped path rather than a
// theoretical one.
//
// isUrlFilterCaseSensitive is set, and it is not cosmetic. The default is
// case-INSENSITIVE, so an allow rule for /p/ABC123/ also let /p/abc123/ past
// the block — a different Instagram post, since shortcodes are case-sensitive.
// sessionCoversUrl compares the scope key exactly, so the overlay re-gated a
// moment later, but the wrong page had already loaded live.
async function registerSessionRule(tabId, session) {
  try {
    const domain = session && session.domain;
    const scopedFilter = session && session.scope && session.scope.url
      ? dnrUrlFilterFor(session.scope.url)
      : '';
    const urlFilter = scopedFilter || `||${domain}^`;
    const ruleId = tabId;
    const addRules = [{
      id: ruleId,
      priority: 2,
      action: {
        type: 'allow'
      },
      condition: {
        urlFilter,
        isUrlFilterCaseSensitive: true,
        tabIds: [tabId],
        resourceTypes: ['main_frame']
      }
    }];

    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [ruleId],
      addRules
    });
    console.log(INT_LOG, 'Registered session allow rule for tab', tabId, 'filter', urlFilter);
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

// A farewell page, not a hook. Chrome/Firefox open this AFTER we are already
// gone; there is no callback, nothing of ours runs, and it is not fired on a
// mere disable. It exists so that the last thing Intention does is explain
// what was on this device, what went with it, and how to get coaching credit
// back — rather than vanishing and leaving someone to wonder. Registered at
// top level so it survives every worker restart. See LEAVING_DOC_URL for why
// it points at GitHub and not at our own backend.
if (typeof chrome !== 'undefined' && chrome.runtime?.setUninstallURL) {
  try {
    chrome.runtime.setUninstallURL(LEAVING_DOC_URL);
  } catch (e) {
    console.warn(INT_LOG, 'setUninstallURL warning:', e);
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
// Likewise: hands the apps this browser's recent website time, so their
// dashboards are current as soon as Safari wakes the extension.
pushActivityToNative();

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
    const { activeSessions = {} } = await getStorage(['activeSessions']);
    const nativeSession = activeSessions[sessionKey];
    if (activeSession(nativeSession)) {
      const expiry = sessionExpiryTime(nativeSession);
      if (Number.isFinite(expiry)) chrome.alarms.create(`checkin-${sessionKey}`, { when: expiry });
      return;
    }
    await bankExpiredSession(sessionKey);
    // A website pass granted without a tab id (Safari's standalone coach)
    // still has browser tabs to interrupt; native app targets match none.
    if (nativeSession && !nativeSession.scope) await interruptSessionTabs(nativeSession, null);
    return;
  }

  // Expiration of session time -> remove DNR allow rule for this tab, and put
  // back the domain redirect rule the grant dropped.
  removeSessionRule(tabId);
  await syncBlockingRules();

  // WHETHER THE CHECK-IN ACTUALLY WENT UP, not whether the message arrived.
  //
  // This used to be a bare try/catch: a throw meant "no content script" and
  // was the only thing that banked the pass. But the content script has three
  // arms that decline to render — a gate or an earlier check-in already owns
  // the page, the address is one the user's own part rule leaves open, or the
  // pass named here is for a different site than the tab is on — and every one
  // of them RESOLVED this call. The catch never ran, nothing was banked, and
  // the session sat in activeSessions with no endedAt while its minutes went
  // unrecorded in dailyStats and allTimeStats. Nothing repaired it later:
  // reconcileSessions is only reachable through its own message, which only
  // the native hosts send.
  //
  // So the content script says, and anything that is not an explicit yes is a
  // no: an older content script, a page with no listener, a throw, a reply
  // that never came. The domain rides along because a tab may hold passes on
  // two blocked sites at once and the page has to know which one expired.
  const { activeSessions: sessionsNow = {} } = await getStorage(['activeSessions']);
  const expiring = sessionsNow[sessionKey];
  const shown = await interruptSessionTabs(expiring, tabId);
  if (!shown) {
    // Nothing on screen will ever end this pass, so bank it before dropping
    // it. Deleting without banking silently lost every minute of a pass whose
    // tab disappeared before its check-in: nothing else ever records a deleted
    // session's time. Sequential awaits on purpose — bankExpiredSession runs
    // its own mutateStorage, and nesting it inside the delete's mutator would
    // deadlock the storage queue.
    await bankExpiredSession(sessionKey);
    await mutateStorage('activeSessions', (activeSessions) => {
      delete activeSessions[sessionKey];
    });
  }
});

async function bankExpiredSession(sessionKey) {
  const { activeSessions = {} } = await getStorage(['activeSessions']);
  const session = activeSessions[sessionKey];
  if (!session || isBanked(session) || activeSession(session)) return;
  const elapsed = sessionElapsedMs(session) / 60000;
  await recordSessionMinutes(session.domain, Math.min(elapsed, session.intervalMinutes), 'ran_out', session.startTime);
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
    if (!isBanked(session) && Number.isFinite(sessionExpiryTime(session))) {
      chrome.alarms.create(`checkin-${newKey}`, {
        when: sessionExpiryTime(session)
      });
    }
  }
  console.log(INT_LOG, 'migrateSessionKeys: rekeyed', renames.length);
  return { migrated: renames.length };
}

async function reconcileSessions() {
  await migrateSessionKeys();
  await applyDuePendingChanges();
  const { activeSessions = {} } = await getStorage(['activeSessions']);
  const banked = [];
  const rearmed = [];
  for (const [sessionKey, session] of Object.entries(activeSessions)) {
    if (!session || isBanked(session)) continue;
    const expiresAt = sessionExpiryTime(session);
    if (Date.now() >= expiresAt) {
      await bankExpiredSession(sessionKey);
      banked.push(sessionKey);
    } else {
      if (Number.isFinite(expiresAt)) {
        chrome.alarms.create(`checkin-${sessionKey}`, { when: expiresAt });
        rearmed.push(sessionKey);
      } else {
        chrome.alarms.clear(`checkin-${sessionKey}`);
      }
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
// (and on Safari no sender.tab); native hosts carry no tab or URL (Android
// marks its platform so pass time can follow foreground use); everything else is a
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
  if (mode === 'context') return mode;
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
    case 'checkPageMatch': return checkPageMatch(message.host, tabId, message.pageContext, resolveSenderUrl(sender, message.url));
    // The content script has put Intention's own UI on the page — a gate, a
    // pass badge, or one of the interstitials. Whichever it was, the page is
    // handled and the backstop above has nothing left to do.
    case 'gateShown':
      cancelGateBackstop(tabId);
      return { ok: true };
    case 'getConfig': {
      const config = await getFullConfig();
      // Only extension pages (options, coaching) may read the API key —
      // never content scripts, which run inside arbitrary web pages.
      if (senderTrust(sender) !== 'extension') config.apiKey = '';
      // And the same rule for the entitlement, for the reason spelled out over
      // getAccess: the stored object carries `token`, a bearer credential that
      // can SPEND the balance. getAccess was hardened against exactly this and
      // getConfig returns the very same object, so leaving it here would have
      // made that control half a control — the next content-script feature
      // that wants any part of the config reopens it, and nothing would fail
      // to say so.
      //
      // Content senders only, not `!== 'extension'` as the key above. The
      // native hosts (Android's BackgroundJsHelper, iOS's BackgroundJSHost)
      // deliver an empty sender, and on those two platforms our own settings
      // page reaches the worker through them — options-access.js reconciles a
      // purchase against this token, so blanking it for 'native' would break
      // restore on the only builds that sell anything. The stricter line the
      // apiKey takes above is older than either control and is left as it was.
      if (senderTrust(sender) === 'content') config.entitlement = null;
      return config;
    }
    // Both whole-config writers are refused outright for a content sender.
    // Neither is page-reachable today — a web page cannot send us a runtime
    // message — but every other privileged action here carries this check, and
    // an unguarded saveSettings is the widest hole in the file: one message
    // sets blockedDomains to [] and the product is off. The asymmetry with
    // applySettingChange three cases down was the only thing making it look
    // deliberate, so it is closed rather than explained.
    case 'saveSetup':
      if (senderTrust(sender) === 'content') return { error: 'Not allowed from a web page' };
      return saveSetup(message.config);
    case 'saveSettings':
      if (senderTrust(sender) === 'content') return { error: 'Not allowed from a web page' };
      return saveSettings(message.config);
    case 'getAccess': return getAccess(sender);
    case 'saveEntitlement': return saveEntitlement(message.entitlement);
    case 'mergeEntitlement': return mergeEntitlement(message.entitlement);
    case 'getSession': {
      if (!message.domain) return { session: null };
      const { activeSessions = {} } = await getStorage(['activeSessions']);
      const session = readSession(activeSessions, tabId, message.domain, { url: message.url || '' });
      await adoptPagePass(activeSessions, tabId, session);
      // `covers` answers the second question the caller actually has: does
      // that pass apply where they were heading? True for every session with
      // no scope, so a caller that never sends a url sees today's behaviour.
      // The gate page cannot work this out for itself — coaching.html
      // deliberately does not load parts.js — so it is answered here.
      return { session, covers: sessionCoversUrl(session, message.url || '') };
    }
    case 'chat':
      return handleChat({
        tabId,
        androidForegroundTime: senderTrust(sender) === 'native' && sender.nativePlatform === 'android',
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
      const namespaced = requested === 'context' ||
        (typeof requested === 'string' && requested.startsWith('settings_gate:'));
      return clearChatHistory(namespaced
        ? requested
        : transcriptKeyFor('gate', { domain: message.domain }));
    }
    case 'getHistory': {
      // Reading is held to a stricter bar than clearChatHistory's: clearing a
      // guessed key destroys disposable history, but reading one leaks what
      // the user told their coach. So the fixed namespaces (the context
      // conversation and the settings gates) are only readable by our own
      // extension pages, and a content script can only ever read the
      // transcript of the site it is actually running on.
      const requested = message.historyKey;
      const namespaced = requested === 'context' ||
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
      // sessions for the site they are running on, the same bar intentionGrant
      // applies.
      if (senderTrust(sender) === 'content' &&
          !hostMatchesDomain(senderPageHost(sender), message.domain)) {
        return { ok: true };
      }
      return endSession({ tabId, domain: message.domain, reason: message.reason });
    case 'intentionGrant': {
      // One of the day's free opens. No conversation stands in front of it,
      // so the only things to check are who is asking and whether an open is
      // left — and the second is intentionGrant's job. A content script may
      // only spend opens for the site it is running on, never another
      // domain's.
      if (senderTrust(sender) === 'content' &&
          !hostMatchesDomain(senderPageHost(sender), message.domain)) {
        return { denied: 'not available' };
      }
      return intentionGrant({ tabId, domain: message.domain, isApp: message.isApp,
        reason: message.reason, minutes: message.minutes,
        androidForegroundTime: senderTrust(sender) === 'native' && sender.nativePlatform === 'android' });
    }
    case 'applySettingChange': {
      // Our own UI asking for a loosening without the coach. It is never
      // refused and never applied on the spot: it is queued for tomorrow (see
      // scheduleSettingChange). The coach-approved path goes through
      // handleChat's approve_setting_change, which calls applySettingChange()
      // directly and is the only way to have it today.
      if (senderTrust(sender) === 'content') {
        return { error: 'Not allowed from a web page' };
      }
      return requestSettingChange({
        changeType: message.changeType,
        domain: message.domain,
        newValue: message.newValue
      });
    }
    // Android, when a package is installed: see linkInstalledApp. Adding to the
    // blocklist is a tightening, but it is still a write to it, so it gets the
    // same refusal every other blocklist writer carries.
    case 'appInstalled': {
      if (senderTrust(sender) === 'content') return { error: 'Not allowed from a web page' };
      return linkInstalledApp(message.packageName, message.label);
    }
    case 'cancelPendingChange': {
      if (senderTrust(sender) === 'content') return { error: 'Not allowed from a web page' };
      return cancelPendingChange({ changeType: message.changeType, domain: message.domain });
    }
    // ---- Leaving ---------------------------------------------------------
    //
    // All three are refused outright for a content sender, and that is not
    // boilerplate: a hostile page that could call 'beginLeave' would spend the
    // stand-down and silence the interposition for fifteen minutes, and one
    // that could call 'completeRemoval' would uninstall a self-control tool
    // out from under its user without a word. Neither is reachable from a
    // page — these are only ever sent by our own options page.
    case 'getLeaveState': {
      if (senderTrust(sender) === 'content') return { error: 'Not allowed from a web page' };
      return getLeaveState();
    }
    case 'beginLeave': {
      if (senderTrust(sender) === 'content') return { error: 'Not allowed from a web page' };
      return beginLeave(message.reason);
    }
    case 'completeRemoval': {
      if (senderTrust(sender) === 'content') return { error: 'Not allowed from a web page' };
      return completeRemoval();
    }
    case 'getBlockInfo':
      return { intention: await getIntention(message.domain) };
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
    case 'reportMessage': {
      const text = String(message.text || '').trim();
      if (!text) return { ok: false, error: 'Nothing to report.' };
      return await reportCoachMessage(text, String(message.note || '').trim());
    }
    default:
      throw new Error('Unknown action: ' + message.action);
  }
}

// Which address a message from a page is actually about.
//
// `sender.url` is the address the browser says the content script is running
// at, and across origins it wins outright for the same reason `sender.tab`
// does: a page cannot forge it, and a page that could name its own origin
// could name an unblocked one.
//
// Within one origin it is the WRONG answer, and that is not a subtlety — it is
// the case this whole feature turns on. Chrome populates `sender.url` from the
// document the content script was injected into, and an SPA calling
// history.pushState does not re-inject anything: instagram.com/direct becomes
// instagram.com/reels with no request, no commit and no new content script, and
// `sender.url` still says /direct minutes later. Asking the worker "is this
// page blocked" would then be answered about a page the user left.
//
// So: same origin, the message's own address wins, because it is the content
// script reading window.location.href in the same document the browser vouched
// for. Different origin, or unparseable, or absent — the sender's.
function resolveSenderUrl(sender, messageUrl) {
  const senderUrl = (sender && typeof sender.url === 'string') ? sender.url : '';
  const claimed = typeof messageUrl === 'string' ? messageUrl : '';
  if (!senderUrl) return claimed;
  if (!claimed) return senderUrl;
  try {
    if (new URL(claimed).origin === new URL(senderUrl).origin) return claimed;
  } catch (e) {
    return senderUrl;
  }
  return senderUrl;
}

async function checkPageMatch(host, tabId, pageContext, url) {
  // Throttled no-op outside the Safari Web Extension runtime — see tracking.js.
  await syncConfigFromNative();
  const stored = await getStorage(['blockedDomains', 'setupComplete', 'activeSessions', 'domainLimits']);
  const { blockedDomains = [], setupComplete = false, activeSessions = {} } = stored;
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
  const pageUrl = url || (pageContext && typeof pageContext.url === 'string' ? pageContext.url : '');
  const session = readSession(activeSessions, tabId, matchedDomain, { url: pageUrl });
  await adoptPagePass(activeSessions, tabId, session);
  // Whether that pass covers the page actually being loaded. Always true for a
  // session with no scope, so this changes nothing for a site pass. The
  // content script asks parts.js the same question itself against
  // window.location.href — it has to, because it must reach the same verdict
  // with the worker dead — and this is here so the two answers cannot come
  // from two different pieces of logic.
  const covered = sessionCoversUrl(session, pageUrl);
  // Which PART of the site this is, against the rule the user set on it. The
  // same asymmetry as the session question above: the content script asks
  // parts.js itself, because it has to reach this verdict with the worker
  // dead, and this call is here so the two answers cannot come from two
  // different pieces of logic. An entry with no part rule answers gated:true,
  // which is what every target has always answered.
  const partEntry = matchedDomain ? limitEntryFor(matchedDomain, stored) : null;
  const verdict = await resolvePageVerdict(partEntry, pageUrl);
  // The rule itself, sanitised, for the page to keep. The content script arms
  // its URL watcher with it: an address that is allowed now can become one that
  // is not, through a pushState the worker may never hear about, and the page
  // needs the rule in hand to answer that on its own. It carries the allowlist
  // too when there is one (pageRuleFor), for the same reason.
  const partRule = hasPageRule(partEntry) ? pageRuleFor(partEntry) : null;
  // A pass that has since expired leaves the domain's redirect rule dropped
  // (see syncBlockingRules) — visiting it again is the moment to notice and
  // put the rule back. A live pass that does NOT cover this page is the same
  // situation from the rule set's point of view: this page has to gate, so the
  // rule has to be there. Not awaited: the content script is holding this
  // page's gate decision open, and the rule only matters from the next load on.
  if (matchedDomain && (!session || !covered)) syncBlockingRules();
  const access = await resolveAIRoute();
  const intention = matchedDomain ? await getIntention(matchedDomain) : null;
  return {
    // `matchedDomain` still says the host is on the blocklist; `isBlocked` now
    // says whether THIS address on it is gated. They come apart exactly when a
    // part rule leaves this page open, and the content script needs both: the
    // first to know there is a rule worth watching, the second to decide
    // whether to gate right now.
    isBlocked: !!matchedDomain && verdict.gated,
    matchedDomain,
    partId: verdict.partId,
    partRule,
    setupComplete: !!setupComplete,
    accessRoute: access.route,
    session,
    intention
  };
}

// The storage half of the target-rule lookups. The resolution itself lives in
// rules.js, which every context loads — this only knows which storage keys to
// read before handing the values over.
async function getLimitsForDomain(domain) {
  const stored = await getStorage(['domainLimits', 'appLimits']);
  return resolveIntention(limitEntryFor(domain, stored));
}

// ---------------------------------------------------------------------------
// AI access routing
// ---------------------------------------------------------------------------
//
// Three states, checked in this order:
//
//   byok    a custom provider key is configured (Settings -> Advanced). Calls
//           go straight from this device to that provider, and the hosted
//           coaching-credit balance doesn't apply. Never reachable on Apple
//           builds (IS_APPLE_BUILD in providers.js): App Store guideline 3.1.1
//           forbids unlocking paid functionality with anything bought outside
//           In-App Purchase, and a provider key is exactly that. The check is
//           here and not only in the settings UI so that a key left behind by
//           an older install, or restored from a backup, still can't bypass
//           the credit balance.
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

  if (!IS_APPLE_BUILD && provider && provider !== HOSTED_PROVIDER && apiKey) {
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

// Caps on what a report carries. Generous enough for a long coach reply,
// bounded so a report can't become a channel for shipping arbitrary bulk.
const REPORT_TEXT_CAP = 4000;
const REPORT_NOTE_CAP = 1000;

// Sends a coach message to Intention as an offensive-content report, along with
// the user turn that provoked it — a reply is rarely judgeable on its own.
//
// The reported line is located by matching its text against the stored
// transcripts rather than by an index the page could pass: turns carry no ids
// (see the { role, content } shape written in handleChat), and histories are
// truncated from the front as they grow, so any position sent from a page would
// already be capable of pointing at the wrong turn by the time it arrived.
//
// Nothing here trusts the caller beyond the text itself, which is why no sender
// check is needed: the worst a hostile content script achieves is a report
// containing words it made up, at whatever rate the server's IP limit allows.
async function reportCoachMessage(text, note) {
  const { chatHistories = {}, backendUrl } = await getStorage(['chatHistories', 'backendUrl']);

  let prompt = '';
  outer:
  for (const history of Object.values(chatHistories)) {
    if (!Array.isArray(history)) continue;
    for (let i = history.length - 1; i >= 0; i--) {
      const turn = history[i];
      if (!turn || turn.role !== 'assistant' || turn.content !== text) continue;
      const before = history[i - 1];
      if (before && before.role === 'user') prompt = String(before.content || '');
      break outer;
    }
  }

  const route = await resolveAIRoute();
  try {
    await postCoachReport({
      backendUrl,
      accessToken: route.accessToken || '',
      reported: text.slice(0, REPORT_TEXT_CAP),
      prompt: prompt.slice(0, REPORT_TEXT_CAP),
      note: note.slice(0, REPORT_NOTE_CAP),
      // Which route produced it is the whole point of collecting these: a bad
      // pattern on the hosted model is ours to fix, the same pattern on a
      // stranger's key is not.
      provider: route.route === 'byok' ? `byok:${route.provider}` : (route.provider || 'unknown'),
      model: route.model || ''
    });
    return { ok: true };
  } catch (e) {
    console.warn(INT_LOG, 'report failed', e);
    return {
      ok: false,
      error: isNetworkError(e)
        ? "Couldn't reach Intention. Check your connection and try again."
        : String(e.message || e)
    };
  }
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
  const clean = cleanEntitlement(entitlement);
  await setStorage({ entitlement: clean });
  return { ok: true, entitlement: clean };
}

// Merges a patch over whatever is stored at the moment of the write, instead of
// replacing the whole record with a snapshot the caller read some time ago.
//
// saveEntitlement above is a whole-object setStorage, which is right when the
// caller has just verified a purchase and holds the complete truth. It is wrong
// on the far side of an unbounded await: options-access.js's recovery reads the
// entitlement, spends a network round trip on /v1/entitlement/recover, and by
// the time the answer lands a purchase may have been verified and persisted by
// a second, concurrent refreshAccessUI (returning from the Play sheet fires
// 'intention-app-active', which is exactly when a top-up completes). Writing
// the old snapshot back took the receipt, the token and the balance with it —
// money taken, access locked, and nothing left to re-verify from.
//
// So this goes through mutateStorage, like applyHostedBalance and
// markEntitlementStale, and only the keys the caller names are written.
async function mergeEntitlement(patch) {
  if (!patch || typeof patch !== 'object') {
    const { entitlement } = await getStorage(['entitlement']);
    return { ok: false, entitlement: entitlement || null };
  }
  let merged = null;
  await mutateStorage('entitlement', (stored) => {
    const base = stored && typeof stored === 'object' ? stored : {};
    merged = cleanEntitlement({ ...base, ...patch });
    return merged;
  }, null);
  return { ok: true, entitlement: merged };
}

// The write whitelist both of the above share. Anything not named here is
// silently dropped on every save, which is the point — the page hands us
// whatever the backend replied with — but it also means a genuinely new field
// has to be added in exactly one place.
function cleanEntitlement(entitlement) {
  return {
    active: !!entitlement.active,
    productId: String(entitlement.productId || ''),
    expiresAt: entitlement.expiresAt ? Number(entitlement.expiresAt) : null,
    source: String(entitlement.source || ''),
    token: String(entitlement.token || ''),
    // How the session behind that token proved itself, as the server stamped
    // it. Like recoveryCheckedAt below it has to be on this list or it is
    // dropped on every save.
    src: String(entitlement.src || ''),
    receipt: entitlement.receipt || null,
    balanceMicros: Number(entitlement.balanceMicros || 0),
    balanceGbp: Number(entitlement.balanceGbp || 0),
    balanceCredits: Number(entitlement.balanceCredits || 0),
    pendingVerification: !!entitlement.pendingVerification,
    lastError: String(entitlement.lastError || ''),
    // When this device last asked the backend whether a balance was still
    // attached to its account id. It has to be on this whitelist or it is
    // silently dropped on every save — and the options page reads it as the
    // throttle marker that stops a fresh install re-asking an unauthenticated,
    // per-IP rate-limited endpoint on every settings open.
    recoveryCheckedAt: Number(entitlement.recoveryCheckedAt || 0),
    updatedAt: Date.now()
  };
}

async function getAccess(sender) {
  const { entitlement, provider, apiKey } = await getStorage(['entitlement', 'provider', 'apiKey']);
  const resolved = await resolveAIRoute();
  const balanceCredits = Number(entitlement?.balanceCredits || 0);
  return {
    route: resolved.route,
    // The stored entitlement carries `token` — a bearer credential that can
    // SPEND the balance, not merely read it. Extension pages need the whole
    // object (options-access.js reconciles against the receipt and the token);
    // a content script, which runs inside an arbitrary web page, needs only
    // the route and the two numbers below. Same rule getConfig applies to
    // apiKey, and for the same reason.
    //
    // This became load-bearing when the gate started painting a credit line:
    // gate-ui.js asks for this on every blocked page, so without the strip the
    // token would ride into every content script the extension has.
    entitlement: senderTrust(sender) === 'content' ? null : (entitlement || null),
    hasCustomKey: !!(apiKey && provider && provider !== HOSTED_PROVIDER),
    customProvider: provider && provider !== HOSTED_PROVIDER ? provider : '',
    // Lifted out of the entitlement so the settings chip and the gate note can
    // read one number without either of them having to know the entitlement's
    // shape — and so the content script, which loads no billing code at all,
    // never receives the balance as anything but this.
    balanceCredits,
    // Two exclusions, and both are the point. A custom key has no balance, so
    // "running low" is meaningless and a warning would be a lie. And a balance
    // of exactly zero is not LOW, it is LOCKED — a different state with a
    // different screen behind it, which is why the paywall and not a warning
    // note is what a zero produces.
    lowCredit: resolved.route === 'hosted' && balanceCredits > 0 && balanceCredits <= LOW_CREDIT_CREDITS
  };
}

// A target's intention together with how much of it today has used — the
// one object the gate paints from. Any loosening that has come due is applied
// first, so the first visit of a new day sees the rule the user asked for
// yesterday rather than the one it replaced.
async function getIntention(domain) {
  await applyDuePendingChanges();
  const stored = await getStorage(['domainLimits', 'appLimits', 'activeSessions']);
  const resolved = resolveIntention(limitEntryFor(domain, stored));
  const stats = domain ? await getStatsForDomain(domain) : { grantsToday: 0 };
  if (resolved.mode === 'dailyTime') {
    // A live pass has not yet been banked into dailyStats. Reserve its whole
    // duration while it is live, so parallel tabs cannot each take the same
    // remaining minutes. Closing one early banks only what was used and
    // releases the rest for a later visit.
    const now = Date.now();
    let liveElapsed = 0, liveReserved = 0;
    for (const session of Object.values(stored.activeSessions || {})) {
      if (!session || session.domain !== domain || isBanked(session) ||
          (session.wallExpiresAt && now >= Number(session.wallExpiresAt))) continue;
      const elapsed = sessionElapsedMs(session, now) / 60000;
      const duration = Math.max(0, Number(session.intervalMinutes) || 0);
      liveElapsed += Math.min(elapsed, duration);
      liveReserved += duration;
    }
    const display = await getDisplayStats();
    const banked = Math.max(0, Number(display.dailyStats?.[dateKey()]?.[domain]?.minutes) || 0);
    return {
      ...resolved,
      minutesUsed: Math.min(resolved.dailyMinutes, Math.ceil(banked + liveElapsed)),
      minutesLeft: Math.max(0, Math.floor(resolved.dailyMinutes - banked - liveReserved)),
      visitMinutesMax: Math.max(0, Math.min(
        Math.floor(resolved.dailyMinutes - banked - liveReserved),
        Math.floor((nextDayStart(now) - now) / 60000)
      ))
    };
  }
  const { opens, minutesEach } = resolved;
  const opensUsed = Math.min(opens, Math.max(0, stats.grantsToday - (stats.negotiatedToday || 0)));
  return { opens, minutesEach, opensUsed, opensLeft: Math.max(0, opens - opensUsed) };
}

// The two setup answers, keyed by service (see serviceKeyFor in sites.js).
// They go straight into a system prompt, so they are trimmed, capped, and
// dropped entirely when blank — "never answered" and "answered blank" mean the
// same thing to the coach, and collapsing them saves a falsy check everywhere
// downstream.
const SERVICE_REASON_CAP = 500;

function sanitizeServiceReasons(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [key, value] of Object.entries(raw)) {
    if (!key || !value || typeof value !== 'object') continue;
    const purpose = String(value.purpose || '').trim().slice(0, SERVICE_REASON_CAP);
    const legitimateUse = String(value.legitimateUse || '').trim().slice(0, SERVICE_REASON_CAP);
    if (!purpose && !legitimateUse) continue;
    const entry = {};
    if (purpose) entry.purpose = purpose;
    if (legitimateUse) entry.legitimateUse = legitimateUse;
    entry.updatedAt = Number(value.updatedAt) || Date.now();
    out[key] = entry;
  }
  return out;
}

async function getFullConfig() {
  await applyDuePendingChanges();
  const keys = ['provider', 'apiKey', 'model', 'userContext', 'contextProjects', 'contextReasons', 'coachInstructions', 'blockedDomains', 'domainLimits', 'blockedApps', 'appLimits', 'appLabels', 'serviceReasons', 'setupComplete', 'entitlement', 'backendUrl', 'leaveDelayMinutes', 'setupCompletedAt', 'pendingChanges'];
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
    serviceReasons: stored.serviceReasons || {},
    pendingChanges: Array.isArray(stored.pendingChanges) ? stored.pendingChanges : [],
    // Normalised on the way out, not just on the way in: this is the number
    // the settings card paints its selected choice from, and a stored value
    // that is not on the ladder must show as the rung below it rather than as
    // nothing selected. normalizeLeaveDelay only ever snaps down.
    leaveDelayMinutes: normalizeLeaveDelay(stored.leaveDelayMinutes),
    setupCompletedAt: Number(stored.setupCompletedAt) || 0,
    providers: PROVIDERS
  };
}

// Every part rule on its way into storage, cleaned by parts.js.
//
// The options page is the only thing that writes one today, but "the only
// caller is careful" is how a validated field stops being validated. This is
// the choke point instead: both entry points that write a limits map run
// through it, so sanitizePartRule's caps (20 parts, 96 chars, no unparseable
// ids) hold however the map arrived — including from an older build's draft,
// or a settings page a future package writes.
//
// An entry that carries neither key comes back BYTE-IDENTICAL. That is the
// whole backward-compatibility story for this feature: absence is the third
// state, so an untouched entry is not rewritten, and there is no migration.
function sanitizeLimitsPartRules(limits) {
  if (!limits || typeof limits !== 'object') return limits;
  const out = {};
  for (const [target, entry] of Object.entries(limits)) {
    if (!entry || typeof entry !== 'object') { out[target] = entry; continue; }
    const withAccounts = sanitizeLimitsRedditAllow(sanitizeLimitsAllowedAccounts(entry));
    if (!('scope' in withAccounts) && !('parts' in withAccounts)) { out[target] = withAccounts; continue; }
    const clean = sanitizePartRule(withAccounts);
    const next = { ...withAccounts };
    // A rule that decides nothing is stored as no rule at all, both keys gone,
    // so the entry reads exactly as it did before the feature existed.
    if (hasPartRule(clean)) {
      next.scope = clean.scope;
      next.parts = clean.parts;
    } else {
      delete next.scope;
      delete next.parts;
    }
    out[target] = next;
  }
  return out;
}

// The allowlist half of the same cleaning, for one entry: through
// sanitizeAllowedAccounts, with an empty list stored as no key at all, for the
// same byte-identical reason as the part rule. An entry without the key comes
// back as the very same object.
function sanitizeLimitsAllowedAccounts(entry) {
  if (!('allowedAccounts' in entry)) return entry;
  const clean = sanitizeAllowedAccounts(entry.allowedAccounts);
  const next = { ...entry };
  if (clean.length) next.allowedAccounts = clean;
  else delete next.allowedAccounts;
  return next;
}

function sanitizeLimitsRedditAllow(entry) {
  if (!('allowedSubreddits' in entry) && !('allowedRedditPosts' in entry)) return entry;
  const next = { ...entry };
  const subs = sanitizeAllowedSubreddits(entry.allowedSubreddits);
  const posts = sanitizeAllowedRedditPosts(entry.allowedRedditPosts);
  if (subs.length) next.allowedSubreddits = subs;
  else delete next.allowedSubreddits;
  if (posts.length) next.allowedRedditPosts = posts;
  else delete next.allowedRedditPosts;
  return next;
}

// The DIRECTION half of the same choke point.
//
// A part rule is the one field on a row whose direction is not implied by the
// gesture that changes it: adding an id to an 'only' list blocks MORE, adding
// the same id to an 'except' list blocks LESS, and removing one flips both.
// options-rows.js asks parts.js (partEditIsLoosening) before it decides
// whether to save straight away or send the user to the coach — and until this
// existed, that test ran entirely in the caller. saveSettings then wrote
// whatever map it was handed. One runtime message, typed into the extension's
// own devtools console by the person the product exists to protect —
// saveSettings with { domainLimits: { 'instagram.com': { scope: 'only',
// parts: ['instagram:dms'] } } } — opened all of Instagram but the DMs with no
// conversation at all. The coach gate on widening a rule was a UI convention,
// not a rule.
//
// Same argument and same remedy as the leaveDelayMinutes clamp in saveSettings
// below, which says it outright: the choke point belongs at the receiving end,
// because "the only caller is careful" is how a guarded field stops being
// guarded. It applied verbatim here and was not applied.
//
// What this does NOT do is refuse the whole write. Only the part rule is held
// back; every other field on the entry (the daily max, the loose window, the
// mode) lands as it was sent. One save carries the entire limits map, so
// rejecting it outright would throw away unrelated tightenings made in the
// same breath. The rule already in storage stays exactly as it was, which is
// the direction to fail in: the block holds, and the row repaints from storage
// on the rerender that follows every save.
//
// The coach-approved path never passes through here. applySettingChange writes
// the approved rule to storage itself, which is what makes approval mean
// something this cannot undo.
function holdPartRuleDirection(next, stored) {
  if (!next || typeof next !== 'object') return next;
  const before = (stored && typeof stored === 'object') ? stored : {};
  const out = {};
  for (const [target, entry] of Object.entries(next)) {
    if (!entry || typeof entry !== 'object') { out[target] = entry; continue; }
    const prior = before[target];
    if (!partEditIsLoosening(prior, entry)) { out[target] = entry; continue; }
    // Put back what was stored — which for a target that had no rule at all
    // means deleting both keys, so the entry stays byte-identical to what
    // shipped before this feature, exactly as sanitizeLimitsPartRules does.
    const kept = sanitizePartRule(prior);
    const held = { ...entry };
    if (hasPartRule(kept)) {
      held.scope = kept.scope;
      held.parts = kept.parts;
    } else {
      delete held.scope;
      delete held.parts;
    }
    out[target] = held;
  }
  return out;
}

// The two steps every write of a limits map runs, in the order they have to
// run in: clean the rule, then refuse to let it loosen. Sanitising first is
// not cosmetic — the direction test has to be asked about the rule that will
// actually be stored, not the one that was sent, or a widening hidden behind
// twenty junk ids would be compared as something else entirely.
async function limitsForWrite(key, limits) {
  const cleaned = sanitizeLimitsPartRules(limits);
  const stored = (await getStorage([key]))[key];
  return holdRedditAllowDirection(holdAllowedAccountsDirection(
    holdIntentionDirection(holdPartRuleDirection(cleaned, stored), stored), stored), stored);
}

// The allowlist's direction guard. Taking an account off the list is a
// tightening and lands; putting one on opens that account's pages, and may
// only arrive through requestSettingChange (tomorrow) or the coach
// (applySettingChange's 'allow_accounts'). A whole-map write that adds one
// has the addition dropped and keeps everything else it said, removals
// included — the same shape as holdPartRuleDirection.
function holdAllowedAccountsDirection(next, stored) {
  if (!next || typeof next !== 'object') return next;
  const before = (stored && typeof stored === 'object') ? stored : {};
  const out = {};
  for (const [target, entry] of Object.entries(next)) {
    if (!entry || typeof entry !== 'object') { out[target] = entry; continue; }
    const prior = before[target] && typeof before[target] === 'object' ? before[target] : {};
    const was = sanitizeAllowedAccounts(prior.allowedAccounts);
    const want = sanitizeAllowedAccounts(entry.allowedAccounts);
    if (!allowedAccountsEditIsLoosening(was, want)) { out[target] = entry; continue; }
    const kept = want.filter(handle => was.includes(handle));
    const held = { ...entry };
    if (kept.length) held.allowedAccounts = kept;
    else delete held.allowedAccounts;
    out[target] = held;
  }
  return out;
}

// A direct limits-map save may remove Reddit allowances, but additions must
// come through the delayed settings change or the coach-approved path.
function holdRedditAllowDirection(next, stored) {
  if (!next || typeof next !== 'object') return next;
  const before = stored && typeof stored === 'object' ? stored : {};
  const out = {};
  for (const [target, entry] of Object.entries(next)) {
    if (!entry || typeof entry !== 'object') { out[target] = entry; continue; }
    const prior = before[target] && typeof before[target] === 'object' ? before[target] : {};
    const wasSubs = sanitizeAllowedSubreddits(prior.allowedSubreddits);
    const wasPosts = sanitizeAllowedRedditPosts(prior.allowedRedditPosts);
    const wantSubs = sanitizeAllowedSubreddits(entry.allowedSubreddits);
    const wantPosts = sanitizeAllowedRedditPosts(entry.allowedRedditPosts);
    if (!redditAllowEditIsLoosening(
      { subreddits: wasSubs, posts: wasPosts }, { subreddits: wantSubs, posts: wantPosts })) {
      out[target] = entry;
      continue;
    }
    const held = { ...entry };
    const subs = wantSubs.filter(x => wasSubs.includes(x));
    const posts = wantPosts.filter(x => wasPosts.includes(x));
    if (subs.length) held.allowedSubreddits = subs;
    else delete held.allowedSubreddits;
    if (posts.length) held.allowedRedditPosts = posts;
    else delete held.allowedRedditPosts;
    out[target] = held;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Allowed accounts: the one page verdict that needs the network
// ---------------------------------------------------------------------------
//
// parts.js decides everything an address can prove on its own. A YouTube
// video's address names no channel, so for an entry that always allows some
// channels, "whose video is this?" is asked of YouTube's public oEmbed
// endpoint — the request page_context.js already makes for the title, to the
// site the user is already loading, without cookies.
//
// It fails closed at every step: no answer inside the timeout, a non-200, a
// body of the wrong shape, an author with no @handle — each leaves the page
// gated, exactly as it would be with no allowlist at all. Answers live in
// memory for the life of the worker, keyed by the video id parts.js mints, and
// are never written to storage; a failure is remembered only briefly, so the
// next visit asks again.
//
// The timeout sits inside the content script's per-attempt budget
// (CHECK_ATTEMPT_TIMEOUT_MS, 1.2s), and a retry that lands while the request is
// still out waits on the same request rather than starting another.
const ACCOUNT_LOOKUP_TIMEOUT_MS = 1000;
const ACCOUNT_LOOKUP_TTL_MS = 6 * 60 * 60 * 1000;
const ACCOUNT_LOOKUP_FAILURE_TTL_MS = 60 * 1000;
const ACCOUNT_LOOKUP_CACHE_MAX = 200;
const accountLookupCache = new Map();
const accountLookupInFlight = new Map();

async function fetchLookupAccount(lookup) {
  if (typeof fetch !== 'function') return null;
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), ACCOUNT_LOOKUP_TIMEOUT_MS) : null;
  try {
    const init = { credentials: 'omit' };
    if (controller) init.signal = controller.signal;
    const res = await fetch(lookup.fetchUrl, init);
    if (!res || !res.ok) return null;
    return accountFromLookupResponse(await res.json());
  } catch (e) {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function lookupVerifiedAccount(lookup) {
  const cached = accountLookupCache.get(lookup.key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.account ? { key: lookup.key, account: cached.account } : null;
  }
  let pending = accountLookupInFlight.get(lookup.key);
  if (!pending) {
    pending = fetchLookupAccount(lookup).then((account) => {
      if (accountLookupCache.size >= ACCOUNT_LOOKUP_CACHE_MAX) {
        accountLookupCache.delete(accountLookupCache.keys().next().value);
      }
      accountLookupCache.set(lookup.key, {
        account,
        expiresAt: Date.now() + (account ? ACCOUNT_LOOKUP_TTL_MS : ACCOUNT_LOOKUP_FAILURE_TTL_MS)
      });
      return account;
    }).finally(() => accountLookupInFlight.delete(lookup.key));
    accountLookupInFlight.set(lookup.key, pending);
  }
  const account = await pending;
  return account ? { key: lookup.key, account } : null;
}

// resolvePartVerdict, plus the lookup when it is the only thing standing
// between an allowed account and its video. Everything an address can prove
// is still parts.js's answer; this only supplies the one fact it cannot hold.
async function resolvePageVerdict(entry, url) {
  const verdict = resolvePartVerdict(entry, url);
  if (!verdict.gated) return verdict;
  const lookup = accountLookupFor(entry, url);
  if (!lookup) return verdict;
  try {
    const verified = await lookupVerifiedAccount(lookup);
    return verified ? resolvePartVerdict(entry, url, verified) : verdict;
  } catch (e) {
    return verdict;
  }
}

// The intention half of the same guard. A whole-map write may lower opens or
// shorten minutes as it likes — that is tightening, and it applies at once —
// but it may not raise either: raising goes through requestSettingChange,
// which queues it for tomorrow, or through the coach. Here a raise is simply
// held at the stored value, field by field, so a write that tightens one
// number and loosens the other keeps the tightening.
//
// Targets with no stored entry are left alone. Adding something to block is
// never a loosening, whatever intention it arrives with.
function holdIntentionDirection(next, stored) {
  if (!next || typeof next !== 'object') return next;
  const before = (stored && typeof stored === 'object') ? stored : {};
  const out = {};
  for (const [target, entry] of Object.entries(next)) {
    const prior = before[target];
    if (!entry || typeof entry !== 'object' || !prior || !isLoosening(prior, entry)) {
      out[target] = entry;
      continue;
    }
    const was = resolveIntention(prior);
    const want = resolveIntention(entry);
    if (was.mode === 'dailyTime' || want.mode === 'dailyTime') {
      out[target] = { ...entry,
        intentionMode: prior.intentionMode || 'opens',
        dailyTimeMinutes: prior.dailyTimeMinutes,
        maxGrants: prior.maxGrants,
        passMinutes: prior.passMinutes };
      continue;
    }
    out[target] = {
      ...entry,
      maxGrants: Math.min(was.opens, want.opens),
      passMinutes: Math.min(was.minutesEach, want.minutesEach)
    };
  }
  return out;
}

// AN OMITTED KEY MEANS "LEAVE IT ALONE"; a key that is present, even as '',
// means "write this".
//
// The distinction is the wizard's only defence for the fields it deliberately
// does not send. options-wizard.js omits userContext, contextProjects and
// contextReasons — setup no longer asks the two general questions — with a
// comment saying that sending '' there would wipe context an existing user had
// built up with the coach. That comment described an intention this function
// did not honour: every field below was written unconditionally, so `|| ''`
// turned "not mentioned" into "cleared" and the omission bought nothing. The
// same shape covered every other field: an omitted blockedDomains cleared the
// blocklist, an omitted appLabels dropped every app's human name.
//
// Reachability, honestly: nothing in the shipped UI can reach it today.
// showSetupView() runs only while `setupComplete` is falsy (options.js), and
// no code path anywhere writes that key back to false or clears storage — the
// Apple bridge only ever merges keys the native store actually HAS
// (AppGroupStorage.get skips absent ones), so it cannot clear it either. The
// fix is here anyway, and not out of caution about a hypothetical: a defence
// the wizard believes it has and does not is worse than no defence, because
// the next field somebody decides to "just leave out" will be trusted to the
// same rule. Making the code do what the comment already claims is cheaper
// than keeping the two apart.
async function saveSetup(config) {
  const {
    provider, apiKey, model, userContext, contextProjects, contextReasons,
    blockedDomains, domainLimits, blockedApps, appLimits, appLabels,
    serviceReasons
  } = config || {};
  // The second whole-key writer of both limits maps, and it gets the same
  // treatment as saveSettings for the same reason: nothing about "this message
  // came from the wizard" is verifiable at this end. On a first run the stored
  // maps are empty and every rule is compared against "all of it blocked",
  // which is what the wizard writes anyway — it has never offered a part rule.
  // On a re-run it is the guard that stops finishing setup a second time from
  // being the way to widen a rule the coach refused an hour ago.
  const cleanDomainLimits = await limitsForWrite('domainLimits', domainLimits || {});
  const cleanAppLimits = await limitsForWrite('appLimits', appLimits || {});

  const write = {};
  // `key in config` rather than a truthiness test: '' and [] are real answers
  // the wizard is entitled to give, and only absence means "not mine to say".
  const given = (key) => !!config && Object.prototype.hasOwnProperty.call(config, key);
  const put = (key, value) => { if (given(key)) write[key] = value; };

  put('provider', provider || '');
  put('apiKey', apiKey || '');
  put('model', model || (provider ? PROVIDERS[provider]?.defaultModel : '') || '');
  put('userContext', userContext || '');
  put('contextProjects', contextProjects || '');
  put('contextReasons', contextReasons || '');
  put('blockedDomains', blockedDomains || []);
  put('blockedApps', blockedApps || []);
  put('appLabels', appLabels || {});
  put('serviceReasons', sanitizeServiceReasons(serviceReasons));
  // The two limits maps take the same rule as everything else, and they have to
  // — an omitted domainLimits cleaned to `{}` and written would strip every
  // blocked site's grant and minute caps while leaving the sites themselves
  // blocked, which is the loosening this whole path exists to refuse. The
  // direction guard above still runs on whatever WAS sent, regardless.
  put('domainLimits', cleanDomainLimits);
  put('appLimits', cleanAppLimits);
  // The one thing finishing setup always asserts.
  write.setupComplete = true;

  // When they started. The leaving conversation is the only thing that reads
  // it, and it reads it to say "you set this up 40 days ago" rather than to
  // count anything — a fact about their own install, kept on their own device,
  // never sent anywhere. Existing installs have no such key and fall back to
  // the earliest day in dailyStats (see handleChat), which is the same answer
  // arrived at from data that was already there.
  //
  // Written ONCE, which is the difference between "when they started" and
  // "when they last pressed Finish". Overwriting it would tell the coach a
  // forty-day install was a fresh one, on the one screen where how long they
  // have been at this is the argument.
  const { setupCompletedAt = 0 } = await getStorage(['setupCompletedAt']);
  if (!(Number(setupCompletedAt) > 0)) write.setupCompletedAt = Date.now();

  await setStorage(write);
  await syncBlockingRules();
  return { ok: true };
}

async function saveSettings(partial) {
  // The one key that must never be written through raw: it is user free text
  // that ends up in a system prompt.
  if (partial && partial.serviceReasons) {
    partial = { ...partial, serviceReasons: sanitizeServiceReasons(partial.serviceReasons) };
  }
  // The two keys that carry part rules: cleaned, and then held to the
  // direction they are allowed to move in (limitsForWrite). See
  // sanitizeLimitsPartRules — an entry without a rule is returned untouched,
  // so this cannot rewrite settings that predate the feature — and
  // holdPartRuleDirection for why the direction test cannot live in the page
  // that calls this.
  if (partial && partial.domainLimits) {
    partial = { ...partial, domainLimits: await limitsForWrite('domainLimits', partial.domainLimits) };
  }
  if (partial && partial.appLimits) {
    partial = { ...partial, appLimits: await limitsForWrite('appLimits', partial.appLimits) };
  }
  if (partial && (partial.domainLimits || partial.appLimits)) {
    await dropSupersededRaises(partial);
  }
  // The cool-off on leaving is the one setting that may only move one way
  // through here. Raising it is a tightening and free, like lowering a daily
  // max; SHORTENING it is a loosening and costs a conversation
  // (applySettingChange's 'decrease_leave_delay' branch, which is the only
  // thing that ever writes a smaller value).
  //
  // The choke point is here rather than in the options page because "the only
  // caller is careful" is how a guarded field stops being guarded. Every
  // extension page can reach saveSettings; without this, the gate is a UI
  // convention rather than a rule.
  if (partial && 'leaveDelayMinutes' in partial) {
    const { leaveDelayMinutes: currentDelay } = await getStorage(['leaveDelayMinutes']);
    const current = normalizeLeaveDelay(currentDelay);
    const next = normalizeLeaveDelay(partial.leaveDelayMinutes);
    partial = { ...partial, leaveDelayMinutes: Math.max(current, next) };
  }
  await setStorage(partial);
  // domainLimits joins blockedDomains here because WHICH domains get a redirect
  // rule now depends on it: a host that has just been given a part rule has to
  // drop out of domainsNeedingRedirect(), and one whose rule was just removed
  // has to come back. Without this a section rule set in Settings would not
  // take effect until something else happened to re-sync — a grant, a tab
  // closing, the next visit — which is a rule that looks saved and is not.
  if (partial.blockedDomains || partial.domainLimits) {
    await syncBlockingRules();
  }
  return { ok: true };
}

// A newly installed app that is the same service as a blocked site — the
// Instagram app arriving on a phone where instagram.com is already blocked.
// Without this the app is a way round the block that did not exist on the day
// they set it up, so it joins the blocklist carrying a copy of the site's
// entry: same opens a day, same minutes, same part rule (part ids are
// per-service, so "instagram:reels" means the same thing to AppParts.kt).
//
// Copied, not shared: getLimitsForDomain() relies on appLimits and
// domainLimits being disjoint, and after today the two rows are edited
// separately like any other pair.
//
// Only ever called for an install, never swept over the installed list. An
// app already on the phone at setup was offered in the wizard and left out on
// purpose, and one removed from the list later was removed on purpose;
// re-adding either would be overruling a decision rather than closing a gap.
//
// Only a site blocked whole-host counts: a blocked "old.reddit.com" says
// nothing about the Reddit app, a blocked "reddit.com" does.
async function linkInstalledApp(packageName, label) {
  const pkg = String(packageName || '');
  const site = APP_ICON_SITE[pkg];
  if (!site) return { linked: null };
  const { blockedDomains = [], domainLimits = {}, blockedApps = [], appLimits = {}, appLabels = {} } =
    await getStorage(['blockedDomains', 'domainLimits', 'blockedApps', 'appLimits', 'appLabels']);
  if (blockedApps.includes(pkg)) return { linked: null };
  const domain = blockedDomains.find(d => hostMatchesDomain(site, d));
  if (!domain) return { linked: null };

  const write = {
    blockedApps: [...blockedApps, pkg],
    appLimits: { ...appLimits, [pkg]: { ...(domainLimits[domain] || INTENTION_DEFAULTS) } }
  };
  const name = String(label || '').trim();
  if (name) write.appLabels = { ...appLabels, [pkg]: name };
  await setStorage(write);
  return { linked: domain };
}

// Keeps a "credit remaining" indicator live after every message, rather than
// only updating the next time the settings page reconciles. Called after each
// successful hosted LLM call — a coaching turn can now involve two.
//
// Returns the balance it just wrote, so the caller can hand it straight back
// to the gate. Without that the gate would have to ask getAccess after every
// single turn to find out what it already caused, which is a second round trip
// per message for a number the response was carrying all along. `null` on any
// route with no balance behind it, which the caller must not flatten to 0.
async function applyHostedBalance(access, llmResponse) {
  if (access.route !== 'hosted') return null;
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
  return Number(llmResponse.balanceCredits || 0);
}

// Settings-gate change types whose `domain` is an app target (an Android
// package name) rather than a hostname. Listed once because three places have
// to agree about it: page context is meaningless for an app, the display name
// has to come from appLabels, and the app context block replaces the page one.
// The reason-box edits are deliberately absent — they exist on site rows and
// app rows alike, so the options page tells us which with `isApp` instead.
const APP_CHANGE_TYPES = ['remove_app', 'increase_app_limit', 'narrow_app_block_scope'];

// Settings-gate change types with no target at all: they are about the whole
// install rather than one site or app. `domain` is null for every one of them,
// which decides three things — which blocking mode gates them (the global one,
// since there is no per-item override to read), that the prompt must not
// render a per-domain usage line, and that nothing may look them up in
// appLabels.
const GLOBAL_CHANGE_TYPES = ['disable_all', 'uninstall', 'decrease_leave_delay'];

// The two change types whose value is a part rule ({ scope, parts }) rather
// than a number or a string. They need naming once because the settings gate
// has to hand the coach a SENTENCE — "all of instagram.com" becoming "only
// Reels and Explore on instagram.com" — where every other change type can pass
// its raw value straight through. An object reaching composeSystemPrompt's
// {{current_value}} token renders as "[object Object]", which is the coach
// quoting a JavaScript artefact at the user at the exact moment it is asking
// them to justify a change.
const SCOPE_CHANGE_TYPES = ['narrow_block_scope', 'narrow_app_block_scope'];

// What the coach is told about the part rule in force here, as PRE-RENDERED
// strings. Computed in background.js and never in prompts.js, for the reason
// stated over the pageScope resolution below: tests/load.js composes the
// prompt bundle as [rules.js, prompts.js], so prompts.js calling parts.js
// breaks every prompt test — and on Android it would be a ReferenceError in
// the background WebView.
//
// Returns null when there is no rule to describe, which is every target that
// existed before this feature and most targets after it.
//
//   scope       the stored rule, degraded to 'all' by resolvePartVerdict
//               whenever this build could not evaluate what was stored.
//   hereLabel   the part this URL landed in, when it landed in one. Under an
//               'only' rule at the gate this is always set and is the whole
//               point: "you're on Reels, which you told me to keep closed".
//               Under an 'except' rule at the gate it is null by construction
//               — being outside every exception is why the gate is open.
//   listLabels  the parts the rule names, in the words Settings shows.
function describePartContext(entry, url) {
  try {
    const verdict = resolvePartVerdict(entry, url);
    if (!hasPartRule(entry) || verdict.scope === 'all') return null;
    const clean = sanitizePartRule(entry);
    return {
      scope: verdict.scope,
      hereLabel: verdict.partId ? partLabel(verdict.partId) : null,
      listLabels: clean.parts.map(partLabel).filter(Boolean)
    };
  } catch (e) {
    return null;
  }
}

async function handleChat({ tabId, mode, domain, isApp, appLabel, userMessage, changeType, currentValue, newValue, pageContext, androidForegroundTime }) {
  const { userContext, contextProjects, contextReasons, coachInstructions, coachObservations = [], serviceReasons = {} } = await getStorage(['userContext', 'contextProjects', 'contextReasons', 'coachInstructions', 'coachObservations', 'serviceReasons']);
  // What the user said this particular service is for, written during setup
  // when they were nowhere near it. One lookup covers both gates: `domain` is
  // a hostname on the web and a package name in an app, and serviceKeyFor
  // folds the second onto the first so instagram.com and the Instagram app
  // share one answer.
  const siteReason = serviceReasons[serviceKeyFor(domain)] || null;
  const access = await resolveAIRoute();
  if (access.route === 'locked') {
    return { error: 'You need coaching credit to talk to your coach.', locked: true };
  }

  // Resolve and enrich page context (video title, duration, Reddit thread, etc.)
  const isAppTarget = isApp || APP_CHANGE_TYPES.includes(changeType);
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

  // Whether this destination is one page or an endless middle, resolved once
  // for both prompt builders and again inside the grant_access branch (which
  // must resolve it at grant time, after any enrichment, rather than trust a
  // value computed a turn earlier). null means "no scoped pass here", which is
  // the ordinary answer for a feed, for every app target, and for most of the
  // web. pageScopeFor lives in parts.js — never in prompts.js, which does not
  // load it and must not start.
  const pageScope = (!isAppTarget && pageCtx && typeof pageCtx.url === 'string')
    ? pageScopeFor(pageCtx.url, pageCtx)
    : null;

  // Which part of the site they are on, and what they told Intention to do
  // about it. Web targets only, and deliberately so: on Android the part would
  // have to come from reading the app's own screen, which this build does not
  // do (see the plan's cut line), and on iOS the Screen Time shield hides a
  // whole app behind an opaque token so there is no part to name at all. An
  // app target is therefore told nothing rather than told a guess.
  const partContext = (!isAppTarget && pageCtx && typeof pageCtx.url === 'string')
    ? describePartContext(limitEntryFor(domain, await getStorage(['domainLimits'])), pageCtx.url)
    : null;

  // For apps, `domain` is the storage/stats key (an Android package name, or
  // the pseudo-target "apps" for the iOS Screen Time pass); prompts get a
  // human-readable display name instead.
  let displayName = domain;
  // Apps get their own context block in place of the page one — there is no
  // page to describe, and saying nothing let the coach invent a screen it
  // cannot see. See renderAppContextBlock.
  let appCtx = null;
  if (isApp || APP_CHANGE_TYPES.includes(changeType)) {
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
      siteReason,
      coachInstructions,
      grantsToday: stats.grantsToday,
      grantsCap: limits.opens,
      minutesEach: limits.minutesEach,
      dailyTimeMinutes: limits.mode === 'dailyTime' ? limits.dailyMinutes : null,
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
      pageScope,
      partContext
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
      siteReason,
      coachInstructions,
      originalReason: session.reason,
      // What the pass that just ran out was pinned to, if anything. Read off
      // the ended session rather than recomputed, because by check-in time the
      // tab may be somewhere else entirely.
      endedScope: session.scope || null,
      grantsToday: stats.grantsToday,
      grantsCap: limits.opens,
      minutesEach: limits.minutesEach,
      dailyTimeMinutes: limits.mode === 'dailyTime' ? limits.dailyMinutes : null,
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
      pageScope,
      partContext
    });
    tools = [GRANT_TOOL, NOTE_OBSERVATION_TOOL];
  } else if (mode === 'settings_gate') {
    const stats = await getStatsForDomain(domain);
    // A part rule is the one change value that is an object. Rendered to the
    // same sentence Settings shows ("all of instagram.com" -> "only Reels on
    // instagram.com") HERE, so prompts.js never has to know what a part is and
    // never has to reach into parts.js to find out. `newValue` itself is left
    // alone: applySettingChange below writes the real rule from the real
    // object, and must not be handed prose.
    const isScopeChange = SCOPE_CHANGE_TYPES.includes(changeType);
    const isIntentionChange = changeType === 'increase_limit' || changeType === 'increase_app_limit';
    // An allowlist's values are lists of handles, and the new one carries only
    // the additions — so the coach reads the list as it would stand after.
    const isAccountChange = changeType === 'allow_accounts';
    const isRedditChange = changeType === 'allow_reddit';
    // The leaving conversation is about the install, not about a target, so it
    // is the one settings gate that needs the aggregate picture: how long they
    // have been at this and how much is on their list. Read only for the two
    // change types that use it — every other gate would be paying for a
    // storage read it never renders.
    const isLeaveChange = changeType === 'uninstall' || changeType === 'decrease_leave_delay';
    let leaveFacts = {};
    if (isLeaveChange) {
      // getDisplayStats rather than raw dailyStats: inside the apps, the days
      // someone spent in Safari count as days they have been at this too.
      const leaveStored = await getDisplayStats(['blockedDomains', 'blockedApps', 'leaveDelayMinutes']);
      // When they started. `setupCompletedAt` is written by saveSetup, so
      // anyone who set Intention up before that key existed has none — and
      // the earliest day they have usage for is the same answer reached from
      // data that was already on the device. Zero either way is "today",
      // which renderRemovalBlock says in words rather than as "0 days ago".
      const dayKeys = Object.keys(leaveStored.dailyStats || {}).sort();
      let startedAt = Number(leaveStored.setupCompletedAt) || 0;
      if (!startedAt && dayKeys.length) startedAt = Date.parse(`${dayKeys[0]}T00:00:00`) || 0;
      leaveFacts = {
        leaveDelayMinutes: normalizeLeaveDelay(leaveStored.leaveDelayMinutes),
        blockedSites: (leaveStored.blockedDomains || []).length,
        blockedApps: (leaveStored.blockedApps || []).length,
        daysActive: startedAt ? Math.max(0, Math.floor((Date.now() - startedAt) / 86400000)) : 0
      };
    }
    systemPrompt = buildSettingsGateSystemPrompt({
      domain: displayName,
      changeType,
      currentValue: isScopeChange ? describeScopeForHuman(currentValue, displayName)
        : isIntentionChange ? describeIntentionForHuman(currentValue)
          : isAccountChange ? describeAllowedAccountsForHuman(currentValue, displayName)
            : isRedditChange ? describeRedditAllowForHuman(currentValue) : currentValue,
      newValue: isScopeChange ? describeScopeForHuman(newValue, displayName)
        : isIntentionChange ? describeIntentionForHuman(newValue)
          : isAccountChange ? describeAllowedAccountsForHuman(
            sanitizeAllowedAccounts(currentValue).concat(sanitizeAllowedAccounts(newValue)), displayName)
            : isRedditChange ? describeRedditAllowForHuman({
              subreddits: sanitizeAllowedSubreddits((currentValue && currentValue.subreddits) || [])
                .concat(sanitizeAllowedSubreddits(newValue && newValue.subreddits)),
              posts: sanitizeAllowedRedditPosts((currentValue && currentValue.posts) || [])
                .concat(sanitizeAllowedRedditPosts(newValue && newValue.posts))
            }) : newValue,
      userContext,
      contextProjects,
      contextReasons,
      siteReason,
      coachInstructions,
      minutesTodaySite: stats.minutesToday,
      minutesTodayAll: stats.minutesTodayAll,
      minutesWeekAll: stats.minutesWeekAll,
      reasonsToday: stats.reasonsToday,
      ...leaveFacts
    });
    // Same tool name, different description. APPROVE_CHANGE_TOOL's own text
    // carries half the scepticism of an ordinary gate ("The default answer is
    // NO"), and a model reads a tool description as attentively as a system
    // prompt — so handing it to the leaving conversation would quietly undo
    // every word of the uninstall branch. See APPROVE_REMOVAL_TOOL.
    tools = [changeType === 'uninstall' ? APPROVE_REMOVAL_TOOL : APPROVE_CHANGE_TOOL];
  } else if (mode === 'context') {
    systemPrompt = buildContextSystemPrompt({ currentContext: userContext });
    tools = [UPDATE_CONTEXT_TOOL];
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

  let balanceCredits = await applyHostedBalance(access, llmResponse);

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
        const intention = await getIntention(domain);

        // The number the model actually asked for, kept before clamping so the
        // correction below can name the gap instead of pretending it granted
        // what was requested.
        const requested = Math.round(Number(input.minutes) || 0);

        // Did the coach ask for one page rather than the whole site, and is
        // there a page here to give?
        //
        // Anything other than the literal 'page' — absent, misspelled, a model
        // that has never heard of the field — reads as a site pass, which is
        // exactly what every grant meant before this existed.
        //
        // The page itself is resolved HERE, from what Intention recorded, and
        // never from anything the model said. The model is not given a URL
        // field for the reason renderScopeBlock states: its only source for a
        // page identity would be the <untrusted_page_data> block, which the
        // page controls.
        //
        // pageScopeFor is never called for an app target. On Android and iOS
        // there is no address to scope to — the accessibility service and the
        // Screen Time shield both work at the whole-app level — so the coach
        // is told scoped passes are unavailable there and a `scope: 'page'` it
        // asks for anyway downgrades with the correction below.
        const wantsPage = input.scope === 'page';
        const scope = (wantsPage && !isAppTarget && pageCtx && typeof pageCtx.url === 'string')
          ? pageScopeFor(pageCtx.url, pageCtx)
          : null;
        if (wantsPage && !scope) {
          systemNote = 'There was no single page to pin that to, so your pass covers the whole site for the full time.';
          correction = 'Your grant_access call asked for scope "page", but Intention could not identify a single page to scope it to: the destination is a feed, an app, or its address was not recorded. The pass was granted for the WHOLE SITE instead. Tell the user that, honestly and in your own words.';
        }

        // The coach is the way PAST the user's intention, never a way around
        // spending it. While a free open is left the gate offers it with one
        // tap, so a conversation that reaches this with opens still in hand
        // arrived by some other door — and paying credit for time that was
        // already free is the one outcome nobody wants. Refused, and the
        // coach is told why.
        if (intention.opensLeft > 0) {
          systemNote = `You still have ${intention.opensLeft} free ${intention.opensLeft === 1 ? 'open' : 'opens'} today. Use one from the gate instead.`;
          correction = `Your grant_access call was NOT applied: the user still has ${intention.opensLeft} of today's intended opens left, which the gate gives them for free. Tell them to use one of those.`;
          continue;
        }
        if (intention.mode === 'dailyTime' && intention.visitMinutesMax > 0) {
          systemNote = `You still have ${intention.visitMinutesMax} minutes of today's intended time available. Choose a visit length at the gate instead.`;
          correction = `Your grant_access call was NOT applied: the user still has ${intention.visitMinutesMax} minutes of today's intended time available for a free visit at the gate. Tell them to use that time there.`;
          continue;
        }

        // Every negotiated pass is short, and this is the arithmetic behind
        // the prompt's promise. There is no daily ceiling past the intention
        // — credit is the friction now — so the length of each pass is what
        // keeps an evening of "just ten more minutes" costing something every
        // time. A scoped pass may run longer: leaving the page ends it.
        const strictCap = scope ? STRICT_PHASE_MAX_MINUTES_SCOPED : STRICT_PHASE_MAX_MINUTES;
        const minutes = Math.max(1, Math.min(strictCap, requested));
        if (minutes < requested) {
          // Overwrites the downgrade correction above where both apply: the
          // clamped-minutes one is the more surprising of the two, and a
          // single correction turn is the whole budget.
          correction = `You asked for ${requested} minutes, but only ${minutes} were available under ${STRICT_PHASE_CLAMP_CAUSE}. The pass was granted for ${minutes} minutes.`;
          systemNote = `Extra time comes in passes of up to ${strictCap} minutes, and your pass is ${minutes} minutes.`;
        }

        const reason = String(input.reason || '').slice(0, 240);
        // Must go through grantSession, not a copy of it: recordGrant is what
        // feeds stats.grantsToday and reasonsToday, so an inlined version that
        // skips it silently disables both the daily cap checked above and the
        // escalating skepticism the check-in prompt is built on.
        grantedSession = await grantSession({ sessionKey, tabId, domain, isApp, minutes, reason,
          scope, negotiated: true, androidForegroundTime });
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
      }
    } catch (e) {
      console.warn(`Intention: tool call "${tc.name}" failed`, e);
      // systemNote only, no correction: an executor bug is ours to surface to
      // the user, not something to spend a second LLM turn explaining. A
      // correction set before the throw (the clamp path assigns it before
      // grantSession runs) must be cleared too, or the honesty turn would
      // assert a grant that never actually landed.
      correction = '';
      systemNote = 'Something went wrong applying that. Try describing what you want again.';
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
      // A scoped pass has to say what it is scoped TO, or the badge's "this
      // page only" and the re-gate that follows read as the tool going wrong
      // rather than as the thing they just agreed to.
      acceptanceFallback = grantedSession.scope
        ? `Okay, you've got ${mins} minute${mins === 1 ? '' : 's'} on that page${r}. Leave it and the block comes straight back, and you keep the minutes you don't use.`
        : `Okay, you've got ${mins} minute${mins === 1 ? '' : 's'}${r}. Make it count; I'll check in when the time's up.`;
    } else if (settingApproved) {
      if (changeType === 'remove' || changeType === 'remove_app') acceptanceFallback = `Alright, I'm convinced. I've removed ${displayName} from your blocklist.`;
      else if (changeType === 'increase_limit' || changeType === 'increase_app_limit') acceptanceFallback = `Okay, you've made your case. Your new intention for ${displayName} starts now.`;
      else if (changeType === 'edit_site_purpose' || changeType === 'edit_site_legitimate') acceptanceFallback = `Okay, that's a fair correction. I've saved your new wording for ${displayName}.`;
      // Named rather than left to the generic line below, because "I've made
      // that change" after a conversation about which SECTIONS stay blocked
      // tells the user nothing about what is now open to them.
      else if (changeType === 'narrow_block_scope' || changeType === 'narrow_app_block_scope') acceptanceFallback = `Alright, I've changed which parts of ${displayName} are blocked. The rest is yours.`;
      else if (changeType === 'allow_accounts') acceptanceFallback = `Alright, that account stays open on ${displayName} from now on.`;
      else if (changeType === 'allow_reddit') acceptanceFallback = 'Alright, those Reddit pages stay open from now on.';
      else if (changeType === 'disable_all') acceptanceFallback = `Understood, I've turned off blocking for now. Be intentional with it.`;
      // Two shapes, because approving a removal with a cool-off set does not
      // remove anything — and a farewell line under a screen that still says
      // "22 hours to go" would read as the button having failed.
      else if (changeType === 'uninstall') {
        const delay = formatLeaveDelay(settingApproved.delayMinutes);
        acceptanceFallback = delay
          ? `Understood. Your ${delay} starts now. Come back when it's up and it'll be one tap. I won't get in your way again before then.`
          : `Understood. I've stepped out of the way. Go ahead and remove it. Look after yourself.`;
      }
      else if (changeType === 'decrease_leave_delay') acceptanceFallback = `Alright, I've shortened the wait on removing Intention.`;
      else acceptanceFallback = `Okay, I'm convinced. I've made that change.`;
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
    history.push({ role: 'assistant', content: firstText || '(\u2026)' });
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
      // The correction turn spends credit too, so its answer supersedes the
      // first one's — reporting the pre-correction balance would tell the user
      // a number that was already out of date when it was printed.
      balanceCredits = await applyHostedBalance(access, second);
      // Tool calls from the correction turn are ignored wholesale: the state
      // has already been settled above, and honouring a fresh grant here
      // would reopen the loop this turn exists to close.
      secondText = (second.text || '').trim();
      history.push({ role: 'assistant', content: secondText || '(\u2026)' });
    } catch (e) {
      console.warn('Intention: correction turn failed', e);
      secondText = '';
      history.pop();
    }
  } else {
    history.push({ role: 'assistant', content: firstText || '(\u2026)' });
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
    assistantText: assistantText || '(\u2026)',
    grantedSession,
    contextUpdated,
    approved: settingApproved ? true : false,
    systemNote: systemNote || undefined,
    // Ride-along, so the gate can keep a credit line honest without a second
    // round trip after every message. Same two exclusions as getAccess: zero
    // is locked rather than low, and a route with no balance says nothing.
    balanceCredits: balanceCredits === null ? undefined : balanceCredits,
    lowCredit: balanceCredits !== null && balanceCredits > 0 && balanceCredits <= LOW_CREDIT_CREDITS
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

// ---------------------------------------------------------------------------
// Leaving: the state the options page reads, and the two verbs it can send.
// ---------------------------------------------------------------------------

// A stored leaveRequest, or null. Everything downstream — the settings card,
// the interposition guard — treats "no request" and "a request we cannot read"
// identically, and the direction of that failure is chosen: an unreadable
// request means Intention thinks nobody has asked to leave, which costs the
// user one more conversation. Reading it the other way would mean a corrupt
// value silently held the door open forever.
function normalizeLeaveRequest(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const availableAt = Number(raw.availableAt);
  if (!Number.isFinite(availableAt) || availableAt <= 0) return null;
  return {
    requestedAt: Number(raw.requestedAt) || 0,
    availableAt,
    delayMinutes: normalizeLeaveDelay(raw.delayMinutes)
  };
}

// The four ways the leaving conversation can end. Stored so that the reason a
// stand-down exists is legible later — and because 'declined' has to look
// exactly like 'approved' to the interposition guard, which is the whole
// anti-loop property and is easier to believe when you can see the value.
const LEAVE_OUTCOMES = ['approved', 'declined', 'cancelled', 'anyway'];

// Whether this build can remove itself.
//
// False on Apple builds, and not because the API is missing — it is there, and
// calling it would work. It would remove the SAFARI EXTENSION while leaving
// the Intention app sitting in /Applications or on the home screen, which is
// not what "Remove Intention" says and not what anyone pressing it wants. The
// options page shows instructions instead (see IS_APPLE_BUILD in options.js).
// False on Android too, where the background WebView's chrome shim has no
// management namespace and removal is an OS-level uninstall.
function canSelfUninstall() {
  if (IS_APPLE_BUILD) return false;
  return typeof chrome !== 'undefined' && !!(chrome.management && chrome.management.uninstallSelf);
}

async function getLeaveState() {
  const stored = await getStorage(['leaveDelayMinutes', 'leaveRequest', 'leaveStandDown']);
  const now = Date.now();
  const request = normalizeLeaveRequest(stored.leaveRequest);
  const standDownUntil = Number(stored.leaveStandDown && stored.leaveStandDown.until) || 0;
  return {
    leaveDelayMinutes: normalizeLeaveDelay(stored.leaveDelayMinutes),
    leaveRequest: request,
    // Computed here rather than in the page, so the clock that decides a
    // cool-off has elapsed is the same one that wrote it.
    ready: !!request && now >= request.availableAt,
    standDownUntil: standDownUntil > now ? standDownUntil : 0,
    canSelfUninstall: canSelfUninstall()
  };
}

// Record that the leaving conversation reached an end. Called for every one of
// them, including the ones where the user decided to stay — see
// LEAVE_STAND_DOWN_MS.
async function beginLeave(reason) {
  const until = Date.now() + LEAVE_STAND_DOWN_MS;
  const outcome = LEAVE_OUTCOMES.includes(reason) ? reason : 'declined';
  await setStorage({ leaveStandDown: { until, reason: outcome } });
  return { ok: true, standDownUntil: until, reason: outcome };
}

// The exit. Reached from the always-available "Remove it anyway" button and
// from a coach approval with no cool-off set; both are the same act.
//
// The stand-down is written FIRST, before the uninstall is attempted, and that
// ordering is the point: if the user cancels the browser's own confirmation
// dialog, Intention is still running and must not greet them with the same
// conversation the moment they look at the extensions page again.
async function completeRemoval() {
  await beginLeave('anyway');
  if (!canSelfUninstall()) return { ok: false, reason: 'unsupported' };
  try {
    // The documented options bag. Without it Chrome removes the extension with
    // no prompt at all, and one mis-tap on a phone-sized settings page should
    // not be able to end this silently — the friction here is the browser's
    // own dialog, which is exactly the right amount.
    await chrome.management.uninstallSelf({ showConfirmDialog: true });
    return { ok: true };
  } catch (e) {
    // The overwhelmingly likely case is that the user said no to that dialog,
    // which is not an error and must not be reported as one.
    return { ok: false, reason: 'cancelled', error: String((e && e.message) || e) };
  }
}

// Perform the actual loosening mutation once the coach approves it, then
// persist and re-sync the blocking rules. Returns the resulting state.
async function applySettingChange({ domain, changeType, newValue }) {
  const { blockedDomains = [], domainLimits = {}, blockedApps = [], appLimits = {}, appLabels = {}, serviceReasons = {} } = await getStorage(['blockedDomains', 'domainLimits', 'blockedApps', 'appLimits', 'appLabels', 'serviceReasons']);

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
    limits[domain] = withIntention(limits[domain], newValue);
    await setStorage({ domainLimits: limits });
    await syncBlockingRules();
    return { changeType, domain, domainLimits: limits, intention: resolveIntention(limits[domain]) };
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
    limits[domain] = withIntention(limits[domain], newValue);
    await setStorage({ appLimits: limits });
    return { changeType, domain, appLimits: limits, intention: resolveIntention(limits[domain]) };
  }

  // Rewriting one of the two things the user told the coach this service is
  // for. Keyed per SERVICE, not per target — serviceKeyFor folds the X app and
  // x.com onto one answer, which is what the row's "Shared with …" note is
  // telling you. The first write of a field never comes through here; it is
  // saved directly, because there is no weak moment to guard against before
  // anything exists (same reasoning as the coach-context card).
  if (changeType === 'edit_site_purpose' || changeType === 'edit_site_legitimate') {
    const key = serviceKeyFor(domain);
    if (!key) return null;
    const field = changeType === 'edit_site_purpose' ? 'purpose' : 'legitimateUse';
    const next = { ...serviceReasons };
    // Through sanitizeServiceReasons like every other write of this key: it is
    // free text that lands in a system prompt, and coach approval must not be
    // a way around the trim and the 500-char cap. Blanking both fields drops
    // the entry, which is what "never answered" already looks like.
    const sanitized = sanitizeServiceReasons({
      [key]: { ...(next[key] || {}), [field]: String(newValue == null ? '' : newValue), updatedAt: Date.now() }
    });
    if (sanitized[key]) next[key] = sanitized[key];
    else delete next[key];
    await setStorage({ serviceReasons: next });
    return { changeType, domain, serviceReasons: next };
  }

  // Narrowing what is blocked on a target to particular sections of it. The
  // value is a whole rule ({ scope, parts }), not a number, and it is the only
  // change type where the direction of the edit is not implied by its name:
  // ADDING a part to an 'only' list blocks MORE and never reaches here, while
  // adding one to an 'except' list blocks less and does. The options page runs
  // that test (partEditIsLoosening) before it decides whether to ask at all;
  // this end only ever applies what was approved.
  //
  // Everything goes through sanitizePartRule, so a hostile or malformed
  // newValue — a value the coach was talked into approving, a list of 500 ids,
  // an id containing a regex — lands as the clean rule or as no rule at all.
  // When it resolves to no rule, BOTH keys are deleted rather than written as
  // 'all': an entry with no part rule has to stay byte-identical to what
  // shipped before this feature, which is what makes the migration empty.
  if (changeType === 'narrow_block_scope' || changeType === 'narrow_app_block_scope') {
    const isApp = changeType === 'narrow_app_block_scope';
    const key = isApp ? 'appLimits' : 'domainLimits';
    const limits = { ...(isApp ? appLimits : domainLimits) };
    if (!limits[domain]) limits[domain] = { maxGrants: 3 };
    const next = sanitizePartRule(newValue);
    const entry = { ...limits[domain] };
    if (hasPartRule(next)) {
      entry.scope = next.scope;
      entry.parts = next.parts;
    } else {
      delete entry.scope;
      delete entry.parts;
    }
    limits[domain] = entry;
    await setStorage({ [key]: limits });
    // Only the site half: which domains carry a redirect rule depends on
    // whether they have a part rule (see domainsNeedingRedirect). An app
    // target has no DNR rule to re-sync.
    if (!isApp) await syncBlockingRules();
    return { changeType, domain, [key]: limits, scope: next.scope, parts: next.parts };
  }

  // Always allowing one or more accounts on a site. The value is the handles
  // to ADD, not the whole list: a request queued last night must not put back
  // an account taken off this morning, so it is merged with what is stored at
  // the moment it applies. Sites only — no app can prove whose screen it is
  // showing (see the ALLOWED ACCOUNTS header in parts.js).
  if (changeType === 'allow_accounts') {
    if (!domain || !accountsSupportedFor(domain)) return null;
    const adds = sanitizeAllowedAccounts(Array.isArray(newValue) ? newValue : [newValue]);
    if (!adds.length) return null;
    const limits = { ...domainLimits };
    const entry = { ...(limits[domain] || { maxGrants: INTENTION_DEFAULTS.maxGrants }) };
    const merged = sanitizeAllowedAccounts(sanitizeAllowedAccounts(entry.allowedAccounts).concat(adds));
    entry.allowedAccounts = merged;
    limits[domain] = entry;
    await setStorage({ domainLimits: limits });
    // Which hosts carry a redirect depends on whether they have a page rule.
    await syncBlockingRules();
    return { changeType, domain, domainLimits: limits, allowedAccounts: merged };
  }

  if (changeType === 'allow_reddit') {
    if (!domain || !redditSupportedFor(domain)) return null;
    const addsSubs = sanitizeAllowedSubreddits(newValue && newValue.subreddits);
    const addsPosts = sanitizeAllowedRedditPosts(newValue && newValue.posts);
    if (!addsSubs.length && !addsPosts.length) return null;
    const limits = { ...domainLimits };
    const entry = { ...(limits[domain] || { maxGrants: INTENTION_DEFAULTS.maxGrants }) };
    entry.allowedSubreddits = sanitizeAllowedSubreddits(
      sanitizeAllowedSubreddits(entry.allowedSubreddits).concat(addsSubs));
    entry.allowedRedditPosts = sanitizeAllowedRedditPosts(
      sanitizeAllowedRedditPosts(entry.allowedRedditPosts).concat(addsPosts));
    if (!entry.allowedSubreddits.length) delete entry.allowedSubreddits;
    if (!entry.allowedRedditPosts.length) delete entry.allowedRedditPosts;
    limits[domain] = entry;
    await setStorage({ domainLimits: limits });
    await syncBlockingRules();
    return { changeType, domain, domainLimits: limits,
      allowedSubreddits: entry.allowedSubreddits || [], allowedRedditPosts: entry.allowedRedditPosts || [] };
  }

  // `increase_quick_check` / `increase_app_quick_check` used to be handled
  // here. The quick check is retired, nothing can request either change type
  // any more, and an unrecognised changeType falls through to the null below
  // — which applySettingChange's callers already treat as "not approved".

  if (changeType === 'disable_all') {
    await setStorage({ blockedDomains: [], blockedApps: [], appLimits: {}, appLabels: {} });
    await syncBlockingRules();
    return { changeType, blockedDomains: [], blockedApps: [] };
  }

  // The coach has agreed to the user leaving. Note what this branch does NOT
  // do: it does not remove anything, clear anything, or touch a single
  // blocking rule. Removal is an act the user performs afterwards, through
  // their browser's own dialog (completeRemoval above) or through the OS. All
  // that happens here is that Intention stops standing in the way.
  //
  // Two shapes, decided by the cool-off the user set for themselves:
  //
  //   no delay — the way is clear now. A stand-down is written so the
  //              conversation does not reopen while they are on their way to
  //              the extensions page to finish.
  //   a delay  — the clock starts. Intention keeps working, unchanged, for
  //              the whole of it. Nothing about the blocklist moves; the only
  //              thing that changes is that a request now exists, and when it
  //              matures the settings card offers a one-tap removal.
  //
  // A stand-down is written on BOTH paths. The design this came from wrote one
  // only on the no-delay path; writing it on both makes "every outcome of the
  // leaving conversation writes a stand-down" a rule with no exceptions, which
  // is a far easier thing to state — to a store reviewer, and to the next
  // person reading this — than one with a carve-out. A live leaveRequest
  // suppresses interposition for its whole life anyway (leaveInterposeAllowed),
  // so the stand-down is belt to that braces and can only ever add silence.
  if (changeType === 'uninstall') {
    const { leaveDelayMinutes } = await getStorage(['leaveDelayMinutes']);
    const delayMinutes = normalizeLeaveDelay(leaveDelayMinutes);
    const now = Date.now();
    const standDownUntil = now + LEAVE_STAND_DOWN_MS;
    if (delayMinutes <= 0) {
      await setStorage({
        leaveStandDown: { until: standDownUntil, reason: 'approved' },
        leaveRequest: null
      });
      return { changeType, delayMinutes: 0, removalReady: true, standDownUntil };
    }
    const availableAt = now + delayMinutes * 60000;
    await setStorage({
      leaveRequest: { requestedAt: now, availableAt, delayMinutes },
      leaveStandDown: { until: standDownUntil, reason: 'approved' }
    });
    return { changeType, delayMinutes, removalReady: false, availableAt, standDownUntil };
  }

  // Shortening the cool-off. The mirror of every other change type in here:
  // LENGTHENING it is a tightening and saves for free through saveSettings,
  // and only the loosening half ever costs a conversation.
  //
  // The `>=` refusal is not defensive coding, it is the rule. A "decrease"
  // that raised the number would let a user launder a change through the gate
  // that they could have made for free — and, far worse, a value equal to the
  // current one would let the coach be talked into approving a no-op, which
  // reads to the user as their cool-off having been shortened when nothing
  // moved. Returning null puts it in the same class as an unrecognised change
  // type, which every caller already treats as "not approved".
  if (changeType === 'decrease_leave_delay') {
    const { leaveDelayMinutes } = await getStorage(['leaveDelayMinutes']);
    const current = normalizeLeaveDelay(leaveDelayMinutes);
    const next = normalizeLeaveDelay(newValue);
    if (next >= current) return null;
    await setStorage({ leaveDelayMinutes: next });
    return { changeType, leaveDelayMinutes: next, previousLeaveDelayMinutes: current };
  }

  return null;
}

// Shared by the LLM's grant_access tool call and the free intentionGrant path:
// records the grant, banks whatever session previously held this key, opens
// the new session, and arms the check-in alarm / DNR rule.
// recordGrant still accepts a { quickCheck } option and tracking.js still
// keeps that tally — see the note there. Nothing passes it any more: every
// grant is a normal grant now, so every grant counts against the daily cap.
async function grantSession({ sessionKey, tabId, domain, isApp, minutes, reason, scope, negotiated, wallExpiresAt, androidForegroundTime }) {
  const grantOptions = {};
  if (scope) grantOptions.scope = 'page';
  if (negotiated) grantOptions.negotiated = true;
  await recordGrant(domain, minutes, reason, Object.keys(grantOptions).length ? grantOptions : undefined);

  // Granting replaces whatever session held this key (a check-in extending
  // time, or a native port reusing the target's slot), so bank the old
  // one's minutes before it's overwritten and lost.
  const { activeSessions = {} } = await getStorage(['activeSessions']);
  const previous = activeSessions[sessionKey];
  if (previous && !isBanked(previous)) {
    const elapsed = sessionElapsedMs(previous) / 60000;
    await recordSessionMinutes(previous.domain, Math.min(elapsed, previous.intervalMinutes), 'extended', previous.startTime);
  }

  const session = { domain, reason, intervalMinutes: minutes, startTime: Date.now() };
  if (androidForegroundTime && tabId == null) session.pausedAt = session.startTime;
  if (tabId == null && wallExpiresAt) session.wallExpiresAt = wallExpiresAt;
  // Written ONLY when there is one. Absence is the third state and it is the
  // entire migration story: every session already in storage, every site pass
  // granted after this, and every intentionGrant carry no `scope` key and are
  // read as site-wide by everything that looks at them — including the three
  // native readers of this value (IntentionAccessibilityService's
  // latestSessionExpiry, SessionOverlay.liveSession, iOS
  // PassLiveActivityController), none of which know this field exists and none
  // of which need to. Never write { kind: 'site' }.
  if (scope) session.scope = scope;
  await mutateStorage('activeSessions', (sessions) => { sessions[sessionKey] = session; });
  if (Number.isFinite(sessionExpiryTime(session))) {
    chrome.alarms.create(`checkin-${sessionKey}`, { when: sessionExpiryTime(session) });
  }
  // Apps have no network rules to allow — the Android accessibility
  // service reads activeSessions directly to let the app through — and
  // neither do the native ports, which have no tab to scope a rule to.
  if (!isApp && tabId != null) await registerSessionRule(tabId, session);
  // Drops this domain's redirect rule for the life of the pass.
  if (!isApp) await syncBlockingRules();
  return session;
}

// One of the day's intended opens: a timed pass of the intention's length,
// with no conversation and no credit. Same bookkeeping as a negotiated pass —
// it goes through grantSession — so it counts toward the day the same way.
const intentionGrantLocks = new Map();

async function intentionGrant({ tabId, domain, isApp, reason, minutes, androidForegroundTime }) {
  // Serialize grants for a target. Two tabs can ask while both getIntention
  // reads are in flight; only the second may see the first one's reservation.
  const prior = intentionGrantLocks.get(domain) || Promise.resolve();
  const work = prior.catch(() => {}).then(() => intentionGrantUnlocked({ tabId, domain, isApp,
    reason, minutes, androidForegroundTime }));
  intentionGrantLocks.set(domain, work);
  try { return await work; }
  finally { if (intentionGrantLocks.get(domain) === work) intentionGrantLocks.delete(domain); }
}

async function intentionGrantUnlocked({ tabId, domain, isApp, reason, minutes, androidForegroundTime }) {
  const sessionKey = sessionKeyFor(tabId, domain);
  if (!sessionKey) return { denied: 'no session target' };

  const intention = await getIntention(domain);
  const why = typeof reason === 'string' ? reason.trim().slice(0, 500) : '';
  if (!why) return { denied: 'reason required', intention };
  if (intention.mode === 'dailyTime') {
    if (intention.dailyMinutes === 0 || intention.minutesLeft <= 0) return { denied: 'intention spent', intention };
    const requested = Number(minutes);
    const untilMidnight = Math.floor((nextDayStart() - Date.now()) / 60000);
    if (!Number.isInteger(requested) || requested < 1 || requested > intention.minutesLeft || requested > untilMidnight) {
      return { denied: 'invalid visit duration', intention };
    }
    const grantedSession = await grantSession({
      sessionKey, tabId, domain, isApp, minutes: requested, reason: why,
      wallExpiresAt: nextDayStart(), androidForegroundTime
    });
    return { grantedSession };
  }
  if (intention.opens === 0) return { denied: 'blocked', intention };
  if (intention.opensLeft <= 0) return { denied: 'intention spent', intention };

  const grantedSession = await grantSession({
    sessionKey, tabId, domain, isApp, minutes: intention.minutesEach, reason: why,
    androidForegroundTime
  });
  return { grantedSession };
}

// ---------------------------------------------------------------------------
// Deferred loosening
// ---------------------------------------------------------------------------
//
// Loosening a rule is never refused — it is delayed. Asked for from settings,
// it waits until the start of tomorrow and then applies itself; the coach is
// the only way to have it today. The delay is the whole mechanism: it is long
// enough that the version of the user who asked is not the one who benefits,
// and short enough that a considered change costs nothing but patience.
//
// Stored as a small queue of { changeType, domain, newValue, requestedAt,
// effectiveAt }, at most one per (changeType, target) — asking again replaces
// the earlier request rather than stacking behind it. Applied through
// applySettingChange, so a queued change and a coach-approved one land
// through exactly the same code.

// Changes that apply at once from settings. Rewording what a service is for
// only changes what the coach reads, and the coach is paid for; leaving has
// its own cool-off in leaveDelayMinutes and must never be slowed by a second.
const IMMEDIATE_CHANGE_TYPES = ['edit_site_purpose', 'edit_site_legitimate', 'uninstall'];

const DEFERRED_CHANGE_TYPES = [
  'remove', 'remove_app', 'increase_limit', 'increase_app_limit',
  'narrow_block_scope', 'narrow_app_block_scope', 'allow_accounts', 'allow_reddit', 'disable_all', 'decrease_leave_delay'
];

async function requestSettingChange({ changeType, domain, newValue }) {
  if (IMMEDIATE_CHANGE_TYPES.includes(changeType)) {
    return applySettingChange({ changeType, domain, newValue });
  }
  if (!DEFERRED_CHANGE_TYPES.includes(changeType)) return { error: 'Unknown change' };
  return scheduleSettingChange({ changeType, domain, newValue });
}

async function scheduleSettingChange({ changeType, domain, newValue, now = Date.now() }) {
  let effectiveAt = nextDayStart(now);
  // Shortening the cool-off on leaving waits out the cool-off it replaces as
  // well as the night. Otherwise a three-day wait could be turned into a
  // one-night wait by asking to shorten it first.
  if (changeType === 'decrease_leave_delay') {
    const { leaveDelayMinutes } = await getStorage(['leaveDelayMinutes']);
    effectiveAt = Math.max(effectiveAt, now + normalizeLeaveDelay(leaveDelayMinutes) * 60000);
  }
  const target = GLOBAL_CHANGE_TYPES.includes(changeType) ? null : (domain || null);
  const entry = { changeType, domain: target, newValue: newValue === undefined ? null : newValue, requestedAt: now, effectiveAt };
  let queue = [];
  await mutateStorage('pendingChanges', (current) => {
    const list = Array.isArray(current) ? current : [];
    queue = list.filter(p => !(p && p.changeType === changeType && (p.domain || null) === target));
    queue.push(entry);
    return queue;
  }, []);
  return { scheduled: true, pending: entry, pendingChanges: queue };
}

async function cancelPendingChange({ changeType, domain }) {
  const target = domain || null;
  let queue = [];
  await mutateStorage('pendingChanges', (current) => {
    const list = Array.isArray(current) ? current : [];
    queue = list.filter(p => !(p && p.changeType === changeType && (p.domain || null) === target));
    return queue;
  }, []);
  return { ok: true, pendingChanges: queue };
}

// Applies every queued change whose time has come. Called on the paths that
// open a new day's state — reconcileSessions at startup, the gate's intention
// lookup, the settings page's config read — so nothing has to be awake at
// midnight. The due entries are taken off the queue BEFORE they are applied:
// two tabs arriving at once must not both apply a removal, and every change
// type here is safe to have applied once and lost, never twice.
async function applyDuePendingChanges(now = Date.now()) {
  const { pendingChanges } = await getStorage(['pendingChanges']);
  if (!Array.isArray(pendingChanges) || !pendingChanges.some(p => p && p.effectiveAt <= now)) return [];
  let due = [];
  await mutateStorage('pendingChanges', (current) => {
    const list = Array.isArray(current) ? current : [];
    due = list.filter(p => p && p.effectiveAt <= now);
    return list.filter(p => p && p.effectiveAt > now);
  }, []);
  const applied = [];
  for (const p of due) {
    try {
      const result = await applySettingChange({ changeType: p.changeType, domain: p.domain, newValue: p.newValue });
      if (result) applied.push(p);
    } catch (e) {
      console.warn(INT_LOG, 'applyDuePendingChanges failed for', p.changeType, e);
    }
  }
  return applied;
}

// A tightening saved for a target supersedes any raise still queued for it:
// the most recent thing the user said about that target is the one that
// stands, and a queued "5 opens" must not undo a later "actually, 2".
async function dropSupersededRaises(partial) {
  const stored = await getStorage(['domainLimits', 'appLimits', 'pendingChanges']);
  if (!Array.isArray(stored.pendingChanges) || !stored.pendingChanges.length) return;
  const changed = (key) => {
    const next = partial[key];
    if (!next) return new Set();
    const before = stored[key] || {};
    return new Set(Object.keys(next).filter(t => {
      const a = resolveIntention(before[t]);
      const b = resolveIntention(next[t]);
      return a.opens !== b.opens || a.minutesEach !== b.minutesEach;
    }));
  };
  const sites = changed('domainLimits');
  const apps = changed('appLimits');
  if (!sites.size && !apps.size) return;
  await mutateStorage('pendingChanges', (current) => (Array.isArray(current) ? current : []).filter(p => !(
    p && ((p.changeType === 'increase_limit' && sites.has(p.domain)) ||
          (p.changeType === 'increase_app_limit' && apps.has(p.domain)))
  )), []);
}

// A limits entry with a new intention written onto it, keeping everything
// else the entry carries (its part rule, above all). `value` is an intention
// object from the settings sheet; anything unreadable leaves that field as it
// was rather than resetting it to a default.
function withIntention(entry, value) {
  const base = entry ? { ...entry } : { ...INTENTION_DEFAULTS };
  const v = (value && typeof value === 'object') ? value : {};
  if (v.intentionMode === 'dailyTime') {
    const next = resolveIntention({ intentionMode: 'dailyTime', dailyTimeMinutes: v.dailyTimeMinutes });
    base.intentionMode = 'dailyTime';
    base.dailyTimeMinutes = next.dailyMinutes;
    return base;
  }
  const next = resolveIntention({
    maxGrants: v.maxGrants !== undefined ? v.maxGrants : base.maxGrants,
    passMinutes: v.passMinutes !== undefined ? v.passMinutes : base.passMinutes
  });
  base.maxGrants = next.opens;
  base.passMinutes = next.minutesEach;
  if (base.intentionMode === 'dailyTime' || v.intentionMode === 'opens') base.intentionMode = 'opens';
  return base;
}

// "3 opens a day, 10 minutes each" — the sentence both the settings row and
// the settings-gate coach use for an intention.
function describeIntentionForHuman(value) {
  const { mode, dailyMinutes, opens, minutesEach } = resolveIntention(value && typeof value === 'object' ? value : null);
  if (mode === 'dailyTime') return `${dailyMinutes} minutes a day, chosen per visit`;
  if (opens === 0) return 'blocked outright (no opens)';
  return `${opens} ${opens === 1 ? 'open' : 'opens'} a day, ${minutesEach} minutes each`;
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
      const elapsed = sessionElapsedMs(session) / 60000;
      const used = Math.min(elapsed, session.intervalMinutes);
      // Closing the tab with time still on the clock is the win the coach is
      // told to celebrate, so only claim it when they genuinely left time
      // unused — otherwise this was just the pass running its course.
      const resolved = outcome === 'ended'
        ? (used < session.intervalMinutes - 0.5 ? 'closed_early' : 'finished')
        : outcome;
      await recordSessionMinutes(session.domain, used, resolved, session.startTime);
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
    // The surviving session's own rule, not just its domain: if what is left
    // on this tab is a page-scoped pass, the rule that replaces the one being
    // torn down has to be the narrow one, or ending an unrelated pass would
    // quietly widen a scoped one to the whole site.
    await registerSessionRule(tabId, stillLive);
  } else {
    removeSessionRule(tabId);
  }
}

async function endSession({ tabId, domain, reason }) {
  const { activeSessions = {} } = await getStorage(['activeSessions']);
  const session = readSession(activeSessions, tabId, domain, { live: false });
  const sessionKey = (session && Object.keys(activeSessions).find(key => activeSessions[key] === session)) ||
    sessionKeyFor(tabId, domain);
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

  // 'left_page' is its own outcome rather than an early close: the pass ended
  // because the page it was pinned to is no longer the page they are on. The
  // minutes banked are the same ones they actually used, and the track record
  // gets to say "you asked for that one video and closed it" instead of
  // flattening it into another closed_early.
  await retireSessionKey(sessionKey, reason === 'left_page' ? 'left_page' : 'ended');
  const ownerTabId = tabIdFromSessionKey(sessionKey);
  await settleTabRule(ownerTabId);
  // The pass is over: this domain needs its redirect rule back. (For a scoped
  // pass on an engine where allowOutranksRedirect() holds, it never went away
  // — see domainsNeedingRedirect — so this is the no-op the idempotence check
  // in applyBlockingRules exists for. Where it does not hold, a scoped pass
  // dropped the redirect like any other and this is what restores it.)
  await syncBlockingRules();
  if (session && !session.scope) await interruptSessionTabs(session, ownerTabId);

  // Deliberately not for 'left_page': they are still on a page of this site,
  // and the drift screen that sent this is about to put the gate up in front
  // of them. Closing the tab from under it would look like a crash.
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
    const session = activeSession(activeSessions[key]);
    // Hand the clock to a surviving tab without granting or banking time.
    // This also lets closing the last tab retire the pass normally.
    const successor = session && !session.scope
      ? (await tabsForSiteSession(session, tabId)).find(id => id !== tabId) : null;
    if (successor != null) {
      const nextKey = sessionKeyFor(successor, session.domain);
      if (!activeSessions[nextKey]) {
        await mutateStorage('activeSessions', (sessions) => {
          sessions[nextKey] = sessions[key];
          delete sessions[key];
        });
        chrome.alarms.clear(`checkin-${key}`);
        chrome.alarms.create(`checkin-${nextKey}`, { when: sessionExpiryTime(session) });
        continue;
      }
    }
    await retireSessionKey(key, reason === 'closed' ? 'tab_closed' : 'ended');
  }
  removeSessionRule(tabId);
  if (keys.length) await syncBlockingRules();
  return { ok: true };
}
