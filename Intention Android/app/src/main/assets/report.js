// ---------------------------------------------------------------------------
// Reporting a coach message.
// ---------------------------------------------------------------------------
//
// Google Play requires that anything putting AI-generated text in front of a
// user let them report it "without needing to exit the app" (Play's
// AI-Generated Content policy). This is that mechanism: press and hold any
// message the coach wrote, and a sheet offers to send it to us.
//
// It lives in its own file because the coach is rendered by four different
// call sites that each grew their own copy of addMessage — coaching.js (the
// full page, and the whole of the Android app's coach), content.js (the
// in-page gate), and options.js twice (the coach and settings-gate modals).
// Rather than teach four renderers to build a sheet, each of them calls
// attachReportPress() on the bubble it just made and nothing else changes.
//
// The sheet builds its own DOM and injects its own styles for the same reason:
// the three surfaces have three unrelated stylesheets (content.css's near-black
// palette, options.css's slate, coaching.html's inline block), and a report
// dialog that looked like a different component on each would be worse than one
// that matches none of them exactly.

const REPORT_PRESS_MS = 500;

// A press that wanders this far was a scroll or a text selection, not a hold.
const REPORT_MOVE_TOLERANCE_PX = 10;

// Attaches press-and-hold reporting to one message bubble. Safe to call more
// than once on the same node. Only ever call it on messages the coach wrote —
// reporting your own words to yourself is meaningless.
// A plain expando rather than dataset or a WeakSet: this runs in three
// different script contexts, one of which injects into whatever DOM the page
// happens to have, and this is the one form that needs nothing from either.
function attachReportPress(bubbleEl) {
  if (!bubbleEl || bubbleEl.__intReportBound) return bubbleEl;
  if (typeof bubbleEl.addEventListener !== 'function') return bubbleEl;
  bubbleEl.__intReportBound = true;

  let timer = null;
  let startX = 0;
  let startY = 0;

  const cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };

  bubbleEl.addEventListener('pointerdown', (e) => {
    // Secondary buttons already have a menu of their own on desktop.
    if (e.button != null && e.button !== 0) return;
    startX = e.clientX;
    startY = e.clientY;
    cancel();
    timer = setTimeout(() => {
      timer = null;
      // The bubble that holds the typing indicator is the same node that later
      // holds the reply, so it gets bound early and has nothing to report yet.
      if (bubbleEl.classList.contains('int-thinking')) return;
      const text = (bubbleEl.textContent || '').trim();
      if (text) openReportSheet(text);
    }, REPORT_PRESS_MS);
  });

  bubbleEl.addEventListener('pointermove', (e) => {
    if (!timer) return;
    if (Math.abs(e.clientX - startX) > REPORT_MOVE_TOLERANCE_PX
      || Math.abs(e.clientY - startY) > REPORT_MOVE_TOLERANCE_PX) cancel();
  });

  for (const evt of ['pointerup', 'pointercancel', 'pointerleave']) {
    bubbleEl.addEventListener(evt, cancel);
  }

  // Android's WebView raises its own text-selection callout on a long press,
  // which would land on top of the sheet at the same moment. Holding a coach
  // message means "report it" here, so the native menu gives way. (Selecting
  // by dragging still works — that cancels the press before this fires.)
  bubbleEl.addEventListener('contextmenu', (e) => e.preventDefault());

  return bubbleEl;
}

// ---- The sheet -------------------------------------------------------------

const REPORT_STYLE_ID = 'int-report-style';

// One neutral dark treatment rather than three per-surface ones. Bottom sheet
// on phones (which is every Android coach), centred dialog above that.
const REPORT_CSS = `
.int-report-backdrop {
  position: fixed;
  inset: 0;
  /* The in-page gate already sits at the maximum, so matching it and relying
     on being appended later is the only way over the top of it. */
  z-index: 2147483647;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
  background: rgba(0, 0, 0, 0.6);
  font-family: inherit;
}
.int-report-sheet {
  width: min(420px, 100%);
  max-height: 84vh;
  overflow-y: auto;
  box-sizing: border-box;
  padding: 18px;
  border: 1px solid #2b2f3a;
  border-radius: 12px;
  background: #14161b;
  color: #e7e7ea;
  animation: int-report-in 140ms ease-out;
}
.int-report-sheet h2 {
  margin: 0 0 10px;
  font-size: 16px;
  font-weight: 700;
  color: #e7e7ea;
}
.int-report-quote {
  margin: 0 0 14px;
  padding: 10px 12px;
  border-left: 2px solid #3b82f6;
  border-radius: 0 6px 6px 0;
  background: rgba(255, 255, 255, 0.04);
  color: #b9bcc5;
  font-size: 13px;
  line-height: 1.45;
  max-height: 30vh;
  overflow-y: auto;
  white-space: pre-wrap;
}
.int-report-label {
  display: block;
  margin-bottom: 6px;
  font-size: 12px;
  color: #8b8f99;
}
.int-report-note {
  width: 100%;
  box-sizing: border-box;
  min-height: 68px;
  padding: 9px 10px;
  border: 1px solid #2b2f3a;
  border-radius: 6px;
  background: #0f1115;
  color: #e7e7ea;
  font-family: inherit;
  /* Under 16px, iOS zooms the page on focus and never zooms back out. */
  font-size: 16px;
  resize: vertical;
}
.int-report-consent {
  margin: 10px 0 0;
  font-size: 12px;
  line-height: 1.45;
  color: #8b8f99;
}
.int-report-actions {
  display: flex;
  gap: 8px;
  margin-top: 14px;
}
.int-report-actions button {
  flex: 1;
  min-height: 44px;
  padding: 10px 14px;
  border-radius: 6px;
  border: 1px solid #2b2f3a;
  background: transparent;
  color: #cbd5e1;
  font-family: inherit;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
}
.int-report-actions .int-report-send {
  border-color: #3b82f6;
  background: #3b82f6;
  color: #ffffff;
}
.int-report-actions button[disabled] { opacity: 0.6; cursor: default; }
.int-report-error { margin: 10px 0 0; font-size: 13px; color: #fca5a5; }
.int-report-done { margin: 0; font-size: 14px; line-height: 1.5; color: #e7e7ea; }
@keyframes int-report-in { from { opacity: 0; transform: translateY(6px); } }
@media (max-width: 560px) {
  .int-report-backdrop { align-items: flex-end; padding: 0; }
  .int-report-sheet {
    width: 100%;
    border-radius: 12px 12px 0 0;
    border-bottom: none;
    padding-bottom: calc(18px + env(safe-area-inset-bottom, 0px));
    animation-name: int-report-up;
  }
  @keyframes int-report-up { from { transform: translateY(100%); } }
}
@media (prefers-reduced-motion: reduce) {
  .int-report-sheet { animation-duration: 1ms; }
}
`;

function ensureReportStyles(doc) {
  if (doc.getElementById(REPORT_STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = REPORT_STYLE_ID;
  style.textContent = REPORT_CSS;
  (doc.head || doc.documentElement).appendChild(style);
}

function openReportSheet(text) {
  const doc = document;
  if (doc.querySelector('.int-report-backdrop')) return;
  ensureReportStyles(doc);

  const backdrop = doc.createElement('div');
  backdrop.className = 'int-report-backdrop';

  const sheet = doc.createElement('div');
  sheet.className = 'int-report-sheet';
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-modal', 'true');
  sheet.setAttribute('aria-label', 'Report this message');

  const heading = doc.createElement('h2');
  heading.textContent = 'Report this message?';

  const quote = doc.createElement('blockquote');
  quote.className = 'int-report-quote';
  quote.textContent = text;

  const label = doc.createElement('label');
  label.className = 'int-report-label';
  label.textContent = "What's wrong with it? (optional)";

  const note = doc.createElement('textarea');
  note.className = 'int-report-note';
  note.rows = 3;
  label.htmlFor = note.id = 'int-report-note-input';

  // Says exactly what leaves the device. This matters most for someone using
  // their own API key, whose conversations otherwise never touch our backend
  // at all — reporting is the one deliberate exception, so it is named.
  const consent = doc.createElement('p');
  consent.className = 'int-report-consent';
  consent.textContent = 'Sends this message, the one you sent just before it, and your note to Intention, so we can look at what the coach said. Nothing else from this conversation is included.';

  const error = doc.createElement('p');
  error.className = 'int-report-error';
  error.hidden = true;

  const actions = doc.createElement('div');
  actions.className = 'int-report-actions';
  const cancelBtn = doc.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'int-report-cancel';
  cancelBtn.textContent = 'Cancel';
  const sendBtn = doc.createElement('button');
  sendBtn.type = 'button';
  sendBtn.className = 'int-report-send';
  sendBtn.textContent = 'Report';
  actions.appendChild(cancelBtn);
  actions.appendChild(sendBtn);

  sheet.appendChild(heading);
  sheet.appendChild(quote);
  sheet.appendChild(label);
  sheet.appendChild(note);
  sheet.appendChild(consent);
  sheet.appendChild(error);
  sheet.appendChild(actions);
  backdrop.appendChild(sheet);
  doc.body.appendChild(backdrop);

  const close = () => {
    doc.removeEventListener('keydown', onKey, true);
    backdrop.remove();
  };
  function onKey(e) {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    }
  }
  doc.addEventListener('keydown', onKey, true);
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
  cancelBtn.addEventListener('click', close);

  sendBtn.addEventListener('click', () => {
    error.hidden = true;
    sendBtn.disabled = cancelBtn.disabled = true;
    sendBtn.textContent = 'Sending…';
    sendReport(text, note.value.trim()).then((resp) => {
      if (!resp || !resp.ok) {
        error.textContent = (resp && resp.error)
          || "Couldn't send that report just now. Please try again.";
        error.hidden = false;
        sendBtn.disabled = cancelBtn.disabled = false;
        sendBtn.textContent = 'Report';
        return;
      }
      sheet.innerHTML = '';
      const done = doc.createElement('p');
      done.className = 'int-report-done';
      done.textContent = 'Thanks — that’s been sent. We read every report and use them to fix what the coach says.';
      sheet.appendChild(done);
      setTimeout(close, 2200);
    });
  });

  // Not on touch: focusing the note there throws up the keyboard and shoves a
  // bottom sheet half off the screen, when the action most people want is the
  // Report button they can already see. The note is optional.
  const coarse = typeof window !== 'undefined' && window.matchMedia
    && window.matchMedia('(pointer: coarse)').matches;
  if (!coarse) note.focus();
}

function sendReport(text, note) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ action: 'reportMessage', text, note }, (resp) => {
        // A dead channel resolves undefined rather than throwing; the caller
        // treats that as a failure and offers the retry.
        resolve(resp);
      });
    } catch (e) {
      resolve({ ok: false, error: String(e.message || e) });
    }
  });
}
