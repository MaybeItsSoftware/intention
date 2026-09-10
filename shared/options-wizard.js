// options-wizard.js - first-run setup.
//
// Everything from "what do you want blocked" to the first render of the
// settings page: the wizard's own draft state, its per-service questions, the
// step order, and the save that ends it.
//
// The step order is a plain list of section ids and its length depends on the
// build, never on the blocklist. It briefly wasn't: the per-service questions
// were one STEP each, so picking six services produced six near-identical
// screens and moved the "Step N of M" denominator every time a site was added
// on the step before. They are now one step that iterates the services inline,
// which is what makes that denominator a constant again.
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
// { [serviceKey]: { needs: string[], costs: string[], needsNote, costsNote } }
// — keyed by serviceKeyFor(), so a site and its app share one answer. See
// shared/sites.js.
//
// CHIP IDS, not prose. They live in the wizard and its draft only:
// collectServiceReasons() composes them into the { purpose, legitimateUse }
// pair that everything downstream — sanitizeServiceReasons,
// renderSiteReasonBlock, the settings row, the Android and iOS readers — has
// always been handed. Nothing outside this file and sites.js knows an id
// exists, which is what let the input change without a storage migration.
let setupServiceAnswers = {};
// Which service card on the purpose step is open. Held here rather than read
// back off the DOM so it survives the rebuild that adding or removing a site
// triggers, and so a restored draft can reopen where the user left off.
let setupExpandedService = null;
let setupStep = 1;
// Bare section ids, computed once per render. The apps and Safari steps only
// exist where a native bridge does, so the contents still depend on the build
// — but not on anything the user does inside the wizard, which is the property
// that matters. See computeStepOrder.
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
  // The per-service questions sit directly after the sites step, and they stay
  // in the order even in simple mode, where nothing will read them. Dropping
  // them when there is no coach is tempting and wrong: it would re-create the
  // bug that put the access step here unconditionally, where toggling
  // Coach/Simple changed the denominator of "Step 4 of 8" under the user's
  // finger. The subtitle adapts instead.
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

  // ---- Step: per-service questions ----
  // Nothing to wire once: every control on that step belongs to a card that
  // renderPurposeStack() builds, so the listeners are attached as the cards
  // are. The step's one fixed control is the skip button, below.

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
    // Every id in the order is distinct now, so a plain loop is enough again.
    // It briefly could not be: the purpose section appeared once per service,
    // and a later iteration re-hid the section an earlier one had just shown.
    for (const id of setupStepOrder) {
      document.getElementById(id).hidden = true;
    }
    const stepId = setupStepOrder[n - 1];
    document.getElementById(stepId).hidden = false;

    document.getElementById('setup-progress-fill').style.width = `${(n / total) * 100}%`;
    document.getElementById('setup-progress-label').textContent = `Step ${n} of ${total}`;
    backBtn.disabled = n === 1;
    nextBtn.hidden = n === total;
    saveBtn.hidden = n !== total;
    // Rebuilt on arrival rather than kept in sync: the selection can only be
    // edited on the steps before this one, so there is never a live card to
    // preserve, and a full repaint is the only way to be sure a service
    // removed on the way back has no card left behind.
    if (stepId === 'setup-step-purpose') renderPurposeStack();
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

  // There is one screen to leave now rather than a run of them, so this is
  // just Next by another name — but it keeps its own button and its own
  // wording. "Skip these" says out loud that answering is optional, which is
  // the thing that stops a long stack of cards reading as a wall to climb;
  // Next on its own says nothing about whether the blanks matter.
  document.getElementById('setup-purpose-skip-btn').onclick = () => {
    showStep(Math.min(setupStep + 1, setupStepOrder.length));
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

// A flat list of section ids, each appearing exactly once.
//
// The only thing that varies is the build: browser 6, Android 7, iOS 8. It
// used to vary with the blocklist too — one purpose step per selected service
// — which meant the total shown on every screen changed the moment a site was
// added, and the step had to be stored as an id PLUS a service key because an
// id no longer identified a step. Both of those are gone. "Step 3 of 6" now
// means the same thing for the whole run, which is the only version of that
// counter worth showing.
function computeStepOrder() {
  const order = ['setup-step-welcome'];
  if (HAS_SAFARI_EXTENSION) order.push('setup-step-safari');
  if (HAS_APP_BLOCKING || HAS_IOS_APP_BLOCKING) order.push('setup-step-apps');
  order.push('setup-step-sites', 'setup-step-purpose', 'setup-step-mode', 'setup-step-access', 'setup-step-done');
  return order;
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

  // The order no longer depends on the selection, so this recompute is a no-op
  // for length and is kept for one honest reason: the apps step's existence
  // depends on a native bridge that reports asynchronously, so the build can
  // still learn something after the first render. Re-anchoring on the current
  // id costs nothing and keeps this correct if that ever grows a second cause.
  if (setupStepOrder.length) {
    const current = setupStepOrder[setupStep - 1];
    setupStepOrder = computeStepOrder();
    const index = setupStepOrder.indexOf(current);
    if (index !== -1) setupStep = index + 1;
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
  // The step is stored as an id rather than an index, and that stays true even
  // though the order is a constant again: an index means nothing across a
  // build that gained or lost the apps step, and the id costs the same.
  // `stepGroup` is gone — one section, one step, so an id identifies a step.
  const draft = {
    stepId: setupStepOrder[setupStep - 1] || null,
    blockedDomains: setupBlockedDomains,
    domainLimits: setupDomainLimits,
    blockedApps: setupBlockedApps,
    appLimits: setupAppLimits,
    appLabels: setupAppLabels,
    serviceAnswers: setupServiceAnswers,
    expandedService: setupExpandedService,
    blockingMode: setupBlockingMode,
    simpleBehavior: setupSimpleBehavior,
    simplePassMinutes: setupSimplePassMinutes
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
  if (typeof draft.expandedService === 'string') setupExpandedService = draft.expandedService;
  if (draft.blockingMode === 'simple' || draft.blockingMode === 'coach') setupBlockingMode = draft.blockingMode;
  if (draft.simpleBehavior === 'hard' || draft.simpleBehavior === 'pass') setupSimpleBehavior = draft.simpleBehavior;
  if (Number(draft.simplePassMinutes) > 0) setupSimplePassMinutes = Number(draft.simplePassMinutes);

  // draft.projects / draft.reasons may still be present in a draft written
  // before the general questions were dropped. Nothing reads them now; they go
  // when the draft is cleared at Finish.

  setupDraftReady = true;
  // These rebuild the step order off the restored selection, which is what the
  // stored step is about to be resolved against.
  renderSetupDomains();
  if (HAS_APP_BLOCKING) renderSetupApps();
  renderSetupModeStep();

  // A saved step that no longer exists (a build change, a bridge that stopped
  // reporting) must not leave the wizard on a blank screen. A draft written by
  // the old wizard may also carry a `stepGroup`; it is simply ignored, and the
  // id alone resolves.
  if (!draft.stepId) return 1;
  const index = setupStepOrder.indexOf(draft.stepId);
  return index === -1 ? 1 : index + 1;
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

// ---- Step: what is each one for? ------------------------------------------
//
// One screen, one card per service, chips instead of textareas.
//
// The shape of this step is the whole point of it. The two questions it asks
// are the single most valuable thing the coach is ever given — the user's own
// rule, written while calm, which renderSiteReasonBlock hands it at every gate
// — and as two open textareas repeated once per service they were also the
// most skipped. Typing two paragraphs about six services on a phone is an
// interrogation, and an interrogation gets answered with whatever ends it.
//
// So: taps. A chip is faster than a sentence, it is structured input the coach
// can be given verbatim through composeServiceReason(), and it is better prose
// than most people type under that much friction. Free text stays underneath
// as an optional refinement, because the one person in ten with something
// specific to say ("only my sister's messages") is exactly the person whose
// answer is worth the most.
//
// The preview line under each card is not decoration; it is what turns the
// form back into a purpose. It says what the coach will DO with the taps, in
// the second person, as they happen. It deliberately promises to "hear you
// out" rather than to let you through: renderSiteReasonBlock's own closing
// paragraph exists to stop a stated legitimate use becoming a password, and
// printing "your coach will let you through for a DM reply" on screen would
// teach the user to recite their setup answer at the gate — the exact failure
// that paragraph is written to prevent.

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

// '' | 'answered' | 'none'. A note on its own counts: someone who typed a
// sentence and tapped nothing has answered.
function serviceAnswerState(key) {
  const answers = setupServiceAnswers[key];
  if (!answers) return '';
  if ((answers.needs || []).includes(NEED_NONE_ID)) return 'none';
  const anything = (answers.needs || []).length || (answers.costs || []).length ||
    String(answers.needsNote || '').trim() || String(answers.costsNote || '').trim();
  return anything ? 'answered' : '';
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

// Opens one card and closes the rest. An accordion rather than a stack of open
// cards because the collapsed rows are the list of what is left to do, and a
// list you can see the end of is the thing the old one-step-per-service run
// could not give.
function expandService(key) {
  setupExpandedService = key;
  const stack = document.getElementById('setup-purpose-stack');
  for (const li of [...stack.children]) {
    const open = li.dataset.service === key;
    li.querySelector('.setup-service-head').setAttribute('aria-expanded', String(open));
    li.querySelector('.setup-service-body').hidden = !open;
  }
  saveSetupDraft();
}

// "2 of 6 answered" plus its own hairline bar. This measures the stack, not
// the wizard: the progress bar at the top says where you are in setup, and
// says nothing about how much of THIS is left — which is the part that reads
// as endless when it is not shown. One service has no run to describe, so the
// whole row goes rather than sitting there saying "0 of 1".
function refreshPurposeProgress() {
  const count = document.getElementById('setup-purpose-count');
  const fill = document.getElementById('setup-purpose-fill');
  const groups = currentServiceGroups();
  const answered = groups.filter(g => serviceAnswerState(g.key)).length;
  // The counter's parent is the .setup-substep row that also holds the track;
  // hiding the row rather than the two children keeps them from leaving a gap.
  count.parentElement.hidden = groups.length < 2;
  count.textContent = `${answered} of ${groups.length} answered`;
  fill.style.width = groups.length ? `${(answered / groups.length) * 100}%` : '0%';
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

function buildMicroLabel(text) {
  const p = document.createElement('p');
  p.className = 'micro-label';
  p.textContent = text;
  return p;
}

// One service's card. Built entirely here rather than cloned from markup
// because the labels come from the catalogue and, for an Android app outside
// it, from whatever the native bridge called the package — third-party text,
// so textContent throughout and never innerHTML.
function buildServiceAnswerCard(group, index, groups) {
  const catalogue = serviceAnswerCatalogue(group.key);
  const bodyId = `setup-service-body-${index + 1}`;
  const next = groups[index + 1] || null;

  const li = document.createElement('li');
  li.className = 'setup-service';
  li.dataset.service = group.key;

  const head = document.createElement('button');
  head.type = 'button';
  head.className = 'setup-service-head';
  head.setAttribute('aria-controls', bodyId);

  const mark = document.createElement('span');
  mark.className = 'setup-service-mark';
  mark.setAttribute('aria-hidden', 'true');
  applyServiceMark(mark, group);

  const name = document.createElement('span');
  name.className = 'setup-service-name';
  name.textContent = group.label;

  const state = document.createElement('span');
  state.className = 'setup-service-state micro-label';

  const chev = document.createElement('span');
  chev.className = 'setup-service-chev';
  chev.setAttribute('aria-hidden', 'true');

  head.append(mark, name, state, chev);
  head.addEventListener('click', () => {
    expandService(head.getAttribute('aria-expanded') === 'true' ? null : group.key);
  });

  const body = document.createElement('div');
  body.className = 'setup-service-body';
  body.id = bodyId;

  // Only where it explains something: that two things the user picked
  // separately are asking their questions once.
  if ((group.domains.length + group.apps.length) > 1) {
    const members = buildMicroLabel(serviceMembersLabel(group, setupAppLabels));
    members.classList.add('setup-service-members');
    body.appendChild(members);
  }

  const preview = document.createElement('p');
  preview.className = 'setup-service-preview';
  preview.setAttribute('aria-live', 'polite');

  const repaint = () => {
    const status = serviceAnswerState(group.key);
    state.textContent = status === 'none' ? 'Blocked outright' : status === 'answered' ? 'Answered' : '';
    state.classList.toggle('answered', status === 'answered');
    needs.sync();
    costs.sync();
    needsNote.sync(!serviceAnswersFor(group.key).needs.includes(NEED_NONE_ID));
    costsNote.sync(true);
    preview.textContent = previewLineFor(group);
    refreshPurposeProgress();
  };

  const needs = buildAnswerChipRow(group, 'needs', catalogue.needs, `Fair reasons to open ${group.label}`, repaint);
  const needsNote = buildServiceNote(group, 'needsNote',
    `Anything else that counts as a fair reason for ${group.label}`,
    "e.g. Only my sister's messages, never the feed.", repaint);
  const costs = buildAnswerChipRow(group, 'costs', catalogue.costs, `Why ${group.label} is blocked`, repaint);
  const costsNote = buildServiceNote(group, 'costsNote',
    `Anything else about why ${group.label} is on the list`,
    'e.g. It eats the evening and I never meant to open it.', repaint);

  body.append(
    buildMicroLabel('When is opening it fair enough?'), needs.row, needsNote.toggle, needsNote.area,
    buildMicroLabel('And why is it on the list?'), costs.row, costsNote.toggle, costsNote.area,
    preview
  );

  // The footer button is the only thing that moves the stack on, so on the
  // last card it must not pretend there is more to come.
  const advance = document.createElement('button');
  advance.type = 'button';
  advance.className = 'secondary setup-service-next';
  advance.textContent = next ? `Next: ${next.label}` : "Done — that's all of them";
  advance.addEventListener('click', () => {
    expandService(next ? next.key : null);
    if (next) {
      li.parentElement.querySelector(`[data-service="${CSS.escape(next.key)}"]`)
        ?.scrollIntoView({ block: 'nearest', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
    }
  });
  body.appendChild(advance);

  li.append(head, body);

  const open = group.key === setupExpandedService;
  head.setAttribute('aria-expanded', String(open));
  body.hidden = !open;
  repaint();
  return li;
}

// Honoured by collapsing the motion rather than removing it, the same way
// options.css's own reduced-motion block does.
function prefersReducedMotion() {
  try {
    return !!window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch (e) {
    return false;
  }
}

// Rebuilds the whole stack. Cheap (a handful of cards), and the only way to be
// certain a service removed on the step before has no card left over.
function renderPurposeStack() {
  const stack = document.getElementById('setup-purpose-stack');
  const empty = document.getElementById('setup-purpose-empty');
  const groups = currentServiceGroups();

  document.getElementById('setup-purpose-subtitle').textContent = setupBlockingMode === 'simple'
    ? 'Tap what counts as a fair reason. Simple mode has no coach to read these — they are kept, and a coach turned on later starts from them.'
    : 'Tap what counts as a fair reason. Your coach reads these at every block, so it can tell a real errand from a scroll dressed up as one.';

  stack.innerHTML = '';
  stack.hidden = groups.length === 0;
  empty.hidden = groups.length > 0;

  if (!groups.length) {
    // An iOS user who blocked apps and no websites lands here legitimately:
    // Apple's picker never tells the web layer which apps were chosen, so
    // there is nothing to name a card after. Say that, rather than showing an
    // empty screen that reads as a bug.
    empty.textContent = setupIOSSelectionCount > 0
      ? "Nothing to ask about here. Apple's app picker never tells Intention which apps you chose, so it can't ask about them by name — your coach will ask at the block instead. Add a website and it will show up here."
      : 'Nothing picked yet. Go back a step and add a site or an app, and it will show up here to answer for.';
    refreshPurposeProgress();
    return;
  }

  // Which card opens: the one that was open, if it is still on the list; else
  // the first one with nothing on it, so arriving here always lands on work
  // still to do; else the first.
  if (!groups.some(g => g.key === setupExpandedService)) {
    setupExpandedService = (groups.find(g => !serviceAnswerState(g.key)) || groups[0]).key;
  }

  groups.forEach((group, i) => stack.appendChild(buildServiceAnswerCard(group, i, groups)));
  refreshPurposeProgress();
}

// Called by the site and app list renderers after an add or a remove — and it
// currently never does anything, because the condition it is guarding on
// cannot hold.
//
// The case it was written for is Back-then-remove: the stack is already built
// and one of its cards has just stopped existing. But removing a site or an
// app is only possible from the rows on the sites and apps steps, and showStep
// hides every section except the one it is showing — so by the time either
// list renderer runs, #setup-step-purpose is hidden, every time. The other two
// call paths (showSetupView's first render, and restoreSetupDraft's) run
// before the first showStep, when every section still carries the `hidden`
// attribute it ships with in the markup. Instrumenting a real wizard through
// exactly the Back-then-remove sequence gives three calls and three hidden
// steps.
//
// Nothing is missed by that: showStep rebuilds the whole stack on arrival at
// the purpose step, which is what actually covers a card whose service is
// gone. This is left in place only because deleting it means deleting its two
// call sites in options-lists.js as well, and `no-undef` is what would catch
// half of that being done.
function refreshPurposeStackIfVisible() {
  const step = document.getElementById('setup-step-purpose');
  if (step && !step.hidden) renderPurposeStack();
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
    ? 'You can switch to a coach any time from Settings. Adding another device later? AI access uses a recovery code; settings sync uses a separate sync key. Both are optional and live in Settings.'
    : 'If you skipped turning your coach on, your sites stay blocked — you just can\'t talk your way past them until you set that up in Settings → AI access. Adding another device later? AI access uses a recovery code; settings sync uses a separate sync key.';
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
  // Announced here rather than discovered later. One screen, however long the
  // list is — which is worth saying out loud, because the version of this that
  // gave each service its own screen is exactly what made a thorough setup
  // read as endless.
  items.push(['One screen for what each one is for',
    "A few taps per site: when opening it is fair enough, and why it's on the list. Skippable, and worth more to your coach than anything else you tell it."]);
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
  const isSimple = setupBlockingMode === 'simple';

  const simpleOverrides = isSimple ? { behavior: setupSimpleBehavior, passMinutes: setupSimplePassMinutes } : {};

  // Build domain limits object
  const domainLimits = {};
  for (const d of setupBlockedDomains) {
    domainLimits[d] = setupDomainLimits[d] || {
      maxGrants: 3,
      maxMinutes: DEFAULT_DAILY_MAX_MINUTES,
      ...simpleOverrides
    };
  }

  // Build app limits object
  const appLimits = {};
  for (const p of setupBlockedApps) {
    appLimits[p] = setupAppLimits[p] || {
      maxGrants: 3,
      maxMinutes: DEFAULT_DAILY_MAX_MINUTES,
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
      serviceReasons: collectServiceReasons(),
      blockingMode: setupBlockingMode,
      simpleBehavior: setupSimpleBehavior,
      simplePassMinutes: setupSimplePassMinutes
    }
  });

  clearSetupDraft();
  await renderCurrentView();
}
