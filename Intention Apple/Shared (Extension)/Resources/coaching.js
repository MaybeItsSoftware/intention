const INT_LOG = '[Intention]';
console.log(INT_LOG, 'coaching.js loaded');

// Parse domain from query parameter. On Android, the coaching overlay is also
// used for blocked apps: `domain` carries the package name, app=1 marks it,
// and `label` carries the human-readable app name.
const urlParams = new URLSearchParams(window.location.search);
const domain = urlParams.get('domain') || window.location.hostname;
const isApp = urlParams.get('app') === '1';
const appLabel = urlParams.get('label') || '';
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

closeBtn.textContent = isApp ? 'Close app' : 'Close tab';
if (isApp) closeBtn.classList.add('int-block');

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

// Show initial coaching prompt
const seed = `Hey. I see you've opened ${displayName}. What's going on? What are you hoping to get out of it?`;
addMessage(messagesEl, 'assistant', seed);

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

async function send() {
  const text = inputEl.value.trim();
  if (!text || sending) return;
  addMessage(messagesEl, 'user', text);
  inputEl.value = '';
  attemptSend(text);
}

async function attemptSend(text) {
  sending = true;
  const thinking = addMessage(messagesEl, 'assistant', '…', true);

  let resp;
  try {
    resp = await new Promise((resolve) => {
      chrome.runtime.sendMessage({
        action: 'chat',
        mode: 'gate',
        domain,
        isApp,
        appLabel: isApp ? appLabel : undefined,
        userMessage: text
      }, resolve);
    });
  } catch (e) {
    thinking.remove();
    sending = false;
    showRetryableError(messagesEl, '[no response: background worker may be offline]', text);
    return;
  }

  if (!resp) {
    thinking.remove();
    sending = false;
    showRetryableError(messagesEl, '[no response: background worker may be offline]', text);
    return;
  }
  if (resp.error) {
    thinking.remove();
    sending = false;
    const message = resp.networkError ? "Can't reach the coach — check your connection." : `[error: ${resp.error}]`;
    showRetryableError(messagesEl, message, text);
    return;
  }
  thinking.classList.remove('int-thinking');
  typeMessage(thinking, messagesEl, resp.assistantText || '(no reply)', () => {
    sending = false;
    if (resp.grantedSession) {
      setTimeout(() => {
        if (isApp && window.intentionApps) {
          // Android: launch the granted app; the native bridge closes this overlay.
          window.intentionApps.launchApp(domain);
        } else if (isApp && window.intentionScreenTime) {
          // iOS: lift the Screen Time shields for the granted window.
          window.intentionScreenTime.grantPass(resp.grantedSession.intervalMinutes, () => {
            window.location.href = 'options.html';
          });
        } else {
          // Redirect back to the target website once session is granted
          window.location.href = `https://${domain}`;
        }
      }, 2200);
    }
  });
}

function showRetryableError(container, message, text) {
  const errorEl = addMessage(container, 'assistant', message);
  addRetryButton(container, () => {
    errorEl.remove();
    attemptSend(text);
  });
}

function addRetryButton(container, onRetry) {
  const row = document.createElement('div');
  row.className = 'int-retry-row';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'int-retry-btn';
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

sendBtn.addEventListener('click', send);
inputEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });
closeBtn.addEventListener('click', () => {
  // End session and close the current tab
  chrome.runtime.sendMessage({ action: 'endSession', reason: 'fulfilled' });
  chrome.runtime.sendMessage({ action: 'closeCurrentTab' });
  if (isApp && !window.intentionApps) {
    // iOS app WebView: window.close() is a no-op — go back to settings.
    window.location.href = 'options.html';
    return;
  }
  window.close();
});
inputEl.focus();

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
