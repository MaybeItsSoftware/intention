// Standalone overlay mount for the dev harness. This re-creates the markup
// that content.js renderChatUI() builds (kept in sync by eye), backed by a
// MOCK chrome and a FAKE LLM, so a developer can iterate on the overlay UI
// (loaded against each variant's real content.css) without loading the
// extension. This file is NOT part of the extension and is never shipped.
//
// It is loaded inside each iframe; window.__INTENTION_MOUNT({mode}) builds the
// overlay in that iframe's document against whatever content.css it linked.

(function () {
  // ---- Mock chrome -------------------------------------------------------
  const FAKE_STATS = {
    minutesToday: 18, minutesWeek: 96, minutesMonth: 320,
    minutesYear: 2100, minutesAllTime: 4200,
    grantsToday: 1, minutesTodayAll: 30, minutesWeekAll: 210,
    reasonsToday: ['quick check']
  };

  const FAKE_REPLIES = [
    "I hear you. You've already spent 18 minutes here today — is this the same pull, or genuinely something new?",
    "What specifically are you hoping to find in the next few minutes? If you can name it, I can help you decide.",
    "That sounds more like restlessness than a real task. Want to try a 5-minute walk first and see if the urge passes?",
    "Okay — that's concrete and time-bounded. I'll give you 10 minutes. Set the intention, then close it when you're done."
  ];
  let replyIdx = 0;

  const mockChrome = {
    runtime: {
      lastError: null,
      sendMessage(msg, cb) {
        if (msg.action === 'getStatsForDomain') {
          setTimeout(() => cb && cb(FAKE_STATS), 120);
        } else if (msg.action === 'chat') {
          const text = FAKE_REPLIES[Math.min(replyIdx++, FAKE_REPLIES.length - 1)];
          setTimeout(() => cb && cb({ assistantText: text, grantedSession: false }), 650);
        } else if (cb) {
          setTimeout(() => cb({}), 50);
        }
      }
    }
  };

  // ---- Mount -------------------------------------------------------------
  window.__INTENTION_MOUNT = function (opts) {
    const mode = (opts && opts.mode) || 'gate';
    const domain = 'twitter.com';
    const chrome = mockChrome;
    const doc = document;

    const seed = mode === 'gate'
      ? `Hey. I see you've opened ${domain}. What's going on — what are you hoping to get out of it?`
      : `Time check. Your time on ${domain} is up. Did you get what you came for?`;
    const subtitle = mode === 'gate'
      ? `${domain} — let's check in before you go through`
      : `${domain} — your time is up`;

    const existing = doc.getElementById('intention-root');
    if (existing) existing.remove();
    const oldBadge = doc.getElementById('intention-badge');
    if (oldBadge) oldBadge.remove();

    const root = doc.createElement('div');
    root.id = 'intention-root';
    root.innerHTML = `
      <div class="int-column">
        <h1>Intention</h1>
        <p class="int-subtitle">${subtitle}</p>
        <div class="int-stats-row" id="int-stats-row" style="display: none;"></div>
        <div class="int-messages" id="int-messages"></div>
        <div class="int-composer">
          <input type="text" id="int-input" placeholder="Type your reply…" autocomplete="off">
          <button id="int-send">Send</button>
        </div>
        <div class="int-close-row">
          <button id="int-close" class="int-secondary">Close tab</button>
        </div>
      </div>
    `;
    doc.body.appendChild(root);

    const messagesEl = doc.getElementById('int-messages');
    const inputEl = doc.getElementById('int-input');
    const sendBtn = doc.getElementById('int-send');
    const closeBtn = doc.getElementById('int-close');

    function addMessage(container, role, text, isThinking) {
      const div = doc.createElement('div');
      div.className = `int-msg int-msg-${role}` + (isThinking ? ' int-thinking' : '');
      div.textContent = text;
      container.appendChild(div);
      container.scrollTop = container.scrollHeight;
      return div;
    }

    addMessage(messagesEl, 'assistant', seed);

    chrome.runtime.sendMessage({ action: 'getStatsForDomain', domain }, (stats) => {
      if (!stats) return;
      const statsRow = doc.getElementById('int-stats-row');
      if (!statsRow) return;
      statsRow.innerHTML = `
        <div class="int-stat"><div class="int-stat-value">${stats.minutesToday || 0}m</div><div class="int-stat-label">Today</div></div>
        <div class="int-stat"><div class="int-stat-value">${stats.minutesWeek || 0}m</div><div class="int-stat-label">Week</div></div>
        <div class="int-stat"><div class="int-stat-value">${stats.minutesYear || 0}m</div><div class="int-stat-label">Year</div></div>
        <div class="int-stat"><div class="int-stat-value">${stats.minutesAllTime || 0}m</div><div class="int-stat-label">All Time</div></div>
      `;
      statsRow.style.display = 'flex';
    });

    let sending = false;
    function send() {
      const text = inputEl.value.trim();
      if (!text || sending) return;
      sending = true;
      addMessage(messagesEl, 'user', text);
      inputEl.value = '';
      const thinking = addMessage(messagesEl, 'assistant', '…', true);
      chrome.runtime.sendMessage({ action: 'chat', mode, domain, userMessage: text }, (resp) => {
        thinking.classList.remove('int-thinking');
        thinking.textContent = (resp && resp.assistantText) || '(no reply)';
        sending = false;
      });
    }
    sendBtn.addEventListener('click', send);
    inputEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });
    closeBtn.addEventListener('click', () => {
      addMessage(messagesEl, 'assistant', '(In the real extension this closes the tab.)');
    });

    // Count-up badge — mirrors content.js renderStatusBadge().
    const badge = doc.createElement('div');
    badge.id = 'intention-badge';
    const startTime = Date.now();
    const reason = 'quick check';
    function update() {
      const totalSec = Math.max(0, Math.round((Date.now() - startTime) / 1000));
      const m = Math.floor(totalSec / 60);
      const s = totalSec % 60;
      const timeStr = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
      badge.textContent = `⏱ ${timeStr}${reason ? ' · "' + reason + '"' : ''}`;
    }
    update();
    setInterval(update, 1000);
    doc.body.appendChild(badge);

    inputEl.focus();
  };
})();
