const INT_LOG = "[Intention]";
console.log(
  INT_LOG,
  "content.js loaded (build: gate-fallback v2)",
  window.location.href,
);

const OVERLAY_CSS = `
#intention-root {
  all: initial;
  position: fixed;
  inset: 0;
  z-index: 2147483647;
  width: 100%;
  height: 100%;
  overflow: hidden;
  background: #0f1115;
  color: #e7e7ea;
  font-family: 'Arvo', Georgia, 'Times New Roman', serif;
}

#intention-root * { box-sizing: border-box; }

#intention-root .int-column {
  max-width: 620px;
  margin: 0 auto;
  min-height: 100%;
  padding: 14vh 24px 40px;
  display: flex;
  flex-direction: column;
}

#intention-root h1 {
  margin: 0 0 4px;
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: #6b7280;
}

#intention-root .int-subtitle {
  margin: 0 0 30px;
  font-size: 15px;
  color: #8b8f99;
}

#intention-root .int-messages {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 22px;
  margin-bottom: 26px;
  overflow-y: auto;
}

#intention-root .int-messages::-webkit-scrollbar { width: 6px; }
#intention-root .int-messages::-webkit-scrollbar-track { background: transparent; }
#intention-root .int-messages::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.12); border-radius: 3px; }
#intention-root .int-messages::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.22); }

#intention-root .int-msg {
  font-size: 19px;
  line-height: 1.62;
  white-space: pre-wrap;
  animation: int-fade-in 0.45s ease-out;
}

#intention-root .int-msg-assistant {
  color: #f3f4f6;
}

#intention-root .int-msg-user {
  color: #7c818c;
}

#intention-root .int-msg-user::before {
  content: "You — ";
  color: #4b5563;
}

#intention-root .int-thinking {
  opacity: 0.5;
}

#intention-root .int-composer {
  display: flex;
  align-items: center;
  gap: 12px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.14);
  padding-bottom: 8px;
}

#intention-root .int-composer input {
  flex: 1;
  border: none;
  background: transparent;
  color: #f3f4f6;
  font-size: 18px;
  outline: none;
  font-family: inherit;
  padding: 4px 0;
}

#intention-root .int-composer input::placeholder { color: #545863; }

#intention-root .int-composer button {
  border: none;
  background: transparent;
  color: #9aa0ac;
  font-weight: 600;
  font-size: 15px;
  cursor: pointer;
  font-family: inherit;
  padding: 4px 0;
}

#intention-root .int-composer button:hover { color: #f3f4f6; }

#intention-root .int-close-row {
  margin-top: 22px;
}

#intention-root #int-open-options {
  align-self: flex-start;
  margin-top: 4px;
  border: 1px solid rgba(255, 255, 255, 0.2);
  background: transparent;
  color: #e7e7ea;
  font-size: 15px;
  padding: 9px 16px;
  border-radius: 8px;
  cursor: pointer;
  font-family: inherit;
}

#intention-root #int-open-options:hover { background: rgba(255, 255, 255, 0.06); }

#intention-root .int-retry-row { margin-top: 4px; }

#intention-root .int-retry-btn {
  border: 1px solid rgba(255, 255, 255, 0.2);
  background: transparent;
  color: #e7e7ea;
  font-size: 14px;
  padding: 7px 14px;
  border-radius: 8px;
  cursor: pointer;
  font-family: inherit;
}

#intention-root .int-retry-btn:hover { background: rgba(255, 255, 255, 0.06); }

#intention-root button.int-secondary {
  border: none;
  background: transparent;
  color: #545863;
  font-size: 14px;
  cursor: pointer;
  font-family: inherit;
  padding: 0;
}

#intention-root button.int-secondary:hover { color: #9aa0ac; text-decoration: underline; }

#intention-root .int-stats-row {
  display: flex;
  flex-wrap: wrap;
  gap: 18px;
  margin-bottom: 30px;
  font-size: 13px;
}

#intention-root .int-stat { display: flex; gap: 5px; }
#intention-root .int-stat-value { color: #9aa0ac; font-weight: 600; }
#intention-root .int-stat-label { color: #545863; }

@keyframes int-fade-in {
  from { opacity: 0; transform: translateY(5px); }
  to { opacity: 1; transform: translateY(0); }
}

#intention-badge {
  all: initial;
  position: fixed;
  top: 14px;
  right: 14px;
  z-index: 2147483647;
  background: #11141a;
  color: #e7e7ea;
  padding: 7px 13px;
  border-radius: 8px;
  font-family: 'Arvo', Georgia, 'Times New Roman', serif;
  font-size: 13px;
  font-weight: 500;
  box-shadow: 0 2px 14px rgba(0, 0, 0, 0.45);
  border: 1px solid rgba(255, 255, 255, 0.1);
  pointer-events: auto;
}

#intention-badge-finish {
  all: unset;
  margin-left: 10px;
  padding: 2px 8px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.02em;
  color: #0f1115;
  background: #e7e7ea;
  border-radius: 5px;
  cursor: pointer;
}

#intention-badge-finish:hover { background: #ffffff; }
`;

function injectOverlayStyle() {
  const styleId = "intention-style";
  if (!document.getElementById(styleId)) {
    const styleEl = document.createElement("style");
    styleEl.id = styleId;
    styleEl.textContent = OVERLAY_CSS;
    (document.body || document.head || document.documentElement).appendChild(
      styleEl,
    );
  }

  // Inject Arvo (self-hosted) so the overlay font works regardless of the host
  // page's CSP — a remote Google Fonts <link> gets blocked on many sites.
  if (!document.getElementById("intention-font")) {
    const f = (name) => chrome.runtime.getURL("fonts/" + name);
    const fontStyle = document.createElement("style");
    fontStyle.id = "intention-font";
    fontStyle.textContent = `
      @font-face { font-family:'Arvo'; font-style:normal; font-weight:400; font-display:swap; src:url("${f("Arvo-Regular.woff2")}") format("woff2"); }
      @font-face { font-family:'Arvo'; font-style:normal; font-weight:700; font-display:swap; src:url("${f("Arvo-Bold.woff2")}") format("woff2"); }
      @font-face { font-family:'Arvo'; font-style:italic; font-weight:400; font-display:swap; src:url("${f("Arvo-Italic.woff2")}") format("woff2"); }
      @font-face { font-family:'Arvo'; font-style:italic; font-weight:700; font-display:swap; src:url("${f("Arvo-BoldItalic.woff2")}") format("woff2"); }
    `;
    (document.head || document.documentElement).appendChild(fontStyle);
  }
}

let currentSession = null;
let matchedDomain = null;
let handled = false;

function showGate(why) {
  if (handled) return;
  handled = true;
  console.log(INT_LOG, "showGate ->", why);
  try {
    ensureBodyAndStop();
    injectOverlayStyle();
    renderChatUI({
      mode: "gate",
      domain: matchedDomain || window.location.hostname,
    });
  } catch (e) {
    console.error(INT_LOG, "failed to render gate:", e);
  }
}

function runCheck() {
  try {
    const host = window.location.hostname;
    chrome.runtime.sendMessage(
      { action: "checkPageMatch", host },
      (response) => {
        if (chrome.runtime.lastError) {
          console.warn(
            INT_LOG,
            "checkPageMatch lastError:",
            chrome.runtime.lastError.message,
          );
          return;
        }
        console.log(INT_LOG, "checkPageMatch response", response);

        if (!response) {
          return;
        }

        if (!response.setupComplete) {
          if (handled) return;
          handled = true;
          try {
            ensureBodyAndStop();
            injectOverlayStyle();
            renderSetupNeededUI();
          } catch (e) {
            console.error(INT_LOG, "failed to render setup needed UI:", e);
          }
          return;
        }

        if (!response.isBlocked) {
          return;
        }

        matchedDomain = response.matchedDomain;

        if (response.session) {
          if (handled) return;
          handled = true;
          currentSession = response.session;
          runWhenBodyExists(() => {
            try {
              injectOverlayStyle();
              renderStatusBadge(response.session);
            } catch (e) {
              console.error(INT_LOG, "failed to render status badge:", e);
            } finally {
              setupInterruptionListener();
            }
          });
        } else {
          showGate("no active session (fail-safe)");
        }
      },
    );
  } catch (e) {
    console.warn(INT_LOG, "sendMessage threw synchronously:", e);
  }
}

if (
  typeof document.visibilityState !== "undefined" &&
  (document.visibilityState === "prerender" ||
    document.visibilityState === "hidden")
) {
  const onVisibilityChange = () => {
    if (document.visibilityState === "visible") {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      runCheck();
    }
  };
  document.addEventListener("visibilitychange", onVisibilityChange);
} else {
  runCheck();
}

function ensureBodyAndStop() {
  window.stop();
  document.documentElement.style.overflow = "hidden";
  if (!document.body) {
    const body = document.createElement("body");
    document.documentElement.appendChild(body);
  } else {
    document.body.innerHTML = "";
  }
  document.body.style.overflow = "hidden";
}

function runWhenBodyExists(callback) {
  if (document.body) {
    callback();
  } else {
    const observer = new MutationObserver((mutations, obs) => {
      if (document.body) {
        obs.disconnect();
        callback();
      }
    });
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
  }
}

function renderSetupNeededUI() {
  const root = document.createElement("div");
  root.id = "intention-root";
  root.innerHTML = `
    <div class="int-column">
      <h1>Intention</h1>
      <p class="int-subtitle">Finish setup to enable your AI coach.</p>
      <button id="int-open-options">Open settings</button>
    </div>
  `;
  document.body.appendChild(root);
  document
    .getElementById("int-open-options")
    .addEventListener("click", () => {
      chrome.runtime.sendMessage({ action: "openOptions" });
    });
}

function renderChatUI({ mode, domain }) {
  if (document.getElementById("intention-root")) {
    document.getElementById("intention-root").remove();
  }
  const seed =
    mode === "gate"
      ? `Hey. I see you've opened ${domain}. What's going on — what are you hoping to get out of it?`
      : `Time check. Your time on ${domain} is up. Did you get what you came for?`;

  const subtitle =
    mode === "gate"
      ? `${domain} — let's check in before you go through`
      : `${domain} — your time is up`;

  const root = document.createElement("div");
  root.id = "intention-root";
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
  document.body.appendChild(root);

  const messagesEl = document.getElementById("int-messages");
  const inputEl = document.getElementById("int-input");
  const sendBtn = document.getElementById("int-send");
  const closeBtn = document.getElementById("int-close");

  addMessage(messagesEl, "assistant", seed);

  // Fetch stats and render stats row
  try {
    chrome.runtime.sendMessage(
      { action: "getStatsForDomain", domain },
      (stats) => {
        if (chrome.runtime.lastError) {
          console.warn(
            INT_LOG,
            "getStatsForDomain lastError:",
            chrome.runtime.lastError.message,
          );
          return;
        }
        if (stats) {
          const statsRow = document.getElementById("int-stats-row");
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
            statsRow.style.display = "flex";
          }
        }
      },
    );
  } catch (e) {
    console.warn(INT_LOG, "getStatsForDomain message threw:", e);
  }

  let sending = false;

  async function send() {
    const text = inputEl.value.trim();
    if (!text || sending) return;
    addMessage(messagesEl, "user", text);
    inputEl.value = "";
    attemptSend(text);
  }

  async function attemptSend(text) {
    sending = true;
    const thinking = addMessage(messagesEl, "assistant", "…", true);

    let resp;
    try {
      resp = await new Promise((resolve) => {
        chrome.runtime.sendMessage(
          {
            action: "chat",
            mode,
            domain,
            userMessage: text,
          },
          resolve,
        );
      });
    } catch (e) {
      thinking.remove();
      sending = false;
      showRetryableError(messagesEl, "[no response — background worker may be offline]", text);
      return;
    }

    if (!resp) {
      thinking.remove();
      sending = false;
      showRetryableError(messagesEl, "[no response — background worker may be offline]", text);
      return;
    }
    if (resp.error) {
      thinking.remove();
      sending = false;
      const message = resp.networkError ? "Can't reach the coach — check your connection." : `[error: ${resp.error}]`;
      showRetryableError(messagesEl, message, text);
      return;
    }
    // Reuse the "…" placeholder and reveal the reply gradually so it reads
    // as if the coach is speaking, rather than snapping in all at once.
    thinking.classList.remove("int-thinking");
    typeMessage(
      thinking,
      messagesEl,
      resp.assistantText || "(no reply)",
      () => {
        sending = false;
        if (resp.grantedSession) {
          setTimeout(() => window.location.reload(), 2200);
        }
      },
    );
  }

  function showRetryableError(container, message, text) {
    const errorEl = addMessage(container, "assistant", message);
    addRetryButton(container, () => {
      errorEl.remove();
      attemptSend(text);
    });
  }

  function addRetryButton(container, onRetry) {
    const row = document.createElement("div");
    row.className = "int-retry-row";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "int-retry-btn";
    btn.textContent = "Try again";
    btn.addEventListener("click", () => {
      row.remove();
      onRetry();
    });
    row.appendChild(btn);
    container.appendChild(row);
    container.scrollTop = container.scrollHeight;
    return row;
  }

  sendBtn.addEventListener("click", send);
  inputEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter") send();
  });
  closeBtn.addEventListener("click", () => {
    chrome.runtime.sendMessage({ action: "endSession", reason: "fulfilled" });
    window.close();
  });
  inputEl.focus();
}

function addMessage(container, role, text, isThinking) {
  const div = document.createElement("div");
  div.className =
    `int-msg int-msg-${role}` + (isThinking ? " int-thinking" : "");
  div.textContent = text;
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
  return div;
}

// Reveal `text` into `el` a few characters at a time. Clicking anywhere skips
// to the full text. `onDone` fires exactly once when the reveal completes.
function typeMessage(el, container, text, onDone) {
  el.textContent = "";
  let i = 0;
  let finished = false;
  const step = Math.max(1, Math.ceil(text.length / 140));

  function finish() {
    if (finished) return;
    finished = true;
    clearInterval(timer);
    el.textContent = text;
    if (container) container.scrollTop = container.scrollHeight;
    document.removeEventListener("click", skip, true);
    if (onDone) onDone();
  }
  function skip() {
    finish();
  }

  const timer = setInterval(() => {
    i += step;
    el.textContent = text.slice(0, i);
    if (container) container.scrollTop = container.scrollHeight;
    if (i >= text.length) finish();
  }, 18);

  document.addEventListener("click", skip, true);
}

function renderStatusBadge(session) {
  const badge = document.createElement("div");
  badge.id = "intention-badge";

  const timeEl = document.createElement("span");
  timeEl.id = "intention-badge-time";
  badge.appendChild(timeEl);

  const finishBtn = document.createElement("button");
  finishBtn.id = "intention-badge-finish";
  finishBtn.type = "button";
  finishBtn.textContent = "Finished";
  badge.appendChild(finishBtn);

  function update() {
    // Count UP from when the session started — show elapsed time, not remaining.
    const totalSec = Math.max(
      0,
      Math.round((Date.now() - session.startTime) / 1000),
    );
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    const timeStr = `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
    timeEl.textContent = `⏱ ${timeStr}${session.reason ? ' · "' + session.reason + '"' : ""}`;
  }
  update();
  const intervalId = setInterval(update, 1000);
  document.body.appendChild(badge);

  finishBtn.addEventListener("click", () => {
    chrome.runtime.sendMessage({ action: "endSession", reason: "fulfilled" });
    clearInterval(intervalId);
    observer.disconnect();
    badge.remove();
  });

  // SPA sites (Twitter, YouTube, …) re-render <body> and can drop our node.
  // Re-attach it whenever it goes missing so the timer stays visible.
  const observer = new MutationObserver(() => {
    if (!document.body.contains(badge)) document.body.appendChild(badge);
  });
  observer.observe(document.body, { childList: true });
}

function setupInterruptionListener() {
  chrome.runtime.onMessage.addListener((message) => {
    if (message.action === "showCheckin") {
      if (!document.getElementById("intention-root")) {
        renderChatUI({
          mode: "checkin",
          domain:
            currentSession?.domain || matchedDomain || window.location.hostname,
        });
      }
    }
  });
}
