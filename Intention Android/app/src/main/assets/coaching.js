const INT_LOG = '[Intention]';
console.log(INT_LOG, 'coaching.js loaded');

// Parse domain from query parameter
const urlParams = new URLSearchParams(window.location.search);
const domain = urlParams.get('domain') || window.location.hostname;

// Check for duplicate coaching tab for same domain
chrome.runtime.sendMessage({ action: 'checkDuplicateCoaching', domain }, (resp) => {
  if (chrome.runtime.lastError) return;
  if (resp?.duplicate) {
    window.close();
  }
});

document.getElementById('int-subtitle').textContent = `${domain} — let's check in before you go through`;

const messagesEl = document.getElementById('int-messages');
const inputEl = document.getElementById('int-input');
const sendBtn = document.getElementById('int-send');
const closeBtn = document.getElementById('int-close');

// Show initial coaching prompt
const seed = `Hey. I see you've opened ${domain}. What's going on — what are you hoping to get out of it?`;
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
  sending = true;
  addMessage(messagesEl, 'user', text);
  inputEl.value = '';
  const thinking = addMessage(messagesEl, 'assistant', '…', true);

  chrome.runtime.sendMessage({
    action: 'chat',
    mode: 'gate',
    domain,
    userMessage: text
  }, (resp) => {
    if (!resp) {
      thinking.remove();
      addMessage(messagesEl, 'assistant', '[no response — background worker may be offline]');
      sending = false;
      return;
    }
    if (resp.error) {
      thinking.remove();
      addMessage(messagesEl, 'assistant', `[error: ${resp.error}]`);
      sending = false;
      return;
    }
    thinking.classList.remove('int-thinking');
    typeMessage(thinking, messagesEl, resp.assistantText || '(no reply)', () => {
      sending = false;
      if (resp.grantedSession) {
        // Redirect back to the target website once session is granted
        setTimeout(() => {
          window.location.href = `https://${domain}`;
        }, 2200);
      }
    });
  });
}

sendBtn.addEventListener('click', send);
inputEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });
closeBtn.addEventListener('click', () => {
  // End session and close the current tab
  chrome.runtime.sendMessage({ action: 'endSession', reason: 'fulfilled' });
  chrome.runtime.sendMessage({ action: 'closeCurrentTab' });
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
