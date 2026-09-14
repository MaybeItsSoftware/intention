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

// The header credit chip: the balance, on every tab, on every settings open.
//
// It reads the background's own numbers rather than the stored entitlement,
// because the two exclusions that make the chip honest are decided there and
// must not be re-derived here — `lowCredit` is already false at zero (that is
// locked, not low) and false on a custom key.
//
// Hidden outright on the 'byok' route. A user pointing the coach at their own
// provider account has no balance with us at all, so a chip reading "0" would
// not be a small inaccuracy, it would be the wrong mental model: it would tell
// them they had run out of something they never bought.
async function refreshCreditChip() {
  const chip = document.getElementById('credit-chip');
  if (!chip) return;
  const access = await getAccessState();
  if (!access || access.route === 'byok') {
    chip.hidden = true;
    return;
  }
  const credits = Number(access.balanceCredits || 0);
  const shown = credits.toLocaleString();
  document.getElementById('credit-chip-value').textContent = shown;
  chip.classList.toggle('credit-chip-low', !!access.lowCredit);
  // The two spans read as "CREDIT 1,240" to the eye and as nothing much to a
  // screen reader, so it gets the sentence and the destination.
  chip.setAttribute('aria-label', `Coaching credit: ${shown}. Open AI access.`);
  chip.title = `Coaching credit: ${shown}. Open AI access.`;
  chip.hidden = false;
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


// default hard/pass behavior + pass length. The per-row Coach/Simple toggle
// (buildRowModeToggle) lets individual sites/apps override this global default
// — and picking the mode that already matches it drops the override again.

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

// The custom-key override, on the builds that may have one.
//
// Where a store sells credit this really is a developer override and is
// described as one. On Chrome and Firefox it is one of the two ordinary ways
// to turn the coach on — offered as such in the AI access card — so calling it
// "developer mode" down here would only make people think they'd taken a
// wrong turn. Same fields either way; this is where you change or clear one.
//
// On Apple there is no such build. The card is removed from the DOM rather
// than hidden, so there is nothing a reviewer can open — or a user can find
// — that enables the coach outside In-App Purchase (guideline 3.1.1; see
// IS_APPLE_BUILD in providers.js, and resolveAIRoute() in background.js for
// the routing half, which is what actually makes a stored key inert).
function wireCustomKeySection(state) {
  if (IS_APPLE_BUILD) {
    document.getElementById('advanced-card')?.remove();
    return;
  }

  document.getElementById('custom-key-summary-note').textContent =
    BYOK_IS_PRIMARY ? '(change or remove)' : '(optional developer mode)';
  document.getElementById('custom-key-blurb').textContent = BYOK_IS_PRIMARY
    ? 'The key you set up under AI access, plus the model to use with it. Clearing it here turns the coach off until you add another.'
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

  // DEFAULT_PROVIDER was read by nothing at all: env.txt advertised it, the
  // parser returned it, and no line in the codebase ever looked at the key.
  // So a file that said `groq` still opened on Anthropic with an empty box,
  // and the GROQ_API_KEY sitting right underneath was never reachable without
  // first changing the dropdown by hand. Honoured once, on first load only,
  // and only when there is no stored provider of the user's own -- applying it
  // from the change handler too would silently undo every manual selection.
  let envProviderApplied = false;

  const syncEnvSettings = (parsedEnv) => {
    if (!envProviderApplied) {
      envProviderApplied = true;
      const stored = state.provider && state.provider !== HOSTED_PROVIDER ? state.provider : '';
      const wanted = String(parsedEnv.DEFAULT_PROVIDER || '').trim().toLowerCase();
      if (!stored && wanted && PROVIDERS[wanted] && !PROVIDERS[wanted].hosted) {
        provSel.value = wanted;
        syncPlaceholder();
      }
    }

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

  // The actual protection controls must not wait behind the optional
  // paywall/credit refreshes below. On a fresh install those can involve a
  // native bridge or a slow backend check; showing Settings while its lists
  // are still empty looks like the rules vanished just after setup.
  renderDomains(state.blockedDomains || [], state.domainLimits || {}, state.serviceReasons || {});
  renderPendingChanges(state);
  refreshStreak();
  wireAddModals();

  if (HAS_APP_BLOCKING) {
    document.getElementById('apps-card').hidden = false;
    renderApps(state.blockedApps || [], state.appLimits || {}, state.appLabels || {}, state.serviceReasons || {});
  } else if (HAS_IOS_APP_BLOCKING) {
    wireIOSAppsCard();
  }

  await refreshAccessUI('access-paywall');
  wireAccessRefreshOnReturn('access-paywall');
  await refreshCreditChip();
  bindOnce('credit-chip', 'click', () => {
    setSettingsSection('settings');
    document.getElementById('ai-access-card')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  // ---- Advanced: custom API key ----
  wireCustomKeySection(state);

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
    requestLoosening({
      changeType: 'disable_all',
      domain: null,
      title: 'Turn off all blocking?',
      subtitle: 'This turns off blocking for every site and app on your list.',
      onApproved: async () => {
        const state = await getConfig();
        renderDomains(state.blockedDomains || [], state.domainLimits || {}, state.serviceReasons || {});
        if (HAS_APP_BLOCKING) {
          renderApps(state.blockedApps || [], state.appLimits || {}, state.appLabels || {}, state.serviceReasons || {});
        }
        if (HAS_IOS_APP_BLOCKING) {
          window.intentionScreenTime.clear(() => refreshIOSAppsCard());
        }
      }
    });
  });

  await refreshLeavingCard();
  wireLeavingCard();
  applyLeaveDeepLink();
}

// ---- Leaving Intention ----------------------------------------------------
//
// The settings half of WP9. The other halves are background.js (the tab
// interposition, the stand-down, applySettingChange's 'uninstall' branch) and
// options-coach.js (the always-live exit inside the conversation).
//
// The one rule this file must not break: nothing here may ever hide, disable
// or delay a way out. The cool-off is something the user chose; the exit
// beside it works during the cool-off, and says so.

// The ladder, in the words the card uses. LEAVE_DELAY_CHOICES in rules.js is
// the list; this is only how each rung reads, and the second line is what
// turns a number into a consequence.
const LEAVE_DELAY_LABELS = {
  0: { label: 'No delay', detail: 'Talk to your coach, then remove it there and then.' },
  60: { label: '1 hour', detail: 'Ask now, remove in an hour.' },
  1440: { label: '24 hours', detail: 'Ask now, remove tomorrow.' },
  4320: { label: '3 days', detail: 'The longest commitment on offer.' }
};

// "in 21 hours" / "3 hours ago" — coarse on purpose. A live-ticking countdown
// to being allowed to leave would be a thing to sit and watch, which is the
// opposite of what a cool-off is for.
function formatLeaveSpan(ms) {
  const minutes = Math.max(0, Math.round(ms / 60000));
  if (minutes < 1) return 'less than a minute';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'}`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'}`;
}

// Everything on the card that depends on stored state. Called on open, and
// again after every action that could have moved it.
async function refreshLeavingCard() {
  const card = document.getElementById('leaving-card');
  if (!card) return;
  const leave = await sendBg({ action: 'getLeaveState' });
  if (!leave || leave.error) return;
  leavingState = leave;

  renderLeaveChoices(leave);
  renderLeavePending(leave);
  renderLeaveRemoveRow(leave);
}

// Held so the click handlers, which are bound once, can read the state the
// last render painted from rather than re-fetching it on every tap.
let leavingState = null;

function renderLeaveChoices(leave) {
  const box = document.getElementById('leave-delay-choices');
  box.textContent = '';
  for (const minutes of LEAVE_DELAY_CHOICES) {
    const copy = LEAVE_DELAY_LABELS[minutes];
    if (!copy) continue;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pill leave-choice' + (minutes === leave.leaveDelayMinutes ? ' selected' : '');
    btn.dataset.minutes = String(minutes);
    btn.setAttribute('aria-pressed', String(minutes === leave.leaveDelayMinutes));
    btn.appendChild(document.createTextNode(copy.label));
    const detail = document.createElement('span');
    detail.className = 'leave-choice-detail';
    detail.textContent = copy.detail;
    btn.appendChild(detail);
    box.appendChild(btn);
  }
}

function renderLeavePending(leave) {
  const box = document.getElementById('leave-pending');
  box.textContent = '';
  box.className = 'leave-pending';
  if (!leave.leaveRequest) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  const now = Date.now();
  const line = document.createElement('p');
  line.style.margin = '0';
  if (leave.ready) {
    box.classList.add('leave-ready');
    line.textContent = `Your cool-off is up. Removing Intention is one tap away whenever you want it.`;
  } else {
    const asked = formatLeaveSpan(now - (leave.leaveRequest.requestedAt || now));
    const left = formatLeaveSpan(leave.leaveRequest.availableAt - now);
    line.textContent = `You asked to remove Intention ${asked} ago. It'll be ready in ${left}.`;
  }
  box.appendChild(line);

  const actions = document.createElement('div');
  actions.className = 'leave-pending-actions';
  // Live during the wait, not only after it. A cool-off you cannot end is a
  // lock, and this is not a lock — the copy on the button says exactly what
  // pressing it costs so that nobody has to find out by pressing it.
  const now_btn = document.createElement('button');
  now_btn.type = 'button';
  now_btn.className = 'secondary';
  now_btn.id = 'leave-now-anyway-btn';
  now_btn.textContent = leave.ready ? 'Remove Intention' : 'Remove it now anyway';
  actions.appendChild(now_btn);

  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'secondary';
  cancel.id = 'leave-cancel-btn';
  cancel.textContent = 'Changed your mind? Cancel the request';
  actions.appendChild(cancel);
  box.appendChild(actions);
}

// The button that starts the conversation — or, on Apple builds, the paragraph
// that replaces it.
function renderLeaveRemoveRow(leave) {
  const row = document.getElementById('leave-remove-row');
  row.textContent = '';

  // On Apple builds `chrome.management.uninstallSelf()` would remove the
  // SAFARI EXTENSION and leave the Intention app exactly where it was —
  // technically a removal, not the one the button promises. There is no API
  // that removes a Mac app or an iOS app from inside it, so the honest answer
  // is directions rather than a button that does the wrong thing.
  if (IS_APPLE_BUILD || !leave.canSelfUninstall) {
    const note = document.createElement('p');
    note.className = 'row-info-note';
    note.id = 'leave-apple-note';
    note.textContent = IS_APPLE_BUILD
      ? 'On iPhone and iPad, remove Intention the way you remove any app: touch and hold its icon, then Remove App. On a Mac, drag Intention out of your Applications folder. Turning the Safari extension off in Safari’s settings stops the website blocking without removing anything.'
      : 'Remove Intention the way you remove any app on this device, from your system settings.';
    row.appendChild(note);
    return;
  }

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.id = 'leave-now-btn';
  btn.className = 'secondary';
  btn.style.width = '100%';
  btn.textContent = 'Remove Intention';
  row.appendChild(btn);
}

// One delegated listener per container, bound once, because every control
// inside them is repainted on each refresh.
function wireLeavingCard() {
  bindOnce('leave-delay-choices', 'click', async (e) => {
    const btn = e.target.closest ? e.target.closest('.leave-choice') : null;
    if (!btn) return;
    const next = normalizeLeaveDelay(btn.dataset.minutes);
    const current = leavingState ? leavingState.leaveDelayMinutes : 0;
    if (next === current) return;

    // Lengthening is a tightening: it saves for free, exactly as lowering an
    // intention does. Shortening is a loosening of a rule they set calmly, so
    // it waits — out the current cool-off and the night — unless the coach
    // allows it sooner, the same trade every other control on this page makes. background.js's saveSettings enforces the same direction, so
    // this branch is the UI half of a rule, not the rule itself.
    if (next > current) {
      await sendBg({ action: 'saveSettings', config: { leaveDelayMinutes: next } });
      await refreshLeavingCard();
      setStatus('leaving-status', next === 0 ? 'Cool-off turned off.' : 'Saved.', 'success');
      return;
    }

    requestLoosening({
      changeType: 'decrease_leave_delay',
      domain: null,
      currentValue: current,
      newValue: next,
      title: 'Shorten the wait?',
      subtitle: 'You chose this wait when you were thinking clearly. A shorter one starts once the current wait would have run out.',
      onApproved: async () => {
        await refreshLeavingCard();
        setStatus('leaving-status', 'Cool-off shortened.', 'success');
      }
    });
  });

  bindOnce('export-list-btn', 'click', exportBlocklistFile);
  bindOnce('import-list-btn', 'click', () => document.getElementById('import-list-input')?.click());
  bindOnce('import-list-input', 'change', importBlocklistFile);

  bindOnce('leave-remove-row', 'click', (e) => {
    if (!e.target.closest || !e.target.closest('#leave-now-btn')) return;
    openLeaveConversation();
  });

  bindOnce('leave-pending', 'click', async (e) => {
    if (!e.target.closest) return;
    if (e.target.closest('#leave-now-anyway-btn')) {
      await finishRemoval();
      return;
    }
    if (e.target.closest('#leave-cancel-btn')) {
      // Cancelling is a tightening — it puts the wait back in front of the
      // exit — so it costs nothing and is saved directly. The stand-down still
      // gets written, because this was an outcome of the leaving conversation
      // like any other and the interposition must not reopen it on the way
      // back to whatever they were doing.
      await sendBg({ action: 'saveSettings', config: { leaveRequest: null } });
      await sendBg({ action: 'beginLeave', reason: 'cancelled' });
      await refreshLeavingCard();
      setStatus('leaving-status', 'Request cancelled. Nothing has changed.', 'success');
    }
  });
}

// Open the leaving conversation. Shared by the card's own button and by the
// ?leave=1 deep link the background's tab interposition opens.
async function openLeaveConversation() {
  const cfg = await getConfig();
  requestLoosening({
    changeType: 'uninstall',
    domain: null,
    // The cool-off, carried through so the exit button inside the modal can
    // name what pressing it costs ("this ends your 24 hours"). The coach reads
    // the same number out of storage rather than from here — a value the page
    // supplies is a value the page could get wrong.
    currentValue: cfg.leaveDelayMinutes || 0,
    title: 'Before you remove Intention',
    subtitle: 'Tell your coach what’s going on. You can go ahead and remove it whichever way this conversation goes — the button below stays live the whole time.',
    onApproved: async () => {
      const leave = await sendBg({ action: 'getLeaveState' });
      await refreshLeavingCard();
      // No cool-off set: the coach agreeing IS the clearance, so go straight
      // to the browser's own removal dialog rather than making the user find
      // a second button for a decision they have just finished making.
      if (leave && !leave.leaveRequest) {
        await finishRemoval();
        return;
      }
      setSettingsSection('blocking');
      document.getElementById('leaving-card')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  });
}

// The exit itself, from every button that offers one.
async function finishRemoval() {
  const result = await sendBg({ action: 'completeRemoval' });
  // If it worked we are already gone and nothing below runs. The two cases
  // that reach here are the user declining the browser's confirmation dialog,
  // and a platform with no self-uninstall at all.
  if (result && result.reason === 'unsupported') {
    setStatus('leaving-status', 'Remove Intention from your device’s own settings — see the note above.', '');
    return;
  }
  await refreshLeavingCard();
  setStatus('leaving-status', 'Nothing removed. Intention is still here whenever you want it gone.', '');
}

// A tab opened at options.html?leave=1 — by the background when the user lands
// on chrome://extensions, or by a native host. It opens the conversation; it
// never removes anything on its own.
function applyLeaveDeepLink() {
  if (new URLSearchParams(window.location.search).get('leave') !== '1') return;
  setSettingsSection('blocking');
  document.getElementById('leaving-card')?.scrollIntoView({ block: 'start' });
  openLeaveConversation();
}

// The list, as a file the user keeps.
//
// An explicit allowlist, never a filtered copy of getConfig(): a field added
// to the config later must not silently end up in a file people email to
// themselves. What is deliberately NOT in here — the API key, the coaching
// entitlement, every stat, every transcript, the coach's observations — is as
// much a part of the format as what is.
const EXPORT_VERSION = 2;
const IMPORTABLE_LIST_KEYS = [
  'blockedDomains', 'domainLimits', 'blockedApps', 'appLimits', 'appLabels',
  'serviceReasons', 'userContext', 'contextProjects', 'contextReasons',
  'coachInstructions', 'leaveDelayMinutes'
];

function buildExportPayload(state) {
  return {
    v: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    blockedDomains: state.blockedDomains || [],
    domainLimits: state.domainLimits || {},
    blockedApps: state.blockedApps || [],
    appLimits: state.appLimits || {},
    appLabels: state.appLabels || {},
    serviceReasons: state.serviceReasons || {},
    userContext: state.userContext || '',
    contextProjects: state.contextProjects || '',
    contextReasons: state.contextReasons || '',
    coachInstructions: state.coachInstructions || '',
    leaveDelayMinutes: normalizeLeaveDelay(state.leaveDelayMinutes)
  };
}

function importedListConfig(payload) {
  if (!payload || typeof payload !== 'object' || ![1, EXPORT_VERSION].includes(payload.v)) {
    throw new Error('Choose an Intention list backup made by a supported version of the app.');
  }
  // A backup is user-provided data, not a trusted config snapshot. Copy only
  // the explicit format fields; API keys, entitlements, activity and any
  // surprise property in a JSON file never cross this boundary.
  const config = {};
  for (const key of IMPORTABLE_LIST_KEYS) {
    if (Object.prototype.hasOwnProperty.call(payload, key)) config[key] = payload[key];
  }
  if (!Array.isArray(config.blockedDomains) || !Array.isArray(config.blockedApps)
    || (config.domainLimits !== undefined && typeof config.domainLimits !== 'object')
    || (config.appLimits !== undefined && typeof config.appLimits !== 'object')) {
    throw new Error('That file does not contain a valid Intention list.');
  }
  return config;
}

async function importBlocklistFile(event) {
  const input = event.target;
  const file = input?.files?.[0];
  if (!file) return;
  try {
    const config = importedListConfig(JSON.parse(await file.text()));
    if (!window.confirm('Restore this list and replace the blocking rules and coach context currently on this device? API keys, credit and activity history stay untouched.')) return;
    const result = await sendBg({ action: 'saveSettings', config });
    if (result?.error) throw new Error(result.error);
    await renderCurrentView();
    setStatus('leaving-status', 'List restored. API keys, credit and history were left on this device.', 'success');
  } catch (e) {
    setStatus('leaving-status', String(e.message || e), 'error');
  } finally {
    // Selecting the same file later must raise another change event.
    input.value = '';
  }
}

async function exportBlocklistFile() {
  const state = await getConfig();
  const payload = buildExportPayload(state);
  const stamp = new Date().toISOString().slice(0, 10);
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `intention-list-${stamp}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoked on a turn of the event loop rather than immediately: Safari has
  // not always started the download by the time click() returns.
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  setStatus('leaving-status', 'Saved. Keep it somewhere you’ll find it.', 'success');
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
async function addDomainToBlocklist(domain) {
  if (!document.getElementById('setup-view').hidden) {
    if (setupBlockedDomains.includes(domain)) return false;
    setupBlockedDomains.push(domain);
    setupDomainLimits[domain] = { ...INTENTION_DEFAULTS };
    renderSetupDomains();
    return true;
  }
  const state = await getConfig();
  const domains = state.blockedDomains || [];
  const limits = state.domainLimits || {};
  if (domains.includes(domain)) return false;
  domains.push(domain);
  limits[domain] = { ...INTENTION_DEFAULTS };
  await sendBg({ action: 'saveSettings', config: { blockedDomains: domains, domainLimits: limits } });
  renderDomains(domains, limits, state.serviceReasons || {});
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

  const added = await addDomainToBlocklist(domain);
  if (!added) {
    setAddSiteError(`${domain} is already on your list.`);
    return false;
  }
  setAddSiteError('');
  input.value = '';
  return true;
}

// Loosening a rule — removing a block, more opens or longer ones, blocking
// less of a site, turning everything off, shortening the cool-off — never
// applies on the spot. The user chooses between having it tomorrow, for free,
// and asking the coach for it now. Leaving is the one exception: it is always
// the leaving conversation, with its exit button live throughout.
//
// `isApp`/`appLabel` only say what the target IS, so the coach can call it "the
// Instagram app" rather than reciting a package name.
async function requestLoosening({ isApp, appLabel, changeType, domain, newValue, currentValue, title, subtitle, onApproved }) {
  if (changeType === 'uninstall') {
    openGateModal({ changeType, domain, isApp, appLabel, currentValue, newValue, title, subtitle, onApproved });
    return;
  }
  const modal = document.getElementById('loosen-modal');
  document.getElementById('loosen-title').textContent = title;
  document.getElementById('loosen-subtitle').textContent = subtitle || '';
  document.getElementById('loosen-when').textContent = changeType === 'decrease_leave_delay'
    ? 'Saved changes to the cool-off start once your current wait would have run out.'
    : 'Saved changes like this start tomorrow.';
  const close = () => { modal.hidden = true; };
  const later = document.getElementById('loosen-later-btn');
  const now = document.getElementById('loosen-now-btn');
  const cancel = document.getElementById('loosen-cancel-btn');
  later.onclick = async () => {
    later.disabled = true;
    try {
      await sendBg({ action: 'applySettingChange', changeType, domain, newValue });
    } finally {
      later.disabled = false;
    }
    close();
    const state = await getConfig();
    renderPendingChanges(state);
    await onApproved();
  };
  now.onclick = () => {
    close();
    openGateModal({ changeType, domain, isApp, appLabel, currentValue, newValue, title, subtitle, onApproved });
  };
  cancel.onclick = close;
  modal.hidden = false;
  later.focus();
}

// What is waiting for tomorrow, and a way to take it back. Taking one back is
// a tightening, so it is free and immediate.
function renderPendingChanges(state) {
  const card = document.getElementById('pending-card');
  const list = document.getElementById('pending-list');
  if (!card || !list) return;
  const pending = (state && state.pendingChanges) || [];
  list.textContent = '';
  card.hidden = pending.length === 0;
  const labels = (state && state.appLabels) || {};
  for (const p of pending) {
    const li = document.createElement('li');
    const text = document.createElement('span');
    text.className = 'pending-text';
    text.textContent = describePendingChange(p, labels);
    const when = document.createElement('span');
    when.className = 'micro-label pending-when';
    when.textContent = formatPendingWhen(p.effectiveAt);
    const undo = document.createElement('button');
    undo.type = 'button';
    undo.className = 'secondary pending-undo';
    undo.textContent = 'Cancel';
    undo.addEventListener('click', async () => {
      await sendBg({ action: 'cancelPendingChange', changeType: p.changeType, domain: p.domain });
      renderPendingChanges(await getConfig());
    });
    li.append(text, when, undo);
    list.appendChild(li);
  }
}

function describePendingChange(p, labels) {
  const name = (p.domain && labels[p.domain]) || p.domain || '';
  switch (p.changeType) {
    case 'remove':
    case 'remove_app': return `Stop blocking ${name}`;
    case 'increase_limit':
    case 'increase_app_limit': return `${name}: ${describeIntention(resolveIntention(p.newValue))}`;
    case 'narrow_block_scope':
    case 'narrow_app_block_scope': return `Block less of ${name}`;
    case 'allow_accounts': {
      const handles = (Array.isArray(p.newValue) ? p.newValue : []).map(h => `@${h}`);
      return `Always allow ${handles.join(', ') || 'an account'} on ${name}`;
    }
    case 'disable_all': return 'Turn off all blocking';
    case 'decrease_leave_delay': return `Cool-off: ${formatLeaveDelay(p.newValue) || 'none'}`;
    default: return 'A change to your rules';
  }
}

function formatPendingWhen(effectiveAt) {
  const at = new Date(Number(effectiveAt) || 0);
  const tomorrow = new Date(nextDayStart());
  if (at.getTime() === tomorrow.getTime()) return 'Tomorrow';
  return at.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' }) + ' ' +
    at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// The streak line in the header of the blocking tab.
async function refreshStreak() {
  const el = document.getElementById('streak-line');
  if (!el) return;
  let summary = null;
  try { summary = await sendBg({ action: 'getStatsSummary' }); } catch (e) { summary = null; }
  const streak = summary && summary.streak;
  if (!streak) { el.hidden = true; return; }
  const days = Number(streak.days) || 0;
  document.getElementById('streak-value').textContent = `${days} ${days === 1 ? 'day' : 'days'}`;
  document.getElementById('streak-grace').textContent = streak.graceLeft > 0
    ? 'One slip this week is forgiven'
    : 'Grace used this week';
  el.hidden = false;
}

function removeDomain(d) {
  requestLoosening({
    changeType: 'remove',
    domain: d,
    title: `Stop blocking ${d}?`,
    subtitle: `${d} won't be blocked any more.`,
    onApproved: async () => {
      const state = await getConfig();
      renderDomains(state.blockedDomains || [], state.domainLimits || {}, state.serviceReasons || {});
    }
  });
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
    limits[app.packageName] = { ...INTENTION_DEFAULTS };
    labels[app.packageName] = app.label;
    await sendBg({ action: 'saveSettings', config: { blockedApps: apps, appLimits: limits, appLabels: labels } });
    renderApps(apps, limits, labels, state.serviceReasons || {});
  }
}

function removeApp(pkg, label) {
  const name = label || pkg;
  requestLoosening({
    isApp: true,
    appLabel: name,
    changeType: 'remove_app',
    domain: pkg,
    title: `Stop blocking ${name}?`,
    subtitle: `${name} won't be blocked any more.`,
    onApproved: async () => {
      const state = await getConfig();
      renderApps(state.blockedApps || [], state.appLimits || {}, state.appLabels || {}, state.serviceReasons || {});
    }
  });
}

function renderApps(apps, limits = {}, labels = {}, serviceReasons = {}) {
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
    renderApps(state.blockedApps || [], state.appLimits || {}, state.appLabels || {}, state.serviceReasons || {});
  };
  for (const pkg of apps) {
    const name = labels[pkg] || pkg;
    const limitInfo = limits[pkg] || { ...INTENTION_DEFAULTS };

    const { li, fields } = buildBlockedRow({
      target: pkg,
      label: name,
      onRemove: () => removeApp(pkg, labels[pkg])
    });

    buildRowBody({
      li, fields, target: pkg, label: name, limitInfo,
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
