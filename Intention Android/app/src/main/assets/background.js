try {
  importScripts('providers.js', 'prompts.js', 'tracking.js');
} catch (e) {
  // Firefox loads these via manifest scripts array; globals already present.
}

const GRANTS_DAILY_CAP = 3;
const INT_LOG = '[Intention]';

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
    
    const coachingUrl = chrome.runtime.getURL('coaching.html');
    const addRules = blockedDomains.map((domain, index) => {
      const ruleId = 1000 + index;
      const escaped = domain.replace(/[/\-\\^$*+?.()|[\]{}]/g, '\\$&');
      return {
        id: ruleId,
        priority: 1,
        action: {
          type: 'redirect',
          redirect: {
            regexSubstitution: `${coachingUrl}?domain=${domain}`
          }
        },
        condition: {
          regexFilter: `^https?://(?:[^/]*\\.)?${escaped}(?:/.*)?$`,
          resourceTypes: ['main_frame']
        }
      };
    });

    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds,
      addRules
    });
    console.log(INT_LOG, 'Synced dynamic blocking rules:', addRules.length);
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
  const { activeSessions = {}, chatHistories = {} } = await getStorage(['activeSessions', 'chatHistories']);
  const session = activeSessions[tabId];
  if (session) {
    const elapsed = (Date.now() - session.startTime) / 60000;
    await recordSessionMinutes(session.domain, Math.min(elapsed, session.intervalMinutes));
    delete activeSessions[tabId];
    await setStorage({ activeSessions });
  }
  if (chatHistories[String(tabId)]) {
    delete chatHistories[String(tabId)];
    await setStorage({ chatHistories });
  }
  chrome.alarms.clear(`checkin-${tabId}`);
  removeSessionRule(tabId);
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (!alarm.name.startsWith('checkin-')) return;
  const tabId = parseInt(alarm.name.replace('checkin-', ''), 10);
  
  // Expiration of session time -> remove DNR allow rule for this tab
  removeSessionRule(tabId);
  
  try {
    await chrome.tabs.sendMessage(tabId, { action: 'showCheckin' });
  } catch (e) {
    const { activeSessions = {} } = await getStorage(['activeSessions']);
    if (activeSessions[tabId]) {
      delete activeSessions[tabId];
      await setStorage({ activeSessions });
    }
  }
});

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
    case 'getSession': {
      if (tabId == null) return { session: null };
      const { activeSessions = {} } = await getStorage(['activeSessions']);
      return { session: activeSessions[tabId] || null };
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
      return clearChatHistory(message.historyKey || (tabId != null ? String(tabId) : null));
    case 'endSession':
      return endSession({ tabId, reason: message.reason });
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
  const session = tabId != null ? (activeSessions[tabId] || null) : null;
  return {
    isBlocked: !!matchedDomain,
    matchedDomain,
    setupComplete: !!setupComplete,
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

async function getFullConfig() {
  const keys = ['provider', 'apiKey', 'model', 'userContext', 'contextProjects', 'contextReasons', 'coachInstructions', 'blockedDomains', 'domainLimits', 'blockedApps', 'appLimits', 'appLabels', 'setupComplete'];
  const stored = await getStorage(keys);
  return {
    setupComplete: !!stored.setupComplete,
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

async function saveSetup({ provider, apiKey, model, userContext, contextProjects, contextReasons, blockedDomains, domainLimits, blockedApps, appLimits, appLabels }) {
  await setStorage({
    provider,
    apiKey,
    model: model || PROVIDERS[provider]?.defaultModel || '',
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
  const { provider, apiKey, model, userContext, contextProjects, contextReasons, coachInstructions } = await getStorage(['provider', 'apiKey', 'model', 'userContext', 'contextProjects', 'contextReasons', 'coachInstructions']);
  if (!provider || !apiKey) return { error: 'No API key configured. Open settings to finish setup.' };

  // For apps, `domain` is the storage/stats key (an Android package name, or
  // the pseudo-target "apps" for the iOS Screen Time pass); prompts get a
  // human-readable display name instead.
  let displayName = domain;
  if (isApp || changeType === 'remove_app' || changeType === 'increase_app_limit') {
    const { appLabels = {} } = await getStorage(['appLabels']);
    const label = appLabel || appLabels[domain];
    displayName = label ? `the ${label} app` : 'a blocked app';
  }

  let historyKey;
  if (mode === 'context' || mode === 'setup') historyKey = mode;
  else if (mode === 'settings_gate') historyKey = `settings_gate:${changeType}:${domain || 'all'}`;
  else historyKey = (tabId != null ? String(tabId) : null);
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
    const session = activeSessions[tabId] || {};
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
    llmResponse = await callLLM({ provider, apiKey, model, system: systemPrompt, messages: history, tools });
  } catch (e) {
    return { error: e.message, networkError: isNetworkError(e) };
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
      const { activeSessions = {} } = await getStorage(['activeSessions']);
      activeSessions[tabId] = { domain, reason, intervalMinutes: minutes, startTime: Date.now() };
      await setStorage({ activeSessions });
      chrome.alarms.create(`checkin-${tabId}`, { delayInMinutes: minutes });
      // Apps have no network rules to allow — the Android accessibility
      // service reads activeSessions directly to let the app through.
      if (!isApp) await registerSessionRule(tabId, domain, minutes);
      grantedSession = activeSessions[tabId];
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
  chatHistories[historyKey] = history.slice(-40);
  await setStorage({ chatHistories });

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
  const { chatHistories = {} } = await getStorage(['chatHistories']);
  delete chatHistories[historyKey];
  await setStorage({ chatHistories });
  return { ok: true };
}

async function endSession({ tabId, reason }) {
  const { activeSessions = {}, chatHistories = {} } = await getStorage(['activeSessions', 'chatHistories']);
  const session = activeSessions[tabId];
  if (session) {
    const elapsed = (Date.now() - session.startTime) / 60000;
    await recordSessionMinutes(session.domain, Math.min(elapsed, session.intervalMinutes));
    delete activeSessions[tabId];
    await setStorage({ activeSessions });
  }
  if (tabId != null) {
    delete chatHistories[String(tabId)];
    await setStorage({ chatHistories });
    chrome.alarms.clear(`checkin-${tabId}`);
    removeSessionRule(tabId);
  }
  if (reason === 'fulfilled' && tabId != null) {
    try { chrome.tabs.remove(tabId); } catch (e) {}
  }
  return { ok: true };
}
