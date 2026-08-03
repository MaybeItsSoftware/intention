const INT_LOG = '[Intention]';
console.log(INT_LOG, 'coaching.js loaded');

// Parse domain from query parameter. On Android, the coaching overlay is also
// used for blocked apps: `domain` carries the package name, app=1 marks it,
// and `label` carries the human-readable app name.
const urlParams = new URLSearchParams(window.location.search);
const domain = urlParams.get('domain') || window.location.hostname;
const isApp = urlParams.get('app') === '1';
const appLabel = urlParams.get('label') || '';
// Android only: the browser package that opened the blocked site, so a
// website grant can return to that browser instead of navigating our WebView.
const browserPackage = urlParams.get('browserPackage') || '';
// The extensions run their check-in inside the page (content.js); the native
// ports have no content script, so the platform relaunches this page with
// mode=checkin when a granted session runs out.
const mode = urlParams.get('mode') === 'checkin' ? 'checkin' : 'gate';
// On iOS the coach grants a pass across all shielded apps (the Screen Time
// selection is opaque), so there is no per-app label — use a generic name.
const displayName = isApp ? (appLabel || 'a blocked app') : domain;

// Check for duplicate coaching tab for same domain
chrome.runtime.sendMessage({ action: 'checkDuplicateCoaching', domain }, (resp) => {
  if (chrome.runtime.lastError) return;
  if (resp?.duplicate) {
    window.close();
  }
});

const messagesEl = document.getElementById('int-messages');
const inputEl = document.getElementById('int-input');
const sendBtn = document.getElementById('int-send');
const closeBtn = document.getElementById('int-close');
const bottomBar = document.getElementById('int-bottom-bar');

// In check-in mode the session is already over, so the button ends it rather
// than declining anything. Otherwise: on Android, declining a website doesn't
// close the tab (no public API can target a specific tab in another app) — it
// opens a blank tab in front of it instead, leaving the original open, so
// "Close tab" would be inaccurate there.
closeBtn.textContent = mode === 'checkin'
  ? "I'm done"
  : (isApp ? 'Close app' : (window.intentionApps ? 'Not now' : 'Close tab'));
closeBtn.classList.add('int-block');

// Keep .int-column's bottom padding in sync with the bar's real rendered
// height (font swap, text wrap, and safe-area insets can all change it).
function updateBarHeightVar() {
  document.documentElement.style.setProperty('--int-bar-height', `${bottomBar.offsetHeight}px`);
}
if (window.ResizeObserver) {
  new ResizeObserver(updateBarHeightVar).observe(bottomBar);
} else {
  window.addEventListener('resize', updateBarHeightVar);
}
updateBarHeightVar();

// Keyboard avoidance: reposition the fixed bottom bar above the on-screen
// keyboard using the visualViewport API. No-op fallback: if unavailable,
// the bar simply stays at its CSS-default bottom: 0.
function updateBottomBarOffset() {
  const vv = window.visualViewport;
  if (!vv) return;
  bottomBar.style.bottom = `${Math.max(0, window.innerHeight - vv.height - vv.offsetTop)}px`;
}
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', updateBottomBarOffset);
  window.visualViewport.addEventListener('scroll', updateBottomBarOffset);
  updateBottomBarOffset();
}

// No AI access on this device: swap the conversation for the purchase flow.
// The block itself doesn't lift — this page is still standing in front of the
// site or app — there's just no coach to make a case to until it's sorted.
async function showPaywall() {
  const paywallEl = document.getElementById('int-paywall');
  // Same reason as the composer below: these carry their own `display`, so
  // `hidden` would be ignored.
  document.getElementById('int-messages').style.display = 'none';
  document.getElementById('int-stats-row').style.display = 'none';
  document.getElementById('int-heading').textContent = 'Coaching Credit';
  // The composer goes (there's nobody to talk to), but the close button stays:
  // inside the app's WebView it is the only way off this page. `hidden` alone
  // wouldn't do it — .int-composer's own `display: flex` outranks it.
  const composer = document.querySelector('.int-composer');
  if (composer) composer.style.display = 'none';
  paywallEl.hidden = false;
  updateBarHeightVar();

  const config = await new Promise(resolve => {
    chrome.runtime.sendMessage({ action: 'getConfig' }, resolve);
  });

  const persist = (entitlement) => new Promise(resolve => {
    chrome.runtime.sendMessage({ action: 'saveEntitlement', entitlement }, resolve);
  });

  const afterUnlock = async (entitlement) => {
    await persist(entitlement);
    // Back to a working gate: reload so the coach opens with a clean history.
    window.location.reload();
  };

  await renderPaywall(paywallEl, {
    entitlement: config?.entitlement || null,
    compact: true,
    onPurchase: async (productId) => {
      const result = await purchaseProduct(productId);
      if (!result || result.status === 'cancelled') return;
      if (result.status !== 'purchased') throw new Error(result.error || "The purchase didn't complete.");
      const entitlement = await verifyPurchase({
        platform: result.platform || (window.intentionApps ? 'google' : 'apple'),
        receipt: result.receipt,
        backendUrl: config?.backendUrl
      });
      await afterUnlock(entitlement);
    },
    onRestore: async () => {
      const result = await restorePurchases();
      if (!result || !result.receipt) throw new Error(result?.error || 'No pending purchase found.');
      const entitlement = await verifyPurchase({
        platform: result.platform || (window.intentionApps ? 'google' : 'apple'),
        receipt: result.receipt,
        backendUrl: config?.backendUrl
      });
      await afterUnlock(entitlement);
    },
    onRedeem: async (code) => {
      const entitlement = await redeemAccessCode(code, config?.backendUrl);
      if (!entitlementIsActive(entitlement)) throw new Error("That code isn't active.");
      await afterUnlock(entitlement);
    }
  });
}

// Decide coach vs simple-mode UI based on the effective blocking mode, then render.
init();

async function init() {
  let blockConfig = null;
  try {
    const resp = await sendChatMessage({ action: 'getBlockInfo', domain, isApp });
    blockConfig = resp?.blockConfig || null;
  } catch (e) {
    blockConfig = null;
  }

  if (blockConfig && blockConfig.mode === 'simple') {
    renderSimpleUI(blockConfig);
  } else {
    renderCoachUI();
  }
}

function renderCoachUI() {
  const seed = mode === 'checkin'
    ? `Time check. Your time on ${displayName} is up. Did you get what you came for?`
    : `Hey. I see you've opened ${displayName}. What's going on? What are you hoping to get out of it?`;
  addMessage(messagesEl, 'assistant', seed);

  sendBtn.addEventListener('click', send);
  inputEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });
  inputEl.focus();
}

// No-AI counterpart to renderCoachUI: a message plus a single action button,
// since simple mode has no LLM to converse with.
function renderSimpleUI(blockConfig) {
  const isPass = blockConfig.behavior !== 'hard';
  const message = mode === 'checkin'
    ? (isPass
        ? `Your time on ${displayName} is up. Take ${blockConfig.passMinutes} more minutes, or you're done.`
        : `Your time on ${displayName} is up.`)
    : (isPass
        ? `${displayName} is blocked. Take ${blockConfig.passMinutes} minutes if you need it.`
        : `${displayName} is blocked. Open settings to change this.`);
  addMessage(messagesEl, 'assistant', message);

  const composer = document.querySelector('.int-composer');
  if (composer) composer.style.display = 'none';

  if (isPass) {
    const passBtn = document.createElement('button');
    passBtn.type = 'button';
    passBtn.className = 'int-retry-btn';
    passBtn.style.marginRight = '10px';
    passBtn.textContent = `Take ${blockConfig.passMinutes} minutes`;
    passBtn.addEventListener('click', async () => {
      passBtn.disabled = true;
      passBtn.textContent = '…';
      let resp;
      try {
        resp = await sendChatMessage({ action: 'simpleGrant', domain, isApp, appLabel: isApp ? appLabel : undefined });
      } catch (e) {
        resp = null;
      }
      if (resp && resp.grantedSession) {
        addMessage(messagesEl, 'assistant', 'Granted.');
        followGrantedSession(resp.grantedSession, 900);
      } else {
        passBtn.disabled = false;
        passBtn.textContent = `Take ${blockConfig.passMinutes} minutes`;
        addMessage(messagesEl, 'assistant', (resp && resp.denied) || "Couldn't grant a pass — try again.");
      }
    });
    closeBtn.insertAdjacentElement('beforebegin', passBtn);
  } else {
    const settingsBtn = document.createElement('button');
    settingsBtn.type = 'button';
    settingsBtn.className = 'int-retry-btn';
    settingsBtn.style.marginRight = '10px';
    settingsBtn.textContent = 'Open settings';
    settingsBtn.addEventListener('click', () => {
      chrome.runtime.sendMessage({ action: 'openOptions' });
    });
    closeBtn.insertAdjacentElement('beforebegin', settingsBtn);
  }
}

// Locked before a word is typed: don't seed a conversation that can't happen.
try {
  chrome.runtime.sendMessage({ action: 'getAccess' }, (access) => {
    if (chrome.runtime.lastError) return;
    if (access && access.route === 'locked') showPaywall();
  });
} catch (e) {
  console.warn(INT_LOG, 'getAccess message threw:', e);
}

// Fetch stats and render stats row
try {
  chrome.runtime.sendMessage({ action: 'getStatsForDomain', domain }, (stats) => {
    if (chrome.runtime.lastError) {
      console.warn(INT_LOG, 'getStatsForDomain lastError:', chrome.runtime.lastError.message);
      return;
    }
    if (stats) {
      const statsRow = document.getElementById('int-stats-row');
      if (statsRow) {
        statsRow.innerHTML = `
          <div class="int-stat">
            <div class="int-stat-value">${stats.minutesToday || 0}m</div>
            <div class="int-stat-label">Today</div>
          </div>
          <div class="int-stat">
            <div class="int-stat-value">${stats.minutesWeek || 0}m</div>
            <div class="int-stat-label">Week</div>
          </div>
          <div class="int-stat">
            <div class="int-stat-value">${stats.minutesYear || 0}m</div>
            <div class="int-stat-label">Year</div>
          </div>
          <div class="int-stat">
            <div class="int-stat-value">${stats.minutesAllTime || 0}m</div>
            <div class="int-stat-label">All Time</div>
          </div>
        `;
        statsRow.style.display = 'flex';
      }
    }
  });
} catch (e) {
  console.warn(INT_LOG, 'getStatsForDomain message threw:', e);
}

let sending = false;
// Bumped above providers.js's 30s per-request fetch timeout so the background
// worker's own timeout/error classification wins the race and reaches the UI
// as a friendly message, instead of the UI giving up first on a request that
// was actually about to fail cleanly on its own.
const CHAT_TIMEOUT_MS = 35000;
// Only the most recent attemptSend's result is allowed to touch the DOM.
// Nothing in the current flow can put two attempts in flight at once, but
// this keeps a stale response harmless if that ever changes.
let requestSeq = 0;

function sendChatMessage(message, timeoutMs = CHAT_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
    try {
      chrome.runtime.sendMessage(message, (resp) => {
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

async function send() {
  const text = inputEl.value.trim();
  if (!text || sending) return;
  addMessage(messagesEl, 'user', text);
  inputEl.value = '';
  attemptSend(text);
}

async function attemptSend(text) {
  const seq = ++requestSeq;
  sending = true;
  const thinking = addMessage(messagesEl, 'assistant', '…', true);

  let resp;
  try {
    resp = await sendChatMessage({
      action: 'chat',
      mode,
      domain,
      isApp,
      appLabel: isApp ? appLabel : undefined,
      userMessage: text
    });
  } catch (e) {
    if (seq !== requestSeq) return;
    thinking.remove();
    sending = false;
    const message = e && e.message === 'timeout'
      ? "That's taking too long to answer. Check your connection and try again."
      : '[no response: background worker may be offline]';
    showRetryableError(messagesEl, message, text);
    return;
  }

  if (seq !== requestSeq) return;

  if (!resp) {
    thinking.remove();
    sending = false;
    showRetryableError(messagesEl, '[no response: background worker may be offline]', text);
    return;
  }
  if (resp.error) {
    thinking.remove();
    sending = false;
    if (resp.locked) {
      showPaywall();
      return;
    }
    const message = resp.networkError ? "Can't reach the coach — check your connection." : resp.error;
    showRetryableError(messagesEl, message, text, resp.errorCode);
    return;
  }
  thinking.classList.remove('int-thinking');
  typeMessage(thinking, messagesEl, resp.assistantText || '(no reply)', () => {
    if (seq !== requestSeq) return;
    sending = false;
    if (resp.grantedSession) {
      followGrantedSession(resp.grantedSession);
    }
  });
}

// Shared by the coach chat flow and the no-AI simple-mode pass button: once a
// session is granted, get the user through to what they asked for.
function followGrantedSession(grantedSession, delayMs = 2200) {
  setTimeout(() => {
    if (isApp && window.intentionApps) {
      // Android: launch the granted app; the native bridge closes this overlay.
      window.intentionApps.launchApp(domain);
    } else if (isApp && window.intentionScreenTime) {
      // iOS: lift the Screen Time shields for the granted window.
      window.intentionScreenTime.grantPass(grantedSession.intervalMinutes, () => {
        window.location.href = 'options.html';
      });
    } else if (!isApp && window.intentionApps && browserPackage) {
      // Android website: bring the real browser (which still holds the
      // blocked tab) back to the foreground and close this overlay.
      window.intentionApps.launchApp(browserPackage);
    } else {
      // Chrome/Firefox/Safari: coaching.html IS the blocked tab, so redirect it.
      window.location.href = `https://${domain}`;
    }
  }, delayMs);
}

function showRetryableError(container, message, text, errorCode) {
  const errorEl = addMessage(container, 'assistant', message);
  const actions = [];
  if (errorCode === 'auth') {
    // Left open (not dismissed on click) so the user can still hit "Try
    // again" here after fixing the key in the settings tab this opens.
    actions.push({
      label: 'Fix API key',
      keepOpen: true,
      onClick: () => openOptionsSection('settings')
    });
  }
  actions.push({
    label: 'Try again',
    onClick: () => {
      errorEl.remove();
      attemptSend(text);
    }
  });
  addActionRow(container, actions);
}

// Native ports have no background page (chrome.tabs doesn't exist), except
// Android, which intercepts the "openOptions" message before it ever gets
// there — see WebAppInterface.sendMessage. iOS has neither, so it has to
// navigate its own WebView directly, same as the "Close tab" button already
// does when window.close() is a no-op there.
function openOptionsSection(section) {
  if (isApp && !window.intentionApps) {
    window.location.href = `options.html?section=${encodeURIComponent(section)}`;
    return;
  }
  chrome.runtime.sendMessage({ action: 'openOptions', section });
}

function addActionRow(container, actions) {
  const row = document.createElement('div');
  row.className = 'int-retry-row';
  for (const action of actions) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'int-retry-btn';
    btn.textContent = action.label;
    btn.addEventListener('click', () => {
      if (!action.keepOpen) row.remove();
      action.onClick();
    });
    row.appendChild(btn);
  }
  container.appendChild(row);
  container.scrollTop = container.scrollHeight;
  return row;
}

closeBtn.addEventListener('click', () => {
  // End session and close the current tab (extensions) or hand off to the
  // native bridge, which opens a blank tab over the blocked one and dismisses
  // this overlay (Android — see closeBtn.textContent above). `domain` is what
  // keys the session on the native ports, which have no tab id to key on.
  chrome.runtime.sendMessage({ action: 'endSession', domain, reason: 'fulfilled' });
  chrome.runtime.sendMessage({ action: 'closeCurrentTab' });
  if (isApp && !window.intentionApps) {
    // iOS app WebView: window.close() is a no-op — go back to settings.
    window.location.href = 'options.html';
    return;
  }
  window.close();
});

function addMessage(container, role, text, isThinking) {
  const div = document.createElement('div');
  div.className = `int-msg int-msg-${role}` + (isThinking ? ' int-thinking' : '');
  div.textContent = text;
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
  return div;
}

function typeMessage(el, container, text, onDone) {
  el.textContent = '';
  let i = 0;
  let finished = false;
  const step = Math.max(1, Math.ceil(text.length / 140));

  function finish() {
    if (finished) return;
    finished = true;
    clearInterval(timer);
    el.textContent = text;
    if (container) container.scrollTop = container.scrollHeight;
    document.removeEventListener('click', skip, true);
    if (onDone) onDone();
  }
  function skip() { finish(); }

  const timer = setInterval(() => {
    i += step;
    el.textContent = text.slice(0, i);
    if (container) container.scrollTop = container.scrollHeight;
    if (i >= text.length) finish();
  }, 18);

  document.addEventListener('click', skip, true);
}
