try {
  importScripts('providers.js', 'prompts.js', 'tracking.js');
} catch (e) {
  // Firefox loads these via manifest scripts array; globals already present.
}

const INT_LOG = '[Intention]';

// Sessions, chat history and check-in alarms are keyed per browser tab in the
// extensions. The native ports (Android, iOS) have no tabs — their bridges
// deliver messages with no sender.tab — so they key per blocked target
// instead. Without this every site and app on the device shares one slot: a
// second grant silently evicts the first, declining one target ends another's
// pass, and every coaching conversation appends to the same transcript.
function sessionKeyFor(tabId, target) {
  if (tabId != null) return String(tabId);
  return target ? `target:${target}` : null;
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

// Sync DNR rules based on blocked domains setting
async function syncBlockingRules() {
  try {
    const { blockedDomains = [] } = await getStorage(['blockedDomains']);
    const currentRules = await chrome.declarativeNetRequest.getDynamicRules();
    const removeRuleIds = currentRules.map(r => r.id);
    
    const isSafari = typeof navigator !== 'undefined' && 
                     navigator.userAgent && 
                     navigator.userAgent.includes('Safari') && 
                     !navigator.userAgent.includes('Chrome') && 
                     !navigator.userAgent.includes('Chromium');

    const addRules = isSafari ? [] : blockedDomains.map((domain, index) => {
      const ruleId = 1000 + index;
      const escaped = domain.replace(/[/\-\\^$*+?.()|[\]{}]/g, '\\$&');
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
          regexFilter: `^https?://(?:[^/]*\\.)?${escaped}(?:/.*)?$`,
          resourceTypes: ['main_frame']
        }
      };
    });

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
    const escaped = domain.replace(/[/\-\\^$*+?.()|[\]{}]/g, '\\$&');
    const addRules = [{
      id: ruleId,
      priority: 2,
      action: {
        type: 'allow'
      },
      condition: {
        regexFilter: `^https?://(?:[^/]*\\.)?${escaped}(?:/.*)?$`,
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
// No-op outside the Safari Web Extension runtime — see tracking.js.
syncConfigFromNative();

chrome.action.onClicked.addListener(async () => {
  const optionsUrl = chrome.runtime.getURL('options.html');
  await focusOrCreateTab(optionsUrl, () => chrome.runtime.openOptionsPage());
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  await endSession({ tabId, reason: 'closed' });
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (!alarm.name.startsWith('checkin-')) return;
  const sessionKey = alarm.name.slice('checkin-'.length);
  const tabId = /^\d+$/.test(sessionKey) ? Number(sessionKey) : null;

  if (tabId == null) {
    // Native ports: there is no content script to interrupt. The platform
    // relaunches the coach in check-in mode off its own timer (Android's
    // accessibility service), so bank the minutes now — they'd be lost if the
    // user never came back — but leave the session in place, marked ended, so
    // the check-in prompt can still quote what they said they came for.
    await bankExpiredSession(sessionKey);
    return;
  }

  // Expiration of session time -> remove DNR allow rule for this tab
  removeSessionRule(tabId);

  try {
    await chrome.tabs.sendMessage(tabId, { action: 'showCheckin' });
  } catch (e) {
    // Tab is gone, or has no content script to show the check-in in — drop the
    // session rather than leaving a pass nothing will ever close.
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
  await recordSessionMinutes(session.domain, Math.min(elapsed, session.intervalMinutes));
  await mutateStorage('activeSessions', (sessions) => {
    if (sessions[sessionKey]) sessions[sessionKey].endedAt = Date.now();
  });
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
async function reconcileSessions() {
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
  return { banked, rearmed };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then(sendResponse)
    .catch(err => sendResponse({ error: String(err?.message || err) }));
  return true;
});

async function handleMessage(message, sender) {
  const tabId = sender.tab?.id;
  switch (message.action) {
    case 'checkPageMatch': return checkPageMatch(message.host, tabId);
    case 'getConfig': {
      const config = await getFullConfig();
      // Only extension pages (options, coaching) may read the API key —
      // never content scripts, which run inside arbitrary web pages.
      const fromExtensionPage = !!sender.url && sender.url.startsWith(chrome.runtime.getURL(''));
      if (!fromExtensionPage) config.apiKey = '';
      return config;
    }
    case 'saveSetup': return saveSetup(message.config);
    case 'saveSettings': return saveSettings(message.config);
    case 'getAccess': return getAccess();
    case 'saveEntitlement': return saveEntitlement(message.entitlement);
    case 'getSession': {
      const sessionKey = sessionKeyFor(tabId, message.domain);
      if (!sessionKey) return { session: null };
      const { activeSessions = {} } = await getStorage(['activeSessions']);
      return { session: activeSession(activeSessions[sessionKey]) };
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
        newValue: message.newValue
      });
    case 'clearChatHistory':
      return clearChatHistory(message.historyKey || sessionKeyFor(tabId, message.domain));
    case 'endSession':
      return endSession({ tabId, domain: message.domain, reason: message.reason });
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
    case 'openOptions': {
      const optionsUrl = chrome.runtime.getURL('options.html');
      await focusOrCreateTab(optionsUrl, () => chrome.runtime.openOptionsPage());
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

async function checkPageMatch(host, tabId) {
  // Throttled no-op outside the Safari Web Extension runtime — see tracking.js.
  await syncConfigFromNative();
  const { blockedDomains = [], setupComplete = false, activeSessions = {} } = await getStorage(['blockedDomains', 'setupComplete', 'activeSessions']);
  const matchedDomain = blockedDomains.find(d => host === d || host.endsWith('.' + d)) || null;
  const sessionKey = sessionKeyFor(tabId, matchedDomain);
  const session = sessionKey ? activeSession(activeSessions[sessionKey]) : null;
  const access = await resolveAIRoute();
  return {
    isBlocked: !!matchedDomain,
    matchedDomain,
    setupComplete: !!setupComplete,
    accessRoute: access.route,
    session
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
      maxMinutes: isNaN(maxMinutes) ? defaults.maxMinutes : maxMinutes
    };
  }
  return defaults;
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

async function getFullConfig() {
  const keys = ['provider', 'apiKey', 'model', 'userContext', 'contextProjects', 'contextReasons', 'coachInstructions', 'blockedDomains', 'domainLimits', 'blockedApps', 'appLimits', 'appLabels', 'setupComplete', 'entitlement', 'backendUrl'];
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
    providers: PROVIDERS
  };
}

// Setup no longer carries provider credentials: a fresh install finishes the
// wizard on the hosted route (or nothing at all, which lands on the paywall
// at the first gate). Any provider/apiKey here comes from the advanced
// override and is passed through untouched.
async function saveSetup({ provider, apiKey, model, userContext, contextProjects, contextReasons, blockedDomains, domainLimits, blockedApps, appLimits, appLabels }) {
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

async function handleChat({ tabId, mode, domain, isApp, appLabel, userMessage, changeType, currentValue, newValue }) {
  const { userContext, contextProjects, contextReasons, coachInstructions } = await getStorage(['userContext', 'contextProjects', 'contextReasons', 'coachInstructions']);
  const access = await resolveAIRoute();
  if (access.route === 'locked') {
    return { error: 'You need coaching credit to talk to your coach.', locked: true };
  }

  // For apps, `domain` is the storage/stats key (an Android package name, or
  // the pseudo-target "apps" for the iOS Screen Time pass); prompts get a
  // human-readable display name instead.
  let displayName = domain;
  if (isApp || changeType === 'remove_app' || changeType === 'increase_app_limit') {
    const { appLabels = {} } = await getStorage(['appLabels']);
    const label = appLabel || appLabels[domain];
    displayName = label ? `the ${label} app` : 'a blocked app';
  }

  const sessionKey = sessionKeyFor(tabId, domain);

  let historyKey;
  if (mode === 'context' || mode === 'setup') historyKey = mode;
  else if (mode === 'settings_gate') historyKey = `settings_gate:${changeType}:${domain || 'all'}`;
  else historyKey = sessionKey;
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
      reasonsToday: stats.reasonsToday
    });
    tools = [GRANT_TOOL];
  } else if (mode === 'checkin') {
    const { activeSessions = {} } = await getStorage(['activeSessions']);
    // Deliberately not activeSession(): by check-in time the native ports have
    // already marked this one ended, and its reason is what we're after.
    const session = activeSessions[sessionKey] || {};
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
      reasonsToday: stats.reasonsToday
    });
    tools = [GRANT_TOOL];
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

  if (userMessage) history.push({ role: 'user', content: userMessage });
  if (history.length === 0) history.push({ role: 'user', content: '(user just opened the conversation)' });

  let llmResponse;
  try {
    llmResponse = await callLLM({
      provider: access.provider,
      apiKey: access.apiKey,
      model: access.model,
      accessToken: access.accessToken,
      backendUrl: access.backendUrl,
      system: systemPrompt,
      messages: history,
      tools
    });
  } catch (e) {
    if (isEntitlementError(e)) {
      await markEntitlementStale(e.code);
      return { error: e.message, locked: true };
    }
    return { error: e.message, networkError: isNetworkError(e) };
  }

  // Keeps a "credit remaining" indicator live after every message, rather
  // than only updating the next time the settings page reconciles.
  if (access.route === 'hosted') {
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

  let grantedSession = null;
  let contextUpdated = null;
  let settingApproved = null;
  let appendedNote = '';

  for (const tc of llmResponse.toolCalls || []) {
    if (tc.name === 'approve_setting_change' && mode === 'settings_gate') {
      settingApproved = await applySettingChange({ domain, changeType, newValue });
      continue;
    }
    if (tc.name === 'grant_access' && (mode === 'gate' || mode === 'checkin')) {
      const stats = await getStatsForDomain(domain);
      const limits = await getLimitsForDomain(domain);
      
      const grantsLimitReached = stats.grantsToday >= limits.maxGrants;
      const minutesLimitReached = limits.maxMinutes > 0 && stats.minutesToday >= limits.maxMinutes;
      
      if (grantsLimitReached || minutesLimitReached) {
        const reasonStr = grantsLimitReached ? "daily grant cap reached" : `absolute max of ${limits.maxMinutes} minutes reached`;
        appendedNote = `\n\n_(Intention: ${reasonStr} — no more time can be granted today, but I'm still here to talk.)_`;
        continue;
      }
      
      let minutes = Math.max(1, Math.min(60, Math.round(Number(tc.input.minutes) || 0)));
      if (limits.maxMinutes > 0) {
        const remainingMinutes = Math.max(0, limits.maxMinutes - stats.minutesToday);
        if (minutes > remainingMinutes) {
          minutes = remainingMinutes;
        }
      }
      
      if (minutes <= 0) {
        appendedNote = `\n\n_(Intention: absolute max reached — no more time can be granted today.)_`;
        continue;
      }
      
      const reason = String(tc.input.reason || '').slice(0, 240);
      await recordGrant(domain, minutes, reason);

      // Granting replaces whatever session held this key (a check-in extending
      // time, or a native port reusing the target's slot), so bank the old
      // one's minutes before it's overwritten and lost.
      const { activeSessions = {} } = await getStorage(['activeSessions']);
      const previous = activeSessions[sessionKey];
      if (previous && !isBanked(previous)) {
        const elapsed = (Date.now() - previous.startTime) / 60000;
        await recordSessionMinutes(previous.domain, Math.min(elapsed, previous.intervalMinutes));
      }

      const session = { domain, reason, intervalMinutes: minutes, startTime: Date.now() };
      await mutateStorage('activeSessions', (sessions) => { sessions[sessionKey] = session; });
      chrome.alarms.create(`checkin-${sessionKey}`, { delayInMinutes: minutes });
      // Apps have no network rules to allow — the Android accessibility
      // service reads activeSessions directly to let the app through — and
      // neither do the native ports, which have no tab to scope a rule to.
      if (!isApp && tabId != null) await registerSessionRule(tabId, domain, minutes);
      grantedSession = session;
    } else if (tc.name === 'update_context' && mode === 'context') {
      const newContext = String(tc.input.new_context || '').slice(0, 5000).trim();
      if (newContext) {
        await setStorage({ userContext: newContext });
        contextUpdated = { new_context: newContext, diff_summary: String(tc.input.diff_summary || '').slice(0, 240) };
      }
    } else if (tc.name === 'save_onboarding' && mode === 'setup') {
      const userContext = String(tc.input.user_context || '').slice(0, 5000).trim();
      const blockedDomains = (tc.input.blocked_domains || []).map(d => 
        String(d).trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0]
      ).filter(Boolean);
      
      const domainLimits = {};
      for (const item of tc.input.domain_limits || []) {
        if (item.domain) {
          const dom = String(item.domain).trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
          domainLimits[dom] = {
            maxGrants: Number(item.max_grants_per_day) || 3,
            maxMinutes: Number(item.max_minutes_per_day) ?? -1
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
      else if (changeType === 'disable_all') acceptanceFallback = `Understood — I've turned off blocking for now. Be intentional with it.`;
      else acceptanceFallback = `Okay, I'm convinced — I've made that change.`;
    }
  }
  const assistantText = (rawText || acceptanceFallback) + appendedNote;
  history.push({ role: 'assistant', content: assistantText || '(…)' });
  // Re-read under the lock: the LLM call above took seconds, and writing back
  // the copy of chatHistories read before it would drop any other
  // conversation's turns committed in the meantime.
  await mutateStorage('chatHistories', (histories) => {
    histories[historyKey] = history.slice(-40);
  });

  return { assistantText, grantedSession, contextUpdated, approved: settingApproved ? true : false };
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

  if (changeType === 'disable_all') {
    await setStorage({ blockedDomains: [], blockedApps: [], appLimits: {}, appLabels: {} });
    await syncBlockingRules();
    return { changeType, blockedDomains: [], blockedApps: [] };
  }

  return null;
}

async function clearChatHistory(historyKey) {
  if (!historyKey) return { ok: true };
  await mutateStorage('chatHistories', (chatHistories) => {
    delete chatHistories[historyKey];
  });
  return { ok: true };
}

async function endSession({ tabId, domain, reason }) {
  const sessionKey = sessionKeyFor(tabId, domain);
  if (!sessionKey) return { ok: true };

  const { activeSessions = {} } = await getStorage(['activeSessions']);
  const session = activeSessions[sessionKey];
  if (session) {
    // An already-banked session (see bankExpiredSession) must not be counted
    // twice — drop it, but don't re-record its minutes.
    if (!isBanked(session)) {
      const elapsed = (Date.now() - session.startTime) / 60000;
      await recordSessionMinutes(session.domain, Math.min(elapsed, session.intervalMinutes));
    }
    await mutateStorage('activeSessions', (sessions) => { delete sessions[sessionKey]; });
  }
  await mutateStorage('chatHistories', (chatHistories) => { delete chatHistories[sessionKey]; });
  chrome.alarms.clear(`checkin-${sessionKey}`);
  if (tabId != null) removeSessionRule(tabId);

  if (reason === 'fulfilled' && tabId != null) {
    try { chrome.tabs.remove(tabId); } catch (e) {}
  }
  return { ok: true };
}
