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
// What is NOT here is the request loop each host wraps around these. Those
// differ in more than transport (one lives in a closure inside renderChatUI
// and talks to the background about a tab, the other is module-level and has
// no tab at all), and merging them would be a rewrite of the gate rather than
// a de-duplication of it. That is a separate change with a separate risk.
//
// Everything here is a pure DOM helper: no chrome.* beyond the one stats
// message, no page-specific ids beyond `int-stats-row`, which both hosts
// render.

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
