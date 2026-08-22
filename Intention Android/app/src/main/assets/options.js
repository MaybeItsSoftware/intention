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
  // Mirrors the wizard's mode step (options-wizard.js): where a store sells
  // coaching credit, an API key is not what turns the coach on — on Apple it
  // isn't even an option — so describing the alternative as "no API key
  // needed" would send people hunting for a key they can't use and read, to a
  // reviewer, as the app expecting one.
  document.getElementById('blocking-mode-blurb').textContent = BYOK_IS_PRIMARY
    ? 'Coach mode uses your AI to gate access and approve changes. Simple mode needs no API key — you choose a hard block or a self-serve timed pass. Either can also be set per site or app below.'
    : 'Coach mode talks you through a block and approves changes, running on coaching credit you buy in the app. Simple mode needs no AI — you choose a hard block or a self-serve timed pass. Either can also be set per site or app below.';
  document.getElementById('settings-mode-simple-desc').textContent = BYOK_IS_PRIMARY
    ? 'No API key needed.'
    : 'No AI, no credit used.';

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
  wireAccessRefreshOnReturn('access-paywall');

  // ---- Advanced: custom API key ----
  wireCustomKeySection(state);

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
