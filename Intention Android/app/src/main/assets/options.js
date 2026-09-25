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
  bindOnce('boot-retry-btn', 'click', () => window.location.reload());
  // The last line of defence against a blank screen: if no view has put
  // anything up by now, say so and offer the one thing that can help.
  setTimeout(() => {
    if (!document.getElementById('boot-view').hidden) bootFailed();
  }, BOOT_WATCHDOG_MS);
  try {
    await renderCurrentView();
  } catch (e) {
    console.error('[Intention] first render failed', e);
    bootFailed();
  }
});

// How long the first screen waits on the background before it stops waiting.
// The extensions answer in milliseconds; the native hosts have to start a web
// view first, which is usually well under this.
const BOOT_CONFIG_TIMEOUT_MS = 4000;
const BOOT_WATCHDOG_MS = 15000;
// Named rather than "everything": not every native bridge reads a null key list
// as the whole store.
const BOOT_STORAGE_KEYS = [
  'setupComplete', 'setupCompletedAt', 'blockedDomains', 'domainLimits', 'blockedApps',
  'appLimits', 'appLabels', 'serviceReasons', 'pendingChanges', 'userContext',
  'contextProjects', 'contextReasons', 'coachInstructions', 'provider', 'model',
  'apiKey', 'entitlement', 'leaveDelayMinutes'
];

// The first read of the config, with a way round a background that is slow or
// gone. Storage itself does not go through the background in any build — in
// the apps it is the App Group, answered natively — so it can always say
// whether setup is done, which is all the first screen needs to pick a view.
// Later reads go through getConfig as normal.
async function getBootConfig() {
  const timedOut = Symbol('timeout');
  const state = await Promise.race([
    getConfig(),
    new Promise(resolve => setTimeout(() => resolve(timedOut), BOOT_CONFIG_TIMEOUT_MS))
  ]);
  if (state && state !== timedOut) return state;
  console.warn('[Intention] background did not answer getConfig; reading storage directly');
  return new Promise(resolve => {
    try {
      chrome.storage.local.get(BOOT_STORAGE_KEYS, (stored) => resolve(stored || {}));
    } catch (e) {
      resolve({});
    }
  });
}

// Called by whichever view has just put real content on screen — not when the
// view is merely chosen, since the wizard's pages are all hidden until its
// first showStep, and hiding this any earlier left a gap with nothing on it.
function hideBootView() {
  const boot = document.getElementById('boot-view');
  if (boot) boot.hidden = true;
}

function bootFailed() {
  const boot = document.getElementById('boot-view');
  if (!boot) return;
  document.getElementById('setup-view').hidden = true;
  document.getElementById('settings-view').hidden = true;
  boot.hidden = false;
  document.getElementById('boot-status').textContent = 'Intention didn’t start properly. Try again, and if it keeps happening, restart the app.';
  document.getElementById('boot-retry-btn').hidden = false;
}

async function renderCurrentView() {
  const state = await getBootConfig();
  const setupComplete = !!state?.setupComplete;
  // The iOS host shows its own "turn on the Safari extension" banner, which
  // would otherwise sit on top of the wizard step that says the same thing at
  // greater length. Hand over while the wizard is running, take it back after.
  if (HAS_SAFARI_EXTENSION) window.intentionExtension.setSetupComplete(setupComplete);
  // Setting up in Safari first is the common way onto a Mac, and it marks
  // setup complete before the app has ever opened — so the app would have
  // skipped straight past anything that explained it. It gets its own short
  // welcome instead, once.
  if (setupComplete && IS_MAC_APP && !(await macOnboarded())) showSetupView('mac-tour');
  else if (setupComplete) showSettingsView(state);
  else showSetupView();
}

// In the App Group, not CONFIG_KEYS: it is about this app on this Mac, and the
// extension has no reason to see it.
async function macOnboarded() {
  try {
    const stored = await new Promise(resolve => chrome.storage.local.get(['macOnboardedAt'], resolve));
    return !!(stored && stored.macOnboardedAt);
  } catch (e) {
    return true;
  }
}

function markMacOnboarded() {
  return new Promise(resolve => {
    try { chrome.storage.local.set({ macOnboardedAt: Date.now() }, () => resolve()); } catch (e) { resolve(); }
  });
}

// The "Start Intention at login" switch, in the Mac welcome and the This Mac
// card. A login launch runs as an accessory — see the macOS AppDelegate — so
// what this buys is the extension-state check after every restart, not a
// window. SMAppService (macOS 13+) owns the real state, so every paint reads it
// back rather than trusting the click: macOS can answer "needs approval", and
// the user can change it in System Settings behind our back.
async function wireLoginSwitch(btnId, subId, approveId) {
  if (!IS_MAC_APP || !window.intentionExtension.loginItem) return;
  const btn = document.getElementById(btnId);
  const sub = document.getElementById(subId);
  const approve = document.getElementById(approveId);
  if (!btn || !sub || !approve) return;

  const paint = (st) => {
    const available = !!(st && st.available);
    const pending = !!(st && st.requiresApproval);
    const on = !!(st && st.enabled) || pending;
    btn.disabled = !available;
    btn.setAttribute('aria-checked', String(on));
    approve.hidden = !pending;
    sub.textContent = !available
      ? 'Needs macOS 13 or later.'
      : pending
        ? 'macOS wants you to allow it in Login Items first.'
        : on ? 'On. Intention checks the extension in the background, out of sight.' : 'Off.';
  };
  const read = () => new Promise(resolve => window.intentionExtension.loginItem(resolve)).then(paint);

  if (!btn.dataset.wired) {
    btn.dataset.wired = '1';
    btn.addEventListener('click', async () => {
      const on = btn.getAttribute('aria-checked') === 'true';
      btn.disabled = true;
      const st = await new Promise(resolve => window.intentionExtension.setLoginItem(!on, resolve));
      paint(st);
    });
    approve.addEventListener('click', () => window.intentionExtension.openLoginItemsSettings());
    // Back from System Settings is when an approval lands.
    window.addEventListener('intention-app-active', read);
  }
  await read();
}

// Only the bring-your-own-key providers are listed: the hosted provider isn't
// something the user picks, it's what a coaching-credit balance routes to.
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
// The Mac app specifically (ios-bridge.js marks the root before any script
// here runs). It gets its own welcome, a login-item switch, and no Screen Time.
const IS_MAC_APP = HAS_SAFARI_EXTENSION && document.documentElement.classList.contains('platform-mac');


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

// ---- Section tabs (Today / Intentions / Coach / Settings) ----
//
// Today used to be split across Blocking (the streak, what starts tomorrow),
// Activity (three lines of minutes and a log) and, on iPhone, a separate Unlock
// tab. It is one page now, and the page someone lands on. The old names still
// resolve — a remembered tab from before, a notification, the chat's
// "?section=" button, Android's deep-link extra — so nothing that links here
// has to change with it.
const SETTINGS_SECTIONS = ['today', 'intentions', 'coach', 'settings'];
const SECTION_ALIASES = { blocking: 'intentions', activity: 'today', unlock: 'today' };
const SECTION_TITLES = { today: 'Today', intentions: 'Intentions', coach: 'Coach', settings: 'Settings' };

function resolveSection(name) {
  const section = SECTION_ALIASES[name] || name;
  return SETTINGS_SECTIONS.includes(section) ? section : null;
}

let activeSettingsSection = (() => {
  try {
    return resolveSection(localStorage.getItem('activeSettingsSection')) || 'today';
  } catch (e) { return 'today'; }
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
    setSettingsSection('today');
  });
}

// A `?section=` query param (e.g. from the chat's "invalid API key" error
// button) overrides whatever tab localStorage last remembered, so the user
// actually lands where the link promised instead of wherever they left off.
function applyDeepLinkSection() {
  const requested = new URLSearchParams(window.location.search).get('section');
  const section = resolveSection(requested);
  if (!section) return;
  setSettingsSection(section);
  // An old "?section=unlock" still means the card, not just the page it is on.
  const target = requested === 'unlock'
    ? document.getElementById('unlock-card')
    : document.querySelector(`#settings-view [data-section="${section}"]`);
  target?.scrollIntoView({ block: 'start' });
  if (section === 'settings') {
    const keyFlow = document.getElementById('int-pw-key-route');
    if (keyFlow) keyFlow.open = true;
    document.getElementById('int-pw-key')?.focus();
  }
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
  // Chrome and Firefox run on the user's own key and nothing else, so there is
  // no balance to show even before a key is saved — "Credit 0" in the sidebar
  // would offer them something those builds cannot sell.
  if (!access || access.route === 'byok' || BILLING_MODE === 'byok') {
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

function setSettingsSection(name) {
  const section = resolveSection(name) || 'today';
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
  document.getElementById('section-title').textContent = SECTION_TITLES[activeSettingsSection];
  const dateEl = document.getElementById('section-date');
  dateEl.textContent = activeSettingsSection === 'today'
    ? new Date().toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })
    : '';
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
  const todayContext = document.getElementById('today-coach-context');
  if (todayContext) {
    todayContext.hidden = !hasContext;
    todayContext.textContent = hasContext ? userContext.trim() : '';
    document.getElementById('today-coach-empty').hidden = hasContext;
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

async function showSettingsView(state) {
  document.getElementById('setup-view').hidden = true;
  document.getElementById('settings-view').hidden = false;
  // Lets the wide layout take the whole window for its sidebar; the wizard
  // keeps the centred column it was designed in.
  document.body.classList.add('in-settings');
  hideBootView();
  if (IS_MAC_APP) {
    document.getElementById('mac-app-card').hidden = false;
    wireLoginSwitch('mac-login-btn', 'mac-login-sub', 'mac-login-approve-btn');
  }

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
  refreshToday(state);
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

  initSettingsTabs();
  initSectionTabs();

  bindOnce('today-coach-btn', 'click', async () => {
    if (await requireAccess()) openCoachModal();
  });
  bindOnce('usage-log-more', 'click', () => {
    usageLogExpanded = !usageLogExpanded;
    applyUsageLogExpanded();
  });
  wireTodayRefresh();
  refreshSideNote();
  await refreshUsageLog(state);

  bindOnce('open-coach-btn', 'click', async () => {
    if (await requireAccess()) openCoachModal();
  });
  bindOnce('close-coach-btn', 'click', closeCoachModal);
  bindOnce('paywall-close-btn', 'click', () => {
    document.getElementById('paywall-modal').hidden = true;
  });

  bindOnce('export-list-btn', 'click', exportBlocklistFile);
  bindOnce('import-list-btn', 'click', () => document.getElementById('import-list-input')?.click());
  bindOnce('import-list-input', 'change', importBlocklistFile);
  applyLeaveDeepLink();
}

// The native/browser uninstall deep link and the coach's always-live exit
// work independently of Settings cards.
async function openLeaveConversation() {
  const cfg = await getConfig();
  requestLoosening({
    changeType: 'uninstall',
    domain: null,
    currentValue: cfg.leaveDelayMinutes || 0,
    title: 'Before you remove Intention',
    subtitle: 'Tell your coach what’s going on. You can go ahead and remove it whichever way this conversation goes. The button below stays live the whole time.',
    onApproved: async () => {
      const leave = await sendBg({ action: 'getLeaveState' });
      if (leave && (!leave.leaveRequest || leave.ready)) {
        await finishRemoval();
        return;
      }
      if (leave && leave.leaveRequest) {
        const available = new Date(leave.leaveRequest.availableAt).toLocaleString();
        window.alert(`Your cool-off ends ${available}. You can still uninstall at any time. ${removalDirections()}`);
      }
    }
  });
}

function removalDirections() {
  if (IS_APPLE_BUILD) {
    return 'On iPhone or iPad, touch and hold Intention, then choose Remove App. On Mac, move Intention from Applications to the Bin.';
  }
  if (HAS_APP_BLOCKING) return 'Open Settings → Apps → Intention → Uninstall.';
  return 'Remove Intention from your browser’s Extensions settings.';
}

async function finishRemoval() {
  const result = await sendBg({ action: 'completeRemoval' });
  if (result && result.reason === 'unsupported') {
    window.alert(removalDirections());
  }
}

// Opening the link starts a conversation; it never uninstalls on its own.
function applyLeaveDeepLink() {
  if (new URLSearchParams(window.location.search).get('leave') !== '1') return;
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
    setStatus('backup-status', 'List restored. API keys, credit and history were left on this device.', 'success');
  } catch (e) {
    setStatus('backup-status', String(e.message || e), 'error');
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
  setStatus('backup-status', 'Saved. Keep it somewhere you’ll find it.', 'success');
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

  document.getElementById('unlock-card').hidden = false;
  bindOnce('ios-request-time-btn', 'click', () => {
    window.location.href = 'coaching.html?domain=apps&app=1';
  });
  // iOS cannot see someone leave a blocked app, so a pass there only ends
  // early when they say so. Shields first, then the record: if the worker is
  // slow the apps are already blocked, which is the half that matters.
  bindOnce('ios-end-pass-btn', 'click', () => {
    window.intentionScreenTime.endPass(async () => {
      await sendBg({ action: 'endSession', domain: 'apps', reason: 'fulfilled' });
      refreshIOSAppsCard();
    });
  });

  refreshIOSAppsCard();
}

async function refreshIOSAppsCard() {
  const statusEl = document.getElementById('ios-apps-status');
  const authorizeBtn = document.getElementById('ios-authorize-btn');
  const unlockStatusEl = document.getElementById('unlock-status');
  const requestBtn = document.getElementById('ios-request-time-btn');
  const endPassBtn = document.getElementById('ios-end-pass-btn');
  const st = await iosScreenTimeStatus();
  endPassBtn.hidden = !(st && st.authorized && st.selectionCount && st.passEndsAt);

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
    unlockStatusEl.textContent = 'Allow Screen Time access under Intentions first.';
    requestBtn.hidden = true;
    return;
  }
  authorizeBtn.hidden = true;
  const n = st.selectionCount || 0;
  if (n === 0) {
    statusEl.textContent = 'No apps blocked yet.';
    unlockStatusEl.textContent = 'No apps blocked yet. Choose some under Intentions first.';
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
    setupDomainLimits[domain] = { ...NEW_TARGET_INTENTION };
    renderSetupDomains();
    return true;
  }
  const state = await getConfig();
  const domains = state.blockedDomains || [];
  const limits = state.domainLimits || {};
  if (domains.includes(domain)) return false;
  domains.push(domain);
  limits[domain] = { ...NEW_TARGET_INTENTION };
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
  later.textContent = changeType === 'decrease_leave_delay' ? 'Save for later' : 'Save for tomorrow';
  now.hidden = false;
  cancel.hidden = false;
  later.onclick = async () => {
    later.disabled = true;
    now.disabled = true;
    cancel.disabled = true;
    try {
      const result = await sendBg({ action: 'applySettingChange', changeType, domain, newValue });
      if (!result || result.error || !result.scheduled) {
        document.getElementById('loosen-when').textContent = result?.error || 'Could not save this change. Try again.';
        return;
      }
      const state = await getConfig();
      await onApproved?.();
      renderPendingChanges(state);
      document.getElementById('loosen-title').textContent = changeType === 'decrease_leave_delay'
        ? 'Saved for later' : 'Saved for tomorrow';
      document.getElementById('loosen-subtitle').textContent = describePendingChange(result.pending, state.appLabels || {});
      document.getElementById('loosen-when').textContent = `Starts ${formatPendingWhen(result.pending.effectiveAt)}. Your current rules stay in place until then.`;
      later.textContent = 'Done';
      later.onclick = close;
      now.hidden = true;
      cancel.hidden = true;
    } catch (e) {
      console.warn('Intention: could not save scheduled change', e);
      document.getElementById('loosen-when').textContent = 'Could not save this change. Try again.';
    } finally {
      later.disabled = false;
      now.disabled = false;
      cancel.disabled = false;
    }
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
  renderPendingList(state, 'pending-card', 'pending-list');
  renderPendingList(state, 'intentions-pending-card', 'intentions-pending-list');
}

function renderPendingList(state, cardId, listId) {
  const card = document.getElementById(cardId);
  const list = document.getElementById(listId);
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
    case 'allow_reddit': {
      const value = p.newValue || {};
      return `Reddit: ${describeRedditAllowForHuman(value)}`;
    }
    case 'disable_all': return 'Clear all blocking rules';
    case 'decrease_leave_delay': return `Cool-off: ${formatLeaveDelay(p.newValue) || 'none'}`;
    default: return 'A change to your rules';
  }
}

function formatPendingWhen(effectiveAt) {
  const at = new Date(Number(effectiveAt) || 0);
  const tomorrow = new Date(nextDayStart());
  if (at.getTime() === tomorrow.getTime()) return 'tomorrow at ' + at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return at.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' }) + ' ' +
    at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// ---- Today ----------------------------------------------------------------
//
// One summary read feeds the streak, the week and the per-target rows, so the
// three can never disagree about a number. Everything user-supplied (domains,
// app labels) goes in as textContent.

async function refreshToday(state) {
  let summary = null;
  try { summary = await sendBg({ action: 'getStatsSummary' }); } catch (e) { summary = null; }
  const config = state || await getConfig();
  renderStreak(summary);
  renderWeek(summary, config);
  renderTodayTargets(summary, config);
}

// Apps can't rely on visibilitychange for an app switch, so the hosts fire
// intention-app-active; a desktop browser tab gets the ordinary event. Either
// way, coming back is when Safari may have pushed new minutes.
let todayRefreshAt = 0;
function wireTodayRefresh() {
  const again = async () => {
    if (document.getElementById('settings-view').hidden) return;
    if (Date.now() - todayRefreshAt < 5000) return;
    todayRefreshAt = Date.now();
    const state = await getConfig();
    refreshToday(state);
    renderPendingChanges(state);
    refreshUsageLog(state);
    refreshSideNote();
  };
  window.addEventListener('intention-app-active', again);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') again();
  });
}

function shortDay(key, style = 'short') {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: style });
}

function renderStreak(summary) {
  const el = document.getElementById('streak-line');
  if (!el) return;
  const streak = summary && summary.streak;
  if (!streak) { el.hidden = true; return; }
  const days = Number(streak.days) || 0;
  document.getElementById('streak-value').textContent = String(days);
  document.getElementById('streak-unit').textContent = days === 1 ? 'day kept' : 'days kept';

  const tag = document.getElementById('streak-today');
  tag.className = `status-tag ${streak.todayKept ? 'ok' : 'warn'}`;
  tag.textContent = streak.todayKept ? 'Today kept so far' : 'Today needed more';

  const list = document.getElementById('streak-days');
  list.textContent = '';
  const week = (summary.week || []);
  week.forEach((day, i) => {
    const li = document.createElement('li');
    const isToday = i === week.length - 1;
    const state = !day.counted ? 'uncounted' : (day.kept ? 'kept' : 'missed');
    li.className = `${state}${isToday ? ' today' : ''}`;
    const mark = document.createElement('span');
    mark.className = 'day-mark';
    const label = document.createElement('span');
    label.textContent = shortDay(day.date, 'narrow');
    li.setAttribute('aria-label', `${shortDay(day.date, 'long')}: ${
      state === 'uncounted' ? 'before you started' : state === 'kept' ? (isToday ? 'kept so far' : 'kept') : 'needed more than intended'}`);
    li.append(mark, label);
    list.appendChild(li);
  });

  const missed = week.filter(d => d.counted && !d.kept);
  const graceEl = document.getElementById('streak-grace');
  if (streak.graceLeft > 0) {
    graceEl.textContent = 'One slip in any seven days is forgiven. You haven’t needed it this week.';
  } else {
    const last = missed[missed.length - 1];
    const when = last ? shortDay(last.date, 'long') : 'this week';
    graceEl.textContent = `Grace used on ${when}. Another slip in the same seven days ends the run.`;
  }
  el.hidden = false;
}

// Every blocked target the page can put a number against: websites
// everywhere, and packages on Android. iOS app time is one opaque total from
// Screen Time, so it appears in Recent days rather than here.
function todayTargets(config) {
  const labels = config.appLabels || {};
  const targets = (config.blockedDomains || []).map(t => ({ id: t, label: t, kind: 'Website' }));
  if (HAS_APP_BLOCKING) {
    for (const pkg of (config.blockedApps || [])) targets.push({ id: pkg, label: labels[pkg] || pkg, kind: 'App' });
  }
  return targets.map(t => ({ ...t, intention: resolveIntention(limitEntryFor(t.id, config)) }));
}

function intendedMinutesPerDay(targets) {
  return targets.reduce((sum, t) => sum + (t.intention.mode === 'dailyTime'
    ? t.intention.dailyMinutes
    : t.intention.opens * t.intention.minutesEach), 0);
}

function renderWeek(summary, config) {
  const figures = document.getElementById('week-figures');
  const chart = document.getElementById('week-chart');
  if (!figures || !chart) return;
  const week = (summary && summary.week) || [];
  const counted = week.filter(d => d.counted);
  const total = counted.reduce((sum, d) => sum + d.minutes, 0);
  const average = counted.length ? Math.round(total / counted.length) : 0;
  const intended = intendedMinutesPerDay(todayTargets(config));

  figures.textContent = '';
  for (const [label, value] of [
    ['Today', `${(summary && summary.minutesToday) || 0} min`],
    ['Daily average', `${average} min`],
    ['Intended per day', intended ? `${intended} min` : 'none']
  ]) {
    const item = document.createElement('div');
    const dt = document.createElement('dt');
    dt.className = 'micro-label';
    dt.textContent = label;
    const dd = document.createElement('dd');
    dd.textContent = value;
    item.append(dt, dd);
    figures.appendChild(item);
  }
  drawWeekChart(chart, week, intended);
}

// Bars, not a line: seven separate days, each its own amount. The dashed rule
// is the day's intended total — every open of every target used in full — so
// a bar above it is a day that went past what was meant.
function drawWeekChart(chart, week, intended) {
  const NS = 'http://www.w3.org/2000/svg';
  const node = (name, attrs, text) => {
    const n = document.createElementNS(NS, name);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
    if (text != null) n.textContent = text;
    return n;
  };
  chart.textContent = '';
  if (!week.length) return;
  const W = Math.max(260, Math.round(chart.clientWidth || 520));
  const H = 150;
  const pad = { l: 34, r: 6, t: 14, b: 22 };
  const peak = Math.max(10, intended, ...week.map(d => d.minutes));
  const step = [10, 15, 30, 60, 120, 180, 240].find(s => peak / s <= 3) || Math.ceil(peak / 3 / 60) * 60;
  const max = step * Math.ceil(peak / step);
  const y = v => pad.t + (H - pad.t - pad.b) * (1 - v / max);
  const band = (W - pad.l - pad.r) / week.length;
  const barW = Math.min(28, band * 0.55);

  const svg = node('svg', {
    viewBox: `0 0 ${W} ${H}`,
    role: 'img',
    'aria-label': 'Minutes per day, last seven days: ' +
      week.map(d => `${shortDay(d.date, 'long')} ${d.minutes}`).join(', ') +
      (intended ? `. Intended: ${intended} a day.` : '')
  });
  for (let v = 0; v <= max; v += step) {
    svg.appendChild(node('line', { class: v === 0 ? 'base-line' : 'grid-line', x1: pad.l, x2: W - pad.r, y1: y(v), y2: y(v) }));
    svg.appendChild(node('text', { class: 'tick', x: pad.l - 8, y: y(v) + 3, 'text-anchor': 'end' }, v));
  }
  if (intended > 0) {
    svg.appendChild(node('line', { class: 'intent-line', x1: pad.l, x2: W - pad.r, y1: y(intended), y2: y(intended) }));
    svg.appendChild(node('text', { class: 'tick', x: W - pad.r, y: y(intended) - 5, 'text-anchor': 'end' }, `intended ${intended}`));
  }

  const tip = document.createElement('div');
  tip.className = 'chart-tip';
  tip.hidden = true;
  week.forEach((day, i) => {
    const isToday = i === week.length - 1;
    const cx = pad.l + band * i + band / 2;
    const top = y(day.minutes);
    const base = y(0);
    const r = Math.min(4, barW / 2, base - top);
    const x0 = cx - barW / 2;
    const x1 = cx + barW / 2;
    const hit = node('rect', { class: 'hit', x: pad.l + band * i, y: pad.t, width: band, height: H - pad.t - pad.b });
    svg.appendChild(hit);
    let bar = null;
    if (day.minutes > 0) {
      bar = node('path', {
        class: `bar${isToday ? ' is-today' : ''}`,
        d: `M${x0},${base} V${top + r} Q${x0},${top} ${x0 + r},${top} H${x1 - r} Q${x1},${top} ${x1},${top + r} V${base} Z`
      });
      svg.appendChild(bar);
    }
    if (isToday && day.minutes > 0) {
      svg.appendChild(node('text', { class: 'tick tick-strong', x: cx, y: top - 5, 'text-anchor': 'middle' }, day.minutes));
    }
    svg.appendChild(node('text', { class: 'tick', x: cx, y: H - 6, 'text-anchor': 'middle' }, shortDay(day.date, 'narrow')));
    hit.addEventListener('mouseenter', () => {
      bar?.classList.add('is-hover');
      tip.textContent = `${isToday ? 'Today' : shortDay(day.date, 'long')} · ${day.minutes} min`;
      tip.style.left = `${(cx / W) * 100}%`;
      tip.style.top = `${(top / H) * chart.clientHeight - 6}px`;
      tip.hidden = false;
    });
    hit.addEventListener('mouseleave', () => {
      bar?.classList.remove('is-hover');
      tip.hidden = true;
    });
  });
  chart.append(svg, tip);

  // Redrawn to the card's real width, once, when that width changes — the
  // viewBox is in pixels so the ticks stay 10px at every size.
  if (!chart._observed && typeof ResizeObserver === 'function') {
    chart._observed = true;
    chart._width = chart.clientWidth;
    new ResizeObserver(() => {
      if (chart.clientWidth === chart._width) return;
      chart._width = chart.clientWidth;
      if (chart._args) drawWeekChart(chart, ...chart._args);
    }).observe(chart);
  }
  chart._args = [week, intended];
}

function renderTodayTargets(summary, config) {
  const list = document.getElementById('today-targets');
  const quiet = document.getElementById('today-quiet');
  if (!list || !quiet) return;
  const perTarget = (summary && summary.perTargetToday) || {};
  const targets = todayTargets(config);
  list.textContent = '';

  if (!targets.length) {
    quiet.hidden = false;
    quiet.textContent = 'Nothing on your list yet. Add a website under Intentions.';
    return;
  }

  const withStats = targets.map(t => {
    const stat = perTarget[t.id] || {};
    const minutes = Number(stat.minutes) || 0;
    const negotiated = Number(stat.negotiated) || 0;
    const opensUsed = Math.min(t.intention.opens, Math.max(0, (Number(stat.grants) || 0) - negotiated));
    return { ...t, minutes, negotiated, opensUsed };
  });
  const active = withStats.filter(t => t.minutes > 0 || t.opensUsed > 0 || t.negotiated > 0)
    .sort((a, b) => b.minutes - a.minutes);
  const idle = withStats.filter(t => !active.includes(t));

  for (const t of active) {
    const { opens, minutesEach, mode, dailyMinutes } = t.intention;
    const allowed = mode === 'dailyTime' ? dailyMinutes : opens * minutesEach;
    const ratio = allowed > 0 ? t.minutes / allowed : (t.minutes > 0 ? 1 : 0);
    let tone = 'ok', tagText = 'On track';
    if (t.negotiated > 0) { tone = 'bad'; tagText = `${t.negotiated} past intention`; }
    else if (mode !== 'dailyTime' && opens === 0) { tone = 'info'; tagText = 'Blocked'; }
    else if (ratio >= 1 || (mode !== 'dailyTime' && t.opensUsed >= opens)) { tone = 'warn'; tagText = 'Used up'; }
    else if (ratio >= 0.8) { tone = 'warn'; tagText = 'Nearly used'; }

    const li = document.createElement('li');
    li.className = 'today-target';

    const name = document.createElement('div');
    name.className = 'today-target-name';
    const strong = document.createElement('strong');
    strong.textContent = t.label;
    const kind = document.createElement('span');
    kind.className = 'micro-label';
    kind.textContent = t.kind;
    name.append(usageMark({ domain: t.id, label: t.label }), strong, kind);

    const meter = document.createElement('div');
    meter.className = 'today-meter';
    meter.setAttribute('role', 'img');
    meter.setAttribute('aria-label', allowed ? `${t.minutes} of ${allowed} minutes` : `${t.minutes} minutes`);
    const fill = document.createElement('span');
    fill.className = tone === 'info' ? 'ok' : tone;
    fill.style.width = `${Math.min(100, Math.round(ratio * 100))}%`;
    meter.appendChild(fill);

    const fig = document.createElement('div');
    fig.className = 'today-target-fig';
    const figValue = document.createElement('strong');
    figValue.textContent = String(t.minutes);
    fig.append(figValue, document.createTextNode(allowed ? ` / ${allowed} min` : ' min'));

    const foot = document.createElement('div');
    foot.className = 'today-target-foot';
    if (mode === 'dailyTime') {
      const budget = document.createElement('span');
      budget.textContent = `${Math.max(0, allowed - t.minutes)} min left in today's budget`;
      foot.appendChild(budget);
    } else if (opens > 0) {
      const dots = document.createElement('span');
      dots.className = 'opens-dots';
      dots.setAttribute('aria-hidden', 'true');
      for (let i = 0; i < opens; i++) {
        const dot = document.createElement('i');
        if (i < t.opensUsed) dot.className = 'used';
        dots.appendChild(dot);
      }
      const opensText = document.createElement('span');
      opensText.textContent = `${t.opensUsed} of ${opens} ${opens === 1 ? 'open' : 'opens'} × ${minutesEach} min`;
      foot.append(dots, opensText);
    } else {
      const blocked = document.createElement('span');
      blocked.textContent = 'Blocked outright';
      foot.appendChild(blocked);
    }
    const tag = document.createElement('span');
    tag.className = `status-tag ${tone}`;
    tag.textContent = tagText;
    foot.appendChild(tag);

    li.append(name, meter, fig, foot);
    list.appendChild(li);
  }

  quiet.hidden = !idle.length;
  if (idle.length) {
    const names = idle.map(t => t.label);
    const shown = names.slice(0, 6).join(', ') + (names.length > 6 ? ` and ${names.length - 6} more` : '');
    quiet.textContent = active.length
      ? `No time yet today: ${shown}.`
      : `No time on anything on your list yet today: ${shown}. Nice.`;
  }
}

// The apps' sidebar footer: whether Safari is actually running the extension.
// On the Mac that is the real switch; on iPhone, a heartbeat within the day.
async function refreshSideNote() {
  const el = document.getElementById('settings-side-note');
  if (!el || !HAS_SAFARI_EXTENSION) return;
  const st = await new Promise(resolve => window.intentionExtension.status(resolve));
  if (!st) { el.hidden = true; return; }
  const seen = Number(st.lastSeenAt) || 0;
  let when = '';
  if (seen) {
    const mins = Math.max(0, Math.round((Date.now() - seen) / 60000));
    when = mins < 1 ? 'just now'
      : mins < 60 ? `${mins} min ago`
      : mins < 60 * 24 ? `${Math.round(mins / 60)} h ago`
      : new Date(seen).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  }
  el.textContent = st.active
    ? `Safari extension on.${when ? ` Last heard from Safari ${when}.` : ''}`
    : 'Safari extension off, so websites aren’t being blocked.';
  el.classList.toggle('is-off', !st.active);
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
    limits[app.packageName] = { ...NEW_TARGET_INTENTION };
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
    renderEmptyList(list, 'No apps blocked yet. Tap "+ Add app" and it suggests a few.');
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
// native app-usage merges added alongside it). One row per day: where the time
// went, and the day's total. The three most recent show; the rest wait behind
// "Show all" so Today stays a glance.
const USAGE_LOG_COLLAPSED_DAYS = 3;
let usageLogExpanded = false;

function formatUsageMinutes(minutes) {
  const rounded = Math.round(minutes || 0);
  if (rounded < 60) return `${rounded} min`;
  const hours = Math.floor(rounded / 60);
  const rest = rounded % 60;
  return rest ? `${hours} hr ${rest} min` : `${hours} hr`;
}

function usageMark(entry, appIcons) {
  const mark = document.createElement('span');
  mark.className = 'usage-mark';
  mark.setAttribute('aria-hidden', 'true');
  const appIcon = appIcons && appIcons[entry.domain];
  if (appIcon && /^data:image\//.test(appIcon)) {
    const img = document.createElement('img');
    img.src = appIcon;
    img.alt = '';
    mark.appendChild(img);
    return mark;
  }
  const siteKey = APP_ICON_SITE[entry.domain] || entry.domain;
  const meta = entry.domain === 'ios-apps' ? null : serviceIconFor(siteKey);
  if (meta && meta.icon) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', meta.color || 'currentColor');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', meta.icon);
    svg.appendChild(path);
    mark.appendChild(svg);
  } else {
    mark.textContent = entry.domain === 'ios-apps' ? '▦' : (entry.label || entry.domain).slice(0, 1).toUpperCase();
  }
  return mark;
}

function renderUsageTotals(entries, appIcons) {
  const list = document.getElementById('usage-target-totals');
  const totalEl = document.getElementById('usage-total');
  list.textContent = '';
  const byTarget = new Map();
  for (const entry of entries || []) {
    if (!entry || !Number.isFinite(Number(entry.minutes)) || Number(entry.minutes) <= 0) continue;
    const current = byTarget.get(entry.domain) || { ...entry, minutes: 0 };
    current.minutes += Number(entry.minutes);
    byTarget.set(entry.domain, current);
  }
  const targets = [...byTarget.values()].sort((a, b) => b.minutes - a.minutes || String(a.label || a.domain).localeCompare(String(b.label || b.domain)));
  if (!targets.length) {
    totalEl.hidden = true;
    return;
  }
  const grandTotal = targets.reduce((sum, target) => sum + target.minutes, 0);
  totalEl.textContent = `${formatUsageMinutes(grandTotal)} total in the last 30 days`;
  totalEl.hidden = false;
  for (const target of targets) {
    const li = document.createElement('li');
    li.className = 'usage-target-row';
    const name = document.createElement('span');
    name.className = 'usage-target-name';
    name.append(usageMark(target, appIcons), document.createTextNode(target.label || target.domain));
    const time = document.createElement('span');
    time.className = 'usage-target-time';
    time.textContent = formatUsageMinutes(target.minutes);
    li.append(name, time);
    list.appendChild(li);
  }
}

function renderUsageLog(entries, appIcons) {
  const list = document.getElementById('usage-log-list');
  const more = document.getElementById('usage-log-more');
  list.textContent = '';
  renderUsageTotals(entries, appIcons);
  if (!entries || !entries.length) {
    const li = document.createElement('li');
    li.className = 'muted history-empty';
    li.textContent = 'No usage recorded yet.';
    list.appendChild(li);
    if (more) more.hidden = true;
    return;
  }

  const days = [];
  for (const entry of entries) {
    let day = days[days.length - 1];
    if (!day || day.date !== entry.date) {
      day = { date: entry.date, items: [], total: 0 };
      days.push(day);
    }
    day.items.push(entry);
    day.total += entry.minutes;
  }

  days.forEach((day, i) => {
    const li = document.createElement('li');
    li.className = 'history-day';
    if (i >= USAGE_LOG_COLLAPSED_DAYS) li.dataset.extra = '1';
    const date = document.createElement('span');
    date.className = 'history-date';
    date.textContent = formatLogDate(day.date);
    const items = document.createElement('span');
    items.className = 'history-items';
    items.textContent = day.items.map(e => `${e.label || e.domain} ${e.minutes}m`).join(' · ');
    const total = document.createElement('span');
    total.className = 'history-total';
    total.textContent = `${day.total} min`;
    li.append(date, items, total);
    list.appendChild(li);
  });

  if (more) {
    more.hidden = days.length <= USAGE_LOG_COLLAPSED_DAYS;
    more.dataset.count = String(days.length);
  }
  applyUsageLogExpanded();
}

function applyUsageLogExpanded() {
  const more = document.getElementById('usage-log-more');
  document.querySelectorAll('#usage-log-list [data-extra]').forEach(li => { li.hidden = !usageLogExpanded; });
  if (more) {
    more.textContent = usageLogExpanded ? 'Show fewer' : `Show all ${more.dataset.count || ''} days`.replace('  ', ' ');
    more.setAttribute('aria-expanded', String(usageLogExpanded));
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

  let appIcons = {};
  if (HAS_APP_BLOCKING && window.intentionApps.getInstalledApps) {
    const installed = await getInstalledApps();
    appIcons = Object.fromEntries(installed.filter(a => a && a.icon).map(a => [a.packageName, a.icon]));
  }

  if (HAS_IOS_APP_BLOCKING && window.intentionScreenTime.getAppUsageReport) {
    const report = await new Promise(resolve => window.intentionScreenTime.getAppUsageReport(resolve));
    for (const [date, minutes] of Object.entries((report && report.minutesByDate) || {})) {
      const m = Math.round(minutes);
      if (m > 0) entries.push({ date, domain: 'ios-apps', minutes: m, label: 'Blocked apps (this device)' });
    }
  }

  entries.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.minutes - a.minutes));
  renderUsageLog(entries, appIcons);
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
