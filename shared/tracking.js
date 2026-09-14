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
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(keys, result => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(result);
    });
  });
}

function setStorage(obj) {
  pushConfigToNative(obj);
  return new Promise((resolve, reject) => {
    chrome.storage.local.set(obj, () => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve();
    });
  });
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
  'setupComplete',
  // These are configuration, not activity data. They have to cross the App
  // Group too: otherwise a list restored in the native app updates its
  // WebView but leaves Safari using the previous reasons and queued changes.
  'serviceReasons', 'pendingChanges',
  // The cool-off the user put on removing Intention. It rides this bridge
  // because on Apple platforms the settings page the user changes it on is the
  // one inside the app, not the one inside the extension, and the two have to
  // agree about a number the coach quotes back at them.
  //
  // `leaveRequest` and `leaveStandDown` deliberately do NOT ride it. They are
  // per-device state — this browser's clock, this device's fifteen minutes of
  // silence — and syncing them would mean a stand-down earned on a Mac
  // silencing the interposition on an iPhone, which is not what either of them
  // means.
  'leaveDelayMinutes'
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

// ---------------------------------------------------------------------------
// Website activity → native app (Apple platforms only). One way, by design.
//
// dailyStats lives in the Safari extension's own storage, which neither app can
// read, so the iPhone and Mac apps had no idea how long anyone spent on a
// blocked site: the dashboard showed app time and nothing else. It cannot ride
// CONFIG_KEYS — that bridge is two-way, and two writers merging a counter that
// both of them increment is how minutes get counted twice or lost.
//
// So the extension pushes a slimmed copy of its recent days under a source id of
// its own (one per Safari profile, per device), the native handler keeps one
// entry per source outside the shared config blob, and the app only ever reads
// it — adding every source into its own figures (mergeDailyStats below). The
// app never writes `webActivity`, and nothing pushed here is ever pulled back.
//
// Numbers only. Session reasons stay in the extension: the dashboard needs how
// much and how often, not what the user told the coach.
const ACTIVITY_PUSH_THROTTLE_MS = 60000;
const ACTIVITY_PUSH_DAYS = 35;
const ACTIVITY_NUMERIC_FIELDS = ['minutes', 'grants', 'negotiated', 'walkedAway', 'quickChecks'];

let lastActivityPushAt = 0;
let activityPushTimer = null;

// Firefox has sendNativeMessage too, with nothing listening. IS_APPLE_BUILD
// comes from providers.js wherever that is loaded; where it is not (tracking.js
// on its own) the native-messaging check alone decides.
function canPushActivity() {
  if (!hasNativeMessaging()) return false;
  return typeof IS_APPLE_BUILD !== 'boolean' || IS_APPLE_BUILD;
}

function activityForNative(dailyStats, keys) {
  const days = {};
  for (const k of keys) {
    const entries = dailyStats && dailyStats[k];
    if (!entries || typeof entries !== 'object') continue;
    const out = {};
    for (const [domain, site] of Object.entries(entries)) {
      if (!site || typeof site !== 'object') continue;
      const slim = {};
      for (const f of ACTIVITY_NUMERIC_FIELDS) {
        const n = Number(site[f]);
        if (n > 0) slim[f] = n;
      }
      if (Object.keys(slim).length) out[domain] = slim;
    }
    if (Object.keys(out).length) days[k] = out;
  }
  return days;
}

async function getActivitySourceId() {
  const { activitySourceId } = await getStorage(['activitySourceId']);
  if (activitySourceId) return activitySourceId;
  const id = (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function')
    ? crypto.randomUUID()
    : `src-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  await setStorage({ activitySourceId: id });
  return id;
}

async function pushActivityToNative() {
  if (!canPushActivity()) return;
  lastActivityPushAt = Date.now();
  try {
    const { dailyStats = {}, setupCompletedAt = 0 } = await getStorage(['dailyStats', 'setupCompletedAt']);
    const sourceId = await getActivitySourceId();
    const days = activityForNative(dailyStats, daysAgoKeys(ACTIVITY_PUSH_DAYS));
    const result = browser.runtime.sendNativeMessage(NATIVE_APP_ID, {
      action: 'pushActivity',
      sourceId,
      days,
      // The app's streak starts counting from here when the user set Intention
      // up in Safari rather than in the app.
      startedAt: Number(setupCompletedAt) || 0
    });
    if (result && typeof result.catch === 'function') await result.catch(() => {});
  } catch (e) {
    // No native host reachable — ignore.
  }
}

// Called after every dailyStats write. Leading edge when the last push is old
// enough, otherwise one trailing push, so the final minutes of a sitting still
// arrive rather than waiting for the next write.
function scheduleActivityPush() {
  if (!canPushActivity() || activityPushTimer) return;
  const wait = ACTIVITY_PUSH_THROTTLE_MS - (Date.now() - lastActivityPushAt);
  if (wait <= 0) {
    pushActivityToNative();
    return;
  }
  activityPushTimer = setTimeout(() => {
    activityPushTimer = null;
    pushActivityToNative();
  }, wait);
}

// The app's side: its own dailyStats (app usage on Android, anything the
// in-app host recorded) plus every pushed source, summed per day and target.
// Pure, and a no-op returning `local` itself when nothing was pushed — which is
// always the case inside a browser extension.
function mergeDailyStats(local, webActivity) {
  const sources = webActivity && typeof webActivity === 'object' ? Object.values(webActivity) : [];
  if (!sources.length) return local || {};
  const merged = {};
  for (const [k, entries] of Object.entries(local || {})) {
    merged[k] = {};
    for (const [d, site] of Object.entries(entries || {})) merged[k][d] = { ...site };
  }
  for (const source of sources) {
    const days = source && source.days;
    if (!days || typeof days !== 'object') continue;
    for (const [k, entries] of Object.entries(days)) {
      if (!entries || typeof entries !== 'object') continue;
      if (!merged[k]) merged[k] = {};
      for (const [d, site] of Object.entries(entries)) {
        if (!site || typeof site !== 'object') continue;
        const into = merged[k][d] || (merged[k][d] = { minutes: 0, grants: 0, sessions: [] });
        for (const f of ACTIVITY_NUMERIC_FIELDS) {
          const n = Number(site[f]);
          if (n > 0) into[f] = (Number(into[f]) || 0) + n;
        }
      }
    }
  }
  return merged;
}

// Every read-only view of usage goes through here; every write keeps using
// raw dailyStats. `setupCompletedAt` falls back to the earliest start a source
// reported, so a Mac app opened after setting up in Safari doesn't show a
// streak that began today.
async function getDisplayStats(extraKeys = []) {
  const stored = await getStorage(['dailyStats', 'webActivity', 'setupCompletedAt', ...extraKeys]);
  const sources = stored.webActivity && typeof stored.webActivity === 'object' ? Object.values(stored.webActivity) : [];
  let startedAt = Number(stored.setupCompletedAt) || 0;
  if (!startedAt) {
    const starts = sources.map(src => Number(src && src.startedAt) || 0).filter(n => n > 0);
    if (starts.length) startedAt = Math.min(...starts);
  }
  return {
    ...stored,
    dailyStats: mergeDailyStats(stored.dailyStats || {}, stored.webActivity),
    setupCompletedAt: startedAt
  };
}

// ---------------------------------------------------------------------------
// Candidate-site tally — what the suggestion grid ranks on.
//
// The grid used to be a fixed list in a fixed order, so someone who only ever
// loses an evening to Hacker News still had nine sites they never open sitting
// above it. This counts how often a *candidate* gets visited so the grid can
// lead with the ones that are actually a problem for this person.
//
// It is deliberately not a browsing log. A host is only counted when it
// matches an entry in COMMON_SITES, which bounds the store to that list —
// there is no key here that the suggestion catalogue did not already name, and
// nothing about a host that isn't on it is written down. Nor is it transmitted:
// `siteVisits` is not in CONFIG_KEYS, so pushConfigToNative skips it.
const VISIT_TALLY_GAP_MS = 30 * 60 * 1000;

// Subdomains fold into their candidate, so old.reddit.com and www.reddit.com
// are one entry — the same host match blocking itself uses.
function candidateForHost(host) {
  if (!host) return null;
  return COMMON_SITES.find(d => host === d || host.endsWith('.' + d)) || null;
}

async function recordCandidateVisit(host) {
  const candidate = candidateForHost(host);
  if (!candidate) return;
  const now = Date.now();
  // Read before mutating: this runs on every page load of a candidate site,
  // and the throttle means most of those have nothing to write.
  const visits = await getCandidateVisits();
  const seen = visits[candidate];
  if (seen && now - seen.last < VISIT_TALLY_GAP_MS) return;
  await mutateStorage('siteVisits', (stored) => {
    const entry = stored[candidate] || { count: 0, last: 0 };
    // One count per candidate per half hour: the ranking wants to know how
    // often they come back, not how many pages deep a single sitting went.
    if (now - entry.last < VISIT_TALLY_GAP_MS) return;
    stored[candidate] = { count: entry.count + 1, last: now };
  });
}

async function getCandidateVisits() {
  const { siteVisits = {} } = await getStorage(['siteVisits']);
  return siteVisits;
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
  scheduleActivityPush();
}

async function recordGrant(domain, minutes, reason, options) {
  // A quick check was a separate lane: it never counted against the day's
  // grants cap, so it got its own counter (lazily added, like walkedAway).
  //
  // The FEATURE is retired — nothing calls this with { quickCheck: true } any
  // more, and background.js no longer has a path that could. This tally is
  // DELIBERATELY LEFT IN PLACE, not overlooked: `quickChecks` and
  // `session.quickCheck` are lazily-added additive fields, so keeping them
  // means every day already banked keeps its two lanes exactly as recorded.
  // Deleting them would either need a migration or silently reread historical
  // quick checks as normal grants, which would rewrite the usage log and the
  // history the coach reasons from. Please don't "tidy" them away.
  const quickCheck = !!(options && options.quickCheck);
  // Which KIND of pass this was. Lazily added exactly like the flag above and
  // for the same reason: a page-scoped pass and a site pass are the same one
  // grant out of the day's allowance, so nothing about the tallies changes —
  // but "12 minutes granted, 3 used, left the page it was for" and "12
  // granted, 3 used, closed early" are different stories, and the coach reads
  // this list as its evidence for what the next ask deserves. Absent means
  // site-wide, so no migration and no rewrite of banked history.
  const scoped = !!(options && options.scope);
  // A pass the coach negotiated past the day's intention, as opposed to one
  // of the intended opens. Counted separately because it is the difference
  // between "used what they meant to" and "needed more" — the gate counts
  // opens left from grants minus these, and the streak reads a day with any
  // of them as a miss.
  const negotiated = !!(options && options.negotiated);
  await withDailyStats((stats, today) => {
    if (!stats[today][domain]) stats[today][domain] = { minutes: 0, grants: 0, sessions: [] };
    if (quickCheck) stats[today][domain].quickChecks = (stats[today][domain].quickChecks || 0) + 1;
    else stats[today][domain].grants += 1;
    const session = { grantedMinutes: minutes, reason, grantedAt: Date.now() };
    if (quickCheck) session.quickCheck = true;
    if (scoped) session.scope = 'page';
    if (negotiated) {
      session.negotiated = true;
      stats[today][domain].negotiated = (stats[today][domain].negotiated || 0) + 1;
    }
    stats[today][domain].sessions.push(session);
  });
}

// How a pass ended, written back onto the grant that opened it. Minutes alone
// can't tell "asked for 10, left after 4" from "asked for 10 and had to be
// interrupted at 10" — and that difference is the only real evidence for how
// much time the next grant deserves. Stamped on the most recent grant for this
// domain that doesn't have an outcome yet; a pass opened before midnight has
// no entry in today's list, so this is best-effort by design.
function stampSessionOutcome(daySites, domain, outcome, usedMinutes) {
  const sessions = daySites?.[domain]?.sessions;
  if (!outcome || !Array.isArray(sessions)) return;
  for (let i = sessions.length - 1; i >= 0; i--) {
    if (sessions[i] && !sessions[i].outcome) {
      sessions[i].outcome = outcome;
      sessions[i].usedMinutes = Math.round(usedMinutes * 10) / 10;
      sessions[i].endedAt = Date.now();
      return;
    }
  }
}

async function recordSessionMinutes(domain, elapsedMinutes, outcome) {
  // Closing the tab the instant the pass opens banks no minutes, but it is the
  // single strongest thing the coach can know about someone — so an outcome is
  // still worth writing down when there is no time to record.
  const minutes = elapsedMinutes > 0 ? elapsedMinutes : 0;
  if (!domain || (!minutes && !outcome)) return;
  await withDailyStats((stats, today) => {
    if (!stats[today][domain]) stats[today][domain] = { minutes: 0, grants: 0, sessions: [] };
    stats[today][domain].minutes += minutes;
    stampSessionOutcome(stats[today], domain, outcome, minutes);
  });

  if (!minutes) return;

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

// Counts gates the user closed without taking any time — the win the coach
// celebrates and the streak the prompt protects. Before this, someone gated
// twelve times who granted zero looked identical to someone who never visited.
// Count-only by design: per-event timestamps would say more, but the number
// itself is the coaching material, and a bare counter rides the existing
// 365-day retention for free.
async function recordWalkAway(domain) {
  if (!domain) return;
  await withDailyStats((stats, today) => {
    if (!stats[today][domain]) stats[today][domain] = { minutes: 0, grants: 0, sessions: [] };
    stats[today][domain].walkedAway = (stats[today][domain].walkedAway || 0) + 1;
  });
}

async function getStatsForDomain(domain) {
  const { dailyStats = {}, allTimeStats = {} } = await getDisplayStats(['allTimeStats']);
  const todayKey = dateKey();
  const weekKeys = daysAgoKeys(7);
  const monthKeys = daysAgoKeys(30);
  const yearKeys = daysAgoKeys(365);

  let minutesToday = 0, grantsToday = 0, negotiatedToday = 0, quickChecksToday = 0, minutesWeek = 0, minutesMonth = 0, minutesYear = 0;
  let minutesTodayAll = 0, minutesWeekAll = 0;
  let walkedAwayToday = 0, walkedAwayWeek = 0;
  let reasonsToday = [];
  let sessionsToday = [];
  // Per-day rollup for this site, today excluded — a pattern is only visible
  // across days, and the coach was previously shown today and nothing else.
  const recentDays = [];

  for (const [k, entries] of Object.entries(dailyStats)) {
    for (const [d, site] of Object.entries(entries)) {
      if (d === domain) {
        if (k === todayKey) {
          minutesToday = site.minutes || 0;
          grantsToday = site.grants || 0;
          negotiatedToday = site.negotiated || 0;
          quickChecksToday = site.quickChecks || 0;
          walkedAwayToday = site.walkedAway || 0;
          reasonsToday = (site.sessions || [])
            .map(s => (s && s.reason ? String(s.reason).trim() : ''))
            .filter(Boolean);
          sessionsToday = (site.sessions || [])
            .filter(Boolean)
            .map(s => ({
              reason: s.reason ? String(s.reason).trim() : '',
              grantedMinutes: s.grantedMinutes || 0,
              grantedAt: s.grantedAt || null,
              usedMinutes: typeof s.usedMinutes === 'number' ? s.usedMinutes : null,
              outcome: s.outcome || null,
              quickCheck: !!s.quickCheck,
              // null rather than undefined for a session banked before scoped
              // passes existed, so renderSessionsToday reads one shape.
              scope: s.scope || null,
              // Without this the "back Nm later" annotation in prompts.js had
              // nothing to compute a gap from — stampSessionOutcome writes
              // endedAt, but the mapping here silently dropped it.
              endedAt: s.endedAt || null
            }));
        } else if (weekKeys.includes(k)) {
          recentDays.push({
            date: k,
            minutes: Math.round(site.minutes || 0),
            grants: site.grants || 0,
            reasons: (site.sessions || [])
              .map(s => (s && s.reason ? String(s.reason).trim() : ''))
              .filter(Boolean),
            // How each day's passes actually ended, as a tally — "ran the
            // clock out twice yesterday" is a pattern minutes alone can't
            // show, and the trust computation reads it directly.
            outcomes: (site.sessions || []).reduce((tally, s) => {
              if (s && s.outcome) tally[s.outcome] = (tally[s.outcome] || 0) + 1;
              return tally;
            }, {}),
            walkedAway: site.walkedAway || 0,
            quickChecks: site.quickChecks || 0
          });
        }
        if (weekKeys.includes(k)) minutesWeek += site.minutes || 0;
        // Includes today deliberately: "3 walk-aways this week" should count
        // the one from an hour ago, or the streak the coach names is stale.
        if (weekKeys.includes(k)) walkedAwayWeek += site.walkedAway || 0;
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

  recentDays.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

  // The same week as a fixed series, oldest first and ending today, with the
  // days that recorded nothing present as zeros. recentDays above is the
  // coach's evidence and skips empty days; this is what the gate draws its
  // seven-day strip from, and a strip needs every day in its place. Read out
  // of the dailyStats already loaded -- no new storage.
  const dailyMinutes = weekKeys.slice().reverse().map(date => ({
    date,
    minutes: Math.round((dailyStats[date] && dailyStats[date][domain] && dailyStats[date][domain].minutes) || 0)
  }));

  return {
    minutesToday: Math.round(minutesToday),
    minutesWeek: Math.round(minutesWeek),
    minutesMonth: Math.round(minutesMonth),
    minutesYear: Math.round(minutesYear),
    minutesAllTime: Math.round(minutesAllTime),
    grantsToday,
    negotiatedToday,
    quickChecksToday,
    minutesTodayAll: Math.round(minutesTodayAll),
    minutesWeekAll: Math.round(minutesWeekAll),
    reasonsToday,
    sessionsToday,
    recentDays,
    dailyMinutes,
    walkedAwayToday,
    walkedAwayWeek
  };
}

async function getUsageLog(days = 30) {
  const { dailyStats = {} } = await getDisplayStats();
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
  const { dailyStats = {}, setupCompletedAt = 0 } = await getDisplayStats();
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
    perSiteToday,
    streak: computeStreak(dailyStats, todayKey, setupCompletedAt)
  };
}

// ---------------------------------------------------------------------------
// Streak
// ---------------------------------------------------------------------------
//
// A streak day is a day the user kept every intention: nothing on any target
// needed a pass negotiated past it. Opening a site within its intention is not
// a miss — that is the intention working — and neither is a day with no usage
// at all.
//
// It forgives. One missed day in any seven is absorbed without breaking the
// run, because a streak that shatters on the first genuine need teaches people
// to stop caring about it, and a streak that never breaks teaches nothing. A
// second miss inside the same seven days ends it.
//
// Today is in progress: a clean today counts, but a missed today does not end
// the streak until it is over — the run is reported up to yesterday plus today
// if today is clean so far, with today's miss shown as the grace it is using.
// Pure: takes the stored stats and returns numbers, so every surface agrees.

function dayKept(daySites) {
  if (!daySites || typeof daySites !== 'object') return true;
  return !Object.values(daySites).some(site => site && Number(site.negotiated) > 0);
}

// `todayKey` is dateKey() for now; `startedAt` is setupCompletedAt (ms), and
// no day before it can count toward — or against — the streak.
function computeStreak(dailyStats, todayKey, startedAt) {
  const stats = dailyStats && typeof dailyStats === 'object' ? dailyStats : {};
  const startKey = Number(startedAt) > 0 ? dateKey(new Date(Number(startedAt))) : todayKey;
  const parse = (key) => {
    const [y, m, d] = key.split('-').map(Number);
    return new Date(y, m - 1, d);
  };
  const cursor = parse(todayKey);
  const start = parse(startKey);
  const misses = [];   // day offsets (0 = today) of forgiven misses
  let days = 0;
  let offset = 0;
  while (cursor >= start && offset < 366) {
    const key = dateKey(cursor);
    const kept = dayKept(stats[key]);
    if (!kept) {
      // A miss is forgiven only if no other miss already sits within the
      // seven-day window ending on it.
      if (misses.some(o => offset - o < 7)) break;
      misses.push(offset);
    } else {
      days += 1;
    }
    cursor.setDate(cursor.getDate() - 1);
    offset += 1;
  }
  const recentMiss = misses.some(o => o < 7);
  return {
    days,
    todayKept: dayKept(stats[todayKey]),
    graceLeft: recentMiss ? 0 : 1
  };
}
