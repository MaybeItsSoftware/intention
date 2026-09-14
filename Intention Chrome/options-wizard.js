// options-wizard.js - first-run setup.
//
// One question per page. Welcome, then pick what pulls you in, then one page
// per thing picked asking how often you mean to open it and for how long, then
// — only if you want to — one page per service saying what it is for, then
// what happens once an intention runs out, then done.
//
// The pages come from a list of page ids built from the selection
// (computeStepOrder). Most are a section of their own; the per-target pages
// share one section, and their id carries the target after a colon
// ("setup-step-intention:instagram.com"). The list is allowed to follow the
// blocklist because nothing on screen counts it: the progress bar fills, and
// the label names the part of setup you are in ("Intentions · 2 of 4"), where
// the only number is one that cannot move while you are on that part.
//
// The state below is module-level `let` on purpose. A classic script's
// top-level bindings are shared with every other script the page loads, so
// the list renderers in options-lists.js read and write these directly.

let setupBlockedDomains = [];
let setupDomainLimits = {};
let setupBlockedApps = [];
let setupAppLimits = {};
let setupAppLabels = {};
// { [serviceKey]: { needs: string[], costs: string[], needsNote, costsNote } }
// — keyed by serviceKeyFor(), so a site and its app share one answer. See
// shared/sites.js.
//
// CHIP IDS, not prose. They live in the wizard and its draft only:
// collectServiceReasons() composes them into the { purpose, legitimateUse }
// pair that everything downstream has always been handed.
let setupServiceAnswers = {};
// Whether they said yes to telling the coach what each service is for. null
// until they answer: the per-service pages only exist once it is true.
let setupWantsReasons = null;
let setupStep = 1;
let setupStepOrder = [];
// Which way the last page change went, so the next page slides in from the
// side it is coming from.
let setupDirection = 1;

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
  document.body.classList.remove('in-settings');

  setupStepOrder = computeStepOrder();

  renderWelcomeStep();
  if (HAS_SAFARI_EXTENSION) wireSafariStep();
  renderSetupDomains();
  if (HAS_APP_BLOCKING) {
    renderSetupApps();
  } else if (HAS_IOS_APP_BLOCKING) {
    renderSetupIOSApps();
  }
  wireAddModals();
  wireIntentionStep();
  // Chrome and Firefox have no credit to buy: the coach runs on the user's own
  // API key there and nothing else.
  if (BYOK_IS_PRIMARY) {
    document.getElementById('setup-access-how').textContent =
      'The coach runs on your own AI provider key. Nothing to set up now — only if you ever need it.';
  }

  const backBtn = document.getElementById('setup-back-btn');
  const nextBtn = document.getElementById('setup-next-btn');
  const saveBtn = document.getElementById('setup-save-btn');

  const showStep = (n) => {
    setupDirection = n >= setupStep ? 1 : -1;
    setupStepOrder = computeStepOrder();
    setupStep = Math.max(1, Math.min(n, setupStepOrder.length));
    const pageId = setupStepOrder[setupStep - 1];
    const section = sectionOf(pageId);

    for (const el of document.querySelectorAll('#setup-view .setup-step')) el.hidden = true;
    const el = document.getElementById(section);
    // Filled before it is shown, so a page never paints with the previous
    // target's words in it.
    if (section === 'setup-step-intention') renderIntentionStep(targetOf(pageId));
    if (section === 'setup-step-purpose') renderPurposeStep(targetOf(pageId));
    if (section === 'setup-step-done') renderDoneStep();
    // Both of these describe state the user can change from outside this
    // wizard (a Safari toggle, a system permission prompt), so they are re-read
    // on arrival rather than trusted from whenever the page was built.
    if (section === 'setup-step-safari') refreshSafariStatus();
    if (section === 'setup-step-apps' && HAS_IOS_APP_BLOCKING) refreshSetupIOSApps();
    el.hidden = false;
    playStepEntrance(el);

    refreshSetupNav();
    const heading = el.querySelector('h3');
    if (heading) {
      heading.setAttribute('tabindex', '-1');
      try { heading.focus({ preventScroll: true }); } catch (e) {}
    }
    try { window.scrollTo({ top: 0, behavior: 'auto' }); } catch (e) {}
    // The document no longer scrolls during setup — the page and its one
    // .setup-scroll region do. Both are reused across pages (every purpose
    // page is the same section, re-rendered), so without this the second
    // service would open halfway down the first one's chips.
    el.scrollTop = 0;
    el.querySelectorAll('.setup-scroll').forEach((region) => { region.scrollTop = 0; });
    saveSetupDraft();
  };
  showSetupStep = showStep;

  backBtn.onclick = () => { if (setupStep > 1) showStep(setupStep - 1); };
  nextBtn.onclick = () => { if (setupStep < setupStepOrder.length) showStep(setupStep + 1); };
  saveBtn.onclick = () => finishSetup();

  document.getElementById('setup-reasons-yes-btn').onclick = () => {
    setupWantsReasons = true;
    showStep(setupStep + 1);
  };
  document.getElementById('setup-reasons-skip-btn').onclick = () => {
    setupWantsReasons = false;
    showStep(setupStep + 1);
  };
  document.getElementById('setup-purpose-skip-btn').onclick = () => {
    const at = setupStepOrder.indexOf('setup-step-access');
    showStep(at === -1 ? setupStep + 1 : at + 1);
  };

  restoreSetupDraft().then(step => showStep(step));
}

// Set by showSetupView so list renderers and the draft restore can drive the
// wizard from outside its closure.
let showSetupStep = () => {};

// "setup-step-intention:instagram.com" -> "setup-step-intention"
function sectionOf(pageId) {
  const at = String(pageId || '').indexOf(':');
  return at === -1 ? String(pageId || '') : pageId.slice(0, at);
}

// "setup-step-intention:instagram.com" -> "instagram.com"
function targetOf(pageId) {
  const at = String(pageId || '').indexOf(':');
  return at === -1 ? '' : pageId.slice(at + 1);
}

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

// Every target that gets an intention page, apps first where apps come first
// in the pick order. iOS apps have none: Screen Time never tells the web layer
// which apps were chosen, so there is nothing to name a page after.
function intentionTargets() {
  return HAS_APP_BLOCKING
    ? [...setupBlockedApps, ...setupBlockedDomains]
    : [...setupBlockedDomains];
}

// The pages, in order. Welcome; the permissions a native build needs; what
// pulls you in; one intention page per target; the question of whether to say
// what each service is for, and then — only on a yes — one page per service;
// what happens past an intention; done.
function computeStepOrder() {
  const order = ['setup-step-welcome'];
  if (HAS_SAFARI_EXTENSION) order.push('setup-step-safari');
  if (HAS_APP_BLOCKING || HAS_IOS_APP_BLOCKING) order.push('setup-step-apps');
  order.push('setup-step-sites');
  for (const target of intentionTargets()) order.push(`setup-step-intention:${target}`);
  const groups = currentServiceGroups();
  if (groups.length) {
    order.push('setup-step-reasons');
    if (setupWantsReasons === true) {
      for (const group of groups) order.push(`setup-step-purpose:${group.key}`);
    }
  }
  order.push('setup-step-access', 'setup-step-done');
  return order;
}

// Finishing with an empty blocklist produces an install that does nothing at
// all, silently — so it's the one thing the wizard refuses to do.
function setupHasSomethingBlocked() {
  return setupBlockedDomains.length + setupBlockedApps.length + setupIOSSelectionCount > 0;
}

// What the label above the bar says for a page. A part of setup, and a count
// only inside a run of pages whose length is already fixed by the time you
// reach it.
function setupProgressLabel(pageId) {
  const section = sectionOf(pageId);
  const runOf = (prefix) => {
    const run = setupStepOrder.filter(id => sectionOf(id) === prefix);
    return `${run.indexOf(pageId) + 1} of ${run.length}`;
  };
  switch (section) {
    case 'setup-step-welcome': return 'Intention';
    case 'setup-step-safari': return 'Safari';
    case 'setup-step-apps':
    case 'setup-step-sites': return 'Pick';
    case 'setup-step-intention': return `Intentions · ${runOf('setup-step-intention')}`;
    case 'setup-step-reasons': return 'Purpose';
    case 'setup-step-purpose': return `Purpose · ${runOf('setup-step-purpose')}`;
    case 'setup-step-access': return 'More time';
    case 'setup-step-done': return 'Ready';
    default: return '';
  }
}

function refreshSetupNav() {
  const backBtn = document.getElementById('setup-back-btn');
  const nextBtn = document.getElementById('setup-next-btn');
  const saveBtn = document.getElementById('setup-save-btn');
  const hint = document.getElementById('setup-sites-empty-hint');
  const ok = setupHasSomethingBlocked();
  if (hint) hint.hidden = ok;
  if (!setupStepOrder.length || !nextBtn) return;

  // The order follows the selection, so re-anchor on the page actually on
  // screen: adding a site on the pick page adds a page after this one, and
  // must not move you.
  const current = setupStepOrder[setupStep - 1];
  setupStepOrder = computeStepOrder();
  const index = setupStepOrder.indexOf(current);
  if (index !== -1) setupStep = index + 1;
  setupStep = Math.min(setupStep, setupStepOrder.length);

  const pageId = setupStepOrder[setupStep - 1];
  const section = sectionOf(pageId);
  const last = setupStep === setupStepOrder.length;

  backBtn.hidden = setupStep === 1;
  nextBtn.hidden = last || section === 'setup-step-reasons';
  saveBtn.hidden = !last;
  saveBtn.disabled = !ok;
  nextBtn.textContent = section === 'setup-step-welcome' ? 'Begin' : 'Continue';
  // Leaving the last pick page with nothing picked would walk into a run of
  // pages about nothing. Every other page can always be left.
  nextBtn.disabled = section === 'setup-step-sites' && !ok;

  const label = document.getElementById('setup-progress-label');
  const fill = document.getElementById('setup-progress-fill');
  if (label) label.textContent = setupProgressLabel(pageId);
  if (fill) fill.style.width = `${(setupStep / setupStepOrder.length) * 100}%`;
}

// The page slides in from the side it came from. Restarted by removing and
// re-adding the class; a reduced-motion preference collapses the duration in
// options.css rather than skipping the class, so nothing depends on it running.
function playStepEntrance(el) {
  el.classList.remove('setup-enter-forward', 'setup-enter-back');
  void el.offsetWidth;
  el.classList.add(setupDirection < 0 ? 'setup-enter-back' : 'setup-enter-forward');
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

// How long a burst of typing is allowed to run before the draft is written.
// Long enough that a sentence is one write rather than forty, short enough
// that putting the phone down mid-sentence still banks it.
const SETUP_DRAFT_DEBOUNCE_MS = 500;
let setupDraftSaveTimer = null;

function cancelPendingSetupDraftSave() {
  if (setupDraftSaveTimer === null) return;
  clearTimeout(setupDraftSaveTimer);
  setupDraftSaveTimer = null;
}

// The deferred form, for callers that fire per keystroke. The answers object
// is always updated straight away by the caller — this is only about how often
// that reaches chrome.storage.
function saveSetupDraftSoon() {
  cancelPendingSetupDraftSave();
  setupDraftSaveTimer = setTimeout(saveSetupDraft, SETUP_DRAFT_DEBOUNCE_MS);
}

function saveSetupDraft() {
  // Any immediate save subsumes a deferred one: they write the same state, read
  // at the same moment from the same variables.
  cancelPendingSetupDraftSave();
  if (!setupDraftReady) return;
  // The step is stored as its id — a page id, which for the per-target pages
  // carries the target — rather than an index: an index means nothing once the
  // list the pages are built from has changed.
  const draft = {
    stepId: setupStepOrder[setupStep - 1] || null,
    blockedDomains: setupBlockedDomains,
    domainLimits: setupDomainLimits,
    blockedApps: setupBlockedApps,
    appLimits: setupAppLimits,
    appLabels: setupAppLabels,
    serviceAnswers: setupServiceAnswers,
    wantsReasons: setupWantsReasons
  };
  try { chrome.storage.local.set({ [SETUP_DRAFT_KEY]: draft }); } catch (e) {}
}

function clearSetupDraft() {
  // A keystroke a moment before Finish leaves a deferred write pending, and it
  // would land after this remove — re-creating the draft of a wizard that has
  // just been completed, which puts the next load back into setup. Nothing is
  // lost by dropping it: finishSetup saves from the answers object, not from
  // the draft.
  cancelPendingSetupDraftSave();
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
  // A draft written by the shipped wizard holds prose, not chip ids. Throwing
  // it away would lose whatever a first-run user typed before they refreshed,
  // which is the exact situation the draft exists for.
  setupServiceAnswers = draft.serviceAnswers || migrateLegacyServiceReasons(draft.serviceReasons);
  if (typeof draft.wantsReasons === 'boolean') setupWantsReasons = draft.wantsReasons;

  // draft.projects / draft.reasons may still be present in a draft written
  // before the general questions were dropped. Nothing reads them now; they go
  // when the draft is cleared at Finish.

  setupDraftReady = true;
  // These rebuild the step order off the restored selection, which is what the
  // stored step is about to be resolved against.
  renderSetupDomains();
  if (HAS_APP_BLOCKING) renderSetupApps();

  // A saved page that no longer exists (a target removed, a build change) must
  // not leave the wizard on a blank screen. Its section is the next best
  // anchor — the first intention page rather than a missing one — and the
  // welcome page after that.
  setupStepOrder = computeStepOrder();
  if (!draft.stepId) return 1;
  const exact = setupStepOrder.indexOf(draft.stepId);
  if (exact !== -1) return exact + 1;
  const section = sectionOf(draft.stepId);
  const near = setupStepOrder.findIndex(id => sectionOf(id) === section);
  return near === -1 ? 1 : near + 1;
}

// Prose written by the shipped wizard, read back as answers. The two typed
// fields become the two free-text notes — purpose was "why is it on the list?"
// and legitimateUse was "when is opening it fair enough?", which is exactly
// what the notes under each chip row now refine — and no chips are guessed
// from it. A migrated card therefore renders with its notes already revealed
// and nothing selected, so nothing typed is lost and nothing is invented.
function migrateLegacyServiceReasons(reasons) {
  const out = {};
  for (const [key, value] of Object.entries(reasons || {})) {
    out[key] = {
      needs: [],
      costs: [],
      needsNote: String(value?.legitimateUse || '').trim(),
      costsNote: String(value?.purpose || '').trim()
    };
  }
  return out;
}

// ---- Page: an intention --------------------------------------------------
//
// "How many times a day do you want to open Instagram?" A big number with a
// minus and a plus, one dot per open, then how long each one lasts. The line
// underneath says what that adds up to, so the choice is felt as a day rather
// than as two settings.

// The target the intention page is currently showing.
let setupIntentionTarget = null;

function isSetupApp(target) {
  return setupBlockedApps.includes(target);
}

// What a target is called on its page. A site and its app picked together
// would otherwise both be "Instagram", so the pair is told apart.
function setupTargetLabel(target) {
  const key = serviceKeyFor(target);
  if (isSetupApp(target)) {
    const label = setupAppLabels[target] || (SITE_META[key] && SITE_META[key].name) || target;
    const siteToo = setupBlockedDomains.some(d => serviceKeyFor(d) === key);
    return siteToo ? `the ${label} app` : label;
  }
  const meta = SITE_META[target];
  const appToo = setupBlockedApps.some(p => serviceKeyFor(p) === key);
  return meta && meta.name && !appToo ? meta.name : target;
}

function setupLimitsFor(target) {
  return isSetupApp(target) ? setupAppLimits : setupDomainLimits;
}

const NUMBER_WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];

function intentionSumLine({ opens, minutesEach }) {
  if (opens === 0) return "Blocked outright. If something ever needs it, that's a conversation with the coach.";
  const total = opens * minutesEach;
  const visits = opens === 1 ? 'one visit' : `${NUMBER_WORDS[opens] || opens} visits`;
  return `Up to ${total} minutes a day, in ${visits}. Each one is a single tap — nothing to explain.`;
}

function wireIntentionStep() {
  const change = (fn) => {
    if (!setupIntentionTarget) return;
    const limits = setupLimitsFor(setupIntentionTarget);
    const now = resolveIntention(limits[setupIntentionTarget]);
    const next = fn(now);
    limits[setupIntentionTarget] = {
      ...(limits[setupIntentionTarget] || {}),
      maxGrants: next.opens,
      passMinutes: next.minutesEach
    };
    renderIntentionStep(setupIntentionTarget, { bump: next.opens !== now.opens });
    saveSetupDraft();
  };
  document.getElementById('setup-intention-minus').onclick = () =>
    change(i => ({ ...i, opens: Math.max(0, i.opens - 1) }));
  document.getElementById('setup-intention-plus').onclick = () =>
    change(i => ({ ...i, opens: Math.min(MAX_OPENS, i.opens + 1) }));

  const chips = document.getElementById('setup-intention-minutes');
  chips.textContent = '';
  for (const minutes of PASS_MINUTE_CHOICES) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'setup-minute-chip';
    chip.dataset.minutes = String(minutes);
    chip.setAttribute('role', 'radio');
    const n = document.createElement('strong');
    n.textContent = String(minutes);
    const unit = document.createElement('span');
    unit.textContent = 'min';
    chip.append(n, unit);
    chip.addEventListener('click', () => change(i => ({ ...i, minutesEach: minutes })));
    chips.appendChild(chip);
  }

  // Copies this page's answer onto every target still to come, and moves past
  // them. For the person with seven sites who wants the same rule for all.
  document.getElementById('setup-intention-same-btn').onclick = () => {
    const targets = intentionTargets();
    const at = targets.indexOf(setupIntentionTarget);
    const here = resolveIntention(setupLimitsFor(setupIntentionTarget)[setupIntentionTarget]);
    for (const target of targets.slice(at + 1)) {
      const limits = setupLimitsFor(target);
      limits[target] = { ...(limits[target] || {}), maxGrants: here.opens, passMinutes: here.minutesEach };
    }
    const lastIntention = setupStepOrder.map(sectionOf).lastIndexOf('setup-step-intention');
    showSetupStep(lastIntention + 2);
  };
}

function renderIntentionStep(target, { bump = false } = {}) {
  setupIntentionTarget = target;
  const label = setupTargetLabel(target);
  const intention = resolveIntention(setupLimitsFor(target)[target]);

  applyServiceMark(document.getElementById('setup-intention-mark'),
    { key: serviceKeyFor(target), label });
  document.getElementById('setup-intention-question').textContent =
    `How many times a day do you want to open ${label}?`;

  const value = document.getElementById('setup-intention-opens');
  value.textContent = String(intention.opens);
  if (bump) {
    value.classList.remove('setup-bump');
    void value.offsetWidth;
    value.classList.add('setup-bump');
  }
  document.getElementById('setup-intention-unit').textContent =
    intention.opens === 0 ? 'not at all' : intention.opens === 1 ? 'time a day' : 'times a day';
  document.getElementById('setup-intention-minus').disabled = intention.opens <= 0;
  document.getElementById('setup-intention-plus').disabled = intention.opens >= MAX_OPENS;
  document.getElementById('setup-intention-minus').setAttribute('aria-label', `Fewer opens of ${label}`);
  document.getElementById('setup-intention-plus').setAttribute('aria-label', `More opens of ${label}`);

  const dots = document.getElementById('setup-intention-dots');
  dots.textContent = '';
  for (let i = 0; i < MAX_OPENS; i++) {
    const dot = document.createElement('span');
    dot.className = i < intention.opens ? 'setup-dot on' : 'setup-dot';
    dots.appendChild(dot);
  }

  const minutesWrap = document.getElementById('setup-intention-minutes-wrap');
  minutesWrap.hidden = intention.opens === 0;
  for (const chip of document.querySelectorAll('#setup-intention-minutes .setup-minute-chip')) {
    const on = Number(chip.dataset.minutes) === intention.minutesEach;
    chip.classList.toggle('selected', on);
    chip.setAttribute('aria-checked', String(on));
  }
  document.getElementById('setup-intention-sum').textContent = intentionSumLine(intention);

  const targets = intentionTargets();
  const remaining = targets.length - targets.indexOf(target) - 1;
  const same = document.getElementById('setup-intention-same-btn');
  same.hidden = remaining < 1;
  same.textContent = remaining === 1
    ? 'Use this for the last one too'
    : `Use this for the other ${remaining}`;
}

// ---- Page: do you want to say what each one is for? -----------------------
//
// Asked once, as a yes or a skip, rather than walking everyone through a page
// per service. The answers are the coach's best material, but only someone who
// will one day ask the coach for more time ever benefits from them — so it is
// an offer, and saying no costs one tap.

// ---- Page: what one service is for -----------------------------------------
//
// Chips instead of textareas. The answer is the user's own rule, written while
// calm, which the coach reads before anything else if they ever ask it for
// more time. A chip is faster than a sentence and better prose than most
// people type under friction; free text stays underneath for the person with
// something specific to say.
//
// The preview line says what the coach will DO with the taps, in the second
// person. It promises to "hear you out" rather than to let you through:
// printing "your coach will let you through for a DM reply" would teach the
// user to recite their setup answer at the gate.

function buildMicroLabel(text) {
  const p = document.createElement('p');
  p.className = 'micro-label';
  p.textContent = text;
  return p;
}

function renderPurposeStep(key) {
  const groups = currentServiceGroups();
  const index = groups.findIndex(g => g.key === key);
  const group = groups[index];
  const body = document.getElementById('setup-reason-body');
  body.textContent = '';
  if (!group) return;
  applyServiceMark(document.getElementById('setup-reason-mark'), group);
  document.getElementById('setup-reason-question').textContent =
    `When is opening ${group.label} fair enough?`;
  body.appendChild(buildServiceAnswerCard(group, index, groups));
}

// One service's answers: the main question, its optional note, then the
// second question folded away, then what the coach will make of it all.
// Built entirely here because the labels come from the catalogue and, for an
// Android app outside it, from whatever the native bridge called the package —
// third-party text, so textContent throughout.
function buildServiceAnswerCard(group) {
  const catalogue = serviceAnswerCatalogue(group.key);

  const wrap = document.createElement('div');
  wrap.className = 'setup-service';
  wrap.dataset.service = group.key;

  if ((group.domains.length + group.apps.length) > 1) {
    const members = buildMicroLabel(serviceMembersLabel(group, setupAppLabels));
    members.classList.add('setup-service-members');
    wrap.appendChild(members);
  }

  const preview = document.createElement('p');
  preview.className = 'setup-service-preview';
  preview.setAttribute('aria-live', 'polite');

  const moreToggle = document.createElement('button');
  moreToggle.type = 'button';
  moreToggle.className = 'setup-link setup-reason-more-toggle';
  const more = document.createElement('div');
  more.className = 'setup-reason-more';
  let moreOpen = false;

  const repaint = () => {
    const answers = serviceAnswersFor(group.key);
    needs.sync();
    costs.sync();
    needsNote.sync(!answers.needs.includes(NEED_NONE_ID));
    costsNote.sync(true);
    const open = moreOpen || answers.costs.length > 0 || !!answers.costsNote;
    more.hidden = !open;
    moreToggle.hidden = open;
    preview.textContent = previewLineFor(group);
  };

  const needs = buildAnswerChipRow(group, 'needs', catalogue.needs, `Fair reasons to open ${group.label}`, repaint);
  const needsNote = buildServiceNote(group, 'needsNote',
    `Anything else that counts as a fair reason for ${group.label}`,
    "e.g. Only my sister's messages, never the feed.", repaint);
  const costs = buildAnswerChipRow(group, 'costs', catalogue.costs, `Why ${group.label} is blocked`, repaint);
  const costsNote = buildServiceNote(group, 'costsNote',
    `Anything else about why ${group.label} is on the list`,
    'e.g. It eats the evening and I never meant to open it.', repaint);

  moreToggle.textContent = `+ And why is ${group.label} on your list?`;
  moreToggle.addEventListener('click', () => {
    moreOpen = true;
    repaint();
  });
  more.append(buildMicroLabel(`Why is ${group.label} on your list?`), costs.row, costsNote.toggle, costsNote.area);

  wrap.append(needs.row, needsNote.toggle, needsNote.area, moreToggle, more, preview);
  repaint();
  return wrap;
}

// The answers held for one service, created empty on first touch. Also repairs
// a migrated draft, which carries the two notes and no arrays at all.
function serviceAnswersFor(key) {
  const existing = setupServiceAnswers[key];
  if (existing) {
    if (!Array.isArray(existing.needs)) existing.needs = [];
    if (!Array.isArray(existing.costs)) existing.costs = [];
    return existing;
  }
  setupServiceAnswers[key] = { needs: [], costs: [], needsNote: '', costsNote: '' };
  return setupServiceAnswers[key];
}

// "a DM reply or a link someone sent you". Alternatives, so "or" — parts.js
// has a joinWithAnd for the list of things a rule covers, which is the other
// relation and would read as a promise to allow all of them at once.
function joinAlternatives(items) {
  if (items.length <= 1) return items[0] || '';
  return `${items.slice(0, -1).join(', ')} or ${items[items.length - 1]}`;
}

// What the coach will do with what has been tapped so far, said back in the
// second person. Four states, because "nothing yet" and "you told it why but
// not when" are different situations and pretending otherwise would make the
// line say something untrue about one of them.
function previewLineFor(group) {
  const answers = serviceAnswersFor(group.key);
  if (answers.needs.includes(NEED_NONE_ID)) {
    return "Your coach will start every visit from no. You've said there's nothing in here you actually need.";
  }
  const phrases = answers.needs
    .map(id => serviceAnswerChip(group.key, 'needs', id))
    .filter(chip => chip && chip.you)
    .map(chip => chip.you);
  if (phrases.length) {
    const feed = serviceAnswerCatalogue(group.key).feed;
    return `Your coach will hear you out for ${joinAlternatives(phrases)} — and push back on ${feed}.`;
  }
  if (answers.costs.length) {
    return `Your coach will know why ${group.label} is on your list, and will ask what you came for.`;
  }
  return 'Nothing on file yet. Your coach will just ask what you came for, with nothing of yours to weigh it against.';
}

// "Nothing — I just want it gone" is exclusive in BOTH directions: picking it
// clears the reasons, and picking a reason clears it. It is the strongest
// thing this step can be told and it means nothing sitting next to four
// reasons the service is fine.
function toggleServiceChip(key, bucket, chipId) {
  const answers = serviceAnswersFor(key);
  const at = answers[bucket].indexOf(chipId);
  if (at !== -1) {
    answers[bucket].splice(at, 1);
    return;
  }
  if (bucket === 'needs' && chipId === NEED_NONE_ID) {
    answers.needs = [NEED_NONE_ID];
    // The refinement under the chips said when opening it is fair enough, and
    // the answer is now "never". Leaving it would compose a sentence that
    // contradicts the one above it.
    answers.needsNote = '';
    return;
  }
  if (bucket === 'needs') answers.needs = answers.needs.filter(id => id !== NEED_NONE_ID);
  answers[bucket].push(chipId);
}

// A row of chips for one bucket. `repaint` is the card's own; every chip in
// the card is repainted from the answers object on every click rather than
// toggling the one that was pressed, because 'none' changes the others.
function buildAnswerChipRow(group, bucket, chips, legend, repaint) {
  const row = document.createElement('div');
  row.className = 'answer-chips';
  row.setAttribute('role', 'group');
  row.setAttribute('aria-label', legend);
  const buttons = [];
  for (const chip of chips) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = chip.id === NEED_NONE_ID ? 'pill answer-chip answer-chip-none' : 'pill answer-chip';
    btn.dataset.bucket = bucket;
    btn.dataset.chip = chip.id;
    btn.textContent = chip.label;
    btn.addEventListener('click', () => {
      toggleServiceChip(group.key, bucket, chip.id);
      repaint();
      saveSetupDraft();
    });
    buttons.push(btn);
    row.appendChild(btn);
  }
  const sync = () => {
    const picked = serviceAnswersFor(group.key)[bucket];
    for (const btn of buttons) {
      const on = picked.includes(btn.dataset.chip);
      btn.classList.toggle('selected', on);
      btn.setAttribute('aria-pressed', String(on));
    }
  };
  return { row, sync };
}

// The optional refinement under a chip row. Hidden behind a reveal because the
// chips are the answer and this is the exception — showing an empty textarea
// on every card would put the wall of text straight back.
function buildServiceNote(group, field, label, placeholder, repaint) {
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'setup-service-note-toggle';
  toggle.textContent = '+ Something else';

  const area = document.createElement('textarea');
  area.className = 'setup-service-note';
  area.rows = 2;
  area.setAttribute('aria-label', label);
  area.placeholder = placeholder;
  area.value = serviceAnswersFor(group.key)[field] || '';

  // Revealed on its own where a migrated draft already holds typed text, so
  // nothing written by the old wizard is hidden behind a button the user has
  // no reason to press.
  let revealed = !!area.value;

  // Two listeners, because the two halves of "saving this" have very different
  // costs and only one of them can afford to wait.
  //
  // 'input' banks the text in the answers object on every keystroke, and it has
  // to be every keystroke: a chip tap repaints the card, and the repaint syncs
  // this textarea back from the answers object — so anything not yet in there
  // is precisely what a repaint writes over. On a desktop that never showed,
  // because clicking a <button> blurs the textarea and 'change' fires first. On
  // a phone it is the ordinary case: iOS Safari and the Android WebView do not
  // reliably move focus onto a button when it is tapped, so no 'change' ever
  // arrived, the stored answer was still '', and a half-typed sentence — the
  // most valuable thing anybody types into this wizard — was replaced with an
  // empty string, with no undo, and then committed by the draft save behind it.
  //
  // What 'change' was originally chosen to avoid was the *storage* write, not
  // the bookkeeping: this field invites a sentence, and one chrome.storage
  // write per letter is far more than it is worth. That reasoning still holds,
  // so only the storage side is deferred — saveSetupDraftSoon coalesces a burst
  // of typing into a single draft write shortly after the burst stops.
  area.addEventListener('input', () => {
    serviceAnswersFor(group.key)[field] = area.value.trim();
    saveSetupDraftSoon();
  });

  // 'change' — a blur, or anything else that takes focus away — stays the
  // moment the card repaints. The preview line is aria-live, so repainting per
  // keystroke would make a screen reader re-read the whole sentence on every
  // letter; the counter and the "Answered" mark can wait for the same moment
  // without anything being lost, since the text itself is already banked above.
  // The save here is the immediate one, which also settles whatever the
  // debounce was still holding.
  area.addEventListener('change', () => {
    serviceAnswersFor(group.key)[field] = area.value.trim();
    repaint();
    saveSetupDraft();
  });
  toggle.addEventListener('click', () => {
    revealed = !revealed;
    repaint();
    if (revealed) area.focus();
  });

  // `available` is false for the needs note once "nothing" is picked: there is
  // no fair reason left to refine.
  //
  // The assignment below overwrites whatever is in the box, and there is now
  // exactly one case where it does: picking "nothing" clears needsNote on
  // purpose (see toggleServiceChip), and the box has to show that clearance.
  // It can no longer overwrite unsaved typing, because 'input' above keeps
  // `stored` level with what has been typed — including while the field still
  // has focus. The comparison is trimmed on both sides, so a trailing space
  // mid-sentence is not counted as a difference and the caret is left alone.
  const sync = (available) => {
    const stored = serviceAnswersFor(group.key)[field] || '';
    if (area.value.trim() !== stored) area.value = stored;
    toggle.hidden = !available;
    toggle.setAttribute('aria-expanded', String(available && (revealed || !!stored)));
    area.hidden = !(available && (revealed || !!stored));
  };
  return { toggle, area, sync };
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

// ---- Page: ready -----------------------------------------------------------
//
// Every intention, said back as a day, and the streak that starts now.

function renderDoneStep() {
  const list = document.getElementById('setup-done-list');
  list.textContent = '';
  for (const target of intentionTargets()) {
    const { opens, minutesEach } = resolveIntention(setupLimitsFor(target)[target]);
    const li = document.createElement('li');
    const mark = document.createElement('span');
    mark.className = 'setup-service-mark';
    mark.setAttribute('aria-hidden', 'true');
    applyServiceMark(mark, { key: serviceKeyFor(target), label: setupTargetLabel(target) });
    const name = document.createElement('span');
    name.className = 'setup-done-name';
    name.textContent = setupTargetLabel(target);
    const rule = document.createElement('span');
    rule.className = 'setup-done-rule';
    rule.textContent = opens === 0 ? 'Blocked' : `${opens} × ${minutesEach} min`;
    li.append(mark, name, rule);
    list.appendChild(li);
  }
  if (setupIOSSelectionCount > 0) {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.className = 'setup-done-name';
    name.textContent = `${setupIOSSelectionCount} app${setupIOSSelectionCount === 1 ? '' : 's'} through Screen Time`;
    li.appendChild(name);
    list.appendChild(li);
  }
  list.hidden = list.children.length === 0;

  document.getElementById('setup-done-note').textContent =
    'Every day you keep all of these adds to your streak. One slip a week is forgiven. Fewer opens take effect straight away; more waits until tomorrow.';
}

// ---- Page: welcome ---------------------------------------------------------

function renderWelcomeStep() {
  const blocksApps = HAS_APP_BLOCKING || HAS_IOS_APP_BLOCKING;
  const items = [
    blocksApps ? 'Pick the apps and sites that pull you in.' : 'Pick the sites that pull you in.',
    'Say how often you mean to open each one. Those opens are one tap.',
    'Past that, the coach decides.'
  ];
  const list = document.getElementById('setup-welcome-checklist');
  list.textContent = '';
  for (const text of items) {
    const li = document.createElement('li');
    li.textContent = text;
    list.appendChild(li);
  }
}

// ---- Step: Safari extension (iPhone and Mac apps only) ----

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

  // The host reports the path that matches this device (it moved in iOS 18,
  // and the Mac says Settings or Preferences depending on macOS) rather than
  // the page guessing. On iOS the button opens the Settings app itself (no
  // public deep link into the Extensions page), so the first step is spelled
  // out in full; on the Mac it lands on Intention's own row in Safari.
  const isMac = !!(st && st.platform === 'mac');
  const path = (st && st.settingsPath) || (isMac ? 'Safari → Settings → Extensions' : 'Settings → Apps → Safari → Extensions');
  const lede = document.getElementById('setup-safari-lede');
  if (lede) {
    lede.textContent = isMac
      ? 'Website blocking runs inside Safari, and only you can switch it on — macOS doesn\u2019t let an app do it for you.'
      : 'Website blocking runs inside Safari, and only you can switch it on — iOS doesn\u2019t let an app do it for you.';
  }
  settingsBtn.textContent = isMac ? 'Open Safari Settings' : 'Open Settings';
  const steps = isMac
    ? [
      `Click "Open Safari Settings" below. It opens ${path} with Intention selected.`,
      'Tick the box next to Intention.',
      'Under Permissions, set it to Allow on every website, or it can only see the sites you approve one at a time.',
      'This page notices on its own once the box is ticked.'
    ]
    : [
      `Tap "Open Settings" below, then go to ${path}.`,
      'Turn on Intention Safari Extension.',
      'Set it to Allow for every website, or it can only see the sites you approve one at a time.',
      'Come back here and tap "I turned it on" — this page notices on its own once the extension has run.'
    ];
  listEl.innerHTML = '';
  for (const text of steps) {
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
  // The Mac reads the switch itself, so there is no "go and wake it up" step
  // and no need for the open-Safari button.
  if (isMac) openBtn.hidden = true;
  statusEl.textContent = active
    ? 'The Safari extension is on and running. Nothing else to do here.'
    : isMac
      ? 'Not on yet.'
      : 'Not running yet. After turning it on, open Safari and load any page once. That’s what wakes the extension up.';
}

// Drops empty answers and anything written about a service the user has since
// removed from the blocklist. background.js sanitizes again on the way in —
// this is about not shipping dead keys, not about trusting the page.
function collectServiceReasons() {
  const live = new Set(currentServiceGroups().map(g => g.key));
  const out = {};
  for (const [key, answers] of Object.entries(setupServiceAnswers)) {
    if (!live.has(key)) continue;
    // The chips become prose here and nowhere else. This is the one seam
    // between the wizard's input and the storage shape every other reader has
    // always been given, which is why changing the input cost no migration.
    const { purpose, legitimateUse } = composeServiceReason(key, answers);
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
  // Every target leaves with a whole intention, whatever the draft held.
  const withIntention = (entry) => {
    const { opens, minutesEach } = resolveIntention(entry);
    const out = { ...(entry || {}), maxGrants: opens, passMinutes: minutesEach };
    return out;
  };
  const domainLimits = {};
  for (const d of setupBlockedDomains) domainLimits[d] = withIntention(setupDomainLimits[d]);
  const appLimits = {};
  for (const p of setupBlockedApps) appLimits[p] = withIntention(setupAppLimits[p]);

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
      // No userContext / contextProjects / contextReasons: setup no longer asks
      // the two general questions, and these keys are deliberately absent
      // rather than empty. saveSetup writes every field it is given, so sending
      // '' here would wipe context an existing user had built up with the coach
      // — the same trap the provider key above is carried through to avoid.
      blockedDomains: setupBlockedDomains,
      domainLimits,
      blockedApps: setupBlockedApps,
      appLimits,
      appLabels: setupAppLabels,
      // Only services still on the list, and only where something was written.
      // A blank answer and no answer mean the same thing to the coach, so
      // storing the difference would buy a falsy check and nothing else.
      serviceReasons: collectServiceReasons()
    }
  });

  clearSetupDraft();
  await renderCurrentView();
}
