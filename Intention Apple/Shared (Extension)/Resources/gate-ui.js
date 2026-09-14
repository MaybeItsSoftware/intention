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
// no tab id, no page context, and no ids beyond `int-stats-row` and
// `int-usage`, which both hosts render. What only one host can read (the
// device's own usage record) arrives as an argument, never by reaching for it. chrome.runtime.sendMessage is the one exception — it is the
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

// ---------------------------------------------------------------------------
// Usage history: the last seven days on the thing being gated.
//
// Shown on the gate itself, under its actions, because the moment someone
// reaches for an app is the moment "you spent 2h 14m here today" means the
// most. Calm on purpose: one line of fact, a flat strip of seven bars with
// today in the one accent, and nothing that asks for anything.
//
// Two sources, and the renderer cannot tell them apart except by the label:
//
//   device     the operating system's own record of foreground time. Only a
//              host that can read one supplies it (the Android app, through
//              UsageStatsManager), as `deviceUsage` below.
//   intention  Intention's own tracking -- minutes spent on passes it granted.
//              Everywhere else, and the fallback when the device source is
//              unavailable or not permitted.
//
// `deviceUsage` is the host's edge, not a branch on which host this is:
//   read(days, done)  done({ granted: true, days: [{ date, minutes }] }) with
//                     days oldest first ending today, or { granted: false }
//   requestAccess()   send the user wherever that permission is granted
// A host without one simply passes nothing.
const USAGE_DAYS = 7;
const USAGE_WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// "0m", "45m", "2h", "2h 14m".
function formatUsageMinutes(minutes) {
  const total = Math.max(0, Math.round(Number(minutes) || 0));
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (!h) return `${m}m`;
  return m ? `${h}h ${m}m` : `${h}h`;
}

// The one sentence above the bars. The average is over the seven days shown,
// so it agrees with what the strip draws. When nothing before today has any
// time on it, an average would only restate today at a seventh of its size,
// so it is left off.
function summariseUsage(days) {
  const list = Array.isArray(days) ? days : [];
  const minutesOf = (d) => Math.max(0, Number(d && d.minutes) || 0);
  const today = list.length ? minutesOf(list[list.length - 1]) : 0;
  const total = list.reduce((sum, d) => sum + minutesOf(d), 0);
  const earlier = total - today;
  if (total <= 0) return 'Nothing in the last 7 days';
  const todayText = `${formatUsageMinutes(today)} today`;
  if (earlier <= 0) return todayText;
  return `${todayText} · ${formatUsageMinutes(total / Math.max(1, list.length))}/day this week`;
}

function usageWeekday(dateKey) {
  const parts = String(dateKey || '').split('-').map(Number);
  if (parts.length !== 3 || parts.some(n => !Number.isFinite(n))) return '';
  return USAGE_WEEKDAYS[new Date(parts[0], parts[1] - 1, parts[2]).getDay()];
}

// Paint `history` into `el`:
//   { source: 'device' | 'intention', days: [{ date, minutes }], onRequestAccess? }
// Built node by node rather than as markup: the numbers are ours, but the
// element sits inside third-party pages in the overlay host, and there is no
// reason to hand innerHTML anything.
function renderUsageHistory(el, history) {
  if (!el) return;
  const days = (history && Array.isArray(history.days) ? history.days : []).slice(-USAGE_DAYS);
  const device = history && history.source === 'device';
  const total = days.reduce((sum, d) => sum + Math.max(0, Number(d && d.minutes) || 0), 0);
  const onRequestAccess = history && history.onRequestAccess;
  el.textContent = '';

  // Intention's own record with nothing in it is not worth a strip of empty
  // bars on a screen that is already asking something of them. Real device
  // data at zero is a fact, and is drawn.
  const drawStrip = days.length > 0 && (device || total > 0);
  if (!drawStrip && !onRequestAccess) {
    el.hidden = true;
    return;
  }

  const make = (tag, className, text) => {
    const node = document.createElement(tag);
    node.className = className;
    if (text !== undefined) node.textContent = text;
    el.appendChild(node);
    return node;
  };

  if (drawStrip) {
    const label = device ? 'Screen time' : 'Time on passes';
    make('p', 'int-usage-label', `${label} · last 7 days`);
    make('p', 'int-usage-summary', summariseUsage(days));

    const bars = make('div', 'int-usage-bars');
    const max = days.reduce((m, d) => Math.max(m, Number(d && d.minutes) || 0), 0);
    const spoken = [];
    days.forEach((day, i) => {
      const minutes = Math.max(0, Number(day && day.minutes) || 0);
      const isToday = i === days.length - 1;
      const weekday = isToday ? 'Today' : usageWeekday(day && day.date);
      spoken.push(`${weekday} ${formatUsageMinutes(minutes)}`);

      const col = document.createElement('div');
      col.className = 'int-usage-day' + (isToday ? ' int-usage-today' : '');
      const track = document.createElement('div');
      track.className = 'int-usage-track';
      const bar = document.createElement('div');
      bar.className = 'int-usage-bar';
      const pct = max > 0 ? Math.round((minutes / max) * 100) : 0;
      // A day with any time at all keeps a visible sliver; a day with none
      // is the baseline hairline and nothing else.
      bar.style.height = minutes > 0 ? `max(2px, ${pct}%)` : '0';
      track.appendChild(bar);
      col.appendChild(track);
      const dow = document.createElement('span');
      dow.className = 'int-usage-dow';
      dow.textContent = isToday ? 'Today' : weekday;
      col.appendChild(dow);
      bars.appendChild(col);
    });
    if (bars.setAttribute) {
      bars.setAttribute('role', 'img');
      bars.setAttribute('aria-label', `${device ? 'Screen time' : 'Time on passes'}, last 7 days: ${spoken.join(', ')}`);
    }
  }

  // The device record is readable but not permitted. One quiet line, once, at
  // the bottom -- never a banner, never repeated in the conversation.
  if (onRequestAccess) {
    const grant = make('button', 'int-usage-grant', 'Show full screen time for this app');
    grant.type = 'button';
    grant.addEventListener('click', onRequestAccess);
  }
  el.hidden = false;
}

// Fetch and paint. Best-effort for the same reason as the stats strip: a gate
// without its history is still a gate.
function loadUsageHistory(domain, deviceUsage) {
  const el = document.getElementById('int-usage');
  if (!el) return;

  const requestAccess = deviceUsage && typeof deviceUsage.requestAccess === 'function'
    ? () => {
        // Coming back from the system's settings is the only moment the answer
        // can have changed, so that is when to look again -- once.
        const onVisible = () => {
          if (document.hidden) return;
          document.removeEventListener('visibilitychange', onVisible);
          loadUsageHistory(domain, deviceUsage);
        };
        document.addEventListener('visibilitychange', onVisible);
        deviceUsage.requestAccess();
      }
    : null;

  const fromIntention = (offerAccess) => {
    const onRequestAccess = offerAccess ? requestAccess : null;
    try {
      chrome.runtime.sendMessage({ action: 'getStatsForDomain', domain }, (stats) => {
        const failed = chrome.runtime.lastError || !stats;
        renderUsageHistory(el, {
          source: 'intention',
          days: failed ? [] : (stats.dailyMinutes || []),
          onRequestAccess
        });
      });
    } catch (e) {
      console.warn('[Intention]', 'usage history message threw:', e);
      renderUsageHistory(el, { source: 'intention', days: [], onRequestAccess });
    }
  };

  if (!deviceUsage || typeof deviceUsage.read !== 'function') {
    fromIntention(false);
    return;
  }
  try {
    deviceUsage.read(USAGE_DAYS, (result) => {
      if (result && result.granted && Array.isArray(result.days)) {
        renderUsageHistory(el, { source: 'device', days: result.days });
        return;
      }
      // Only an explicit "not granted" earns the offer. A read that failed for
      // any other reason would not be fixed by a trip to settings.
      fromIntention(!!(result && result.granted === false));
    });
  } catch (e) {
    console.warn('[Intention]', 'device usage read threw:', e);
    fromIntention(false);
  }
}

// The credit line above the conversation.
//
// It answers a complaint that was never about the gate at all — "there seems
// to be no means to see credit balance" — by putting the number on the one
// screen a paying user reliably reaches. Settings is where the balance
// belongs; the gate is where it is actually looked at.
//
// Two voices, one element. A low balance is a warning and says so. A healthy
// balance is a fact and reads like one, so it is only shown where the gate is
// the whole screen (the app's own coaching page, which marks its div
// `data-persistent`) and stays out of the way in the content overlay, where a
// blocked page is already carrying a conversation the user did not ask for.
// The host declares that in its own markup rather than this file asking which
// host it is running in.
//
// `credits` is only ever a number the background computed. `lowCredit` is a
// boolean, which is why the content script never needs the threshold itself.
//
// `route` is the third argument and not an optional one, because the balance
// alone cannot say whether it means anything. getAccess hands back the stored
// number on every route, so a user who bought credit, spent some of it and then
// pointed the coach at their own Anthropic key was being told "830 coaching
// credits left" on every blocked page while every message was billed to that
// key. The settings chip goes to explicit lengths to hide itself on 'byok' for
// exactly this reason — a balance shown for a route that does not spend it is
// not a small inaccuracy, it is the wrong mental model — and this is the same
// rule on the other surface. An unknown route says nothing, which is the safe
// direction to be wrong in.
function renderCreditNote(lowCredit, credits, route) {
  const note = document.getElementById('int-credit-note');
  if (!note) return;
  const remaining = Number(credits || 0);
  const persistent = note.dataset && note.dataset.persistent !== undefined;
  if (route !== 'hosted') {
    note.hidden = true;
    return;
  }
  // Nothing to say at zero either — zero is locked, and the paywall is already
  // saying that louder.
  if (!lowCredit && !(persistent && remaining > 0)) {
    note.hidden = true;
    return;
  }
  note.classList.toggle('int-credit-note-low', !!lowCredit);
  note.textContent = lowCredit
    ? `Coaching credit is running low — ${remaining.toLocaleString()} credits left.`
    : `${remaining.toLocaleString()} coaching credits left.`;
  note.hidden = false;
}

// Same line, from a cold start. Best-effort throughout, for the reason the
// stats strip is: a gate that failed to stand up because a balance could not
// be fetched would be a far worse bug than a gate with no balance on it.
function loadCreditNote() {
  try {
    chrome.runtime.sendMessage({ action: 'getAccess' }, (access) => {
      if (chrome.runtime.lastError || !access) return;
      renderCreditNote(access.lowCredit, access.balanceCredits, access.route);
    });
  } catch (e) {
    console.warn('[Intention]', 'getAccess message threw:', e);
  }
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
  // Exactly once per gate, in both hosts — this is constructed when the gate
  // stands up and never again. Deliberately not hung off attemptOpen(): a
  // resumed conversation skips that, and a returning user is precisely who the
  // balance is for.
  loadCreditNote();
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
      // The background computed this while spending the credit, so the line
      // stays honest turn by turn without a second round trip. Absent on a
      // route with no balance, where the note has nothing to say anyway —
      // applyHostedBalance returns null off the hosted route and the field
      // never rides along, so its presence IS the route.
      if (resp.balanceCredits !== undefined) {
        renderCreditNote(resp.lowCredit, resp.balanceCredits, 'hosted');
      }
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
