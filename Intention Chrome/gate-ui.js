// gate-ui.js — the pieces of the coaching conversation that are the same
// wherever it is shown.
//
// The gate has two homes. On Chrome, Firefox and Safari it is an overlay
// injected into the blocked page by content.js; on Android and iOS, and
// whenever the background's gate backstop fires, it is coaching.html driven by
// coaching.js. Same conversation, two hosts.
//
// The two files had grown their own copies of the small things: the message
// bubble, the typing reveal, the walk-away moment, the stats strip, the chat
// timeout. Line-for-line identical in most cases, and in one — typeMessage —
// identical only after one of them had been fixed and the other followed by
// hand. That is the shape of a bug waiting: the next fix reaches one home.
//
// The request loop each host wrapped around them is here too, as
// createGateConversation. It resisted the first pass because the two copies
// differ in more than transport — one lives in a closure inside renderChatUI
// and talks to the background about a tab, the other is module-level with no
// tab at all — but every one of those differences turned out to be an *edge*
// of the loop rather than a step inside it: where the request goes, and what
// a locked account, a granted pass or a "Fix API key" click mean locally. So
// the loop takes them as a `host` and keeps the rest.
//
// Nothing here reaches for anything only one host has: no window.intention*,
// no tab id, no page context, and no ids beyond `int-stats-row`, which both
// hosts render. chrome.runtime.sendMessage is the one exception — it is the
// only way to ask the background anything, and it exists in both.

// Above providers.js's 30s per-request fetch timeout, so the background
// worker's own timeout/error classification wins the race and reaches the UI
// as a friendly message rather than the UI giving up first on a request that
// was about to fail cleanly. A clamped grant makes TWO sequential LLM calls
// (the honesty turn), so the budget covers both: giving up between them would
// leave a granted pass with nobody following it.
const CHAT_TIMEOUT_MS = 75000;

// One bubble in the transcript. Assistant bubbles get report.js's press-and-
// hold handler, bound even while the bubble is still the typing indicator,
// because that same node is what the reply gets typed into.
function addMessage(container, role, text, isThinking) {
  const div = document.createElement('div');
  div.className = `int-msg int-msg-${role}` + (isThinking ? ' int-thinking' : '');
  div.textContent = text;
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
  if (role === 'assistant') attachReportPress(div);
  return div;
}

// Short user-facing note from the background (a clamped grant, a cap hit):
// machinery speaking, not the coach, so it renders as a centered aside and
// gets no report affordance.
function addSystemNote(container, text) {
  const div = document.createElement('div');
  div.className = 'int-msg int-system';
  div.textContent = text;
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
  return div;
}

// Reveal `text` into `el` a few characters at a time. Clicking anywhere skips
// to the full text. `onDone` fires exactly once when the reveal completes.
function typeMessage(el, container, text, onDone) {
  el.textContent = '';
  let i = 0;
  let finished = false;
  // Reveal the whole message in ~290ms (24 steps × 12ms) regardless of
  // length — the old 2.5s length-independent crawl was self-inflicted latency
  // at the impulse moment.
  const step = Math.max(1, Math.ceil(text.length / 24));

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
  }, 12);

  document.addEventListener('click', skip, true);
}

// Spoken at the moment of walking away. Deliberately not an LLM call and not
// awaited on anything: the whole point of the moment is that it costs nothing
// and leaves fast.
const WALK_AWAY_LINES = [
  'Closed. That is the whole game.',
  'You looked at the urge and left. Strong.',
  'Nothing here you needed. Well spotted.',
  'That urge just lost one.',
  'Walking away is the rep. You just did one.'
];

// A ~1s full-screen affirmation before the tab or page goes, skippable with a
// click (same capture-phase idiom as typeMessage). onDone fires exactly once,
// whether the timer or the skip gets there first.
//
// `stats` is what the host already fetched at load — the line must render
// instantly, so it never asks anything at close time. The +1 is the walk-away
// that just happened, which those stats predate.
function showWalkAwayMoment(onDone, stats) {
  const overlay = document.createElement('div');
  overlay.className = 'int-walkaway';
  const weekCount = ((stats && stats.walkedAwayWeek) || 0) + 1;
  overlay.textContent = weekCount >= 2
    ? `That's ${weekCount} times this week you've walked away. That streak is the real work.`
    : WALK_AWAY_LINES[Math.floor(Math.random() * WALK_AWAY_LINES.length)];
  // In the overlay host it goes inside the extension's own root, so the
  // injected styles and Arvo reach it; on the coaching page there is no such
  // root and the body is the right parent anyway.
  const root = document.getElementById('intention-root');
  (root || document.body).appendChild(overlay);

  let finished = false;
  function finish() {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    document.removeEventListener('click', skip, true);
    onDone();
  }
  function skip() { finish(); }

  const timer = setTimeout(finish, 950);
  document.addEventListener('click', skip, true);
}

// The five-figure strip above the conversation. Static markup from numbers the
// background computed — no interpolation of anything a page could have
// authored, which is why this one may use innerHTML.
function renderStatsRow(stats) {
  const statsRow = document.getElementById('int-stats-row');
  if (!statsRow) return;
  const cell = (value, label) =>
    `<div class="int-stat"><div class="int-stat-value">${value}</div><div class="int-stat-label">${label}</div></div>`;
  statsRow.innerHTML = [
    cell(`${stats.minutesToday || 0}m`, 'Today'),
    cell(`${stats.minutesWeek || 0}m`, 'Week'),
    cell(`${stats.minutesYear || 0}m`, 'Year'),
    cell(`${stats.minutesAllTime || 0}m`, 'All Time'),
    cell(stats.walkedAwayWeek || 0, 'Walked away (wk)')
  ].join('');
  statsRow.style.display = 'flex';
}

// Ask the background for this domain's numbers, render them, and hand them
// back to the caller — which keeps them for showWalkAwayMoment. Best-effort
// throughout: a gate with no stats strip is a gate; a gate that failed to
// stand up because a statistic was unavailable is not.
function loadStatsRow(domain, onStats) {
  try {
    chrome.runtime.sendMessage({ action: 'getStatsForDomain', domain }, (stats) => {
      if (chrome.runtime.lastError) {
        console.warn('[Intention]', 'getStatsForDomain lastError:', chrome.runtime.lastError.message);
        return;
      }
      if (!stats) return;
      if (onStats) onStats(stats);
      renderStatsRow(stats);
    });
  } catch (e) {
    console.warn('[Intention]', 'getStatsForDomain message threw:', e);
  }
}

// One round-trip to the background, as a promise with a deadline. The reply
// arrives on a callback and `lastError` has to be read inside it, so this is
// the shape both hosts need; the timeout is the outer bound described above.
// A throw from sendMessage itself (a torn-down worker on some ports) rejects
// like any other failure rather than escaping as a synchronous error.
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

// The conversation itself: a thinking bubble, a request, and a reply typed
// into that same bubble — plus everything that can go wrong on the way.
//
// Both hosts run exactly this loop. What they don't share is where the
// request goes and what a result means locally, so those arrive as `host`:
//
//   messages / input / sendButton  the elements, already in the document
//   openerFallback                 the line to speak if the opener can't be fetched
//   sendChat(userMessage|null)     one round-trip; null means "open the conversation"
//   onLocked()                     no coaching credit left — the host takes the screen
//   onGranted(session)             a pass was granted; the host gets the user through
//   onOpenSettings()               the "Fix API key" route
//
// Everything else — the retry row, the stale-response guard, the phrasing of
// each failure — is the same conversation wherever it is shown, and lives
// here so that fixing it once fixes it in both places.
function createGateConversation(host) {
  const messages = host.messages;
  let sending = false;
  // Only the most recent request's result is allowed to touch the DOM, so a
  // stale response arriving after a timeout and a retry can't double-render.
  let requestSeq = 0;

  function addActionRow(actions) {
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
    messages.appendChild(row);
    messages.scrollTop = messages.scrollHeight;
    return row;
  }

  function showRetryableError(message, text, errorCode) {
    const errorEl = addMessage(messages, 'assistant', message);
    const actions = [];
    if (errorCode === 'auth') {
      // Left open (not dismissed on click) so the user can still hit "Try
      // again" here after fixing the key in the settings tab this opens.
      actions.push({ label: 'Fix API key', keepOpen: true, onClick: () => host.onOpenSettings() });
    }
    actions.push({
      label: 'Try again',
      onClick: () => {
        errorEl.remove();
        attemptSend(text);
      }
    });
    addActionRow(actions);
  }

  // The turn both entry points share. `onFailure` receives a message that is
  // already user-facing; by the time it runs the thinking bubble is gone and
  // the composer is live again.
  async function run(userMessage, fallbackText, onFailure) {
    const seq = ++requestSeq;
    sending = true;
    const thinking = addMessage(messages, 'assistant', '…', true);

    const stop = () => {
      thinking.remove();
      sending = false;
    };
    const fail = (message, errorCode) => {
      stop();
      onFailure(message, errorCode);
    };

    let resp;
    try {
      resp = await host.sendChat(userMessage);
    } catch (e) {
      if (seq !== requestSeq) return;
      fail(e && e.message === 'timeout'
        ? "That's taking too long to answer. Check your connection and try again."
        : '[no response: background worker may be offline]');
      return;
    }

    if (seq !== requestSeq) return;

    if (!resp || resp.error) {
      if (resp && resp.locked) {
        stop();
        host.onLocked();
        return;
      }
      if (!resp) {
        fail('[no response: background worker may be offline]');
        return;
      }
      fail(resp.networkError ? "Can't reach the coach — check your connection." : resp.error,
        resp.errorCode);
      return;
    }

    // Reuse the "…" placeholder and reveal the reply gradually so it reads as
    // if the coach is speaking, rather than snapping in all at once.
    thinking.classList.remove('int-thinking');
    typeMessage(thinking, messages, resp.assistantText || fallbackText, () => {
      if (seq !== requestSeq) return;
      sending = false;
      if (resp.systemNote) addSystemNote(messages, resp.systemNote);
      // The reveal above has already finished, so the host's hand-off pause is
      // just long enough to register the grant line before the pass starts.
      if (resp.grantedSession) host.onGranted(resp.grantedSession);
    });
  }

  function attemptSend(text) {
    return run(text, '(no reply)', (message, errorCode) =>
      showRetryableError(message, text, errorCode));
  }

  // attemptSend minus the user bubble: asks the background for the coach's
  // opening line. No userMessage — the background records its own marker turn.
  // No retry row either: the composer stays live, so the user's first reply
  // retries naturally through attemptSend.
  function attemptOpen() {
    return run(null, host.openerFallback, () => {
      addMessage(messages, 'assistant', host.openerFallback);
    });
  }

  function send() {
    const text = host.input.value.trim();
    if (!text || sending) return;
    addMessage(messages, 'user', text);
    host.input.value = '';
    attemptSend(text);
  }

  function wireComposer() {
    host.sendButton.addEventListener('click', send);
    host.input.addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });
  }

  return { send, attemptSend, attemptOpen, wireComposer };
}
