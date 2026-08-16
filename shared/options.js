async function loadEnv() {
  try {
    const res = await fetch(chrome.runtime.getURL('env.txt'));
    if (!res.ok) return {};
    const text = await res.text();
    const env = {};
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const index = trimmed.indexOf('=');
      if (index !== -1) {
        const key = trimmed.substring(0, index).trim();
        const value = trimmed.substring(index + 1).trim().replace(/^["']|["']$/g, '');
        env[key] = value;
      }
    }
    return env;
  } catch (e) {
    return {};
  }
}

function sendBg(msg) {
  return new Promise(resolve => chrome.runtime.sendMessage(msg, resolve));
}

// Chat calls (coach/settings-gate modals) can hang if the background worker
// is busy or the LLM request stalls, so unlike sendBg above they get a
// bounded timeout — above TWO of providers.js's 30s fetch timeouts, since a
// clamped grant adds a second honesty-turn call, and the background's own
// error classification should win the race — and reject on
// chrome.runtime.lastError instead of silently resolving with undefined.
function sendBgChat(msg, timeoutMs = 75000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
    try {
      chrome.runtime.sendMessage(msg, (resp) => {
        clearTimeout(timer);
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve(resp);
      });
    } catch (e) {
      clearTimeout(timer);
      reject(e);
    }
  });
}

async function getConfig() {
  return sendBg({ action: 'getConfig' });
}

document.addEventListener('DOMContentLoaded', async () => {
  populateProviderDropdowns();
  await renderCurrentView();
});

async function renderCurrentView() {
  const state = await getConfig();
  const setupComplete = !!state?.setupComplete;
  // The iOS host shows its own "turn on the Safari extension" banner, which
  // would otherwise sit on top of the wizard step that says the same thing at
  // greater length. Hand over while the wizard is running, take it back after.
  if (HAS_SAFARI_EXTENSION) window.intentionExtension.setSetupComplete(setupComplete);
  if (setupComplete) showSettingsView(state);
  else showSetupView();
}

// Only the bring-your-own-key providers are listed: the hosted provider isn't
// something the user picks, it's what a coaching-credit balance routes to.
function populateProviderDropdowns() {
  for (const id of ['provider-select-2']) {
    const sel = document.getElementById(id);
    if (!sel) continue;
    sel.innerHTML = '';
    for (const [key, cfg] of Object.entries(PROVIDERS)) {
      if (cfg.hosted) continue;
      const opt = document.createElement('option');
      opt.value = key;
      opt.textContent = cfg.label;
      sel.appendChild(opt);
    }
  }
}

const HAS_APP_BLOCKING = !!window.intentionApps;
// iOS app blocking goes through the native Screen Time bridge instead of a
// package list — the FamilyActivitySelection is opaque, so the web layer only
// sees counts and drives the native picker.
const HAS_IOS_APP_BLOCKING = !HAS_APP_BLOCKING && !!window.intentionScreenTime;
// Only the iOS host app can walk someone through Safari's extension toggle:
// iOS has no API to flip it and no deep link to the page it lives on, so the
// most an app can do is say exactly where it is and watch for the extension
// waking up. Absent everywhere else — on Chrome/Firefox/macOS the extension is
// already running by the time this page is open.
const HAS_SAFARI_EXTENSION = !!window.intentionExtension;

let setupBlockedDomains = [];
let setupDomainLimits = {};
let setupBlockedApps = [];
let setupAppLimits = {};
let setupAppLabels = {};
let setupStep = 1;
let setupStepOrder = []; // computed per-render — apps step only exists where the native bridge does
let setupBlockingMode = 'coach';
let setupSimpleBehavior = 'pass';
let setupSimplePassMinutes = 10;

let installedAppsCache = null;

function getInstalledApps() {
  if (installedAppsCache) return Promise.resolve(installedAppsCache);
  return new Promise(resolve => {
    window.intentionApps.getInstalledApps(apps => {
      installedAppsCache = apps || [];
      resolve(installedAppsCache);
    });
  });
}

function showSetupView() {
  document.getElementById('setup-view').hidden = false;
  document.getElementById('settings-view').hidden = true;

  // A welcome step first, so the wizard opens by saying what it is instead of
  // with a bare question. Anything that needs a trip outside the app (Safari's
  // extension toggle on iOS) comes next, on purpose: leaving for Settings can
  // cost the user whatever they've typed, which is nothing this early.
  // Apps get their own step ahead of websites wherever a native bridge exists,
  // and the paywall only exists in coach mode, since it's the only mode that
  // needs paid AI.
  const computeStepOrder = () => {
    const order = ['setup-step-welcome'];
    if (HAS_SAFARI_EXTENSION) order.push('setup-step-safari');
    order.push('setup-step-mode');
    if (HAS_APP_BLOCKING || HAS_IOS_APP_BLOCKING) order.push('setup-step-apps');
    order.push('setup-step-sites', 'setup-step-projects', 'setup-step-reasons');
    if (setupBlockingMode !== 'simple') order.push('setup-step-access');
    return order;
  };
  setupStepOrder = computeStepOrder();

  // ---- Step: welcome ----
  renderWelcomeStep();

  // ---- Step: Safari extension (iOS app only) ----
  if (HAS_SAFARI_EXTENSION) wireSafariStep();

  // ---- Step: mode ----
  const modeCoachBtn = document.getElementById('setup-mode-coach-btn');
  const modeSimpleBtn = document.getElementById('setup-mode-simple-btn');
  const simpleOptions = document.getElementById('setup-simple-options');
  const simpleHardBtn = document.getElementById('setup-simple-hard-btn');
  const simplePassBtn = document.getElementById('setup-simple-pass-btn');
  const simpleMinutesGroup = document.getElementById('setup-simple-minutes-group');
  const simpleMinutesInput = document.getElementById('setup-simple-minutes-input');

  // Where a store sells coaching credit, "bring your own API key" is a hidden
  // developer option rather than the way in, so saying so up front would only
  // send people looking for a key they don't need.
  document.getElementById('setup-mode-coach-desc').textContent = BYOK_IS_PRIMARY
    ? 'Talk to an AI coach to get through a block or change your rules. Needs your own LLM API key.'
    : 'Talk to an AI coach to get through a block or change your rules. Runs on coaching credit you buy in the app.';

  const renderModeStep = () => {
    modeCoachBtn.classList.toggle('selected', setupBlockingMode === 'coach');
    modeSimpleBtn.classList.toggle('selected', setupBlockingMode === 'simple');
    simpleOptions.hidden = setupBlockingMode !== 'simple';
    simpleHardBtn.classList.toggle('selected', setupSimpleBehavior === 'hard');
    simplePassBtn.classList.toggle('selected', setupSimpleBehavior === 'pass');
    simpleMinutesGroup.hidden = setupSimpleBehavior !== 'pass';
  };

  // Switching modes adds or drops the paywall step at the end of the wizard,
  // so the "Step N of M" counter has to be redrawn or it keeps promising a
  // step count that no longer exists. The mode step's own index never moves,
  // so re-showing the current step is safe.
  const onModeChanged = () => {
    renderModeStep();
    setupStepOrder = computeStepOrder();
    showStep(setupStep);
  };
  modeCoachBtn.onclick = () => { setupBlockingMode = 'coach'; onModeChanged(); };
  modeSimpleBtn.onclick = () => { setupBlockingMode = 'simple'; onModeChanged(); };
  simpleHardBtn.onclick = () => { setupSimpleBehavior = 'hard'; renderModeStep(); };
  simplePassBtn.onclick = () => { setupSimpleBehavior = 'pass'; renderModeStep(); };
  simpleMinutesInput.oninput = () => {
    setupSimplePassMinutes = Number(simpleMinutesInput.value) > 0 ? Number(simpleMinutesInput.value) : 10;
  };

  renderModeStep();

  // ---- Step: websites ----
  renderSetupDomains();

  // ---- Step: apps (only where a native bridge exists) ----
  if (HAS_APP_BLOCKING) {
    renderSetupApps();
  } else if (HAS_IOS_APP_BLOCKING) {
    renderSetupIOSApps();
  }

  wireAddModals();

  // ---- Wizard navigation ----
  const backBtn = document.getElementById('setup-back-btn');
  const nextBtn = document.getElementById('setup-next-btn');
  const saveBtn = document.getElementById('setup-save-btn');

  const showStep = (n) => {
    setupStep = n;
    const total = setupStepOrder.length;
    setupStepOrder.forEach((id, i) => {
      document.getElementById(id).hidden = i !== n - 1;
    });
    document.getElementById('setup-progress-fill').style.width = `${(n / total) * 100}%`;
    document.getElementById('setup-progress-label').textContent = `Step ${n} of ${total}`;
    backBtn.disabled = n === 1;
    nextBtn.hidden = n === total;
    saveBtn.hidden = n !== total;
    const stepId = setupStepOrder[n - 1];
    // Prices come from the store, so the paywall is only built once the user
    // actually reaches it — and rebuilt each time, to pick up a purchase made
    // and then backed out of.
    if (stepId === 'setup-step-access') {
      refreshAccessUI('setup-paywall', { compact: false });
    }
    // Both of these describe state the user can change from outside this
    // wizard (a Safari toggle, a system permission prompt), so they get
    // re-read on arrival rather than trusted from whenever the step was built.
    if (stepId === 'setup-step-safari') refreshSafariStatus();
    if (stepId === 'setup-step-apps' && HAS_IOS_APP_BLOCKING) refreshSetupIOSApps();
  };

  backBtn.onclick = () => { if (setupStep > 1) showStep(setupStep - 1); };
  nextBtn.onclick = () => { if (setupStep < setupStepOrder.length) showStep(setupStep + 1); };

  // Enter advances the single-textarea steps (Shift+Enter for a newline).
  for (const id of ['setup-projects-input', 'setup-reasons-input']) {
    document.getElementById(id).onkeydown = e => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        nextBtn.click();
      }
    };
  }

  showStep(1);

  saveBtn.onclick = () => finishSetup();
}

// The welcome step's checklist doubles as an agenda. It matters most on iOS,
// where setup has to ask for two system permissions: a permission prompt the
// user was told about a screen earlier reads as part of a plan, and the same
// prompt arriving cold reads as an app overreaching.
function renderWelcomeStep() {
  const items = [];
  if (HAS_SAFARI_EXTENSION) {
    items.push(['Turn on the Safari extension',
      "A switch in iOS Settings that lets Intention block websites. We'll show you exactly where it is."]);
  }
  if (HAS_IOS_APP_BLOCKING) {
    items.push(['Allow Screen Time',
      'Apple’s permission for blocking apps. Intention uses it only to shield the apps you pick.']);
  }
  items.push(['Choose your sites and apps',
    'The ones you want a moment of friction in front of.']);
  items.push(['Say what you’re trying to focus on',
    'Two short answers, so a block can point at your own reasons instead of just saying no.']);

  const list = document.getElementById('setup-welcome-checklist');
  list.innerHTML = '';
  for (const [title, detail] of items) {
    const li = document.createElement('li');
    const strong = document.createElement('strong');
    strong.textContent = title;
    const span = document.createElement('span');
    span.textContent = detail;
    li.append(strong, span);
    list.appendChild(li);
  }
}

// ---- Step: Safari extension (iOS app only) ----

function wireSafariStep() {
  document.getElementById('setup-safari-settings-btn').addEventListener('click', () => {
    window.intentionExtension.openSettings();
  });
  document.getElementById('setup-safari-open-btn').addEventListener('click', () => {
    window.intentionExtension.openSafari();
  });
  // Returning from Settings or Safari is the one moment this answer can
  // change, and a WKWebView gets no dependable visibilitychange for an app
  // switch — so the host fires this event instead, from
  // ViewController.appDidBecomeActive.
  window.addEventListener('intention-app-active', () => {
    if (setupStepOrder[setupStep - 1] === 'setup-step-safari') refreshSafariStatus();
  });
  refreshSafariStatus();
}

async function refreshSafariStatus() {
  if (!HAS_SAFARI_EXTENSION) return;
  const listEl = document.getElementById('setup-safari-steps');
  const statusEl = document.getElementById('setup-safari-status');
  const settingsBtn = document.getElementById('setup-safari-settings-btn');
  const openBtn = document.getElementById('setup-safari-open-btn');
  const hintEl = document.getElementById('setup-safari-skip-hint');
  const st = await new Promise(resolve => window.intentionExtension.status(resolve));

  // The Settings path moved in iOS 18, so the host reports the one that
  // matches this device rather than the page guessing. The button below opens
  // the Settings app itself (iOS has no public deep link into the Extensions
  // page), so the first step is still spelled out in full for the last few taps.
  const path = (st && st.settingsPath) || 'Settings → Apps → Safari → Extensions';
  listEl.innerHTML = '';
  for (const text of [
    `Tap "Open Settings" below, then go to ${path}.`,
    'Turn on Intention Safari Extension.',
    'Set it to Allow for every website, or it can only see the sites you approve one at a time.',
    'Come back here and tap "I turned it on" — this page notices on its own once the extension has run.'
  ]) {
    const li = document.createElement('li');
    li.textContent = text;
    listEl.appendChild(li);
  }

  const active = !!(st && st.active);
  listEl.hidden = active;
  settingsBtn.hidden = active;
  openBtn.hidden = active;
  hintEl.hidden = active;
  statusEl.className = active ? 'setup-check ok' : 'setup-check';
  statusEl.textContent = active
    ? 'The Safari extension is on and running. Nothing else to do here.'
    : 'Not running yet. After turning it on, open Safari and load any page once. That’s what wakes the extension up.';
}

// Commits whatever the wizard currently holds and switches to the settings
// view. Called by the wizard's own finish button, and by the paywall's "use my
// own key" link, which has to leave the wizard for a field that only exists in
// the settings view.
async function finishSetup() {
  const isSimple = setupBlockingMode === 'simple';

  const projectsAns = document.getElementById('setup-projects-input').value.trim();
  const reasonsAns = document.getElementById('setup-reasons-input').value.trim();

  // Create user context
  const userContext = `Goals and activities I want to focus on:
${projectsAns || '(not configured)'}

How distracting sites make me feel and why I want to step away:
${reasonsAns || '(not configured)'}`;

  const simpleOverrides = isSimple ? { behavior: setupSimpleBehavior, passMinutes: setupSimplePassMinutes } : {};

  // Build domain limits object
  const domainLimits = {};
  for (const d of setupBlockedDomains) {
    domainLimits[d] = setupDomainLimits[d] || {
      maxGrants: 3,
      maxMinutes: 10,
      ...simpleOverrides
    };
  }

  // Build app limits object
  const appLimits = {};
  for (const p of setupBlockedApps) {
    appLimits[p] = setupAppLimits[p] || {
      maxGrants: 3,
      maxMinutes: 10,
      ...simpleOverrides
    };
  }

  setStatus('setup-status', 'Saving setup...', 'info');

  // No provider/key is collected here any more: the coach reaches the hosted
  // route through whatever access the paywall step set up, and a custom key
  // is a Settings -> Advanced option for developers. Sending empty strings
  // leaves saveSetup's existing defaults in charge.
  await sendBg({
    action: 'saveSetup',
    config: {
      provider: '',
      apiKey: '',
      model: '',
      userContext,
      contextProjects: projectsAns,
      contextReasons: reasonsAns,
      blockedDomains: setupBlockedDomains,
      domainLimits,
      blockedApps: setupBlockedApps,
      appLimits,
      appLabels: setupAppLabels,
      blockingMode: setupBlockingMode,
      simpleBehavior: setupSimpleBehavior,
      simplePassMinutes: setupSimplePassMinutes
    }
  });

  await renderCurrentView();
}


// ---------------------------------------------------------------------------
// AI access: coaching-credit purchase, restore, and the paywall
// ---------------------------------------------------------------------------

function getAccessState() {
  return sendBg({ action: 'getAccess' });
}

function persistEntitlement(entitlement) {
  return sendBg({ action: 'saveEntitlement', entitlement });
}

async function currentBackendUrl() {
  const state = await getConfig();
  return state?.backendUrl || '';
}

// Hands the store's receipt to the backend, which checks it with Apple/Google
// and mints the token coach calls are made with. A purchase we can't confirm
// right now is kept (with its receipt) rather than thrown away, so the retry on
// the next load can turn it into access without charging anyone twice.
async function verifyAndStore(platform, receipt) {
  const backendUrl = await currentBackendUrl();
  try {
    const entitlement = await verifyPurchase({ platform, receipt, backendUrl });
    await persistEntitlement(entitlement);
    return entitlement;
  } catch (e) {
    await persistEntitlement({
      active: false,
      source: platform,
      receipt,
      pendingVerification: true,
      lastError: String(e.message || e)
    });
    throw new Error("Your purchase went through, but we couldn't confirm it yet. It'll be applied automatically — reopen Settings to retry.");
  }
}

// Re-checks a stored entitlement against the backend — a purchase that
// couldn't be verified when it was made, or (rarely) a stored token that's
// simply missing. There's no renewal to pre-empt for a top-up, so unlike the
// old subscription version, this only re-checks when something is actually
// unresolved rather than on a timer.
async function reconcileEntitlement(entitlement) {
  if (!entitlement) return null;
  const stale = entitlement.pendingVerification || !entitlement.token;
  if (!stale) return entitlement;
  const backendUrl = await currentBackendUrl();
  const refreshed = await refreshEntitlement(entitlement, backendUrl);
  if (refreshed && entitlementSignature(refreshed) !== entitlementSignature(entitlement)) {
    await persistEntitlement(refreshed);
  }
  return refreshed;
}

async function refreshAccessUI(containerId, { compact = false } = {}) {
  const container = document.getElementById(containerId);
  if (!container) return;
  const access = await getAccessState();
  const entitlement = access?.entitlement || null;

  const rerender = () => refreshAccessUI(containerId, { compact });

  await renderPaywall(container, {
    entitlement,
    compact,
    onPurchase: async (productId) => {
      const result = await purchaseProduct(productId);
      if (!result || result.status === 'cancelled') return;
      if (result.status === 'pending') {
        throw new Error('Your purchase is pending approval. It will unlock automatically once approved.');
      }
      if (result.status !== 'purchased') {
        throw new Error(result.error || "The purchase didn't complete.");
      }
      await verifyAndStore(result.platform || storePlatform(), result.receipt);
      await rerender();
      await onAccessChanged();
    },
    onRestore: async () => {
      const result = await restorePurchases();
      if (!result || !result.receipt) {
        throw new Error(result?.error || 'No pending purchase found.');
      }
      await verifyAndStore(result.platform || storePlatform(), result.receipt);
      await rerender();
      await onAccessChanged();
    },
    onRedeem: async (code) => {
      const backendUrl = await currentBackendUrl();
      const entitlement = await redeemAccessCode(code, backendUrl);
      if (!entitlementIsActive(entitlement)) throw new Error('That code isn\'t active.');
      await persistEntitlement(entitlement);
      await rerender();
      await onAccessChanged();
    },
    onLinkBrowser: async () => {
      const backendUrl = await currentBackendUrl();
      return requestAccessCode(entitlement, backendUrl);
    },
    // Only offered where no store sells credit (Chrome/Firefox); elsewhere
    // the key field exists solely in Settings -> Advanced.
    onUseOwnKey: BYOK_IS_PRIMARY ? () => openAdvancedKeySection() : null
  });

  // A verified purchase that arrived while the app was closed settles here.
  const reconciled = await reconcileEntitlement(entitlement);
  if (entitlementSignature(reconciled) !== entitlementSignature(entitlement)) {
    await refreshAccessUI(containerId, { compact });
    await onAccessChanged();
  }
}

function storePlatform() {
  return HAS_APP_BLOCKING ? 'google' : 'apple';
}

// Called after any change that can flip the access route, so the settings view
// stops offering a locked coach (or starts offering an unlocked one).
async function onAccessChanged() {
  const access = await getAccessState();
  const modal = document.getElementById('paywall-modal');
  if (access?.route !== 'locked' && modal && !modal.hidden) modal.hidden = true;
}

// The setup wizard and the settings view both need a way to send someone who
// is locked out to the purchase flow without derailing what they were doing.
async function openPaywallModal() {
  const modal = document.getElementById('paywall-modal');
  modal.hidden = false;
  await refreshAccessUI('paywall-modal-body', { compact: true });
}

async function openAdvancedKeySection() {
  // Reached from the onboarding paywall on browser builds: the advanced field
  // lives in the settings view, so the wizard has to be committed first or the
  // click would silently do nothing behind a hidden view.
  if (!document.getElementById('setup-view').hidden) {
    await finishSetup();
  }
  setSettingsSection('settings');
  const advanced = document.getElementById('advanced-card');
  const keyDetails = document.getElementById('custom-key-details');
  const modal = document.getElementById('paywall-modal');
  if (modal) modal.hidden = true;
  if (advanced) advanced.open = true;
  if (keyDetails) {
    keyDetails.open = true;
    keyDetails.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  document.getElementById('api-key-input-2')?.focus();
}

// Every coach entry point funnels through this: with no access, the paywall
// opens instead of a conversation that would only fail at the LLM call.
async function requireAccess() {
  const access = await getAccessState();
  if (access?.route === 'locked') {
    await openPaywallModal();
    return false;
  }
  return true;
}

function buildRecommendCard(meta, label, title, onAdd) {
  const card = document.createElement('button');
  card.type = 'button';
  card.className = 'recommend-card';
  card.title = title;
  // A catalogue entry can name something Simple Icons has no mark for (Daily
  // Mail, Prime Video); those chips are text-only rather than absent.
  if (meta && meta.icon) {
    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('class', 'chip-icon');
    svg.setAttribute('fill', meta.color);
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS(svgNS, 'path');
    path.setAttribute('d', meta.icon);
    svg.appendChild(path);
    card.appendChild(svg);
  }
  const name = document.createElement('span');
  name.className = 'recommend-card-name';
  name.textContent = label;
  card.appendChild(name);
  const addIcon = document.createElement('span');
  addIcon.className = 'recommend-card-add';
  addIcon.textContent = '+';
  addIcon.setAttribute('aria-hidden', 'true');
  card.appendChild(addIcon);
  card.addEventListener('click', onAdd);
  return card;
}

// How many suggestions sit above the fold. Detected sites are never folded
// away — they are the whole point of detecting them — so this is a floor on
// what shows, not a ceiling.
const RECOMMEND_VISIBLE = 6;

// Expanded state is per grid, so opening the sites list doesn't also open the
// apps one, and it survives the re-render that adding a suggestion triggers.
const recommendExpanded = {};

// Both grids want the same tally, and the setup wizard re-renders on every
// add, so ask the worker once per page load. A visit banked while the page is
// open can wait for the next one.
let siteVisitsPromise = null;
function getSiteVisits() {
  if (!siteVisitsPromise) {
    siteVisitsPromise = sendBg({ action: 'getSiteVisits' }).then(r => r || {}, () => ({}));
  }
  return siteVisitsPromise;
}

// Shared tail of both grids: lay out `ordered`, fold everything past the cap
// behind the "show more" button, and label the detected run at the front.
// `seenCount` is how many leading entries came from the visit tally.
function renderRecommendGrid(container, more, ordered, seenCount, buildCard, rerender) {
  const expanded = !!recommendExpanded[container.id];
  const cap = Math.max(seenCount, RECOMMEND_VISIBLE);
  const shown = expanded ? ordered : ordered.slice(0, cap);

  container.innerHTML = '';
  // The labels are grid items themselves (the row is a wrapping flex line, and
  // a full-width item breaks it), so an unvisited chip can't be mistaken for
  // one the person actually opens.
  const addLabel = (text) => {
    const label = document.createElement('p');
    label.className = 'recommend-label';
    label.textContent = text;
    container.appendChild(label);
  };
  if (seenCount > 0) addLabel("You've been on these");
  shown.forEach((item, i) => {
    if (seenCount > 0 && i === seenCount) addLabel('Commonly blocked');
    container.appendChild(buildCard(item));
  });
  container.hidden = ordered.length === 0;

  const folded = ordered.length - shown.length;
  more.hidden = ordered.length === 0 || (!expanded && folded === 0);
  more.textContent = expanded ? 'Show fewer' : `Show ${folded} more`;
  more.onclick = () => {
    recommendExpanded[container.id] = !expanded;
    rerender();
  };
}

async function renderSiteRecommendations(containerId, moreId, blockedDomains) {
  const container = document.getElementById(containerId);
  const more = document.getElementById(moreId);
  const pool = COMMON_SITES.filter(s => !blockedDomains.includes(s) && !RECOMMEND_IGNORE_SITES.includes(s));
  const visits = await getSiteVisits();
  // Visited candidates lead, most-visited first; the rest keep the
  // catalogue's own order. With an empty tally this is just that order.
  const seen = pool
    .filter(s => visits[s] && visits[s].count > 0)
    .sort((a, b) => visits[b].count - visits[a].count);
  const seenSet = new Set(seen);
  const ordered = [...seen, ...pool.filter(s => !seenSet.has(s))];
  renderRecommendGrid(
    container, more, ordered, seen.length,
    (site) => {
      const meta = SITE_META[site];
      return buildRecommendCard(meta, meta ? meta.name : site, site, () => addDomainToBlocklist(site, 10));
    },
    () => renderSiteRecommendations(containerId, moreId, blockedDomains)
  );
}

function renderAppRecommendations(containerId, moreId, blockedApps) {
  const container = document.getElementById(containerId);
  const more = document.getElementById(moreId);
  container.innerHTML = '';
  if (!HAS_APP_BLOCKING) {
    container.hidden = true;
    more.hidden = true;
    return;
  }
  getInstalledApps().then(installed => {
    const installedPkgs = new Set(installed.map(a => a.packageName));
    // Apps have no equivalent of the visit tally — Android blocks natively, so
    // nothing on this device sees app launches until one is already blocked —
    // but "is it even installed" is the same kind of signal, and it does most
    // of the same narrowing.
    const pool = COMMON_APPS.filter(a =>
      installedPkgs.has(a.packageName) &&
      !blockedApps.includes(a.packageName) &&
      !RECOMMEND_IGNORE_APPS.includes(a.packageName)
    );
    renderRecommendGrid(
      container, more, pool, 0,
      (app) => {
        const meta = SITE_META[APP_ICON_SITE[app.packageName]];
        return buildRecommendCard(meta, app.label, app.packageName, () => addApp(app));
      },
      () => renderAppRecommendations(containerId, moreId, blockedApps)
    );
  });
}

// Wires a search input to the installed-apps list from the native bridge.
// isSelected hides already-blocked apps; onAdd is called with {packageName, label}.
function wireAppSearch(inputId, resultsId, isSelected, onAdd) {
  const input = document.getElementById(inputId);
  const results = document.getElementById(resultsId);
  // Detach the results list to <body> so it renders as a floating popup,
  // fixed-positioned under the input, instead of being trapped inside the
  // stacking context of ancestors like .card (which use backdrop-filter).
  document.body.appendChild(results);
  const positionResults = () => {
    const rect = input.getBoundingClientRect();
    results.style.left = rect.left + 'px';
    results.style.top = (rect.bottom + 6) + 'px';
    results.style.width = rect.width + 'px';
  };
  window.addEventListener('scroll', () => {
    if (!results.hidden) positionResults();
  }, true);
  window.addEventListener('resize', () => {
    if (!results.hidden) positionResults();
  });
  const render = async () => {
    const q = input.value.trim().toLowerCase();
    results.innerHTML = '';
    if (!q) {
      results.hidden = true;
      return;
    }
    positionResults();
    const apps = await getInstalledApps();
    const matches = apps.filter(a =>
      !isSelected(a.packageName) &&
      (a.label.toLowerCase().includes(q) || a.packageName.toLowerCase().includes(q))
    ).slice(0, 8);
    results.hidden = matches.length === 0;
    for (const app of matches) {
      const li = document.createElement('li');

      if (app.icon) {
        const icon = document.createElement('img');
        icon.className = 'app-icon';
        icon.src = app.icon;
        icon.alt = '';
        li.appendChild(icon);
      }

      const infoContainer = document.createElement('div');
      infoContainer.className = 'domain-info';
      const span = document.createElement('span');
      span.textContent = app.label;
      span.className = 'domain-name';
      infoContainer.appendChild(span);
      const pkgSpan = document.createElement('span');
      pkgSpan.textContent = app.packageName;
      pkgSpan.className = 'app-pkg';
      infoContainer.appendChild(pkgSpan);
      li.appendChild(infoContainer);

      const btn = document.createElement('button');
      btn.textContent = 'Block';
      btn.className = 'secondary';
      btn.addEventListener('click', () => {
        onAdd(app);
        input.value = '';
        results.innerHTML = '';
        results.hidden = true;
      });
      li.appendChild(btn);
      results.appendChild(li);
    }
  };
  input.addEventListener('input', render);
  input.addEventListener('focus', () => {
    if (input.value.trim()) render();
  });
  document.addEventListener('click', (e) => {
    if (!results.hidden && e.target !== input && !results.contains(e.target)) {
      results.hidden = true;
    }
  });
}

function renderSetupDomains() {
  renderSiteRecommendations('setup-sites-recommend-grid', 'setup-sites-recommend-more', setupBlockedDomains);
  const list = document.getElementById('setup-websites-list');
  list.innerHTML = '';
  for (const d of setupBlockedDomains) {
    const li = document.createElement('li');
    
    const infoContainer = document.createElement('div');
    infoContainer.className = 'domain-info';
    
    const span = document.createElement('span');
    span.textContent = d;
    span.className = 'domain-name';
    infoContainer.appendChild(span);

    const limitInfo = setupDomainLimits[d] || { maxGrants: 3, maxMinutes: 10 };
    
    const limitSpan = document.createElement('span');
    limitSpan.className = 'domain-limit-badge';
    limitSpan.appendChild(document.createTextNode('Absolute Max: '));

    const inlineInput = document.createElement('input');
    inlineInput.type = 'number';
    inlineInput.min = '1';
    inlineInput.className = 'inline-limit-input';
    inlineInput.value = limitInfo.maxMinutes;
    inlineInput.addEventListener('change', (e) => {
      const val = parseInt(e.target.value, 10);
      if (!isNaN(val) && val > 0) {
        if (!setupDomainLimits[d]) {
          setupDomainLimits[d] = { maxGrants: 3 };
        }
        setupDomainLimits[d].maxMinutes = val;
      }
    });

    limitSpan.appendChild(inlineInput);
    limitSpan.appendChild(document.createTextNode(' min/day'));
    infoContainer.appendChild(limitSpan);
    
    li.appendChild(infoContainer);
    
    const btn = document.createElement('button');
    btn.textContent = 'Remove';
    btn.className = 'delete-btn';
    btn.addEventListener('click', () => {
      setupBlockedDomains = setupBlockedDomains.filter(x => x !== d);
      delete setupDomainLimits[d];
      renderSetupDomains();
    });
    li.appendChild(btn);
    list.appendChild(li);
  }
}

function addSetupApp(app) {
  if (setupBlockedApps.includes(app.packageName)) return;
  setupBlockedApps.push(app.packageName);
  setupAppLimits[app.packageName] = { maxGrants: 3, maxMinutes: 10 };
  setupAppLabels[app.packageName] = app.label;
  renderSetupApps();
}

function renderSetupApps() {
  renderAppRecommendations('setup-apps-recommend-grid', 'setup-apps-recommend-more', setupBlockedApps);
  const list = document.getElementById('setup-apps-list');
  list.innerHTML = '';
  for (const pkg of setupBlockedApps) {
    const li = document.createElement('li');

    const infoContainer = document.createElement('div');
    infoContainer.className = 'domain-info';

    const span = document.createElement('span');
    span.textContent = setupAppLabels[pkg] || pkg;
    span.className = 'domain-name';
    infoContainer.appendChild(span);

    const limitInfo = setupAppLimits[pkg] || { maxGrants: 3, maxMinutes: 10 };

    const limitSpan = document.createElement('span');
    limitSpan.className = 'domain-limit-badge';
    limitSpan.appendChild(document.createTextNode('Absolute Max: '));

    const inlineInput = document.createElement('input');
    inlineInput.type = 'number';
    inlineInput.min = '1';
    inlineInput.className = 'inline-limit-input';
    inlineInput.value = limitInfo.maxMinutes;
    inlineInput.addEventListener('change', (e) => {
      const val = parseInt(e.target.value, 10);
      if (!isNaN(val) && val > 0) {
        if (!setupAppLimits[pkg]) {
          setupAppLimits[pkg] = { maxGrants: 3 };
        }
        setupAppLimits[pkg].maxMinutes = val;
      }
    });

    limitSpan.appendChild(inlineInput);
    limitSpan.appendChild(document.createTextNode(' min/day'));
    infoContainer.appendChild(limitSpan);

    li.appendChild(infoContainer);

    const btn = document.createElement('button');
    btn.textContent = 'Remove';
    btn.className = 'delete-btn';
    btn.addEventListener('click', () => {
      setupBlockedApps = setupBlockedApps.filter(x => x !== pkg);
      delete setupAppLimits[pkg];
      delete setupAppLabels[pkg];
      renderSetupApps();
    });
    li.appendChild(btn);
    list.appendChild(li);
  }
}

// iOS app blocking is opaque (Screen Time's FamilyActivitySelection, not a
// package list) — Apple's picker can't be pre-filtered to a specific app, so
// per-app tiles would all just open the same blank picker. Instead: name
// popular picks as plain text and drive everything through the one real
// "Choose apps to block" button, mirroring wireIOSAppsCard.
function renderSetupIOSApps() {
  document.getElementById('setup-apps-title').textContent = 'Block distracting apps';
  document.getElementById('setup-apps-subtitle').textContent =
    `Apps are blocked through Apple's Screen Time, so the picker below is Apple's own. Intention never learns which apps are on your phone, only how many you chose. Most people start with ${COMMON_APPS.slice(0, 4).map(a => a.label).join(', ')}. You can skip this and add apps later.`;
  document.getElementById('setup-open-add-app-btn').textContent = 'Choose apps to block';
  document.getElementById('setup-apps-recommend-grid').hidden = true;
  document.getElementById('setup-apps-recommend-grid').innerHTML = '';
  document.getElementById('setup-apps-recommend-more').hidden = true;
  document.getElementById('setup-apps-list').hidden = true;
  document.getElementById('setup-ios-apps-status').hidden = false;
  refreshSetupIOSApps();
}

async function refreshSetupIOSApps() {
  const statusEl = document.getElementById('setup-ios-apps-status');
  const authorizeBtn = document.getElementById('setup-ios-authorize-btn');
  const st = await iosScreenTimeStatus();

  if (!st || !st.available) {
    statusEl.textContent = 'App blocking needs iOS 16 or later. Website blocking still works.';
    statusEl.className = 'setup-check';
    authorizeBtn.hidden = true;
    return;
  }
  if (!st.authorized) {
    statusEl.textContent = iosAuthGuidance(st);
    statusEl.className = 'setup-check';
    authorizeBtn.hidden = false;
    return;
  }
  authorizeBtn.hidden = true;
  const n = st.selectionCount || 0;
  statusEl.className = n === 0 ? 'setup-check' : 'setup-check ok';
  statusEl.textContent = n === 0
    ? 'Screen Time access granted. No apps chosen yet, so tap "Choose apps to block" above.'
    : `${n} app${n === 1 ? '' : 's or categories'} blocked.`;
}

// Unauthorized states need different guidance: before the first prompt it's a
// simple ask, but after a decline iOS may stop re-prompting, so point at the
// Screen Time settings page where access can be turned back on.
function iosAuthGuidance(st) {
  if (st.authorizationStatus === 'denied') {
    return 'Screen Time access was declined, so Apple\'s app picker can\'t load. Tap "Allow Screen Time" to try again; if no prompt appears, iOS has stopped asking, so open Settings → Screen Time → Apps with Screen Time Access and turn on Intention.';
  }
  return 'iOS will ask you to allow Screen Time access the first time you choose apps. Say yes: without it, Intention has no way to shield an app.';
}

// ---- Mobile Apps/Websites tab toggle ----

let activeSettingsTab = 'apps'; // apps shown first, per spec

function initSettingsTabs() {
  const tabsEl = document.getElementById('settings-tabs');
  const showTabs = HAS_APP_BLOCKING || HAS_IOS_APP_BLOCKING;
  tabsEl.hidden = !showTabs;
  if (!showTabs) return;
  document.getElementById('tab-apps-btn').addEventListener('click', () => setSettingsTab('apps'));
  document.getElementById('tab-websites-btn').addEventListener('click', () => setSettingsTab('websites'));
  applySettingsTab();
}

function setSettingsTab(tab) {
  activeSettingsTab = tab;
  applySettingsTab();
}

function applySettingsTab() {
  document.getElementById('tab-apps-btn').classList.toggle('selected', activeSettingsTab === 'apps');
  document.getElementById('tab-websites-btn').classList.toggle('selected', activeSettingsTab === 'websites');
  document.getElementById('apps-card').classList.toggle('tab-hidden', activeSettingsTab !== 'apps');
  document.getElementById('websites-card').classList.toggle('tab-hidden', activeSettingsTab !== 'websites');
}

// ---- Mobile section tabs (Blocking / Activity / Coach / Unlock / Settings) ----

const SETTINGS_SECTIONS = ['blocking', 'activity', 'coach', 'unlock', 'settings'];
let activeSettingsSection = (() => {
  try {
    const saved = localStorage.getItem('activeSettingsSection');
    return SETTINGS_SECTIONS.includes(saved) ? saved : 'blocking';
  } catch (e) { return 'blocking'; }
})();

function initSectionTabs() {
  document.querySelectorAll('#section-tabs [data-section-tab]').forEach(btn => {
    btn.addEventListener('click', () => setSettingsSection(btn.dataset.sectionTab));
  });
  applySettingsSection();
  applyDeepLinkSection();
}

// A `?section=` query param (e.g. from the chat's "invalid API key" error
// button) overrides whatever tab localStorage last remembered, so the user
// actually lands where the link promised instead of wherever they left off.
function applyDeepLinkSection() {
  const section = new URLSearchParams(window.location.search).get('section');
  if (!section || !SETTINGS_SECTIONS.includes(section)) return;
  setSettingsSection(section);
  const target = document.querySelector(`#settings-view [data-section="${section}"]`);
  target?.scrollIntoView({ block: 'start' });
  if (section === 'settings') document.getElementById('api-key-input-2')?.focus();
}

function setSettingsSection(section) {
  activeSettingsSection = section;
  try { localStorage.setItem('activeSettingsSection', section); } catch (e) {}
  applySettingsSection();
}

function applySettingsSection() {
  document.querySelectorAll('#section-tabs [data-section-tab]').forEach(btn => {
    btn.classList.toggle('selected', btn.dataset.sectionTab === activeSettingsSection);
  });
  document.querySelectorAll('#settings-view [data-section]').forEach(el => {
    el.classList.toggle('section-hidden', el.dataset.section !== activeSettingsSection);
  });
}

// ---- Add-item popup modals ----

function openAddModal(modalId, focusInputId) {
  document.getElementById(modalId).hidden = false;
  document.getElementById(focusInputId)?.focus();
}

function closeAddModal(modalId) {
  document.getElementById(modalId).hidden = true;
}

// The "+ Add website"/"+ Add app" modals are shared singletons used by both
// the setup wizard and the settings view, so they're wired once; addDomain()
// and addApp() branch on which view is currently active.
let addModalsWired = false;
function wireAddModals() {
  if (addModalsWired) return;
  addModalsWired = true;

  document.getElementById('open-add-site-btn')?.addEventListener('click', () => openAddModal('add-site-modal', 'domain-input'));
  document.getElementById('setup-open-add-site-btn')?.addEventListener('click', () => openAddModal('add-site-modal', 'domain-input'));
  document.getElementById('close-add-site-btn').addEventListener('click', () => closeAddModal('add-site-modal'));
  document.getElementById('add-btn').addEventListener('click', async () => { await addDomain(); closeAddModal('add-site-modal'); });
  document.getElementById('domain-input').addEventListener('keydown', async e => {
    if (e.key === 'Enter') { await addDomain(); closeAddModal('add-site-modal'); }
  });
  document.getElementById('domain-limit-input').addEventListener('keydown', async e => {
    if (e.key === 'Enter') { await addDomain(); closeAddModal('add-site-modal'); }
  });

  if (HAS_APP_BLOCKING) {
    document.getElementById('open-add-app-btn')?.addEventListener('click', () => openAddModal('add-app-modal', 'app-search-input'));
    document.getElementById('setup-open-add-app-btn')?.addEventListener('click', () => openAddModal('add-app-modal', 'app-search-input'));
    document.getElementById('close-add-app-btn').addEventListener('click', () => closeAddModal('add-app-modal'));
    wireAppSearch(
      'app-search-input',
      'app-search-results',
      pkg => (document.getElementById('setup-view').hidden ? settingsBlockedApps : setupBlockedApps).includes(pkg),
      app => { addApp(app); closeAddModal('add-app-modal'); }
    );
  } else if (HAS_IOS_APP_BLOCKING) {
    document.getElementById('setup-open-add-app-btn')?.addEventListener('click', () => {
      window.intentionScreenTime.pickApps(() => refreshSetupIOSApps());
    });
    document.getElementById('setup-ios-authorize-btn')?.addEventListener('click', () => {
      window.intentionScreenTime.authorize(() => refreshSetupIOSApps());
    });
  }
}

// Once context exists, it's chat-only by design (see subtitle copy) — but
// there's no "weak moment" to guard against before it exists in the first
// place, so the very first write can happen directly.
function renderContextCard(userContext) {
  const contextDisplay = document.getElementById('context-display');
  const contextEditInput = document.getElementById('context-edit-input');
  const contextSubtitle = document.getElementById('context-subtitle');
  const saveContextBtn = document.getElementById('save-context-btn');
  const hasContext = !!(userContext && userContext.trim());
  contextDisplay.hidden = !hasContext;
  contextEditInput.hidden = hasContext;
  saveContextBtn.hidden = hasContext;
  contextSubtitle.textContent = hasContext
    ? "The coach updates this only through conversation with you, so you can't silently rewrite the rules in a weak moment."
    : "Nothing set yet. Write it yourself, or talk it through with your coach.";
  if (hasContext) {
    contextDisplay.textContent = userContext;
  } else {
    contextEditInput.value = '';
  }
}

// The coach's cross-day notepad (see note_observation in background.js).
// Readable and clearable here because a memory the user can't inspect would
// be a dossier, not a notepad.
async function renderCoachObservations() {
  const list = document.getElementById('coach-observations-list');
  const stored = await new Promise(resolve => chrome.storage.local.get('coachObservations', resolve));
  const observations = stored.coachObservations || [];
  list.innerHTML = '';
  if (!observations.length) {
    const li = document.createElement('li');
    li.className = 'muted';
    li.textContent = '(nothing yet)';
    list.appendChild(li);
    return;
  }
  for (const obs of observations) {
    const li = document.createElement('li');
    // Model-authored text: textContent only, never innerHTML.
    li.textContent = (obs && obs.text) || '';
    list.appendChild(li);
  }
}

// Global blocking-mode card in Settings: Coach vs Simple, and (for Simple) the
// default hard/pass behavior + pass length. Per-row controls (buildRowModeControl)
// let individual sites/apps override this global default.
function wireBlockingModeCard(state) {
  const coachBtn = document.getElementById('settings-mode-coach-btn');
  const simpleBtn = document.getElementById('settings-mode-simple-btn');
  const simpleOptions = document.getElementById('settings-simple-options');
  const hardBtn = document.getElementById('settings-simple-hard-btn');
  const passBtn = document.getElementById('settings-simple-pass-btn');
  const minutesGroup = document.getElementById('settings-simple-minutes-group');
  const minutesInput = document.getElementById('settings-simple-minutes-input');
  const saveBtn = document.getElementById('save-blocking-mode-btn');

  let mode = state.blockingMode || 'coach';
  let behavior = state.simpleBehavior || 'pass';
  minutesInput.value = state.simplePassMinutes || 10;

  function render() {
    coachBtn.classList.toggle('selected', mode === 'coach');
    simpleBtn.classList.toggle('selected', mode === 'simple');
    simpleOptions.hidden = mode !== 'simple';
    hardBtn.classList.toggle('selected', behavior === 'hard');
    passBtn.classList.toggle('selected', behavior === 'pass');
    minutesGroup.hidden = behavior !== 'pass';
  }
  render();

  coachBtn.onclick = () => { mode = 'coach'; render(); };
  simpleBtn.onclick = () => { mode = 'simple'; render(); };
  hardBtn.onclick = () => { behavior = 'hard'; render(); };
  passBtn.onclick = () => { behavior = 'pass'; render(); };

  saveBtn.onclick = async () => {
    const simplePassMinutes = Number(minutesInput.value) > 0 ? Number(minutesInput.value) : 10;
    await sendBg({ action: 'saveSettings', config: { blockingMode: mode, simpleBehavior: behavior, simplePassMinutes } });
    setStatus('blocking-mode-status', 'Saved.', 'success');
    const fresh = await getConfig();
    renderDomains(fresh.blockedDomains || [], fresh.domainLimits || {}, fresh.blockingMode);
    if (HAS_APP_BLOCKING) {
      renderApps(fresh.blockedApps || [], fresh.appLimits || {}, fresh.appLabels || {}, fresh.blockingMode);
    }
  };
}

async function showSettingsView(state) {
  document.getElementById('setup-view').hidden = true;
  document.getElementById('settings-view').hidden = false;

  renderContextCard(state.userContext);
  await renderCoachObservations();

  document.getElementById('clear-observations-btn').addEventListener('click', async () => {
    await new Promise(resolve => chrome.storage.local.set({ coachObservations: [] }, resolve));
    await renderCoachObservations();
    setStatus('observations-status', 'Cleared.', 'success');
  });

  document.getElementById('save-context-btn').addEventListener('click', async () => {
    const contextEditInput = document.getElementById('context-edit-input');
    const value = contextEditInput.value.trim();
    if (!value) return;
    await sendBg({ action: 'saveSettings', config: { userContext: value } });
    renderContextCard(value);
  });

  // Configurable coach instructions (system prompt) + the two settings questions.
  const instructionsInput = document.getElementById('coach-instructions-input');
  const projectsInput = document.getElementById('settings-projects-input');
  const reasonsInput = document.getElementById('settings-reasons-input');
  instructionsInput.value = state.coachInstructions || '';
  projectsInput.value = state.contextProjects || '';
  reasonsInput.value = state.contextReasons || '';

  document.getElementById('save-prompt-btn').addEventListener('click', async () => {
    await sendBg({
      action: 'saveSettings',
      config: {
        coachInstructions: instructionsInput.value.trim(),
        contextProjects: projectsInput.value.trim(),
        contextReasons: reasonsInput.value.trim()
      }
    });
    setStatus('prompt-status', 'Saved.', 'success');
  });

  document.getElementById('reset-prompt-btn').addEventListener('click', async () => {
    instructionsInput.value = state.defaultCoachInstructions || '';
    await sendBg({ action: 'saveSettings', config: { coachInstructions: '' } });
    const fresh = await getConfig();
    instructionsInput.value = fresh.coachInstructions || '';
    setStatus('prompt-status', 'Reset to default.', 'success');
  });

  await refreshAccessUI('access-paywall');

  // ---- Advanced: custom API key (developer override) ----
  const provSel = document.getElementById('provider-select-2');
  const modelInput = document.getElementById('model-input-2');
  const keyInput = document.getElementById('api-key-input-2');
  provSel.value = state.provider && state.provider !== HOSTED_PROVIDER ? state.provider : 'anthropic';
  modelInput.value = state.model || '';
  keyInput.value = state.apiKey || '';

  const syncPlaceholder = () => {
    const p = PROVIDERS[provSel.value];
    modelInput.placeholder = p ? p.modelPlaceholder : '';
  };

  const syncEnvSettings = (parsedEnv) => {
    const provider = provSel.value;
    const providerKey = `${provider.toUpperCase()}_API_KEY`;
    const modelKey = `${provider.toUpperCase()}_MODEL`;

    if (!keyInput.value && (parsedEnv[providerKey] || parsedEnv.API_KEY)) {
      keyInput.value = parsedEnv[providerKey] || parsedEnv.API_KEY;
    }
    if (!modelInput.value && (parsedEnv[modelKey] || parsedEnv.DEFAULT_MODEL)) {
      modelInput.value = parsedEnv[modelKey] || parsedEnv.DEFAULT_MODEL;
    }
  };

  provSel.addEventListener('change', () => {
    syncPlaceholder();
    loadEnv().then(syncEnvSettings);
  });
  syncPlaceholder();
  loadEnv().then(syncEnvSettings);

  document.getElementById('save-provider-btn').addEventListener('click', async () => {
    const provider = provSel.value;
    const model = modelInput.value.trim() || PROVIDERS[provider].defaultModel;
    const apiKey = keyInput.value.trim();
    await sendBg({ action: 'saveSettings', config: { provider, model, apiKey } });
    setStatus('provider-status', apiKey ? 'Saved. Custom key is now in use.' : 'Saved.', 'success');
    await refreshAccessUI('access-paywall');
  });

  // Clearing the override drops straight back to the hosted/credit route.
  document.getElementById('clear-provider-btn').addEventListener('click', async () => {
    keyInput.value = '';
    await sendBg({ action: 'saveSettings', config: { provider: '', model: '', apiKey: '' } });
    setStatus('provider-status', 'Custom key cleared.', 'success');
    await refreshAccessUI('access-paywall');
  });

  wireBlockingModeCard(state);

  renderDomains(state.blockedDomains || [], state.domainLimits || {}, state.blockingMode);
  wireAddModals();

  if (HAS_APP_BLOCKING) {
    document.getElementById('apps-card').hidden = false;
    renderApps(state.blockedApps || [], state.appLimits || {}, state.appLabels || {}, state.blockingMode);
  } else if (HAS_IOS_APP_BLOCKING) {
    wireIOSAppsCard();
  }

  initSettingsTabs();
  initSectionTabs();

  const summary = await sendBg({ action: 'getStatsSummary' });
  renderStats(summary);
  await refreshUsageLog(state);

  document.getElementById('open-coach-btn').addEventListener('click', async () => {
    if (await requireAccess()) openCoachModal();
  });
  document.getElementById('close-coach-btn').addEventListener('click', closeCoachModal);
  document.getElementById('paywall-close-btn').addEventListener('click', () => {
    document.getElementById('paywall-modal').hidden = true;
  });

  // Disabling all blocking is the biggest loosening of all — gate it.
  document.getElementById('disable-all-btn').addEventListener('click', async () => {
    const cfg = await getConfig();
    const iosStatus = HAS_IOS_APP_BLOCKING ? await iosScreenTimeStatus() : null;
    const iosHasApps = !!(iosStatus && iosStatus.selectionCount > 0);
    if (!(cfg.blockedDomains || []).length && !(cfg.blockedApps || []).length && !iosHasApps) {
      setStatus('prompt-status', 'Nothing is blocked right now.', '');
      return;
    }
    applyOrGate({
      isSimple: (cfg.blockingMode || 'coach') === 'simple',
      changeType: 'disable_all',
      domain: null,
      title: 'Disable all blocking?',
      subtitle: 'This turns off blocking for every site and app on your list. Convince your coach this is what you really want.',
      onApproved: async () => {
        const state = await getConfig();
        renderDomains(state.blockedDomains || [], state.domainLimits || {}, state.blockingMode);
        if (HAS_APP_BLOCKING) {
          renderApps(state.blockedApps || [], state.appLimits || {}, state.appLabels || {}, state.blockingMode);
        }
        if (HAS_IOS_APP_BLOCKING) {
          window.intentionScreenTime.clear(() => refreshIOSAppsCard());
        }
      }
    });
  });
}

// ---- iOS Screen Time apps card ----

function iosScreenTimeStatus() {
  return new Promise(resolve => window.intentionScreenTime.status(resolve));
}

function wireIOSAppsCard() {
  document.getElementById('apps-card').hidden = false;
  document.getElementById('apps-card-subtitle').textContent =
    'Block distracting apps on this device with Screen Time. Tap "Choose apps to block" to open Screen Time\'s picker; your coach can grant you time here.';
  document.getElementById('ios-apps-controls').hidden = false;

  const openAppBtn = document.getElementById('open-add-app-btn');
  openAppBtn.textContent = 'Choose apps to block';
  openAppBtn.addEventListener('click', () => {
    // Adding apps only ever tightens the rules, so no coach gate here;
    // clearing them goes through the gated "Disable all blocking" flow.
    window.intentionScreenTime.pickApps(() => refreshIOSAppsCard());
  });

  document.getElementById('ios-authorize-btn').addEventListener('click', () => {
    window.intentionScreenTime.authorize(() => refreshIOSAppsCard());
  });

  document.getElementById('section-tab-unlock').hidden = false;
  document.getElementById('unlock-card').hidden = false;
  document.getElementById('ios-request-time-btn').addEventListener('click', () => {
    window.location.href = 'coaching.html?domain=apps&app=1';
  });

  refreshIOSAppsCard();
}

async function refreshIOSAppsCard() {
  const statusEl = document.getElementById('ios-apps-status');
  const authorizeBtn = document.getElementById('ios-authorize-btn');
  const unlockStatusEl = document.getElementById('unlock-status');
  const requestBtn = document.getElementById('ios-request-time-btn');
  const st = await iosScreenTimeStatus();

  if (!st || !st.available) {
    statusEl.textContent = 'App blocking needs iOS 16 or later.';
    authorizeBtn.hidden = true;
    unlockStatusEl.textContent = 'App blocking needs iOS 16 or later.';
    requestBtn.hidden = true;
    return;
  }
  if (!st.authorized) {
    statusEl.textContent = iosAuthGuidance(st);
    authorizeBtn.hidden = false;
    unlockStatusEl.textContent = 'Enable Screen Time access in the Blocking tab first.';
    requestBtn.hidden = true;
    return;
  }
  authorizeBtn.hidden = true;
  const n = st.selectionCount || 0;
  if (n === 0) {
    statusEl.textContent = 'No apps blocked yet.';
    unlockStatusEl.textContent = 'No apps blocked yet — choose some in the Blocking tab first.';
    requestBtn.hidden = true;
  } else {
    const passNote = st.passEndsAt
      ? ` A pass is active until ${new Date(st.passEndsAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.`
      : '';
    statusEl.textContent = `${n} app${n === 1 ? '' : 's or categories'} blocked.${passNote}`;
    unlockStatusEl.textContent = `${n} app${n === 1 ? '' : 's or categories'} blocked.${passNote}`;
    requestBtn.hidden = false;
  }
}

// Adding tightens the rules, so it's applied immediately: during setup that
// means the local setup accumulator, otherwise it saves straight to the
// background config.
async function addDomainToBlocklist(domain, limit) {
  if (!document.getElementById('setup-view').hidden) {
    if (!setupBlockedDomains.includes(domain)) {
      setupBlockedDomains.push(domain);
      setupDomainLimits[domain] = { maxGrants: 3, maxMinutes: limit };
      renderSetupDomains();
    }
    return;
  }
  const state = await getConfig();
  const domains = state.blockedDomains || [];
  const limits = state.domainLimits || {};
  if (!domains.includes(domain)) {
    domains.push(domain);
    limits[domain] = { maxGrants: 3, maxMinutes: limit };
    await sendBg({ action: 'saveSettings', config: { blockedDomains: domains, domainLimits: limits } });
    renderDomains(domains, limits, state.blockingMode);
  }
}

async function addDomain() {
  const input = document.getElementById('domain-input');
  const limitInput = document.getElementById('domain-limit-input');
  const raw = input.value.trim().toLowerCase();
  if (!raw) return;

  const limitVal = parseInt(limitInput.value, 10);
  const limit = isNaN(limitVal) ? 10 : limitVal;

  const domain = raw.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
  if (domain) {
    await addDomainToBlocklist(domain, limit);
    input.value = '';
    limitInput.value = '10';
  }
}

// A per-item `mode` override on a domain/app limit entry wins; otherwise the
// global blockingMode applies. Mirrors getEffectiveMode() in background.js.
function effectiveModeFor(entry, globalMode) {
  return (entry && entry.mode) || globalMode || 'coach';
}

// The lane a site actually has right now, defaults included. Mirrors
// normalizeQuickCheck() in prompts.js (the options page doesn't load that
// file) — keep the two in sync. Needed so tighten-vs-loosen compares against
// the effective value: a missing field IS the default lane, not "off".
function effectiveQuickCheckFor(entry) {
  const src = (entry && typeof entry.quickCheck === 'object' && entry.quickCheck) || {};
  let minutes = Math.round(Number(src.minutes));
  let usesPerDay = Math.round(Number(src.usesPerDay));
  if (isNaN(minutes)) minutes = 3;
  if (isNaN(usesPerDay)) usesPerDay = 1;
  if (minutes <= 0 || usesPerDay <= 0) return { minutes: 0, usesPerDay: 0, enabled: false };
  return { minutes: Math.min(minutes, 60), usesPerDay, enabled: true };
}

// Loosening a rule (removing a block, raising a limit, disabling everything)
// normally requires convincing the AI coach via openGateModal. In simple mode
// there's no AI, so the change just applies immediately instead.
async function applyOrGate({ isSimple, changeType, domain, newValue, currentValue, title, subtitle, onApproved }) {
  if (isSimple) {
    await sendBg({ action: 'applySettingChange', changeType, domain, newValue });
    await onApproved();
    return;
  }
  openGateModal({ changeType, domain, currentValue, newValue, title, subtitle, onApproved });
}

function removeDomain(d, isSimple) {
  applyOrGate({
    isSimple,
    changeType: 'remove',
    domain: d,
    title: `Remove ${d}?`,
    subtitle: `Removing ${d} means it won't be blocked anymore. Convince your coach this is the right call.`,
    onApproved: async () => {
      const state = await getConfig();
      renderDomains(state.blockedDomains || [], state.domainLimits || {}, state.blockingMode);
    }
  });
}

function renderDomains(domains, limits = {}, globalMode = 'coach') {
  renderSiteRecommendations('sites-recommend-grid', 'sites-recommend-more', domains);
  const list = document.getElementById('domain-list');
  list.innerHTML = '';
  for (const d of domains) {
    const li = document.createElement('li');
    
    const infoContainer = document.createElement('div');
    infoContainer.className = 'domain-info';
    
    const span = document.createElement('span');
    span.textContent = d;
    span.className = 'domain-name';
    infoContainer.appendChild(span);
    
    const limitInfo = limits[d] || { maxGrants: 3, maxMinutes: 10 };
    const mins = limitInfo.maxMinutes !== undefined ? limitInfo.maxMinutes : (limitInfo.max_minutes_per_day || 10);
    
    const limitSpan = document.createElement('span');
    limitSpan.className = 'domain-limit-badge';
    limitSpan.appendChild(document.createTextNode('Absolute Max: '));

    const inlineInput = document.createElement('input');
    inlineInput.type = 'number';
    inlineInput.min = '1';
    inlineInput.className = 'inline-limit-input';
    const currentMins = mins > 0 ? mins : 10;
    inlineInput.value = currentMins;
    inlineInput.addEventListener('change', async (e) => {
      const val = parseInt(e.target.value, 10);
      if (isNaN(val) || val <= 0) {
        e.target.value = currentMins;
        return;
      }
      // Current effective limit: a non-positive maxMinutes means unlimited.
      const curMaxMinutes = limitInfo.maxMinutes !== undefined ? limitInfo.maxMinutes : (limitInfo.max_minutes_per_day ?? 10);
      const currentlyUnlimited = !(curMaxMinutes > 0);
      const isIncrease = currentlyUnlimited ? true : (val > curMaxMinutes);

      if (!isIncrease) {
        // Decreasing (or unchanged) tightens the rule — apply immediately, free.
        const state = await getConfig();
        const currentLimits = state.domainLimits || {};
        if (!currentLimits[d]) currentLimits[d] = { maxGrants: 3 };
        currentLimits[d].maxMinutes = val;
        await sendBg({ action: 'saveSettings', config: { domainLimits: currentLimits } });
        return;
      }

      // Increasing the limit loosens the rule — must be approved by the coach
      // (or applied outright, if this domain is in simple mode).
      e.target.value = currentMins; // revert until/unless approved
      applyOrGate({
        isSimple: effectiveModeFor(limitInfo, globalMode) === 'simple',
        changeType: 'increase_limit',
        domain: d,
        currentValue: currentlyUnlimited ? -1 : curMaxMinutes,
        newValue: val,
        title: `Raise the absolute max on ${d}?`,
        subtitle: `Going from ${currentlyUnlimited ? 'unlimited' : curMaxMinutes + 'm/day'} to ${val}m/day gives you more time on ${d}. Convince your coach.`,
        onApproved: async () => {
          const state = await getConfig();
          renderDomains(state.blockedDomains || [], state.domainLimits || {}, state.blockingMode);
        }
      });
    });

    limitSpan.appendChild(inlineInput);
    limitSpan.appendChild(document.createTextNode(' min/day'));
    infoContainer.appendChild(limitSpan);

    const rerenderDomains = async () => {
      const state = await getConfig();
      renderDomains(state.blockedDomains || [], state.domainLimits || {}, state.blockingMode);
    };
    infoContainer.appendChild(buildQuickCheckControl(d, limitInfo, globalMode, rerenderDomains));
    infoContainer.appendChild(buildRowModeControl(d, limitInfo, globalMode, rerenderDomains));

    li.appendChild(infoContainer);

    const btn = document.createElement('button');
    btn.textContent = 'Remove';
    btn.className = 'delete-btn';
    btn.addEventListener('click', () => removeDomain(d, effectiveModeFor(limitInfo, globalMode) === 'simple'));
    li.appendChild(btn);
    list.appendChild(li);
  }
}

// Builds the "Use default / Coach / Simple" row control shown under each
// blocked domain/app, letting a single site or app override the global mode.
// `persistKey` picks domainLimits vs appLimits; `onSaved` re-renders the list.
function buildRowModeControl(key, limitInfo, globalMode, onSaved, persistKey = 'domainLimits') {
  const row = document.createElement('div');
  row.className = 'row-mode-control';

  const modeSelect = document.createElement('select');
  modeSelect.className = 'row-mode-select';
  modeSelect.innerHTML = `
    <option value="">Use default (${globalMode === 'simple' ? 'Simple' : 'Coach'})</option>
    <option value="coach">Coach</option>
    <option value="simple">Simple</option>
  `;
  modeSelect.value = limitInfo.mode || '';

  const behaviorSelect = document.createElement('select');
  behaviorSelect.className = 'row-behavior-select';
  behaviorSelect.innerHTML = `<option value="pass">Timed pass</option><option value="hard">Hard block</option>`;
  behaviorSelect.value = limitInfo.behavior || 'pass';

  const minutesInput = document.createElement('input');
  minutesInput.type = 'number';
  minutesInput.min = '1';
  minutesInput.max = '180';
  minutesInput.className = 'row-minutes-input inline-limit-input';
  minutesInput.value = limitInfo.passMinutes || 10;

  const updateVisibility = () => {
    const effMode = modeSelect.value || globalMode;
    const show = effMode === 'simple';
    behaviorSelect.hidden = !show;
    minutesInput.hidden = !show || behaviorSelect.value !== 'pass';
  };
  updateVisibility();

  const persist = async () => {
    const state = await getConfig();
    const currentLimits = state[persistKey] || {};
    if (!currentLimits[key]) currentLimits[key] = { maxGrants: 3 };
    if (modeSelect.value) currentLimits[key].mode = modeSelect.value;
    else delete currentLimits[key].mode;
    if (modeSelect.value === 'simple') {
      currentLimits[key].behavior = behaviorSelect.value;
      currentLimits[key].passMinutes = parseInt(minutesInput.value, 10) || 10;
    } else {
      delete currentLimits[key].behavior;
      delete currentLimits[key].passMinutes;
    }
    await sendBg({ action: 'saveSettings', config: { [persistKey]: currentLimits } });
    await onSaved();
  };

  modeSelect.addEventListener('change', () => { updateVisibility(); persist(); });
  behaviorSelect.addEventListener('change', () => { updateVisibility(); persist(); });
  minutesInput.addEventListener('change', persist);

  row.appendChild(modeSelect);
  row.appendChild(behaviorSelect);
  row.appendChild(minutesInput);
  return row;
}

// The per-row "Quick check: [n] min × [m]/day" control, shared by the domain
// and app lists. Same rules as every other setting here: tightening or
// disabling applies instantly and free; enabling or raising anything goes
// through the coach gate. Coach-only feature — hidden on simple-mode rows.
function buildQuickCheckControl(key, limitInfo, globalMode, onSaved, persistKey = 'domainLimits', displayName = key) {
  const badge = document.createElement('span');
  badge.className = 'domain-limit-badge quick-check-badge';
  if (effectiveModeFor(limitInfo, globalMode) === 'simple') {
    badge.hidden = true;
    return badge;
  }

  const current = effectiveQuickCheckFor(limitInfo);

  const toggle = document.createElement('input');
  toggle.type = 'checkbox';
  toggle.checked = current.enabled;
  toggle.title = 'Allow one lenient daily quick check on this site';

  const minsInput = document.createElement('input');
  minsInput.type = 'number';
  minsInput.min = '1';
  minsInput.max = '60';
  minsInput.className = 'inline-limit-input';
  minsInput.value = current.enabled ? current.minutes : 3;

  const usesInput = document.createElement('input');
  usesInput.type = 'number';
  usesInput.min = '1';
  usesInput.max = '5';
  usesInput.className = 'inline-limit-input';
  usesInput.value = current.enabled ? current.usesPerDay : 1;

  const reflect = () => {
    minsInput.disabled = !toggle.checked;
    usesInput.disabled = !toggle.checked;
  };
  reflect();

  const revert = () => {
    toggle.checked = current.enabled;
    minsInput.value = current.enabled ? current.minutes : 3;
    usesInput.value = current.enabled ? current.usesPerDay : 1;
    reflect();
  };

  const save = async (qc) => {
    const state = await getConfig();
    const currentLimits = state[persistKey] || {};
    if (!currentLimits[key]) currentLimits[key] = { maxGrants: 3 };
    currentLimits[key].quickCheck = qc;
    await sendBg({ action: 'saveSettings', config: { [persistKey]: currentLimits } });
    await onSaved();
  };

  const requestChange = async () => {
    const m = parseInt(minsInput.value, 10);
    const u = parseInt(usesInput.value, 10);
    if (toggle.checked && (isNaN(m) || m <= 0 || isNaN(u) || u <= 0)) {
      revert();
      return;
    }
    const next = toggle.checked
      ? { minutes: Math.min(m, 60), usesPerDay: Math.min(u, 5) }
      : { minutes: 0, usesPerDay: 0 };
    // The effective value is the comparison point: with the lane on by
    // default, a missing field is the default lane, not "off" — so enabling
    // from off, or raising either number, is a loosening.
    const loosens = next.minutes > 0 &&
      (!current.enabled || next.minutes > current.minutes || next.usesPerDay > current.usesPerDay);
    if (!loosens) {
      await save(next);
      return;
    }
    revert(); // until/unless approved
    const curStr = current.enabled ? `${current.minutes} min × ${current.usesPerDay}/day` : 'off';
    const newStr = `${next.minutes} min × ${next.usesPerDay}/day`;
    applyOrGate({
      isSimple: effectiveModeFor(limitInfo, globalMode) === 'simple',
      changeType: persistKey === 'appLimits' ? 'increase_app_quick_check' : 'increase_quick_check',
      domain: key,
      currentValue: current.enabled ? { minutes: current.minutes, usesPerDay: current.usesPerDay } : { minutes: 0, usesPerDay: 0 },
      newValue: next,
      title: `Loosen the quick check on ${displayName}?`,
      subtitle: `Going from ${curStr} to ${newStr} of no-questions time every day. Convince your coach.`,
      onApproved: onSaved
    });
  };

  toggle.addEventListener('change', () => { reflect(); requestChange(); });
  minsInput.addEventListener('change', requestChange);
  usesInput.addEventListener('change', requestChange);

  badge.appendChild(toggle);
  badge.appendChild(document.createTextNode(' Quick check: '));
  badge.appendChild(minsInput);
  badge.appendChild(document.createTextNode(' min × '));
  badge.appendChild(usesInput);
  badge.appendChild(document.createTextNode('/day'));
  return badge;
}

// ---- Blocked apps (settings view, Android only) ----
// Mirrors the domain list above: adding/tightening is free, any loosening
// (removing an app, raising its limit) goes through the coach gate.
let settingsBlockedApps = [];

async function addApp(app) {
  if (!document.getElementById('setup-view').hidden) {
    addSetupApp(app);
    return;
  }
  const state = await getConfig();
  const apps = state.blockedApps || [];
  const limits = state.appLimits || {};
  const labels = state.appLabels || {};
  if (!apps.includes(app.packageName)) {
    apps.push(app.packageName);
    limits[app.packageName] = { maxGrants: 3, maxMinutes: 10 };
    labels[app.packageName] = app.label;
    await sendBg({ action: 'saveSettings', config: { blockedApps: apps, appLimits: limits, appLabels: labels } });
    renderApps(apps, limits, labels, state.blockingMode);
  }
}

function removeApp(pkg, label, isSimple) {
  const name = label || pkg;
  applyOrGate({
    isSimple,
    changeType: 'remove_app',
    domain: pkg,
    title: `Remove ${name}?`,
    subtitle: `Removing ${name} means it won't be blocked anymore. Convince your coach this is the right call.`,
    onApproved: async () => {
      const state = await getConfig();
      renderApps(state.blockedApps || [], state.appLimits || {}, state.appLabels || {}, state.blockingMode);
    }
  });
}

function renderApps(apps, limits = {}, labels = {}, globalMode = 'coach') {
  settingsBlockedApps = apps;
  renderAppRecommendations('apps-recommend-grid', 'apps-recommend-more', apps);
  const list = document.getElementById('app-list');
  list.innerHTML = '';
  for (const pkg of apps) {
    const li = document.createElement('li');

    const infoContainer = document.createElement('div');
    infoContainer.className = 'domain-info';

    const span = document.createElement('span');
    span.textContent = labels[pkg] || pkg;
    span.className = 'domain-name';
    infoContainer.appendChild(span);

    const limitInfo = limits[pkg] || { maxGrants: 3, maxMinutes: 10 };
    const mins = limitInfo.maxMinutes !== undefined ? limitInfo.maxMinutes : 10;

    const limitSpan = document.createElement('span');
    limitSpan.className = 'domain-limit-badge';
    limitSpan.appendChild(document.createTextNode('Absolute Max: '));

    const inlineInput = document.createElement('input');
    inlineInput.type = 'number';
    inlineInput.min = '1';
    inlineInput.className = 'inline-limit-input';
    const currentMins = mins > 0 ? mins : 10;
    inlineInput.value = currentMins;
    inlineInput.addEventListener('change', async (e) => {
      const val = parseInt(e.target.value, 10);
      if (isNaN(val) || val <= 0) {
        e.target.value = currentMins;
        return;
      }
      const curMaxMinutes = limitInfo.maxMinutes !== undefined ? limitInfo.maxMinutes : 10;
      const currentlyUnlimited = !(curMaxMinutes > 0);
      const isIncrease = currentlyUnlimited ? true : (val > curMaxMinutes);

      if (!isIncrease) {
        const state = await getConfig();
        const currentLimits = state.appLimits || {};
        if (!currentLimits[pkg]) currentLimits[pkg] = { maxGrants: 3 };
        currentLimits[pkg].maxMinutes = val;
        await sendBg({ action: 'saveSettings', config: { appLimits: currentLimits } });
        return;
      }

      const name = labels[pkg] || pkg;
      e.target.value = currentMins; // revert until/unless approved
      applyOrGate({
        isSimple: effectiveModeFor(limitInfo, globalMode) === 'simple',
        changeType: 'increase_app_limit',
        domain: pkg,
        currentValue: currentlyUnlimited ? -1 : curMaxMinutes,
        newValue: val,
        title: `Raise the absolute max on ${name}?`,
        subtitle: `Going from ${currentlyUnlimited ? 'unlimited' : curMaxMinutes + 'm/day'} to ${val}m/day gives you more time on ${name}. Convince your coach.`,
        onApproved: async () => {
          const state = await getConfig();
          renderApps(state.blockedApps || [], state.appLimits || {}, state.appLabels || {}, state.blockingMode);
        }
      });
    });

    limitSpan.appendChild(inlineInput);
    limitSpan.appendChild(document.createTextNode(' min/day'));
    infoContainer.appendChild(limitSpan);

    const rerenderApps = async () => {
      const state = await getConfig();
      renderApps(state.blockedApps || [], state.appLimits || {}, state.appLabels || {}, state.blockingMode);
    };
    infoContainer.appendChild(buildQuickCheckControl(pkg, limitInfo, globalMode, rerenderApps, 'appLimits', labels[pkg] || pkg));
    infoContainer.appendChild(buildRowModeControl(pkg, limitInfo, globalMode, rerenderApps, 'appLimits'));

    li.appendChild(infoContainer);

    const btn = document.createElement('button');
    btn.textContent = 'Remove';
    btn.className = 'delete-btn';
    btn.addEventListener('click', () => removeApp(pkg, labels[pkg], effectiveModeFor(limitInfo, globalMode) === 'simple'));
    li.appendChild(btn);
    list.appendChild(li);
  }
}

function renderStats(summary) {
  const el = document.getElementById('stats-display');
  if (!summary || !summary.minutesToday) {
    el.innerHTML = '<p class="muted">No time on blocked sites yet today. Nice.</p>';
    return;
  }
  const perSite = Object.entries(summary.perSiteToday || {})
    .sort((a, b) => b[1] - a[1])
    .map(([d, m]) => `${d}: ${Math.round(m)}m`)
    .join(' · ');
  // perSite carries domain and package names straight out of stored config, so
  // it goes in as text — the rest of the markup is static.
  el.innerHTML = `
    <p><strong>${summary.minutesToday} min</strong> on blocked sites today.</p>
    <p class="muted" id="stats-per-site"></p>
    <p class="muted">Past 7 days: <strong>${summary.minutesWeek} min</strong>.</p>
  `;
  el.querySelector('#stats-per-site').textContent = perSite;
}

function formatLogDate(key) {
  const [y, m, d] = key.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const diffDays = Math.round((startOfToday - date) / 86400000);
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// entries: [{ date: 'YYYY-MM-DD', domain, minutes, label? }], already sorted
// by date desc then minutes desc (see getUsageLog in tracking.js and any
// native app-usage merges added alongside it).
function renderUsageLog(entries) {
  const list = document.getElementById('usage-log-list');
  list.innerHTML = '';
  if (!entries || !entries.length) {
    const li = document.createElement('li');
    li.className = 'muted';
    li.textContent = 'No usage recorded yet.';
    list.appendChild(li);
    return;
  }

  let lastDate = null;
  for (const entry of entries) {
    if (entry.date !== lastDate) {
      lastDate = entry.date;
      const heading = document.createElement('li');
      heading.className = 'log-date-heading';
      heading.textContent = formatLogDate(entry.date);
      list.appendChild(heading);
    }

    const li = document.createElement('li');
    const infoContainer = document.createElement('div');
    infoContainer.className = 'domain-info';

    const span = document.createElement('span');
    span.textContent = entry.label || entry.domain;
    span.className = 'domain-name';
    infoContainer.appendChild(span);

    const minSpan = document.createElement('span');
    minSpan.className = 'domain-limit-badge';
    minSpan.textContent = `${entry.minutes} min`;
    infoContainer.appendChild(minSpan);

    li.appendChild(infoContainer);
    list.appendChild(li);
  }
}

// Merges website usage (always available) with native per-app usage (Android
// via UsageStatsManager, iOS via the DeviceActivityReport bridge) when the
// native layer exposes it. Both native sources are optional/feature-detected
// since most builds (Chrome/Firefox/Safari extension pages) have neither.
async function refreshUsageLog(state) {
  const days = 30;
  const entries = await sendBg({ action: 'getUsageLog', days });

  const accessEl = document.getElementById('usage-log-access');
  accessEl.hidden = true;
  accessEl.innerHTML = '';

  if (HAS_APP_BLOCKING && window.intentionApps.getAppUsageStats) {
    const hasAccess = window.intentionApps.hasUsageAccess ? window.intentionApps.hasUsageAccess() : true;
    if (!hasAccess) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'secondary';
      btn.style.width = '100%';
      btn.textContent = 'Grant usage access to log app time';
      btn.addEventListener('click', () => window.intentionApps.requestUsageAccess());
      accessEl.appendChild(btn);
      accessEl.hidden = false;
    } else {
      const labels = state.appLabels || {};
      const appEntries = await new Promise(resolve => window.intentionApps.getAppUsageStats(days, resolve));
      for (const e of (appEntries || [])) {
        entries.push({ date: e.date, domain: e.packageName, minutes: e.minutes, label: labels[e.packageName] || e.packageName });
      }
    }
  }

  if (HAS_IOS_APP_BLOCKING && window.intentionScreenTime.getAppUsageReport) {
    const report = await new Promise(resolve => window.intentionScreenTime.getAppUsageReport(resolve));
    for (const [date, minutes] of Object.entries((report && report.minutesByDate) || {})) {
      const m = Math.round(minutes);
      if (m > 0) entries.push({ date, domain: 'ios-apps', minutes: m, label: 'Blocked apps (this device)' });
    }
  }

  entries.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.minutes - a.minutes));
  renderUsageLog(entries);
}

// Shared by the coach and settings-gate modals below.
function addRetryButton(container, onRetry) {
  const row = document.createElement('div');
  row.className = 'int-retry-row';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'secondary';
  btn.textContent = 'Try again';
  btn.addEventListener('click', () => {
    row.remove();
    onRetry();
  });
  row.appendChild(btn);
  container.appendChild(row);
  container.scrollTop = container.scrollHeight;
  return row;
}

let coachSending = false;
// Only the most recent attemptCoachSend's result is allowed to touch the DOM;
// see the matching guard in coaching.js for why.
let coachRequestSeq = 0;

// The modal's old hardcoded greeting, kept as the offline fallback for the
// LLM opener below. No retry row on failure — the input stays live, so the
// user's first message retries naturally through attemptCoachSend.
const COACH_OPENER_FALLBACK = "Hey there. Let's design your coaching context together. To help me support you better, what are you working on right now, and what tend to be your biggest distractions or triggers? I'll save our updated notes as we chat.";

async function openCoachModal() {
  const modal = document.getElementById('coach-modal');
  modal.hidden = false;
  // Invalidate any request still in flight from a previous open, so a late
  // response can't land in this fresh conversation.
  coachRequestSeq++;
  coachSending = false;
  const messagesEl = document.getElementById('coach-messages');
  messagesEl.innerHTML = '';

  const input = document.getElementById('coach-input');
  const send = document.getElementById('coach-send-btn');
  input.value = '';
  input.focus();

  const onSend = async () => {
    const text = input.value.trim();
    if (!text || coachSending) return;
    addCoachMsg('user', text);
    input.value = '';
    attemptCoachSend(text, messagesEl);
  };
  send.onclick = onSend;
  input.onkeydown = e => { if (e.key === 'Enter') onSend(); };

  // These modals are one-shot by design: the transcript is normally deleted
  // on close, but closing the options TAB skips that handler, and the opener
  // below would then stack a fresh marker+greeting onto the orphaned
  // conversation every time the modal reopens. Clear first so each open
  // really starts clean.
  sendBg({ action: 'clearChatHistory', historyKey: 'context' }).then(() => {
    attemptCoachOpen(messagesEl);
  });
}

// attemptCoachSend minus the user bubble: the coach speaks first. No
// userMessage — the background records its own marker turn.
async function attemptCoachOpen(messagesEl) {
  const seq = ++coachRequestSeq;
  coachSending = true;
  const thinking = addCoachMsg('assistant', '…', true);
  let resp;
  try {
    resp = await sendBgChat({ action: 'chat', mode: 'context' });
  } catch (e) {
    if (seq !== coachRequestSeq) return;
    coachSending = false;
    thinking.remove();
    addCoachMsg('assistant', COACH_OPENER_FALLBACK);
    return;
  }
  if (seq !== coachRequestSeq) return;
  coachSending = false;
  if (!resp || resp.error) {
    thinking.remove();
    if (resp && resp.locked) {
      await closeCoachModal();
      await openPaywallModal();
      return;
    }
    addCoachMsg('assistant', COACH_OPENER_FALLBACK);
    return;
  }
  thinking.classList.remove('int-thinking');
  typeCoachMsg(thinking, resp.assistantText || COACH_OPENER_FALLBACK);
  if (resp.systemNote) addCoachMsg('assistant', resp.systemNote, false, true);
}

async function attemptCoachSend(text, messagesEl) {
  const seq = ++coachRequestSeq;
  coachSending = true;
  const thinking = addCoachMsg('assistant', '…', true);
  let resp;
  try {
    resp = await sendBgChat({ action: 'chat', mode: 'context', userMessage: text });
  } catch (e) {
    if (seq !== coachRequestSeq) return;
    coachSending = false;
    thinking.remove();
    const message = e && e.message === 'timeout'
      ? "That's taking too long to answer. Check your connection and try again."
      : '[no response - background worker may be offline]';
    showCoachRetryableError(messagesEl, message, text);
    return;
  }
  if (seq !== coachRequestSeq) return;
  coachSending = false;
  if (!resp) {
    thinking.remove();
    showCoachRetryableError(messagesEl, '[no response - background worker may be offline]', text);
    return;
  }
  if (resp.error) {
    thinking.remove();
    if (resp.locked) {
      await closeCoachModal();
      await openPaywallModal();
      return;
    }
    const message = resp.networkError ? "Can't reach the coach — check your connection." : resp.error;
    showCoachRetryableError(messagesEl, message, text);
    return;
  }
  thinking.classList.remove('int-thinking');
  typeCoachMsg(thinking, resp.assistantText || '(no reply)');
  if (resp.systemNote) addCoachMsg('assistant', resp.systemNote, false, true);
  if (resp.contextUpdated) {
    addCoachMsg('assistant', `(context saved - ${resp.contextUpdated.diff_summary || 'updated'})`, false, true);
    const state = await getConfig();
    renderContextCard(state.userContext);
  }
}

function showCoachRetryableError(messagesEl, message, text) {
  const errorEl = addCoachMsg('assistant', message);
  addRetryButton(messagesEl, () => {
    errorEl.remove();
    attemptCoachSend(text, messagesEl);
  });
}

async function closeCoachModal() {
  document.getElementById('coach-modal').hidden = true;
  await sendBg({ action: 'clearChatHistory', historyKey: 'context' });
}

function addCoachMsg(role, text, isThinking, isSystem) {
  const messagesEl = document.getElementById('coach-messages');
  const div = document.createElement('div');
  div.className = `int-msg int-msg-${role}`
    + (isThinking ? ' int-thinking' : '')
    + (isSystem ? ' int-system' : '');
  div.textContent = text;
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return div;
}

// Reveal the coach's reply gradually into an existing message element.
function typeCoachMsg(el, text) {
  const messagesEl = document.getElementById('coach-messages');
  el.textContent = '';
  let i = 0;
  const step = Math.max(1, Math.ceil(text.length / 140));
  const timer = setInterval(() => {
    i += step;
    el.textContent = text.slice(0, i);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    if (i >= text.length) {
      clearInterval(timer);
      el.textContent = text;
    }
  }, 18);
}

// ---- Settings-gate modal: user must convince the coach to loosen a rule ----
let gateSending = false;
let gateChange = null;
// Only the most recent attemptGateSend's result is allowed to touch the DOM;
// see the matching guard in coaching.js for why.
let gateRequestSeq = 0;

// Loosening a rule has to be argued with the coach, so it needs the same AI
// access a gate conversation does — without it, show the paywall rather than a
// chat box that can only fail.
async function openGateModal({ changeType, domain, currentValue, newValue, title, subtitle, onApproved }) {
  if (!(await requireAccess())) return;
  gateChange = { changeType, domain, currentValue, newValue, onApproved };
  const modal = document.getElementById('gate-modal');
  modal.hidden = false;
  // Invalidate any request still in flight from a previous open, so a late
  // response can't land in this fresh conversation.
  gateRequestSeq++;
  document.getElementById('gate-title').textContent = title || 'Convince your coach';
  document.getElementById('gate-subtitle').textContent = subtitle || '';

  const messagesEl = document.getElementById('gate-messages');
  messagesEl.innerHTML = '';
  gateSending = false;

  const input = document.getElementById('gate-input');
  const send = document.getElementById('gate-send-btn');
  input.value = '';
  input.focus();

  const onSend = async () => {
    const text = input.value.trim();
    if (!text || gateSending) return;
    addGateMsg('user', text);
    input.value = '';
    attemptGateSend(text, messagesEl);
  };
  send.onclick = onSend;
  input.onkeydown = e => { if (e.key === 'Enter') onSend(); };
  document.getElementById('gate-close-btn').onclick = closeGateModal;

  // Same reason as openCoachModal: closing the options tab skips
  // closeGateModal's transcript delete, so clear before the opener rather
  // than stacking onto an orphaned conversation.
  sendBg({ action: 'clearChatHistory', historyKey: `settings_gate:${changeType}:${domain || 'all'}` }).then(() => {
    attemptGateOpen(messagesEl);
  });
}

// The modal's old hardcoded openers, kept as the offline fallback per change
// type. No retry row on failure — the input stays live, so the user's first
// message retries naturally through attemptGateSend.
function gateOpenerFallback(changeType, domain) {
  return changeType === 'remove'
    ? `You want to remove ${domain} from your blocklist. You set this rule for a reason. Tell me what's changed.`
    : changeType === 'increase_limit'
      ? `You want more time on ${domain}. Why? What's driving this right now?`
      : changeType === 'increase_quick_check' || changeType === 'increase_app_quick_check'
        ? `You want a bigger daily quick check here. That's extra no-questions time every single day — what's driving it?`
        : `You want to turn off all blocking. That's a big move. Talk to me about what's going on.`;
}

// attemptGateSend minus the user bubble: the coach speaks first. No
// userMessage — the background records its own marker turn.
async function attemptGateOpen(messagesEl) {
  const seq = ++gateRequestSeq;
  gateSending = true;
  // gateChange can be nulled by closeGateModal while the request is in
  // flight, so hold on to the fields the fallback needs.
  const { changeType, domain, currentValue, newValue } = gateChange;
  const thinking = addGateMsg('assistant', '…', true);
  let resp;
  try {
    resp = await sendBgChat({
      action: 'chat',
      mode: 'settings_gate',
      domain,
      changeType,
      currentValue,
      newValue
    });
  } catch (e) {
    if (seq !== gateRequestSeq) return;
    gateSending = false;
    thinking.remove();
    addGateMsg('assistant', gateOpenerFallback(changeType, domain));
    return;
  }
  if (seq !== gateRequestSeq) return;
  gateSending = false;
  if (!resp || resp.error) {
    thinking.remove();
    if (resp && resp.locked) {
      await closeGateModal();
      await openPaywallModal();
      return;
    }
    addGateMsg('assistant', gateOpenerFallback(changeType, domain));
    return;
  }
  thinking.classList.remove('int-thinking');
  typeGateMsg(thinking, resp.assistantText || gateOpenerFallback(changeType, domain));
  if (resp.systemNote) addGateMsg('assistant', resp.systemNote, false, true);
}

async function attemptGateSend(text, messagesEl) {
  const seq = ++gateRequestSeq;
  gateSending = true;
  const thinking = addGateMsg('assistant', '…', true);
  let resp;
  try {
    resp = await sendBgChat({
      action: 'chat',
      mode: 'settings_gate',
      domain: gateChange.domain,
      changeType: gateChange.changeType,
      currentValue: gateChange.currentValue,
      newValue: gateChange.newValue,
      userMessage: text
    });
  } catch (e) {
    if (seq !== gateRequestSeq) return;
    gateSending = false;
    thinking.remove();
    const message = e && e.message === 'timeout'
      ? "That's taking too long to answer. Check your connection and try again."
      : '[no response - background worker may be offline]';
    showGateRetryableError(messagesEl, message, text);
    return;
  }
  if (seq !== gateRequestSeq) return;
  gateSending = false;
  if (!resp) {
    thinking.remove();
    showGateRetryableError(messagesEl, '[no response - background worker may be offline]', text);
    return;
  }
  if (resp.error) {
    thinking.remove();
    if (resp.locked) {
      await closeGateModal();
      await openPaywallModal();
      return;
    }
    const message = resp.networkError ? "Can't reach the coach — check your connection." : resp.error;
    showGateRetryableError(messagesEl, message, text);
    return;
  }
  thinking.classList.remove('int-thinking');
  typeGateMsg(thinking, resp.assistantText || '(no reply)');
  if (resp.systemNote) addGateMsg('assistant', resp.systemNote, false, true);
  if (resp.approved) {
    addGateMsg('assistant', '(approved - applying your change)', false, true);
    const cb = gateChange.onApproved;
    setTimeout(async () => {
      if (cb) await cb();
      closeGateModal();
    }, 900);
  }
}

function showGateRetryableError(messagesEl, message, text) {
  const errorEl = addGateMsg('assistant', message);
  addRetryButton(messagesEl, () => {
    errorEl.remove();
    attemptGateSend(text, messagesEl);
  });
}

async function closeGateModal() {
  const modal = document.getElementById('gate-modal');
  modal.hidden = true;
  if (gateChange) {
    const historyKey = `settings_gate:${gateChange.changeType}:${gateChange.domain || 'all'}`;
    await sendBg({ action: 'clearChatHistory', historyKey });
  }
  gateChange = null;
}

function addGateMsg(role, text, isThinking, isSystem) {
  const messagesEl = document.getElementById('gate-messages');
  const div = document.createElement('div');
  div.className = `int-msg int-msg-${role}`
    + (isThinking ? ' int-thinking' : '')
    + (isSystem ? ' int-system' : '');
  div.textContent = text;
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return div;
}

function typeGateMsg(el, text) {
  const messagesEl = document.getElementById('gate-messages');
  el.textContent = '';
  let i = 0;
  const step = Math.max(1, Math.ceil(text.length / 140));
  const timer = setInterval(() => {
    i += step;
    el.textContent = text.slice(0, i);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    if (i >= text.length) {
      clearInterval(timer);
      el.textContent = text;
    }
  }, 18);
}

function setStatus(id, text, variant = '') {
  const el = document.getElementById(id);
  el.textContent = text;
  el.className = 'status ' + variant;
  if (text) setTimeout(() => { el.textContent = ''; el.className = 'status'; }, 3000);
}
