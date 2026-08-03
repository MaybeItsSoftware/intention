function dateKey(date) {
  const d = date || new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function daysAgoKeys(n) {
  const keys = [];
  const now = new Date();
  for (let i = 0; i < n; i++) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    keys.push(dateKey(d));
  }
  return keys;
}

function getStorage(keys) {
  return new Promise(resolve => chrome.storage.local.get(keys, resolve));
}

function setStorage(obj) {
  pushConfigToNative(obj);
  return new Promise(resolve => chrome.storage.local.set(obj, resolve));
}

// chrome.storage has no transactions, so a plain read → await → write cycle
// silently drops whatever another caller committed in between (two coaching
// tabs appending to chatHistories, a grant racing a session end, overlapping
// stats writes). Every read-modify-write of a shared key goes through this
// queue instead, so those cycles serialize rather than clobber each other.
//
// `mutator` receives the stored value (or a fresh `fallback`) and may mutate it
// in place or return a replacement. It may await — the queue holds until it
// settles — but it must never call mutateStorage itself, which would deadlock.
let storageQueue = Promise.resolve();

function mutateStorage(key, mutator, fallback = {}) {
  const run = async () => {
    const stored = await getStorage([key]);
    const value = stored[key] === undefined ? fallback : stored[key];
    const replacement = await mutator(value);
    const next = replacement === undefined ? value : replacement;
    await setStorage({ [key]: next });
    return next;
  };
  const queued = storageQueue.then(run, run);
  // Keep the chain alive regardless of how this link settles.
  storageQueue = queued.then(() => {}, () => {});
  return queued;
}

// ---------------------------------------------------------------------------
// Native app config bridge (Apple platforms only).
//
// The iOS app hosts its own copy of this extension's config UI in a WebView
// and needs to stay in sync with the config the Safari Web Extension actually
// runs with. `browser.runtime.sendNativeMessage` only exists in Safari (and
// Firefox, where it's harmlessly a no-op since we have no registered native
// host there) — it's absent in Chrome's `browser` global entirely, so this
// whole bridge is inert everywhere except the Safari Web Extension runtime,
// where SafariWebExtensionHandler.swift answers `pushConfig`/`pullConfig`.
const CONFIG_KEYS = [
  'provider', 'apiKey', 'model', 'userContext', 'contextProjects',
  'contextReasons', 'coachInstructions', 'blockedDomains', 'domainLimits',
  'blockedApps', 'appLimits', 'appLabels',
  // Coaching credit is bought in the app (StoreKit lives there, not in a
  // Safari extension process), so the entitlement it mints has to reach the
  // extension through this bridge or the extension's coach stays locked.
  'entitlement',
  'setupComplete'
];
const NATIVE_APP_ID = 'com.intention.app'; // ignored by Safari (single native host per app)
const NATIVE_PULL_THROTTLE_MS = 30000;

let syncingFromNative = false;
let lastNativePullAt = 0;

function hasNativeMessaging() {
  return typeof browser !== 'undefined' && browser.runtime && typeof browser.runtime.sendNativeMessage === 'function';
}

// Fire-and-forget push of any config keys being written so the native app's
// shared storage reflects settings changed from within Safari's own options
// page. Never blocks or throws into setStorage's caller.
function pushConfigToNative(obj) {
  if (syncingFromNative || !hasNativeMessaging()) return;
  const config = {};
  for (const k of Object.keys(obj)) {
    if (CONFIG_KEYS.includes(k)) config[k] = obj[k];
  }
  if (!Object.keys(config).length) return;
  try {
    const result = browser.runtime.sendNativeMessage(NATIVE_APP_ID, { action: 'pushConfig', config });
    if (result && typeof result.catch === 'function') result.catch(() => {});
  } catch (e) {
    // No native host reachable — ignore.
  }
}

// Pull the latest config from the native app's shared storage so settings
// changed in the native iOS app reach the running extension. Throttled since
// callers (e.g. checkPageMatch) may invoke this on every navigation.
async function syncConfigFromNative() {
  if (!hasNativeMessaging()) return;
  const now = Date.now();
  if (now - lastNativePullAt < NATIVE_PULL_THROTTLE_MS) return;
  lastNativePullAt = now;
  try {
    const response = await browser.runtime.sendNativeMessage(NATIVE_APP_ID, { action: 'pullConfig' });
    if (!response || !response.config) return;
    syncingFromNative = true;
    try {
      await setStorage(response.config);
    } finally {
      syncingFromNative = false;
    }
  } catch (e) {
    // No native host reachable — ignore.
  }
}

async function withDailyStats(mutator) {
  await mutateStorage('dailyStats', (dailyStats) => {
    const today = dateKey();
    if (!dailyStats[today]) dailyStats[today] = {};
    mutator(dailyStats, today);
    const allKeys = Object.keys(dailyStats).sort().reverse();
    if (allKeys.length > 365) {
      for (const old of allKeys.slice(365)) delete dailyStats[old];
    }
  });
}

async function recordGrant(domain, minutes, reason) {
  await withDailyStats((stats, today) => {
    if (!stats[today][domain]) stats[today][domain] = { minutes: 0, grants: 0, sessions: [] };
    stats[today][domain].grants += 1;
    stats[today][domain].sessions.push({ grantedMinutes: minutes, reason, grantedAt: Date.now() });
  });
}

async function recordSessionMinutes(domain, elapsedMinutes) {
  if (!domain || elapsedMinutes <= 0) return;
  await withDailyStats((stats, today) => {
    if (!stats[today][domain]) stats[today][domain] = { minutes: 0, grants: 0, sessions: [] };
    stats[today][domain].minutes += elapsedMinutes;
  });

  await mutateStorage('allTimeStats', async (allTimeStats) => {
    if (allTimeStats[domain] === undefined) {
      // First write for this domain: seed it from the daily history (which
      // already includes the minutes recorded just above) rather than starting
      // from zero and losing everything logged before all-time tracking.
      const { dailyStats = {} } = await getStorage(['dailyStats']);
      let sumDaily = 0;
      for (const entries of Object.values(dailyStats)) {
        if (entries[domain]) {
          sumDaily += entries[domain].minutes || 0;
        }
      }
      allTimeStats[domain] = sumDaily;
    } else {
      allTimeStats[domain] += elapsedMinutes;
    }
  });
}

async function getStatsForDomain(domain) {
  const { dailyStats = {}, allTimeStats = {} } = await getStorage(['dailyStats', 'allTimeStats']);
  const todayKey = dateKey();
  const weekKeys = daysAgoKeys(7);
  const monthKeys = daysAgoKeys(30);
  const yearKeys = daysAgoKeys(365);

  let minutesToday = 0, grantsToday = 0, minutesWeek = 0, minutesMonth = 0, minutesYear = 0;
  let minutesTodayAll = 0, minutesWeekAll = 0;
  let reasonsToday = [];

  for (const [k, entries] of Object.entries(dailyStats)) {
    for (const [d, site] of Object.entries(entries)) {
      if (d === domain) {
        if (k === todayKey) {
          minutesToday = site.minutes || 0;
          grantsToday = site.grants || 0;
          reasonsToday = (site.sessions || [])
            .map(s => (s && s.reason ? String(s.reason).trim() : ''))
            .filter(Boolean);
        }
        if (weekKeys.includes(k)) minutesWeek += site.minutes || 0;
        if (monthKeys.includes(k)) minutesMonth += site.minutes || 0;
        if (yearKeys.includes(k)) minutesYear += site.minutes || 0;
      }
      if (k === todayKey) minutesTodayAll += site.minutes || 0;
      if (weekKeys.includes(k)) minutesWeekAll += site.minutes || 0;
    }
  }

  let minutesAllTime = allTimeStats[domain];
  if (minutesAllTime === undefined) {
    let sumDaily = 0;
    for (const entries of Object.values(dailyStats)) {
      if (entries[domain]) {
        sumDaily += entries[domain].minutes || 0;
      }
    }
    minutesAllTime = sumDaily;
  }

  return {
    minutesToday: Math.round(minutesToday),
    minutesWeek: Math.round(minutesWeek),
    minutesMonth: Math.round(minutesMonth),
    minutesYear: Math.round(minutesYear),
    minutesAllTime: Math.round(minutesAllTime),
    grantsToday,
    minutesTodayAll: Math.round(minutesTodayAll),
    minutesWeekAll: Math.round(minutesWeekAll),
    reasonsToday
  };
}

async function getUsageLog(days = 30) {
  const { dailyStats = {} } = await getStorage(['dailyStats']);
  const keys = daysAgoKeys(days);
  const entries = [];

  for (const k of keys) {
    const dayEntries = dailyStats[k];
    if (!dayEntries) continue;
    for (const [domain, site] of Object.entries(dayEntries)) {
      const minutes = Math.round(site.minutes || 0);
      if (minutes > 0) entries.push({ date: k, domain, minutes });
    }
  }

  entries.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.minutes - a.minutes));
  return entries;
}

async function getStatsSummary() {
  const { dailyStats = {} } = await getStorage(['dailyStats']);
  const todayKey = dateKey();
  const weekKeys = daysAgoKeys(7);

  let minutesToday = 0, minutesWeek = 0;
  const perSiteToday = {};

  for (const [k, entries] of Object.entries(dailyStats)) {
    for (const [domain, site] of Object.entries(entries)) {
      if (k === todayKey) {
        minutesToday += site.minutes || 0;
        perSiteToday[domain] = (perSiteToday[domain] || 0) + (site.minutes || 0);
      }
      if (weekKeys.includes(k)) minutesWeek += site.minutes || 0;
    }
  }

  return {
    minutesToday: Math.round(minutesToday),
    minutesWeek: Math.round(minutesWeek),
    perSiteToday
  };
}
