// options-wizard.js - first-run setup.
//
// Everything from "what do you want blocked" to the first render of the
// settings page: the wizard's own draft state, its per-service questions, the
// step order (computed rather than a fixed list, because there is one screen
// per service selected), and the save that ends it.
//
// The state below is module-level `let` on purpose. A classic script's
// top-level bindings are shared with every other script the page loads, so
// the list renderers in options-lists.js read and write these directly - the
// same arrangement they had when this was all one file, which is what makes
// this a move rather than a rewrite.

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
