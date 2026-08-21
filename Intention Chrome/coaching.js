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

// Safari doesn't populate `sender.tab` for extension pages the way Chrome
// does, so from the background's point of view this gate belongs to no tab:
// the pass it grants is filed under a different key than the one the site's
// content script reads (so the site re-gates the instant it's granted), no
// per-tab allow rule is registered, and "Close tab" closes nothing. Resolve
// our own tab id up front and send it with anything the background keys by
// tab — a real `sender.tab` still wins over it there.
let selfTabId = null;
const selfTabReady = new Promise((resolve) => {
  try {
    if (!chrome.tabs || !chrome.tabs.getCurrent) {
      resolve();
      return;
    }
    chrome.tabs.getCurrent((tab) => {
      if (!chrome.runtime.lastError && tab && typeof tab.id === 'number') selfTabId = tab.id;
      resolve();
    });
  } catch (e) {
    resolve();
  }
});

async function sendTabMessage(message, timeoutMs) {
  await selfTabReady;
  return sendChatMessage(withTabId(message), timeoutMs);
}

function withTabId(message) {
  return selfTabId == null ? message : { ...message, tabId: selfTabId };
}

// Fire-and-forget counterpart to sendTabMessage, for the messages sent on the
// way out of this page: waiting on a reply that may never come would only
// delay the close.
function postTabMessage(message) {
  try {
    const sent = chrome.runtime.sendMessage(withTabId(message));
    if (sent && typeof sent.catch === 'function') sent.catch(() => {});
  } catch (e) {}
}

// The deep link this gate stood in front of, once the background has told us
// what it was — see `getIntendedUrl`.
let intendedUrl = '';

// Check for duplicate coaching tab for same domain. The verdict is stored so
// renderCoachUI can wait for it before opening the conversation — an opener
// fired into a tab that is about to close itself would burn a request for
// nothing. Resolves true when this tab is the duplicate (window.close()
// already called); a hung check falls through as false via the timeout.
const dupCheckPromise = sendTabMessage({ action: 'checkDuplicateCoaching', domain }, 10000)
  .then((resp) => {
    if (resp?.duplicate) {
      window.close();
      return true;
    }
    return false;
  })
  .catch(() => false);

const intendedUrlReady = isApp
  ? Promise.resolve()
  : sendTabMessage({ action: 'getIntendedUrl', domain }, 10000)
      .then((resp) => {
        if (resp?.url) intendedUrl = resp.url;
      })
      .catch(() => {});

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
  if (await passThroughIfGranted()) return;

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

// A gate that opens on a domain the user already holds a pass for has nothing
// to ask. The domain's redirect rule is dropped for the life of a pass, so
// this only happens on a race (the pass was granted seconds ago) or after the
// background was suspended and restarted — but when it does happen the user is
// stuck arguing for time they already have, and every fresh grant re-arms the
// same trap. Send them through instead. The marker keeps it to one automatic
// hop per pass, so a redirect rule that somehow outlives the grant can't
// ping-pong the tab.
async function passThroughIfGranted() {
  if (isApp || mode === 'checkin') return false;
  let session = null;
  try {
    const resp = await sendTabMessage({ action: 'getSession', domain }, 10000);
    session = resp?.session || null;
  } catch (e) {
    return false;
  }
  if (!session) return false;

  const marker = `intention:passed:${domain}:${session.startTime}`;
  try {
    if (sessionStorage.getItem(marker)) return false;
    sessionStorage.setItem(marker, '1');
  } catch (e) {
    // No session storage (private browsing): the hop is still worth making.
  }
  await intendedUrlReady;
  window.location.href = intendedUrl || `https://${domain}`;
  return true;
}

async function renderCoachUI() {
  conversation.wireComposer();
  inputEl.focus();

  // Bail if this tab is the duplicate — window.close() is already on its way.
  if (await dupCheckPromise) return;

  // Re-render whatever was already said this pass (the background filters out
  // its own synthetic marker turns), so a same-day reopen picks the
  // conversation back up instead of starting cold.
  let turns = [];
  try {
    const resp = await sendTabMessage({ action: 'getHistory', domain }, 10000);
    turns = resp?.turns || [];
  } catch (e) {
    turns = [];
  }
  for (const turn of turns) {
    addMessage(messagesEl, turn.role === 'user' ? 'user' : 'assistant', turn.content);
  }

  // The coach speaks first: always at check-in (the pass ending is the news),
  // otherwise only when there is no conversation to pick back up.
  if (mode === 'checkin' || turns.length === 0) conversation.attemptOpen();
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
        resp = await sendTabMessage({ action: 'simpleGrant', domain, isApp, appLabel: isApp ? appLabel : undefined });
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

// Today's stats for this domain, kept for showWalkAwayMoment below: the
// walk-away line must render instantly, so it reads what was already fetched
// at load rather than asking anything at close time.
let domainStats = null;

loadStatsRow(domain, (stats) => { domainStats = stats; });

// The hardcoded greetings the gate used to open with, kept as the offline
// fallback: if the LLM opener can't be fetched, this line still stands the
// gate up.
const OPENER_FALLBACK = mode === 'checkin'
  ? `Time check. Your time on ${displayName} is up. Did you get what you came for?`
  : `Hey. I see you've opened ${displayName}. What's going on — what are you hoping to get out of it?`;

// The loop itself is gate-ui.js's, shared with content.js. What is
// host-specific is here: the transport — this gate is an extension page, so
// every message carries the tab id resolved at the top of this file, and an
// app gate has a package name and a label rather than a page to describe —
// and what a locked account or a granted pass means when the gate is the
// whole screen rather than an overlay on the thing being gated.
const conversation = createGateConversation({
  messages: messagesEl,
  input: inputEl,
  sendButton: sendBtn,
  openerFallback: OPENER_FALLBACK,
  sendChat: (userMessage) => sendTabMessage({
    action: 'chat',
    mode,
    domain,
    isApp,
    appLabel: isApp ? appLabel : undefined,
    // Absent rather than empty when opening the conversation: the background
    // reads the missing key as "no user turn yet" and records its own marker
    // turn instead.
    ...(userMessage ? { userMessage } : {})
  }),
  onLocked: showPaywall,
  onGranted: followGrantedSession,
  onOpenSettings: () => openOptionsSection('settings')
});

// Shared by the coach chat flow and the no-AI simple-mode pass button: once a
// session is granted, get the user through to what they asked for. The pause
// is just long enough to register the grant line — the reveal above has
// already finished, so anything longer is dead air.
function followGrantedSession(grantedSession, delayMs = 600) {
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
      // Chrome/Firefox/Safari: coaching.html IS the blocked tab, so redirect it
      // — back to whatever was asked for, if the background still knows it.
      window.location.href = intendedUrl || `https://${domain}`;
    }
  }, delayMs);
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

// A double-click can get both clicks past the awaits below before the
// walk-away overlay exists to swallow the second one — which would record
// two walk-aways for a single exit.
let closingGate = false;
closeBtn.addEventListener('click', async () => {
  if (closingGate) return;
  closingGate = true;
  // End session and close the current tab (extensions) or hand off to the
  // native bridge, which opens a blank tab over the blocked one and dismisses
  // this overlay (Android — see closeBtn.textContent above). `domain` is what
  // keys the session on the native ports, which have no tab id to key on.
  // Only the local tab-id lookup is waited on — window.close() below would
  // otherwise tear the page down before either message was posted.
  await selfTabReady;

  const leave = () => {
    postTabMessage({ action: 'closeCurrentTab' });
    if (isApp && !window.intentionApps) {
      // iOS app WebView: window.close() is a no-op — go back to settings.
      window.location.href = 'options.html';
      return;
    }
    window.close();
  };

  if (mode === 'checkin') {
    postTabMessage({ action: 'endSession', domain, reason: 'fulfilled' });
    leave();
    return;
  }

  // Gate mode (coach or simple UI — same button): closing without taking time
  // is a walk-away, the exact habit this tool exists to build. Record it
  // immediately — 'walked_away' doesn't close the tab on the background side,
  // so the moment below owns the close timing.
  postTabMessage({ action: 'endSession', domain, reason: 'walked_away' });
  showWalkAwayMoment(leave, domainStats);
});

