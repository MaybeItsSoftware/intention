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

// The blocklist as of the last getConfig, used for one thing only: telling a
// settings row that another row is the same service, so editing one visibly
// edits the other. Not a cache — read it for display, never to decide a write.
let lastKnownBlocked = { domains: [], apps: [], appLabels: {} };

async function getConfig() {
  const state = await sendBg({ action: 'getConfig' });
  if (state) {
    lastKnownBlocked = {
      domains: state.blockedDomains || [],
      apps: state.blockedApps || [],
      appLabels: state.appLabels || {}
    };
  }
  return state;
}

// Everything currently blocked, sites and apps together, named the way the
// user would recognise them — a package name in a sentence about their own
// settings reads as a bug.
function allBlockedTargets() {
  return [
    ...lastKnownBlocked.domains.map(d => ({ target: d, label: d })),
    ...lastKnownBlocked.apps.map(p => ({
      target: p,
      label: lastKnownBlocked.appLabels[p] ? `the ${lastKnownBlocked.appLabels[p]} app` : p
    }))
  ];
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
// { [serviceKey]: { purpose, legitimateUse } } — keyed by serviceKeyFor(), so a
// site and its app share one answer. See shared/sites.js.
let setupServiceReasons = {};
let setupStep = 1;
// Computed per-render, and recomputed whenever the selection changes. Entries
// are { id, group }: the apps step only exists where a native bridge does, and
// the purpose steps are one per selected service, so neither the contents nor
// the length is known up front.
let setupStepOrder = [];
let setupBlockingMode = 'coach';
let setupSimpleBehavior = 'pass';
let setupSimplePassMinutes = 10;

let installedAppsCache = null;
// How many apps/categories the iOS Screen Time picker currently holds. Apple
// only ever tells us the count, never which ones — see refreshSetupIOSApps.
let setupIOSSelectionCount = 0;

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
  // Apps get their own step ahead of websites wherever a native bridge exists.
  //
  // What they're blocking comes before how blocking works: "Coach or Simple?"
  // is unanswerable until you know what's behind the gate, and it reads as a
  // preference once you do.
  //
  // The access step is always in the order, even in simple mode where it has
  // nothing to sell. It used to be added and removed as the mode was toggled,
  // which changed the denominator of "Step 4 of 8" under the user's finger.
  //
  // The per-service questions sit after the global "what are you protecting?"
  // — the general case, then the specifics — and they stay in the order even
  // in simple mode, where nothing will read them. Dropping them when there is
  // no coach is tempting and wrong: it would re-create the bug that put the
  // access step here unconditionally, where toggling Coach/Simple changed the
  // denominator of "Step 4 of 8" under the user's finger. The subtitle adapts
  // instead.
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
    modeCoachBtn.setAttribute('aria-pressed', String(setupBlockingMode === 'coach'));
    modeSimpleBtn.classList.toggle('selected', setupBlockingMode === 'simple');
    modeSimpleBtn.setAttribute('aria-pressed', String(setupBlockingMode === 'simple'));
    simpleOptions.hidden = setupBlockingMode !== 'simple';
    simpleHardBtn.classList.toggle('selected', setupSimpleBehavior === 'hard');
    simpleHardBtn.setAttribute('aria-pressed', String(setupSimpleBehavior === 'hard'));
    simplePassBtn.classList.toggle('selected', setupSimpleBehavior === 'pass');
    simplePassBtn.setAttribute('aria-pressed', String(setupSimpleBehavior === 'pass'));
    simpleMinutesGroup.hidden = setupSimpleBehavior !== 'pass';
    // The card used to advertise a literal "Take N minutes" button.
    document.getElementById('setup-simple-pass-desc').textContent =
      `A "Take ${setupSimplePassMinutes} minutes" button lets you through without asking anyone.`;
  };

  // The step order no longer changes with the mode, but the access step's
  // contents do (there is nothing to buy in simple mode), and so does the
  // finish summary.
  const onModeChanged = () => {
    renderModeStep();
    renderAccessStep();
    saveSetupDraft();
  };
  // Each of these has to bank the draft itself: the wizard is otherwise only
  // written on step navigation, so a mode chosen and then reloaded (or
  // interrupted by a trip out to iOS Settings) would come back as the default.
  const onModeEdited = () => { renderModeStep(); saveSetupDraft(); };
  modeCoachBtn.onclick = () => { setupBlockingMode = 'coach'; onModeChanged(); };
  modeSimpleBtn.onclick = () => { setupBlockingMode = 'simple'; onModeChanged(); };
  simpleHardBtn.onclick = () => { setupSimpleBehavior = 'hard'; onModeEdited(); };
  simplePassBtn.onclick = () => { setupSimpleBehavior = 'pass'; onModeEdited(); };
  simpleMinutesInput.oninput = () => {
    setupSimplePassMinutes = Number(simpleMinutesInput.value) > 0 ? Number(simpleMinutesInput.value) : 10;
    onModeEdited();
  };

  // Same for the two free-text answers, which someone can spend a while on.
  for (const id of ['setup-projects-input', 'setup-reasons-input']) {
    document.getElementById(id).addEventListener('change', saveSetupDraft);
  }

  // ---- Step: per-service questions ----
  wirePurposeStep();

  // Hoisted for the same reason as showSetupStep below: restoring a draft has
  // to repaint the mode cards, and it runs outside this closure.
  renderSetupModeStep = renderModeStep;
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

  // In simple mode there is no AI to turn on, so the access step says so
  // rather than showing a paywall for something the user just opted out of.
  const renderAccessStep = () => {
    const isSimple = setupBlockingMode === 'simple';
    const paywall = document.getElementById('setup-paywall');
    document.getElementById('setup-access-title').textContent =
      isSimple ? 'Nothing to turn on' : 'Turn on your coach';
    document.getElementById('setup-access-subtitle').textContent = isSimple
      ? "Simple mode runs entirely on your device — there's no AI behind it and nothing to buy. Go back a step if you'd rather have a coach."
      // Kept short: the paywall's own lede, directly below, explains the choice.
      : 'Optional — you can do this later. Your sites and apps start blocking either way.';
    paywall.hidden = isSimple;
    if (isSimple) paywall.innerHTML = '';
  };

  const showStep = (n) => {
    setupStep = n;
    const total = setupStepOrder.length;
    // Hide every distinct section first, then reveal the one. The old
    // hidden = i !== n - 1 loop cannot survive an id appearing more than once
    // in the order: a later iteration would re-hide the section an earlier one
    // had just shown, and the purpose step appears once per service.
    for (const id of new Set(setupStepOrder.map(s => s.id))) {
      document.getElementById(id).hidden = true;
    }
    const step = setupStepOrder[n - 1];
    document.getElementById(step.id).hidden = false;

    document.getElementById('setup-progress-fill').style.width = `${(n / total) * 100}%`;
    document.getElementById('setup-progress-label').textContent = `Step ${n} of ${total}`;
    backBtn.disabled = n === 1;
    nextBtn.hidden = n === total;
    saveBtn.hidden = n !== total;
    const stepId = step.id;
    if (step.group) renderPurposeStep(step.group);
    // Prices come from the store, so the paywall is only built once the user
    // actually reaches it — and rebuilt each time, to pick up a purchase made
    // and then backed out of.
    if (stepId === 'setup-step-access') {
      renderAccessStep();
      if (setupBlockingMode !== 'simple') refreshAccessUI('setup-paywall', { compact: false });
    }
    if (stepId === 'setup-step-done') renderDoneStep();
    // Both of these describe state the user can change from outside this
    // wizard (a Safari toggle, a system permission prompt), so they get
    // re-read on arrival rather than trusted from whenever the step was built.
    if (stepId === 'setup-step-safari') refreshSafariStatus();
    if (stepId === 'setup-step-apps' && HAS_IOS_APP_BLOCKING) refreshSetupIOSApps();
    refreshSetupNav();
    saveSetupDraft();
  };

  // Skips the whole run of per-service questions, not just this one. Someone
  // who picked twelve sites needs a way out that isn't twelve taps on Next,
  // and capping the number of screens would have taken the choice away from
  // the people who want to answer all twelve.
  document.getElementById('setup-purpose-skip-btn').onclick = () => {
    let n = setupStep;
    while (n < setupStepOrder.length && setupStepOrder[n].group) n++;
    showStep(Math.min(n + 1, setupStepOrder.length));
  };
  // Hoisted onto the module scope so the site/app list renderers can re-run the
  // empty-list check after an add or a remove, without reaching into this
  // closure.
  showSetupStep = showStep;

  backBtn.onclick = () => { if (setupStep > 1) showStep(setupStep - 1); };
  nextBtn.onclick = () => { if (setupStep < setupStepOrder.length) showStep(setupStep + 1); };

  // Enter no longer advances the wizard from the two free-text answers: they
  // invite several sentences, and a paragraph break is the more likely intent.

  restoreSetupDraft().then(step => showStep(step));

  saveBtn.onclick = () => finishSetup();
}

// Set by showSetupView so list renderers and the draft restore can drive the
// wizard from outside its closure.
let showSetupStep = () => {};
let renderSetupModeStep = () => {};

// The services the wizard currently holds, collapsed so a site and its app ask
// their questions once. iOS contributes no app groups on purpose: Screen Time's
// FamilyActivitySelection is opaque and the web layer only ever learns a count,
// never which apps — so there is nothing to name a screen after.
function currentServiceGroups() {
  return buildServiceGroups({
    domains: setupBlockedDomains,
    apps: setupBlockedApps,
    appLabels: setupAppLabels,
    appsFirst: HAS_APP_BLOCKING
  });
}

// Step descriptors, not bare ids: the purpose step reuses one section for every
// service, so an id alone no longer identifies a step.
//
// Recomputing is safe at any point during the wizard because the selection can
// only be edited on the apps and sites steps, which sit before every purpose
// step — so adding a site lengthens the run ahead of the user, never under
// their feet.
function computeStepOrder() {
  const order = ['setup-step-welcome'];
  if (HAS_SAFARI_EXTENSION) order.push('setup-step-safari');
  if (HAS_APP_BLOCKING || HAS_IOS_APP_BLOCKING) order.push('setup-step-apps');
  order.push('setup-step-sites', 'setup-step-why');
  const steps = order.map(id => ({ id, group: null }));
  for (const group of currentServiceGroups()) {
    steps.push({ id: 'setup-step-purpose', group: group.key });
  }
  for (const id of ['setup-step-mode', 'setup-step-access', 'setup-step-done']) {
    steps.push({ id, group: null });
  }
  return steps;
}

// Finishing with an empty blocklist produces an install that does nothing at
// all, silently — so it's the one thing the wizard refuses to do.
function setupHasSomethingBlocked() {
  return setupBlockedDomains.length + setupBlockedApps.length + setupIOSSelectionCount > 0;
}

function refreshSetupNav() {
  const saveBtn = document.getElementById('setup-save-btn');
  const hint = document.getElementById('setup-sites-empty-hint');
  const ok = setupHasSomethingBlocked();
  if (saveBtn) saveBtn.disabled = !ok;
  if (hint) hint.hidden = ok;

  // Adding or removing a site changes how many per-service questions there
  // are, so the order has to be rebuilt here — this runs after every add and
  // remove. Safe mid-wizard: see computeStepOrder.
  if (setupStepOrder.length) {
    const current = setupStepOrder[setupStep - 1];
    setupStepOrder = computeStepOrder();
    // Removing the service whose screen is open would otherwise leave the step
    // pointing past the end of the order.
    if (current) {
      const index = setupStepOrder.findIndex(s => s.id === current.id && s.group === current.group);
      if (index !== -1) setupStep = index + 1;
    }
    setupStep = Math.min(setupStep, setupStepOrder.length);
    const label = document.getElementById('setup-progress-label');
    const fill = document.getElementById('setup-progress-fill');
    if (label) label.textContent = `Step ${setupStep} of ${setupStepOrder.length}`;
    if (fill) fill.style.width = `${(setupStep / setupStepOrder.length) * 100}%`;
  }
}

// ---- Wizard draft ---------------------------------------------------------
//
// The wizard is the whole UI until it finishes, and it can't be dismissed, so
// losing everything to a refresh (or to a trip out to iOS Settings) used to
// strand people. The draft is the same shape as the wizard's own state and is
// dropped the moment setup is saved for real.

const SETUP_DRAFT_KEY = 'setupDraft';

// showSetupView renders the (still empty) lists before it can await the stored
// draft, and those renders save a draft of their own — which would overwrite
// the very thing being restored. Nothing is written until the read is done.
let setupDraftReady = false;

function saveSetupDraft() {
  if (!setupDraftReady) return;
  const projects = document.getElementById('setup-projects-input');
  const reasons = document.getElementById('setup-reasons-input');
  // The step is stored as an id plus a service key rather than an index: the
  // order's length now depends on the selection, so an index saved before a
  // site was added points somewhere else entirely when it is read back.
  const step = setupStepOrder[setupStep - 1] || null;
  const draft = {
    stepId: step ? step.id : null,
    stepGroup: step ? step.group : null,
    blockedDomains: setupBlockedDomains,
    domainLimits: setupDomainLimits,
    blockedApps: setupBlockedApps,
    appLimits: setupAppLimits,
    appLabels: setupAppLabels,
    serviceReasons: setupServiceReasons,
    blockingMode: setupBlockingMode,
    simpleBehavior: setupSimpleBehavior,
    simplePassMinutes: setupSimplePassMinutes,
    projects: projects ? projects.value : '',
    reasons: reasons ? reasons.value : ''
  };
  try { chrome.storage.local.set({ [SETUP_DRAFT_KEY]: draft }); } catch (e) {}
}

function clearSetupDraft() {
  try { chrome.storage.local.remove(SETUP_DRAFT_KEY); } catch (e) {}
}

// Returns the step to open on — 1 when there is no usable draft.
async function restoreSetupDraft() {
  let draft;
  try {
    const stored = await new Promise(resolve => chrome.storage.local.get(SETUP_DRAFT_KEY, resolve));
    draft = stored && stored[SETUP_DRAFT_KEY];
  } catch (e) {
    setupDraftReady = true;
    return 1;
  }
  if (!draft || typeof draft !== 'object') {
    setupDraftReady = true;
    return 1;
  }

  setupBlockedDomains = Array.isArray(draft.blockedDomains) ? draft.blockedDomains : [];
  setupDomainLimits = draft.domainLimits || {};
  setupBlockedApps = Array.isArray(draft.blockedApps) ? draft.blockedApps : [];
  setupAppLimits = draft.appLimits || {};
  setupAppLabels = draft.appLabels || {};
  setupServiceReasons = draft.serviceReasons || {};
  if (draft.blockingMode === 'simple' || draft.blockingMode === 'coach') setupBlockingMode = draft.blockingMode;
  if (draft.simpleBehavior === 'hard' || draft.simpleBehavior === 'pass') setupSimpleBehavior = draft.simpleBehavior;
  if (Number(draft.simplePassMinutes) > 0) setupSimplePassMinutes = Number(draft.simplePassMinutes);

  const projects = document.getElementById('setup-projects-input');
  const reasons = document.getElementById('setup-reasons-input');
  if (projects) projects.value = draft.projects || '';
  if (reasons) reasons.value = draft.reasons || '';

  setupDraftReady = true;
  // These rebuild the step order off the restored selection, which is what the
  // stored step is about to be resolved against.
  renderSetupDomains();
  if (HAS_APP_BLOCKING) renderSetupApps();
  renderSetupModeStep();

  // A saved step that no longer exists (a build change, a bridge that stopped
  // reporting, a service since removed from the blocklist) must not leave the
  // wizard on a blank screen.
  if (!draft.stepId) return 1;
  const index = setupStepOrder.findIndex(s => s.id === draft.stepId && s.group === (draft.stepGroup || null));
  return index === -1 ? 1 : index + 1;
}

// ---- Step: why this one? --------------------------------------------------
//
// One section serving N services, so the inputs are wired once and read this
// to know who they are currently writing about.
let currentPurposeGroup = null;

function purposeAnswersFor(key) {
  if (!setupServiceReasons[key]) setupServiceReasons[key] = { purpose: '', legitimateUse: '' };
  return setupServiceReasons[key];
}

function wirePurposeStep() {
  const fields = [
    ['setup-purpose-why-input', 'purpose'],
    ['setup-purpose-legit-input', 'legitimateUse']
  ];
  for (const [id, field] of fields) {
    const el = document.getElementById(id);
    // 'change' rather than 'input' for the same reason as the two global
    // answers: these invite several sentences, and banking a draft on every
    // keystroke writes to storage far more often than it is worth.
    el.addEventListener('change', () => {
      if (!currentPurposeGroup) return;
      purposeAnswersFor(currentPurposeGroup)[field] = el.value.trim();
      saveSetupDraft();
    });
  }
}

function renderPurposeStep(key) {
  currentPurposeGroup = key;
  const group = currentServiceGroups().find(g => g.key === key);
  // The order is recomputed on every selection change, so a step can only
  // point at a service that still exists. Guarding anyway: a stale draft
  // resolving to a removed service must not blank the screen.
  if (!group) return;

  document.getElementById('setup-purpose-title').textContent = group.label;

  // Two things at once, and both earn their place. "3 of 6" makes the run
  // finite: "Step 7 of 14" says where you are in the wizard but not how much
  // of *this* is left, and a repeating screen with no end in sight is what
  // makes a thorough setup read as an interrogation. The members clause only
  // appears when it explains something — that two things the user picked
  // separately are asking their questions once.
  const purposeSteps = setupStepOrder.filter(s => s.group);
  const position = purposeSteps.findIndex(s => s.group === key) + 1;
  const parts = [];
  if (purposeSteps.length > 1) parts.push(`${position} of ${purposeSteps.length}`);
  if ((group.domains.length + group.apps.length) > 1) {
    parts.push(serviceMembersLabel(group, setupAppLabels));
  }
  const members = document.getElementById('setup-purpose-members');
  members.textContent = parts.join(' · ');
  members.hidden = !parts.length;

  const mark = document.getElementById('setup-purpose-mark');
  applyServiceMark(mark, group);

  document.getElementById('setup-purpose-subtitle').textContent = setupBlockingMode === 'simple'
    ? 'Both optional. Simple mode has no coach to read these, but they are kept — turn a coach on later and it starts here.'
    : 'Both optional. Your coach reads these at the gate, so it can tell a real errand from a scroll dressed up as one.';

  document.getElementById('setup-purpose-why-label').textContent =
    `Why do you need to use ${group.label} with Intention?`;
  document.getElementById('setup-purpose-legit-label').textContent =
    `When do you consider yourself to have legitimate reason to use ${group.label}?`;

  const answers = purposeAnswersFor(key);
  document.getElementById('setup-purpose-why-input').value = answers.purpose || '';
  document.getElementById('setup-purpose-legit-input').value = answers.legitimateUse || '';
}

// The brand glyph from the suggestion chips, reused so the service is
// recognisable at a glance. Falls back to its initial where the catalogue has
// no mark — a hand-typed domain, or an app we don't know.
function applyServiceMark(el, group) {
  el.textContent = '';
  el.removeAttribute('style');
  const meta = SITE_META[group.key];
  if (meta && meta.icon) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', meta.icon);
    path.setAttribute('fill', meta.color || 'currentColor');
    svg.appendChild(path);
    el.appendChild(svg);
    return;
  }
  el.textContent = (group.label || '?').trim().charAt(0).toUpperCase();
}

// ---- Step: you're set -----------------------------------------------------

function renderDoneStep() {
  const siteCount = setupBlockedDomains.length;
  const appCount = setupBlockedApps.length;
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

  const parts = [];
  if (siteCount) parts.push(plural(siteCount, 'website'));
  if (appCount) parts.push(plural(appCount, 'app'));
  const what = parts.length ? parts.join(' and ') : 'nothing yet';

  document.getElementById('setup-done-summary').textContent =
    `Intention will step in on ${what}. Here's what happens from now on:`;

  const items = [];
  if (setupBlockingMode === 'simple') {
    items.push(setupSimpleBehavior === 'hard'
      ? ['A blocked page stops you', 'No way through from the page itself — you\'d have to change your settings.']
      : ['A blocked page offers you a pass', `A "Take ${setupSimplePassMinutes} minutes" button, on your own say-so.`]);
  } else {
    items.push(['A blocked page opens a conversation',
      'Your coach asks what you came for. A real, specific reason gets you time; a hollow one gets you alternatives.']);
    items.push(['Getting through gets harder as the day goes on',
      'Three passes a day at most, and each one takes more convincing than the last.']);
  }
  items.push(['Loosening a rule goes through your coach too',
    'Tightening is instant. Removing a block or raising a limit means making the case for it.']);

  const list = document.getElementById('setup-done-list');
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

  document.getElementById('setup-done-note').textContent = setupBlockingMode === 'simple'
    ? 'You can switch to a coach any time from Settings.'
    : 'If you skipped turning your coach on, your sites stay blocked — you just can\'t talk your way past them until you set that up in Settings → AI access.';
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
  // Chrome and Firefox have no apps step — promising one here sets up a
  // screen that never arrives.
  const blocksApps = HAS_APP_BLOCKING || HAS_IOS_APP_BLOCKING;
  items.push([blocksApps ? 'Choose your sites and apps' : 'Choose your sites',
    'The ones you want a moment of friction in front of.']);
  items.push(['Say what you’re trying to focus on',
    'Two short answers, so a block can point at your own reasons instead of just saying no.']);
  // Announced here rather than discovered at step 6 of 14. The run is as long
  // as the list they are about to pick, and saying so up front is what makes
  // it read as thorough instead of endless.
  items.push([blocksApps ? 'Then the same, for each one' : 'Then the same, for each site',
    'Why you need it, and when using it is fair enough. Skippable, and worth more than anything else you tell your coach.']);
  items.push(['Pick how a block should work',
    'A coach you have to talk past, or a plain block with no AI involved.']);

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
    if (setupStepOrder[setupStep - 1]?.id === 'setup-step-safari') refreshSafariStatus();
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

// Drops empty answers and anything written about a service the user has since
// removed from the blocklist. background.js sanitizes again on the way in —
// this is about not shipping dead keys, not about trusting the page.
function collectServiceReasons() {
  const live = new Set(currentServiceGroups().map(g => g.key));
  const out = {};
  for (const [key, value] of Object.entries(setupServiceReasons)) {
    if (!live.has(key)) continue;
    const purpose = (value?.purpose || '').trim();
    const legitimateUse = (value?.legitimateUse || '').trim();
    if (!purpose && !legitimateUse) continue;
    out[key] = { purpose, legitimateUse, updatedAt: Date.now() };
  }
  return out;
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

  // saveSetup writes every field it is given, so a key the user entered on the
  // access step has to be carried through here — passing the empty strings this
  // used to send would wipe it the moment they pressed Finish.
  const existing = await getConfig();

  await sendBg({
    action: 'saveSetup',
    config: {
      provider: existing?.provider || '',
      apiKey: existing?.apiKey || '',
      model: existing?.model || '',
      userContext,
      contextProjects: projectsAns,
      contextReasons: reasonsAns,
      blockedDomains: setupBlockedDomains,
      domainLimits,
      blockedApps: setupBlockedApps,
      appLimits,
      appLabels: setupAppLabels,
      // Only services still on the list, and only where something was written.
      // A blank answer and no answer mean the same thing to the coach, so
      // storing the difference would buy a falsy check and nothing else.
      serviceReasons: collectServiceReasons(),
      blockingMode: setupBlockingMode,
      simpleBehavior: setupSimpleBehavior,
      simplePassMinutes: setupSimplePassMinutes
    }
  });

  clearSetupDraft();
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
    // A custom key is access too, but it leaves no entitlement behind — without
    // this the paywall keeps asking for one after the key is already working.
    route: access?.route || null,
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
    // Offered wherever a store doesn't forbid it: Chrome/Firefox, where it is
    // the way in, and Android, where it sits under the purchase buttons as an
    // alternative. On Apple it stays null and lives solely in Settings ->
    // Advanced (see BYOK_IS_OFFERED in billing.js for why the two differ).
    //
    // Entering the key in place, rather than jumping to a disclosure inside a
    // disclosure, is reserved for builds where BYOK leads — and only in the
    // full-size paywall. The compact one renders inside a blocked page, which
    // is the worst possible moment to ask someone to go and fetch a key.
    onUseOwnKey: BYOK_IS_OFFERED ? () => openAdvancedKeySection() : null,
    onSaveKey: BYOK_IS_PRIMARY && !compact ? async ({ provider, apiKey, model }) => {
      await sendBg({ action: 'saveSettings', config: { provider, apiKey, model } });
      await rerender();
      await onAccessChanged();
    } : null
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
  // Reached from the onboarding paywall on browser and Android builds: the
  // advanced field lives in the settings view, so the wizard has to be
  // committed first or the click would silently do nothing behind a hidden
  // view. Committing is safe by then — the access step is the last thing
  // before "done", and blocking is already configured either way.
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
    // A monochrome mark (color: null) inherits the chip's text colour, so it
    // flips with the theme instead of staying the near-white it was published
    // as. See SITE_META.
    svg.setAttribute('fill', meta.color || 'currentColor');
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

// The daily limit a tapped suggestion should use. The chips lived in the
// Blocked sites card until they moved into the Add-website dialog, where there
// was no minutes field within reach and 10 was hard-coded; now they sit beside
// one, so a chip and the Add button agree on the number that was just typed.
// The wizard's own chip grid is still inline in its step and reads the same
// (untouched, so 10) field — one number for both, wherever you tap.
function currentAddSiteLimit() {
  const el = document.getElementById('domain-limit-input');
  const val = parseInt(el ? el.value : '', 10);
  return !isNaN(val) && val > 0 ? val : 10;
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
      return buildRecommendCard(meta, meta ? meta.name : site, site, () => addDomainToBlocklist(site, currentAddSiteLimit()));
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
  refreshSetupNav();
  saveSetupDraft();
  const list = document.getElementById('setup-websites-list');
  list.innerHTML = '';
  for (const d of setupBlockedDomains) {
    const limitInfo = setupDomainLimits[d] || { maxGrants: 3, maxMinutes: 10 };

    // No badge: the wizard hasn't asked about blocking mode yet at this step,
    // so there is nothing true to put there.
    const { li, fields } = buildBlockedRow({
      target: d,
      label: d,
      inlineFields: true,
      onRemove: () => {
        setupBlockedDomains = setupBlockedDomains.filter(x => x !== d);
        delete setupDomainLimits[d];
        renderSetupDomains();
      }
    });

    fields.appendChild(buildDailyLimitField(limitInfo.maxMinutes, d, (e) => {
      const val = parseInt(e.target.value, 10);
      if (!isNaN(val) && val > 0) {
        if (!setupDomainLimits[d]) {
          setupDomainLimits[d] = { maxGrants: 3 };
        }
        setupDomainLimits[d].maxMinutes = val;
      }
    }));

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
  refreshSetupNav();
  saveSetupDraft();
  const list = document.getElementById('setup-apps-list');
  list.innerHTML = '';
  for (const pkg of setupBlockedApps) {
    const name = setupAppLabels[pkg] || pkg;
    const limitInfo = setupAppLimits[pkg] || { maxGrants: 3, maxMinutes: 10 };

    const { li, fields } = buildBlockedRow({
      target: pkg,
      label: name,
      inlineFields: true,
      onRemove: () => {
        setupBlockedApps = setupBlockedApps.filter(x => x !== pkg);
        delete setupAppLimits[pkg];
        delete setupAppLabels[pkg];
        renderSetupApps();
      }
    });

    fields.appendChild(buildDailyLimitField(limitInfo.maxMinutes, name, (e) => {
      const val = parseInt(e.target.value, 10);
      if (!isNaN(val) && val > 0) {
        if (!setupAppLimits[pkg]) {
          setupAppLimits[pkg] = { maxGrants: 3 };
        }
        setupAppLimits[pkg].maxMinutes = val;
      }
    }));

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
  // Apple's picker is opaque — a count is all the web layer ever learns — so
  // this is also the only way the finish guard can tell whether an iOS user
  // has actually chosen anything.
  setupIOSSelectionCount = n;
  refreshSetupNav();
  statusEl.className = n === 0 ? 'setup-check' : 'setup-check ok';
  statusEl.textContent = n === 0
    ? 'Screen Time access granted. No apps chosen yet, so tap "Choose apps to block" above.'
    : `${n} app${n === 1 ? '' : 's or categories'} chosen.`;
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
  for (const [id, tab] of [['tab-apps-btn', 'apps'], ['tab-websites-btn', 'websites']]) {
    const btn = document.getElementById(id);
    btn.classList.toggle('selected', activeSettingsTab === tab);
    btn.setAttribute('role', 'tab');
    btn.setAttribute('aria-selected', String(activeSettingsTab === tab));
  }
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
  applyIOSUnlockLanding();
  applyDeepLinkSection();
}

// On iOS a blocked app's shield can't open this app — Apple only lets it close
// the app the user was in — so the whole intervention ends with them arriving
// here having been told to find "Unlock". Opening on the tab they were sent to
// beats restoring whichever one they last used. A deep link still wins, and so
// does any later tap.
function applyIOSUnlockLanding() {
  if (!HAS_IOS_APP_BLOCKING) return;
  iosScreenTimeStatus().then(st => {
    if (!st || !st.authorized || !(st.selectionCount > 0)) return;
    if (new URLSearchParams(window.location.search).get('section')) return;
    setSettingsSection('unlock');
  });
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
  // .selected is the only thing that used to mark the current tab, which a
  // screen reader can't see — these are tabs, so they should say so.
  document.querySelectorAll('#section-tabs [data-section-tab]').forEach(btn => {
    const on = btn.dataset.sectionTab === activeSettingsSection;
    btn.classList.toggle('selected', on);
    btn.setAttribute('role', 'tab');
    btn.setAttribute('aria-selected', String(on));
  });
  document.querySelectorAll('#settings-view [data-section]').forEach(el => {
    el.classList.toggle('section-hidden', el.dataset.section !== activeSettingsSection);
  });
}

// ---- Add-item popup modals ----

// What had focus when the dialog opened, per modal, so closing hands it back
// to the button that opened it instead of dropping the caret onto <body> —
// which on a phone leaves the next Tab starting from the top of the page.
const addModalReturnFocus = {};

// The suggestion chips moved into these dialogs because they belong to the act
// of adding. The wizard's own site and app steps have always had a chip grid
// inline, right under the "+ Add website" button — so opening the dialog from
// the wizard put the same twelve suggestions on top of the twelve already on
// screen. Both are correct in their own view; only their overlap is wrong.
//
// The wizard keeps the inline grid, because during onboarding the chips ARE
// the step: an empty list with tappable suggestions under it is the whole
// instruction, and hiding them behind a dialog turns a one-tap start into two.
// So the dialog drops its copy while the wizard is on screen, and is what it
// says on the button there — the place you go to type an address the
// suggestions don't cover.
function openAddModal(modalId, focusInputId) {
  addModalReturnFocus[modalId] = document.activeElement;
  const inWizard = !document.getElementById('setup-view').hidden;
  const suggestions = document.getElementById(modalId).querySelector('.add-modal-suggestions');
  if (suggestions) suggestions.hidden = inWizard;
  document.getElementById(modalId).hidden = false;
  document.getElementById(focusInputId)?.focus();
}

function closeAddModal(modalId) {
  document.getElementById(modalId).hidden = true;
  const opener = addModalReturnFocus[modalId];
  delete addModalReturnFocus[modalId];
  // The opener can have been re-rendered away underneath us (adding a site
  // rebuilds the list), so only restore focus to something still on the page.
  if (opener && typeof opener.focus === 'function' && document.contains(opener)) opener.focus();
}

// Anything a Tab can land on. Kept in one place because the trap below has to
// agree with the browser about what "focusable" means, or it wraps early and
// makes controls unreachable.
const FOCUSABLE_SELECTOR = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

// These dialogs are plain divs toggled with the `hidden` attribute rather than
// <dialog>, because they're shared singletons driven from both the wizard and
// the settings view and they have to behave the same inside the Android
// WebView. Nothing <dialog> gives you for free comes for free here, so the
// three things a modal owes you are spelled out: a scrim you can click, an
// Escape that closes, and a Tab that can't walk out into the page behind.
//
// `extraIds` names containers that belong to the dialog but live elsewhere in
// the DOM — wireAppSearch detaches its results popup to <body> so it can
// escape the stacking context of .card — and would otherwise be trapped out.
function wireModalDismissal(modalId, onClose, extraIds = []) {
  const modal = document.getElementById(modalId);
  if (!modal) return;

  // Only a press that both starts and ends on the scrim dismisses. A drag that
  // begins inside the box and releases outside it is a text selection, and
  // closing on it would throw away whatever had been typed.
  let pressedScrim = false;
  modal.addEventListener('mousedown', (e) => { pressedScrim = e.target === modal; });
  modal.addEventListener('click', (e) => {
    const dismiss = e.target === modal && pressedScrim;
    pressedScrim = false;
    if (dismiss) onClose();
  });

  // Bound to the document, not the dialog: a click on the scrim leaves focus
  // on <body>, and the results popup lives outside the dialog's subtree, so a
  // listener on the modal itself would miss both.
  document.addEventListener('keydown', (e) => {
    if (modal.hidden) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key !== 'Tab') return;
    const roots = [modal, ...extraIds.map(id => document.getElementById(id))];
    const items = roots
      .filter(root => root && !root.hidden)
      .flatMap(root => [...root.querySelectorAll(FOCUSABLE_SELECTOR)])
      // offsetParent is null for anything display:none'd by an ancestor, which
      // is how the folded-away suggestion chips and the empty results list
      // hide — a wrap onto one of those would look like focus vanishing.
      .filter(el => el.offsetParent !== null);
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  });
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
  // Every route out of the dialog runs the same teardown — the error line has
  // to go with it, or it is still sitting there the next time it opens.
  const dismissSiteModal = () => {
    setAddSiteError('');
    closeAddModal('add-site-modal');
  };
  document.getElementById('close-add-site-btn').addEventListener('click', dismissSiteModal);
  wireModalDismissal('add-site-modal', dismissSiteModal);
  // The modal only closes on a successful add now — closing it on a rejected
  // one would take the error message away with it.
  const submitDomain = async () => {
    if (await addDomain()) closeAddModal('add-site-modal');
  };
  document.getElementById('add-btn').addEventListener('click', submitDomain);
  document.getElementById('domain-input').addEventListener('keydown', async e => {
    if (e.key === 'Enter') await submitDomain();
  });
  document.getElementById('domain-limit-input').addEventListener('keydown', async e => {
    if (e.key === 'Enter') await submitDomain();
  });

  if (HAS_APP_BLOCKING) {
    document.getElementById('open-add-app-btn')?.addEventListener('click', () => openAddModal('add-app-modal', 'app-search-input'));
    document.getElementById('setup-open-add-app-btn')?.addEventListener('click', () => openAddModal('add-app-modal', 'app-search-input'));
    const dismissAppModal = () => closeAddModal('add-app-modal');
    document.getElementById('close-add-app-btn').addEventListener('click', dismissAppModal);
    // The search results are detached to <body>, so they have to be named here
    // to stay inside the trap. See wireAppSearch.
    wireModalDismissal('add-app-modal', dismissAppModal, ['app-search-results']);
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
// default hard/pass behavior + pass length. The per-row Coach/Simple toggle
// (buildRowModeToggle) lets individual sites/apps override this global default
// — and picking the mode that already matches it drops the override again.
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

  // These read as a radio group but are plain buttons carrying a .selected
  // class, so the chosen one has to be announced explicitly.
  const setChoice = (btn, on) => {
    btn.classList.toggle('selected', on);
    btn.setAttribute('aria-pressed', String(on));
  };

  function render() {
    setChoice(coachBtn, mode === 'coach');
    setChoice(simpleBtn, mode === 'simple');
    simpleOptions.hidden = mode !== 'simple';
    setChoice(hardBtn, behavior === 'hard');
    setChoice(passBtn, behavior === 'pass');
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
    renderDomains(fresh.blockedDomains || [], fresh.domainLimits || {}, fresh.blockingMode, fresh.serviceReasons || {});
    if (HAS_APP_BLOCKING) {
      renderApps(fresh.blockedApps || [], fresh.appLimits || {}, fresh.appLabels || {}, fresh.blockingMode, fresh.serviceReasons || {});
    }
  };
}

// showSettingsView re-runs whenever the view is re-rendered (finishing the
// wizard lands here, and so does the paywall's jump to the key field), but the
// controls below are static markup that only needs binding once. Binding on
// every pass stacked handlers — two "turn off all blocking" listeners means two
// coach gates for one click. wireAddModals/wireBlockingModeCard already guard
// themselves; this does the same for the rest.
const boundOnce = new Set();
function bindOnce(id, event, handler) {
  const key = `${id}:${event}`;
  if (boundOnce.has(key)) return;
  boundOnce.add(key);
  document.getElementById(id)?.addEventListener(event, handler);
}

async function showSettingsView(state) {
  document.getElementById('setup-view').hidden = true;
  document.getElementById('settings-view').hidden = false;

  renderContextCard(state.userContext);
  await renderCoachObservations();

  bindOnce('clear-observations-btn', 'click', async () => {
    await new Promise(resolve => chrome.storage.local.set({ coachObservations: [] }, resolve));
    await renderCoachObservations();
    setStatus('observations-status', 'Cleared.', 'success');
  });

  bindOnce('save-context-btn', 'click', async () => {
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

  const savePromptFields = async (announce) => {
    await sendBg({
      action: 'saveSettings',
      config: {
        coachInstructions: instructionsInput.value.trim(),
        contextProjects: projectsInput.value.trim(),
        contextReasons: reasonsInput.value.trim()
      }
    });
    if (announce) setStatus('prompt-status', 'Saved.', 'success');
  };

  bindOnce('save-prompt-btn', 'click', () => savePromptFields(true));

  // These three sit inside a collapsed <details> in the Coach section, and
  // every other control on the page saves itself — so typing here, switching
  // tab and coming back used to lose the lot with nothing said. Saving on the
  // way out costs nothing and the button still works for anyone who wants it.
  for (const field of [instructionsInput, projectsInput, reasonsInput]) {
    bindOnce(field.id, 'blur', () => savePromptFields(false));
  }

  bindOnce('reset-prompt-btn', 'click', async () => {
    instructionsInput.value = state.defaultCoachInstructions || '';
    await sendBg({ action: 'saveSettings', config: { coachInstructions: '' } });
    const fresh = await getConfig();
    instructionsInput.value = fresh.coachInstructions || '';
    setStatus('prompt-status', 'Reset to default.', 'success');
  });

  await refreshAccessUI('access-paywall');

  // ---- Advanced: custom API key ----
  //
  // Where a store sells credit this really is a developer override and is
  // described as one. On Chrome and Firefox it is one of the two ordinary ways
  // to turn the coach on — offered as such in AI access above — so calling it
  // "developer mode" down here would only make people think they'd taken a
  // wrong turn. Same fields either way; this is where you change or clear one.
  document.getElementById('custom-key-summary-note').textContent =
    BYOK_IS_PRIMARY ? '(change or remove)' : '(optional developer mode)';
  document.getElementById('custom-key-blurb').textContent = BYOK_IS_PRIMARY
    ? 'The key you set up under AI access, plus the model to use with it. Clearing it here switches the coach back to coaching credit.'
    : 'For advanced users and developers. If configured, custom keys will bypass the coaching-credit balance.';

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

  bindOnce('save-provider-btn', 'click', async () => {
    const provider = provSel.value;
    const model = modelInput.value.trim() || PROVIDERS[provider].defaultModel;
    const apiKey = keyInput.value.trim();
    await sendBg({ action: 'saveSettings', config: { provider, model, apiKey } });
    setStatus('provider-status', apiKey ? 'Saved. Custom key is now in use.' : 'Saved.', 'success');
    await refreshAccessUI('access-paywall');
  });

  // Clearing the override drops straight back to the hosted/credit route.
  bindOnce('clear-provider-btn', 'click', async () => {
    keyInput.value = '';
    await sendBg({ action: 'saveSettings', config: { provider: '', model: '', apiKey: '' } });
    setStatus('provider-status', 'Custom key cleared.', 'success');
    await refreshAccessUI('access-paywall');
  });

  wireBlockingModeCard(state);

  renderDomains(state.blockedDomains || [], state.domainLimits || {}, state.blockingMode, state.serviceReasons || {});
  wireAddModals();

  if (HAS_APP_BLOCKING) {
    document.getElementById('apps-card').hidden = false;
    renderApps(state.blockedApps || [], state.appLimits || {}, state.appLabels || {}, state.blockingMode, state.serviceReasons || {});
  } else if (HAS_IOS_APP_BLOCKING) {
    wireIOSAppsCard();
  }

  initSettingsTabs();
  initSectionTabs();

  const summary = await sendBg({ action: 'getStatsSummary' });
  renderStats(summary);
  await refreshUsageLog(state);

  bindOnce('open-coach-btn', 'click', async () => {
    if (await requireAccess()) openCoachModal();
  });
  bindOnce('close-coach-btn', 'click', closeCoachModal);
  bindOnce('paywall-close-btn', 'click', () => {
    document.getElementById('paywall-modal').hidden = true;
  });

  // Disabling all blocking is the biggest loosening of all — gate it.
  bindOnce('disable-all-btn', 'click', async () => {
    const cfg = await getConfig();
    const iosStatus = HAS_IOS_APP_BLOCKING ? await iosScreenTimeStatus() : null;
    const iosHasApps = !!(iosStatus && iosStatus.selectionCount > 0);
    if (!(cfg.blockedDomains || []).length && !(cfg.blockedApps || []).length && !iosHasApps) {
      // Used to write into #prompt-status, which lives inside the collapsed
      // "Coach instructions" disclosure in a different section — so on mobile
      // this said nothing at all.
      setStatus('disable-all-status', 'Nothing is blocked right now.', '');
      return;
    }
    applyOrGate({
      isSimple: (cfg.blockingMode || 'coach') === 'simple',
      changeType: 'disable_all',
      domain: null,
      title: 'Turn off all blocking?',
      subtitle: 'This turns off blocking for every site and app on your list. Convince your coach this is what you really want.',
      onApproved: async () => {
        const state = await getConfig();
        renderDomains(state.blockedDomains || [], state.domainLimits || {}, state.blockingMode, state.serviceReasons || {});
        if (HAS_APP_BLOCKING) {
          renderApps(state.blockedApps || [], state.appLimits || {}, state.appLabels || {}, state.blockingMode, state.serviceReasons || {});
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

  bindOnce('ios-authorize-btn', 'click', () => {
    window.intentionScreenTime.authorize(() => refreshIOSAppsCard());
  });

  document.getElementById('section-tab-unlock').hidden = false;
  document.getElementById('unlock-card').hidden = false;
  bindOnce('ios-request-time-btn', 'click', () => {
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
// Returns false when the domain was already on the list, so the caller can say
// so — silently doing nothing reads as the Add button being broken.
async function addDomainToBlocklist(domain, limit) {
  if (!document.getElementById('setup-view').hidden) {
    if (setupBlockedDomains.includes(domain)) return false;
    setupBlockedDomains.push(domain);
    setupDomainLimits[domain] = { maxGrants: 3, maxMinutes: limit };
    renderSetupDomains();
    return true;
  }
  const state = await getConfig();
  const domains = state.blockedDomains || [];
  const limits = state.domainLimits || {};
  if (domains.includes(domain)) return false;
  domains.push(domain);
  limits[domain] = { maxGrants: 3, maxMinutes: limit };
  await sendBg({ action: 'saveSettings', config: { blockedDomains: domains, domainLimits: limits } });
  renderDomains(domains, limits, state.blockingMode, state.serviceReasons || {});
  return true;
}

// Normalisation only ever stripped a scheme, a www. and a path, so anything at
// all survived as a "domain" — "asdf" was accepted and then quietly never
// matched a page for the rest of the install. A hostname needs at least one dot
// and a plausible TLD to be worth adding.
function isBlockableDomain(domain) {
  return /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(domain);
}

function normalizeDomainInput(raw) {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .split('/')[0]
    .split('?')[0]
    .split('#')[0]
    .replace(/:\d+$/, '');
}

function setAddSiteError(message) {
  const el = document.getElementById('add-site-error');
  if (!el) return;
  el.textContent = message || '';
  el.hidden = !message;
}

// Resolves true when the modal should close.
async function addDomain() {
  const input = document.getElementById('domain-input');
  const limitInput = document.getElementById('domain-limit-input');
  const raw = input.value.trim();
  if (!raw) {
    setAddSiteError('Type a website address first.');
    return false;
  }

  const domain = normalizeDomainInput(raw);
  if (!isBlockableDomain(domain)) {
    setAddSiteError(`"${raw}" doesn't look like a website address. Try something like twitter.com.`);
    return false;
  }

  const limitVal = parseInt(limitInput.value, 10);
  const limit = !isNaN(limitVal) && limitVal > 0 ? limitVal : 10;

  const added = await addDomainToBlocklist(domain, limit);
  if (!added) {
    setAddSiteError(`${domain} is already on your list.`);
    return false;
  }
  setAddSiteError('');
  input.value = '';
  limitInput.value = '10';
  return true;
}

// Both of these used to be hand-written mirrors of background.js. They now
// name rules.js's resolution, which every context shares — the row rendering
// below already holds the limits entry, so it calls the entry-level form
// rather than the storage-reading wrappers in background.js.
const effectiveModeFor = resolveMode;
const looseUntilFor = (entry) => normalizeLooseUntil(entry && entry.looseUntilMinutes);

// Loosening a rule (removing a block, raising a limit, lengthening the lenient
// window, rewriting what you told the coach a site is for, disabling
// everything) normally requires convincing the AI coach via openGateModal. In
// simple mode there's no AI, so the change just applies immediately instead.
//
// `isApp`/`appLabel` only say what the target IS, so the coach can call it "the
// Instagram app" rather than reciting a package name. Most change types give
// that away by their name; the reason-box edits don't, because one row type
// isn't enough to tell sites and apps apart there.
async function applyOrGate({ isSimple, isApp, appLabel, changeType, domain, newValue, currentValue, title, subtitle, onApproved }) {
  if (isSimple) {
    await sendBg({ action: 'applySettingChange', changeType, domain, newValue });
    await onApproved();
    return;
  }
  openGateModal({ changeType, domain, isApp, appLabel, currentValue, newValue, title, subtitle, onApproved });
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
      renderDomains(state.blockedDomains || [], state.domainLimits || {}, state.blockingMode, state.serviceReasons || {});
    }
  });
}

// ---- The blocked-site / blocked-app row ------------------------------------
//
// A row is a small card, and it reads top to bottom as one decision getting
// more specific: WHICH site, HOW it's blocked, HOW MUCH at most, WHEN the
// coach stops being lenient, and WHY you set it up in the first place.
//
// The head is identity and the one switch that changes everything under it —
// a brand mark, the name, the Coach/Simple toggle, Remove. Everything below
// the hairline is that mode's settings. Hierarchy comes from surface and
// position: every field names itself with the 10px micro-label rather than
// with a bigger font, and the controls all sit at one size.
//
// What was here before had six controls and no order: a badge that only
// reported the blocking mode, a "Blocking mode" select two inches under it
// saying the same thing, a limit called "Daily limit" as if it were an
// allowance, and the two answers the coach actually argues from folded away
// inside a collapsed disclosure at the bottom.

function microLabel(text) {
  const el = document.createElement('span');
  el.className = 'micro-label';
  el.textContent = text;
  return el;
}

// A labelled control in the settings strip: a micro-label caption over one or
// more controls that sit on a line together. Every control in a row is named
// this way rather than by a title attribute a screen reader may never announce.
function buildRowField(labelEl, ...controls) {
  const field = document.createElement('div');
  field.className = 'row-field';
  field.appendChild(labelEl);
  const control = document.createElement('div');
  control.className = 'row-field-control';
  control.append(...controls);
  field.appendChild(control);
  return field;
}

// What the row does, and the control that changes it — one thing, in the head,
// where you read it.
//
// This replaces a pair that said the same thing twice: a "COACH" badge in the
// head and a "Blocking mode" select in the strip below it. A badge that only
// reports a setting sitting two inches above the setting is a label pretending
// to be information.
//
// Two buttons where storage has three states. The third — `mode` absent,
// meaning "follow the global default" — is not dropped, it is just no longer
// something to choose: the toggle shows the mode that is EFFECTIVE, and
// picking the one that already matches the global deletes the override rather
// than writing it. So a row you never touched still follows the global card,
// and a row you set to disagree with it stays set. Same three states, one
// fewer decision.
function buildRowModeToggle(target, label, limitInfo, globalMode, persistKey, onSaved) {
  const group = document.createElement('div');
  group.className = 'row-mode-toggle';
  // A named group, because "Coach" and "Simple" ten times down the page is
  // twenty unattached words to a screen reader without the row named once.
  group.setAttribute('role', 'group');
  group.setAttribute('aria-label', `How ${label} is blocked`);

  const current = effectiveModeFor(limitInfo, globalMode);

  const persist = async (mode) => {
    if (mode === current) return;
    const state = await getConfig();
    const currentLimits = state[persistKey] || {};
    if (!currentLimits[target]) currentLimits[target] = { maxGrants: 3 };
    // Matching the global again means having no opinion again — see above.
    if (mode === (globalMode || 'coach')) delete currentLimits[target].mode;
    else currentLimits[target].mode = mode;
    // The simple-only fields follow the mode they belong to, exactly as they
    // did when the select owned this: a coach row carrying a stale pass length
    // is a setting that does nothing and reappears if you ever switch back.
    if (mode === 'simple') {
      if (!currentLimits[target].behavior) currentLimits[target].behavior = limitInfo.behavior || 'pass';
      if (!currentLimits[target].passMinutes) currentLimits[target].passMinutes = limitInfo.passMinutes || 10;
    } else {
      delete currentLimits[target].behavior;
      delete currentLimits[target].passMinutes;
    }
    await sendBg({ action: 'saveSettings', config: { [persistKey]: currentLimits } });
    await onSaved();
  };

  for (const [mode, text] of [['coach', 'Coach'], ['simple', 'Simple']]) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'row-mode-btn';
    btn.textContent = text;
    // Buttons carrying a .selected class read as nothing at all without this;
    // aria-pressed is what makes the pair announce as a choice.
    btn.setAttribute('aria-pressed', String(mode === current));
    btn.classList.toggle('selected', mode === current);
    btn.addEventListener('click', () => persist(mode));
    group.appendChild(btn);
  }
  return group;
}

// The head and the empty settings strip, shared by all four lists (settings
// and wizard, sites and apps). Returns both, so the caller fills the strip
// with whatever its list actually offers.
//
// `inlineFields` drops the strip and hands back the head instead: the wizard
// rows carry a daily limit and nothing else, and a band of its own for one
// number is a lot of card for very little.
function buildBlockedRow({ target, label, headExtra, onRemove, inlineFields = false }) {
  const li = document.createElement('li');

  const head = document.createElement('div');
  head.className = 'row-head';

  const mark = document.createElement('span');
  mark.className = 'row-mark';
  mark.setAttribute('aria-hidden', 'true');
  applyServiceMark(mark, { key: serviceKeyFor(target), label });
  head.appendChild(mark);

  const name = document.createElement('span');
  name.className = 'domain-name';
  name.textContent = label;
  // The name still truncates on a narrow window; the title is the whole of it.
  name.title = label;
  head.appendChild(name);

  // The settings rows put the Coach/Simple toggle here, between the name and
  // Remove. The wizard rows pass nothing: it hasn't asked about blocking mode
  // yet at that step, so there is nothing true to put there.
  if (headExtra) head.appendChild(headExtra);

  // Placed before the Remove button either way, so the caller can fill it
  // afterwards and still have Remove come last.
  const fields = document.createElement('div');
  fields.className = inlineFields ? 'row-fields-inline' : 'row-fields';
  if (inlineFields) head.appendChild(fields);

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = 'Remove';
  btn.className = 'delete-btn';
  // Ten buttons all reading "Remove" is one row of the settings page to a
  // screen reader. The visible label stays short; the accessible one doesn't.
  btn.setAttribute('aria-label', `Remove ${label}`);
  btn.addEventListener('click', onRemove);
  head.appendChild(btn);

  li.appendChild(head);
  if (!inlineFields) li.appendChild(fields);

  return { li, fields };
}

// Ids for the info notes below. A page-lifetime counter rather than the target
// name: a domain is not a valid id fragment, and the same service can appear
// in both the sites list and the apps list.
let rowInfoSeq = 0;

// The ⓘ beside the absolute daily max. A disclosure, not a tooltip: a tooltip
// is a hover, and most installs of this page are a phone. `aria-expanded` and
// `aria-controls` are the whole of the semantics, and what it opens is
// ordinary text in the flow rather than a floating layer to keep positioned.
function buildInfoAffordance(labelText, text) {
  const id = `row-info-${++rowInfoSeq}`;

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'row-info-btn';
  btn.textContent = 'i';
  btn.setAttribute('aria-label', labelText);
  btn.setAttribute('aria-expanded', 'false');
  btn.setAttribute('aria-controls', id);

  const note = document.createElement('p');
  note.className = 'row-info-note';
  note.id = id;
  note.textContent = text;
  note.hidden = true;

  btn.addEventListener('click', () => {
    note.hidden = !note.hidden;
    btn.setAttribute('aria-expanded', String(!note.hidden));
  });
  return { btn, note };
}

const MAX_MINUTES_EXPLAINER =
  'The most time you could genuinely need here in one day — a ceiling, not a target. ' +
  'Your coach will never grant past it, however good the reason. Set it to what a bad day should still be allowed to cost you, not to what a normal day looks like.';

// The absolute daily max — the same `maxMinutes` field it has always been,
// under the name it has always had in the coach's own prompts ("absolute max").
// "Daily limit" read like an allowance to be spent; it is a wall.
//
// The four lists disagree about what a change means — the wizard writes to a
// draft, the settings lists gate an increase behind the coach — so the handler
// is the caller's, and only the markup is shared. `info` is settings-only: the
// wizard step explains the number in its own subtitle, and a second
// explanation per row would be three of them on one screen.
function buildDailyLimitField(minutes, ariaName, onChange, { info = false } = {}) {
  const input = document.createElement('input');
  input.type = 'number';
  input.min = '1';
  input.className = 'inline-limit-input';
  input.setAttribute('aria-label', `Absolute daily max in minutes for ${ariaName}`);
  input.value = minutes;
  input.addEventListener('change', onChange);
  const unit = document.createElement('span');
  unit.className = 'row-field-unit';
  unit.textContent = 'min/day';

  if (!info) return buildRowField(microLabel('Absolute daily max'), input, unit);

  const { btn, note } = buildInfoAffordance(
    `What the absolute daily max on ${ariaName} means`,
    MAX_MINUTES_EXPLAINER
  );
  const field = buildRowField(microLabel('Absolute daily max'), input, unit, btn);
  field.appendChild(note);
  return field;
}

// An empty list used to render as nothing at all, which reads the same as a
// list that failed to load. One line saying so, and where to start.
function renderEmptyList(list, text) {
  const li = document.createElement('li');
  li.className = 'list-empty';
  li.textContent = text;
  list.appendChild(li);
}

// The two lists' four disagreements, in one place. Everything below the head
// hairline is otherwise identical between a blocked site and a blocked app,
// and it was already two near-identical copies of the daily-max gate before
// the timeline and the reason boxes were about to make it three.
const ROW_KINDS = {
  domain: {
    persistKey: 'domainLimits',
    increaseLimit: 'increase_limit',
    increaseLoose: 'increase_loose_window',
    isApp: false
  },
  app: {
    persistKey: 'appLimits',
    increaseLimit: 'increase_app_limit',
    increaseLoose: 'increase_app_loose_window',
    isApp: true
  }
};

// ---- The loose -> strict timeline (buildLooseTimelineField) ----------------
//
// One number drawn as the day it describes: `looseUntilMinutes`, how many of
// today's minutes on this site the coach spends being lenient before it turns
// strict. Left of the split a plausible, specific reason earns time; right of
// it only genuine need does, and any pass the coach does grant comes back
// clamped short. Absent means no split at all — the whole day is lenient,
// which is exactly how every row behaved before this control existed — so the
// handle opens at the far right rather than inventing a line the user never
// drew. Dragging it back is the act of drawing one.
//
// The thing that moves is a real <input type="range">, not a div with pointer
// handlers. A range is keyboard-operable out of the box (arrows, Home, End,
// Page keys), announced by screen readers with its own value and bounds, and
// draggable, with no ARIA plumbing to get wrong. The band behind it is
// decoration and is hidden from the accessibility tree outright, because a
// screen reader reading "loose, strict, slider 15" is the same fact three
// times. The number box beside it is the second way in, for anyone who would
// rather type 15 than hunt for it; both write the same field.
//
// The band and the number update on `input` — live, as you drag — but nothing
// is saved until `change`, which for a range fires on release. Otherwise
// dragging left to right would open a coach gate for every pixel on the way.
function buildLooseTimelineField(target, label, limitInfo, kind, maxMinutes, rerender) {
  const stored = looseUntilFor(limitInfo);
  // A max that has since been lowered can leave a split beyond the end of the
  // track. Past the end and absent mean the same thing here — lenient all day.
  const effective = stored == null ? maxMinutes : Math.min(stored, maxMinutes);

  const field = document.createElement('div');
  field.className = 'row-field row-timeline-field';
  field.appendChild(microLabel('Coach goes strict after'));

  const timeline = document.createElement('div');
  timeline.className = 'row-timeline';

  // The band and the range it drives share a positioned box of their own, so
  // the range can be laid over the band without reaching the scale beneath it
  // — on a coarse pointer the range grows to a 44px target and would otherwise
  // sit on top of the number box.
  const track = document.createElement('div');
  track.className = 'row-timeline-track';

  const band = document.createElement('div');
  band.className = 'row-timeline-band';
  band.setAttribute('aria-hidden', 'true');
  const loose = document.createElement('span');
  loose.className = 'row-timeline-phase is-loose';
  loose.textContent = 'loose';
  const strict = document.createElement('span');
  strict.className = 'row-timeline-phase is-strict';
  strict.textContent = 'strict';
  band.append(loose, strict);

  const range = document.createElement('input');
  range.type = 'range';
  range.className = 'row-timeline-range';
  range.min = '0';
  range.max = String(maxMinutes);
  range.step = '1';
  range.setAttribute('aria-label', `Minutes on ${label} before the coach turns strict`);

  const scale = document.createElement('div');
  scale.className = 'row-timeline-scale';
  const zero = document.createElement('span');
  zero.className = 'row-timeline-end';
  zero.textContent = '0';
  const number = document.createElement('input');
  number.type = 'number';
  number.className = 'inline-limit-input row-timeline-number';
  number.min = '0';
  number.max = String(maxMinutes);
  number.setAttribute('aria-label', `Minutes on ${label} before the coach turns strict`);
  const end = document.createElement('span');
  end.className = 'row-timeline-end';
  end.textContent = `${maxMinutes} min`;
  scale.append(zero, number, end);

  const note = document.createElement('p');
  note.className = 'row-timeline-note';

  // Paints, never saves. Called on every drag frame and to revert a change the
  // coach didn't approve.
  const paint = (value) => {
    const pct = maxMinutes > 0 ? Math.round((value / maxMinutes) * 100) : 100;
    loose.style.flexBasis = `${pct}%`;
    strict.style.flexBasis = `${100 - pct}%`;
    range.value = String(value);
    number.value = String(value);
    // aria-valuetext, so the announcement is "15 minutes, then strict" rather
    // than a bare "15" — the number alone doesn't say what it counts.
    range.setAttribute('aria-valuetext',
      value >= maxMinutes
        ? `lenient all day, no strict phase`
        : `${value} of ${maxMinutes} minutes lenient, then strict`);
    note.textContent = value >= maxMinutes
      ? 'Lenient all day — the coach never turns strict here.'
      : `The first ${value} min of your day here are judged gently. After that, genuine need only, and passes are capped short.`;
  };
  paint(effective);

  const persist = async (value) => {
    const state = await getConfig();
    const currentLimits = state[kind.persistKey] || {};
    if (!currentLimits[target]) currentLimits[target] = { maxGrants: 3 };
    currentLimits[target].looseUntilMinutes = value;
    await sendBg({ action: 'saveSettings', config: { [kind.persistKey]: currentLimits } });
  };

  // Direction is the whole of the rule here, exactly as it is for the daily
  // max above: a SHORTER lenient window is a tightening and saves itself, a
  // LONGER one is a loosening and has to be argued for.
  const commit = async (raw) => {
    const parsed = parseInt(raw, 10);
    if (isNaN(parsed)) {
      paint(effective);
      return;
    }
    const value = Math.max(0, Math.min(maxMinutes, parsed));
    if (value === effective) {
      paint(effective);
      return;
    }
    if (value < effective) {
      paint(value);
      await persist(value);
      return;
    }
    paint(effective); // revert until/unless approved
    applyOrGate({
      // Only ever reachable in coach mode — the whole band is coach-only, so
      // there is no simple-mode branch to take here. Passed anyway, and read
      // from the row, so the day this moves it does the right thing.
      isSimple: false,
      isApp: kind.isApp,
      appLabel: kind.isApp ? label : undefined,
      changeType: kind.increaseLoose,
      domain: target,
      currentValue: effective,
      newValue: value,
      title: `Stay lenient for longer on ${label}?`,
      subtitle: `Right now your coach goes strict after ${effective} min a day on ${label}. You're asking for ${value}. Convince your coach.`,
      onApproved: rerender
    });
  };

  range.addEventListener('input', () => paint(parseInt(range.value, 10) || 0));
  range.addEventListener('change', () => commit(range.value));
  number.addEventListener('change', () => commit(number.value));

  track.append(band, range);
  timeline.append(track, scale, note);
  field.appendChild(timeline);
  return field;
}

// ---- The two site-specific answers (buildRowReasonFields) ------------------
//
// Promoted out of the collapsed <details> they used to hide inside. They are
// not a footnote to the row: they are the calm version of you, in writing,
// which the coach quotes back at the version standing in front of the block.
// A disclosure was the right shape when they were optional prose nobody read;
// it is the wrong shape for the thing that decides the argument.
//
// Keyed per SERVICE, not per target (serviceKeyFor folds the X app and x.com
// onto one answer), which is what the "Shared with …" note is telling you.
//
// Editing one now costs a conversation. They feed every gate decision on this
// service, so quietly rewriting "when is it legitimate" is just the block with
// extra steps. The FIRST write of a field is direct, exactly as the coach-
// context card's is — there is no weak moment to guard against before anything
// exists — and every edit after that routes through applyOrGate.
function buildRowReasonFields(target, label, kind, serviceReasons, allBlocked, rerender) {
  const key = serviceKeyFor(target);
  const answers = (serviceReasons || {})[key] || {};

  const wrap = document.createElement('div');
  wrap.className = 'row-reasons';

  // Only worth saying where it is true, and it is the entire explanation for
  // why editing this row also changes another one.
  const shared = (allBlocked || [])
    .filter(t => t.target !== target && serviceKeyFor(t.target) === key)
    .map(t => t.label);
  if (shared.length) {
    const sharedNote = document.createElement('p');
    sharedNote.className = 'row-reason-shared';
    sharedNote.textContent = `Shared with ${shared.join(', ')} — the same service, so this edits both.`;
    wrap.appendChild(sharedNote);
  }

  const fields = [
    {
      field: 'purpose',
      caption: "Why you're blocking it",
      changeType: 'edit_site_purpose',
      placeholder: `e.g. It eats the evening and I never meant to open it.`
    },
    {
      field: 'legitimateUse',
      caption: 'Why you need it',
      changeType: 'edit_site_legitimate',
      placeholder: `e.g. Replying to one specific DM. Never the feed.`
    }
  ];

  for (const { field, caption, changeType, placeholder } of fields) {
    const row = document.createElement('div');
    row.className = 'row-reason';

    const fieldLabel = document.createElement('label');
    fieldLabel.className = 'micro-label row-reason-label';
    fieldLabel.textContent = caption;

    const area = document.createElement('textarea');
    area.rows = 2;
    area.className = 'row-reason-input';
    area.value = answers[field] || '';
    area.placeholder = placeholder;
    area.id = `row-reason-${++rowInfoSeq}`;
    fieldLabel.htmlFor = area.id;
    // The visible caption is two or three words and repeats down the page; the
    // accessible one names the row it belongs to.
    area.setAttribute('aria-label', `${caption} — ${label}`);

    area.addEventListener('change', async () => {
      // Re-read rather than trusting the closure: another row of the same
      // service may have been edited since this one was drawn.
      const state = await getConfig();
      const existing = (state.serviceReasons || {})[key] || {};
      const before = String(existing[field] || '');
      const after = area.value.trim();
      if (after === before) return;

      if (!before) {
        // Nothing there yet, so there is nothing to weaken. Straight in.
        const next = { ...(state.serviceReasons || {}) };
        next[key] = { ...(next[key] || {}), [field]: after, updatedAt: Date.now() };
        await sendBg({ action: 'saveSettings', config: { serviceReasons: next } });
        return;
      }

      area.value = before; // revert until/unless approved
      applyOrGate({
        isSimple: false,
        isApp: kind.isApp,
        appLabel: kind.isApp ? label : undefined,
        changeType,
        domain: target,
        currentValue: before,
        newValue: after,
        title: `Change "${caption.toLowerCase()}" for ${label}?`,
        subtitle: `Your coach reads this at every block on ${label}. Rewriting it changes every future decision, not just today's. Talk it through.`,
        onApproved: rerender
      });
    });

    row.append(fieldLabel, area);
    wrap.appendChild(row);
  }
  return wrap;
}

// The one thing a simple-mode row owns: what happens when you open it, and for
// how long. There is no coach to argue with, so the loose/strict split and the
// two answers written FOR that coach are both dead controls here, and the row
// shows this pair in their place.
function buildSimpleBehaviorField(target, label, limitInfo, kind, onSaved) {
  const behaviorSelect = document.createElement('select');
  behaviorSelect.className = 'row-behavior-select';
  behaviorSelect.setAttribute('aria-label', `What happens when you open ${label}`);
  behaviorSelect.innerHTML = `<option value="pass">Timed pass</option><option value="hard">Hard block</option>`;
  behaviorSelect.value = limitInfo.behavior || 'pass';

  const minutesInput = document.createElement('input');
  minutesInput.type = 'number';
  minutesInput.min = '1';
  minutesInput.max = '180';
  minutesInput.className = 'row-minutes-input inline-limit-input';
  minutesInput.setAttribute('aria-label', `Minutes per pass on ${label}`);
  minutesInput.value = limitInfo.passMinutes || 10;

  const minutesUnit = document.createElement('span');
  minutesUnit.className = 'row-field-unit';
  minutesUnit.textContent = 'min';

  const updateVisibility = () => {
    const showMinutes = behaviorSelect.value === 'pass';
    minutesInput.hidden = !showMinutes;
    minutesUnit.hidden = !showMinutes;
  };
  updateVisibility();

  const persist = async () => {
    const state = await getConfig();
    const currentLimits = state[kind.persistKey] || {};
    if (!currentLimits[target]) currentLimits[target] = { maxGrants: 3 };
    currentLimits[target].behavior = behaviorSelect.value;
    currentLimits[target].passMinutes = parseInt(minutesInput.value, 10) || 10;
    await sendBg({ action: 'saveSettings', config: { [kind.persistKey]: currentLimits } });
    await onSaved();
  };

  behaviorSelect.addEventListener('change', () => { updateVisibility(); persist(); });
  minutesInput.addEventListener('change', persist);

  return buildRowField(microLabel('When you open it'), behaviorSelect, minutesInput, minutesUnit);
}

// Everything under the head hairline, for both lists.
//
// The absolute daily max is here in BOTH modes, because it binds in both —
// simpleGrant checks it just as the coach's grant path does, and a cap that
// still stops you but no longer appears is worse than no cap at all.
// Everything else in the band is about the coach: the loose/strict timeline
// and the two answers written for it are coach-only, and a simple row gets its
// pass controls instead.
function buildRowBody({ li, fields, target, label, limitInfo, globalMode, kind, serviceReasons, rerender }) {
  const isSimple = effectiveModeFor(limitInfo, globalMode) === 'simple';
  const stored = limitInfo.maxMinutes !== undefined
    ? limitInfo.maxMinutes
    : (limitInfo.max_minutes_per_day ?? 10);
  // A non-positive maxMinutes means unlimited; the box still has to show a
  // number you can edit, and 10 is what every other default here is.
  const currentMins = stored > 0 ? stored : 10;

  fields.appendChild(buildDailyLimitField(currentMins, label, async (e) => {
    const val = parseInt(e.target.value, 10);
    if (isNaN(val) || val <= 0) {
      e.target.value = currentMins;
      return;
    }
    const currentlyUnlimited = !(stored > 0);
    const isIncrease = currentlyUnlimited ? true : (val > stored);

    if (!isIncrease) {
      // Decreasing (or unchanged) tightens the rule — apply immediately, free.
      const state = await getConfig();
      const currentLimits = state[kind.persistKey] || {};
      if (!currentLimits[target]) currentLimits[target] = { maxGrants: 3 };
      currentLimits[target].maxMinutes = val;
      await sendBg({ action: 'saveSettings', config: { [kind.persistKey]: currentLimits } });
      await rerender();
      return;
    }

    // Increasing the limit loosens the rule — must be approved by the coach
    // (or applied outright, if this row is in simple mode).
    e.target.value = currentMins; // revert until/unless approved
    applyOrGate({
      isSimple,
      isApp: kind.isApp,
      appLabel: kind.isApp ? label : undefined,
      changeType: kind.increaseLimit,
      domain: target,
      currentValue: currentlyUnlimited ? -1 : stored,
      newValue: val,
      title: `Raise the absolute daily max on ${label}?`,
      subtitle: `Going from ${currentlyUnlimited ? 'unlimited' : stored + 'm/day'} to ${val}m/day gives you more time on ${label}. Convince your coach.`,
      onApproved: rerender
    });
  }, { info: true }));

  if (isSimple) {
    fields.appendChild(buildSimpleBehaviorField(target, label, limitInfo, kind, rerender));
    return;
  }

  // Coach-only from here down.
  li.appendChild(buildLooseTimelineField(target, label, limitInfo, kind, currentMins, rerender));
  li.appendChild(buildRowReasonFields(target, label, kind, serviceReasons, allBlockedTargets(), rerender));
}

function renderDomains(domains, limits = {}, globalMode = 'coach', serviceReasons = {}) {
  renderSiteRecommendations('sites-recommend-grid', 'sites-recommend-more', domains);
  const list = document.getElementById('domain-list');
  list.innerHTML = '';
  if (!domains.length) {
    renderEmptyList(list, 'No websites blocked yet. Tap "+ Add website" — it suggests a few.');
    return;
  }
  const rerender = async () => {
    const state = await getConfig();
    renderDomains(state.blockedDomains || [], state.domainLimits || {}, state.blockingMode, state.serviceReasons || {});
  };
  for (const d of domains) {
    const limitInfo = limits[d] || { maxGrants: 3, maxMinutes: 10 };

    const { li, fields } = buildBlockedRow({
      target: d,
      label: d,
      headExtra: buildRowModeToggle(d, d, limitInfo, globalMode, 'domainLimits', rerender),
      onRemove: () => removeDomain(d, effectiveModeFor(limitInfo, globalMode) === 'simple')
    });

    buildRowBody({
      li, fields, target: d, label: d, limitInfo, globalMode,
      kind: ROW_KINDS.domain, serviceReasons, rerender
    });
    list.appendChild(li);
  }
}

// ---- Blocked apps (settings view, Android only) ----
// Mirrors the domain list above: adding/tightening is free, any loosening
// (removing an app, raising its limit, lengthening its lenient window,
// rewriting what you told the coach it is for) goes through the coach gate.
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
    renderApps(apps, limits, labels, state.blockingMode, state.serviceReasons || {});
  }
}

function removeApp(pkg, label, isSimple) {
  const name = label || pkg;
  applyOrGate({
    isSimple,
    isApp: true,
    appLabel: name,
    changeType: 'remove_app',
    domain: pkg,
    title: `Remove ${name}?`,
    subtitle: `Removing ${name} means it won't be blocked anymore. Convince your coach this is the right call.`,
    onApproved: async () => {
      const state = await getConfig();
      renderApps(state.blockedApps || [], state.appLimits || {}, state.appLabels || {}, state.blockingMode, state.serviceReasons || {});
    }
  });
}

function renderApps(apps, limits = {}, labels = {}, globalMode = 'coach', serviceReasons = {}) {
  settingsBlockedApps = apps;
  renderAppRecommendations('apps-recommend-grid', 'apps-recommend-more', apps);
  const list = document.getElementById('app-list');
  list.innerHTML = '';
  if (!apps.length) {
    renderEmptyList(list, 'No apps blocked yet. Tap "+ Add app" — it suggests a few.');
    return;
  }
  const rerender = async () => {
    const state = await getConfig();
    renderApps(state.blockedApps || [], state.appLimits || {}, state.appLabels || {}, state.blockingMode, state.serviceReasons || {});
  };
  for (const pkg of apps) {
    const name = labels[pkg] || pkg;
    const limitInfo = limits[pkg] || { maxGrants: 3, maxMinutes: 10 };

    const { li, fields } = buildBlockedRow({
      target: pkg,
      label: name,
      headExtra: buildRowModeToggle(pkg, name, limitInfo, globalMode, 'appLimits', rerender),
      onRemove: () => removeApp(pkg, labels[pkg], effectiveModeFor(limitInfo, globalMode) === 'simple')
    });

    buildRowBody({
      li, fields, target: pkg, label: name, limitInfo, globalMode,
      kind: ROW_KINDS.app, serviceReasons, rerender
    });
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
  // Press and hold anything the coach said to report it (report.js). System
  // notes are our own machinery talking, not the model, so they stay out.
  if (role === 'assistant' && !isSystem) attachReportPress(div);
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
async function openGateModal({ changeType, domain, isApp, appLabel, currentValue, newValue, title, subtitle, onApproved }) {
  if (!(await requireAccess())) return;
  gateChange = { changeType, domain, isApp, appLabel, currentValue, newValue, onApproved };
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
//
// A map rather than the chain of ternaries this was, because the chain's tail
// was `disable_all`'s line: every change type it didn't know about opened by
// telling the user they were turning off all blocking, which they weren't.
const GATE_OPENER_FALLBACKS = {
  remove: (d) => `You want to remove ${d} from your blocklist. You set this rule for a reason. Tell me what's changed.`,
  remove_app: (d) => `You want to remove ${d} from your blocklist. You set this rule for a reason. Tell me what's changed.`,
  increase_limit: (d) => `You want more time on ${d}. Why? What's driving this right now?`,
  increase_app_limit: (d) => `You want more time on ${d}. Why? What's driving this right now?`,
  increase_loose_window: (d) => `You want me to go easy on you for longer on ${d}. What's behind that?`,
  increase_app_loose_window: (d) => `You want me to go easy on you for longer on ${d}. What's behind that?`,
  edit_site_purpose: (d) => `You want to change what you told me ${d} is for. Talk me through what's different now.`,
  edit_site_legitimate: (d) => `You want to change what counts as a legitimate reason to open ${d}. Tell me why the old wording is wrong.`,
  disable_all: () => `You want to turn off all blocking. That's a big move. Talk to me about what's going on.`
};

function gateOpenerFallback(changeType, domain) {
  const fallback = GATE_OPENER_FALLBACKS[changeType];
  return fallback
    ? fallback(domain)
    : `You want to loosen your rules on ${domain}. Tell me what's driving that right now.`;
}

// attemptGateSend minus the user bubble: the coach speaks first. No
// userMessage — the background records its own marker turn.
async function attemptGateOpen(messagesEl) {
  const seq = ++gateRequestSeq;
  gateSending = true;
  // gateChange can be nulled by closeGateModal while the request is in
  // flight, so hold on to the fields the fallback needs.
  const { changeType, domain, isApp, appLabel, currentValue, newValue } = gateChange;
  const thinking = addGateMsg('assistant', '…', true);
  let resp;
  try {
    resp = await sendBgChat({
      action: 'chat',
      mode: 'settings_gate',
      domain,
      isApp,
      appLabel,
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
      isApp: gateChange.isApp,
      appLabel: gateChange.appLabel,
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
  if (role === 'assistant' && !isSystem) attachReportPress(div);
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
  // Confirmations can disappear on their own — the user saw the thing they
  // asked for happen. An error is the one message they may still need on
  // screen while they work out what to do about it, so it stays until the
  // next action replaces it.
  if (text && variant !== 'error') {
    setTimeout(() => { el.textContent = ''; el.className = 'status'; }, 3000);
  }
}
