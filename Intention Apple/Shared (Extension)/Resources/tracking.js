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
  const { dailyStats = {} } = await getStorage(['dailyStats']);
  const today = dateKey();
  if (!dailyStats[today]) dailyStats[today] = {};
  mutator(dailyStats, today);
  const allKeys = Object.keys(dailyStats).sort().reverse();
  if (allKeys.length > 365) {
    for (const old of allKeys.slice(365)) delete dailyStats[old];
  }
  await setStorage({ dailyStats });
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

  const { allTimeStats = {} } = await getStorage(['allTimeStats']);
  if (allTimeStats[domain] === undefined) {
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
  await setStorage({ allTimeStats });
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
