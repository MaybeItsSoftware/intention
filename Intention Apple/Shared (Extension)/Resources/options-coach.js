// options-coach.js - the two chats the settings page can open.
//
// The coach modal, where the "about you" context is rewritten by talking
// rather than typing, and the settings gate, where a rule can only be loosened
// by convincing the coach. They are near-identical by design: the same request
// sequencing, the same retry affordance, the same typing animation, a
// different tool on the other end.

let coachSending = false;
// Only the most recent attemptCoachSend's result is allowed to touch the DOM;
// see the matching guard in coaching.js for why.
let coachRequestSeq = 0;

// The modal's old hardcoded greeting, kept as the offline fallback for the
// LLM opener below. No retry row on failure — the input stays live, so the
// user's first message retries naturally through attemptCoachSend.
const COACH_OPENER_FALLBACK = "Hey there. Let's design your coaching context together. To help me support you better, what are you working on right now, and what tend to be your biggest distractions or triggers? I'll save our updated notes as we chat.";

async function openCoachModal() {
  const modal = document.getElementById('coach-modal');
  modal.hidden = false;
  // Invalidate any request still in flight from a previous open, so a late
  // response can't land in this fresh conversation.
  coachRequestSeq++;
  coachSending = false;
  const messagesEl = document.getElementById('coach-messages');
  messagesEl.innerHTML = '';

  const input = document.getElementById('coach-input');
  const send = document.getElementById('coach-send-btn');
  input.value = '';
  input.focus();

  const onSend = async () => {
    const text = input.value.trim();
    if (!text || coachSending) return;
    addCoachMsg('user', text);
    input.value = '';
    attemptCoachSend(text, messagesEl);
  };
  send.onclick = onSend;
  input.onkeydown = e => { if (e.key === 'Enter') onSend(); };

  // These modals are one-shot by design: the transcript is normally deleted
  // on close, but closing the options TAB skips that handler, and the opener
  // below would then stack a fresh marker+greeting onto the orphaned
  // conversation every time the modal reopens. Clear first so each open
  // really starts clean.
  sendBg({ action: 'clearChatHistory', historyKey: 'context' }).then(() => {
    attemptCoachOpen();
  });
}

// attemptCoachSend minus the user bubble: the coach speaks first. No
// userMessage — the background records its own marker turn.
async function attemptCoachOpen() {
  const seq = ++coachRequestSeq;
  coachSending = true;
  const thinking = addCoachMsg('assistant', '…', true);
  let resp;
  try {
    resp = await sendBgChat({ action: 'chat', mode: 'context' });
  } catch (e) {
    if (seq !== coachRequestSeq) return;
    coachSending = false;
    thinking.remove();
    addCoachMsg('assistant', COACH_OPENER_FALLBACK);
    return;
  }
  if (seq !== coachRequestSeq) return;
  coachSending = false;
  if (!resp || resp.error) {
    thinking.remove();
    if (resp && resp.locked) {
      await closeCoachModal();
      await openPaywallModal();
      return;
    }
    addCoachMsg('assistant', COACH_OPENER_FALLBACK);
    return;
  }
  thinking.classList.remove('int-thinking');
  typeCoachMsg(thinking, resp.assistantText || COACH_OPENER_FALLBACK);
  if (resp.systemNote) addCoachMsg('assistant', resp.systemNote, false, true);
}

async function attemptCoachSend(text, messagesEl) {
  const seq = ++coachRequestSeq;
  coachSending = true;
  const thinking = addCoachMsg('assistant', '…', true);
  let resp;
  try {
    resp = await sendBgChat({ action: 'chat', mode: 'context', userMessage: text });
  } catch (e) {
    if (seq !== coachRequestSeq) return;
    coachSending = false;
    thinking.remove();
    const message = e && e.message === 'timeout'
      ? "That's taking too long to answer. Check your connection and try again."
      : '[no response - background worker may be offline]';
    showCoachRetryableError(messagesEl, message, text);
    return;
  }
  if (seq !== coachRequestSeq) return;
  coachSending = false;
  if (!resp) {
    thinking.remove();
    showCoachRetryableError(messagesEl, '[no response - background worker may be offline]', text);
    return;
  }
  if (resp.error) {
    thinking.remove();
    if (resp.locked) {
      await closeCoachModal();
      await openPaywallModal();
      return;
    }
    const message = resp.networkError ? "Can't reach the coach — check your connection." : resp.error;
    showCoachRetryableError(messagesEl, message, text);
    return;
  }
  thinking.classList.remove('int-thinking');
  typeCoachMsg(thinking, resp.assistantText || '(no reply)');
  if (resp.systemNote) addCoachMsg('assistant', resp.systemNote, false, true);
  if (resp.contextUpdated) {
    addCoachMsg('assistant', `(context saved - ${resp.contextUpdated.diff_summary || 'updated'})`, false, true);
    const state = await getConfig();
    renderContextCard(state.userContext);
  }
}

function showCoachRetryableError(messagesEl, message, text) {
  const errorEl = addCoachMsg('assistant', message);
  addRetryButton(messagesEl, () => {
    errorEl.remove();
    attemptCoachSend(text, messagesEl);
  });
}

async function closeCoachModal() {
  document.getElementById('coach-modal').hidden = true;
  await sendBg({ action: 'clearChatHistory', historyKey: 'context' });
}

function addCoachMsg(role, text, isThinking, isSystem) {
  const messagesEl = document.getElementById('coach-messages');
  const div = document.createElement('div');
  div.className = `int-msg int-msg-${role}`
    + (isThinking ? ' int-thinking' : '')
    + (isSystem ? ' int-system' : '');
  div.textContent = text;
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  // Press and hold anything the coach said to report it (report.js). System
  // notes are our own machinery talking, not the model, so they stay out.
  if (role === 'assistant' && !isSystem) attachReportPress(div);
  return div;
}

// Reveal the coach's reply gradually into an existing message element.
function typeCoachMsg(el, text) {
  const messagesEl = document.getElementById('coach-messages');
  el.textContent = '';
  let i = 0;
  const step = Math.max(1, Math.ceil(text.length / 140));
  const timer = setInterval(() => {
    i += step;
    el.textContent = text.slice(0, i);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    if (i >= text.length) {
      clearInterval(timer);
      el.textContent = text;
    }
  }, 18);
}

// ---- Settings-gate modal: user must convince the coach to loosen a rule ----
let gateSending = false;
let gateChange = null;
// Only the most recent attemptGateSend's result is allowed to touch the DOM;
// see the matching guard in coaching.js for why.
let gateRequestSeq = 0;

// Loosening a rule has to be argued with the coach, so it needs the same AI
// access a gate conversation does — without it, show the paywall rather than a
// chat box that can only fail.
async function openGateModal({ changeType, domain, isApp, appLabel, currentValue, newValue, title, subtitle, onApproved }) {
  if (!(await requireAccess())) return;
  gateChange = { changeType, domain, isApp, appLabel, currentValue, newValue, onApproved };
  const modal = document.getElementById('gate-modal');
  modal.hidden = false;
  // Invalidate any request still in flight from a previous open, so a late
  // response can't land in this fresh conversation.
  gateRequestSeq++;
  document.getElementById('gate-title').textContent = title || 'Convince your coach';
  document.getElementById('gate-subtitle').textContent = subtitle || '';

  const messagesEl = document.getElementById('gate-messages');
  messagesEl.innerHTML = '';
  gateSending = false;

  const input = document.getElementById('gate-input');
  const send = document.getElementById('gate-send-btn');
  input.value = '';
  input.focus();

  const onSend = async () => {
    const text = input.value.trim();
    if (!text || gateSending) return;
    addGateMsg('user', text);
    input.value = '';
    attemptGateSend(text, messagesEl);
  };
  send.onclick = onSend;
  input.onkeydown = e => { if (e.key === 'Enter') onSend(); };
  document.getElementById('gate-close-btn').onclick = closeGateModal;

  // Same reason as openCoachModal: closing the options tab skips
  // closeGateModal's transcript delete, so clear before the opener rather
  // than stacking onto an orphaned conversation.
  sendBg({ action: 'clearChatHistory', historyKey: `settings_gate:${changeType}:${domain || 'all'}` }).then(() => {
    attemptGateOpen();
  });
}

// The modal's old hardcoded openers, kept as the offline fallback per change
// type. No retry row on failure — the input stays live, so the user's first
// message retries naturally through attemptGateSend.
//
// A map rather than the chain of ternaries this was, because the chain's tail
// was `disable_all`'s line: every change type it didn't know about opened by
// telling the user they were turning off all blocking, which they weren't.
const GATE_OPENER_FALLBACKS = {
  remove: (d) => `You want to remove ${d} from your blocklist. You set this rule for a reason. Tell me what's changed.`,
  remove_app: (d) => `You want to remove ${d} from your blocklist. You set this rule for a reason. Tell me what's changed.`,
  increase_limit: (d) => `You want more time on ${d}. Why? What's driving this right now?`,
  increase_app_limit: (d) => `You want more time on ${d}. Why? What's driving this right now?`,
  increase_loose_window: (d) => `You want me to go easy on you for longer on ${d}. What's behind that?`,
  increase_app_loose_window: (d) => `You want me to go easy on you for longer on ${d}. What's behind that?`,
  edit_site_purpose: (d) => `You want to change what you told me ${d} is for. Talk me through what's different now.`,
  edit_site_legitimate: (d) => `You want to change what counts as a legitimate reason to open ${d}. Tell me why the old wording is wrong.`,
  disable_all: () => `You want to turn off all blocking. That's a big move. Talk to me about what's going on.`
};

function gateOpenerFallback(changeType, domain) {
  const fallback = GATE_OPENER_FALLBACKS[changeType];
  return fallback
    ? fallback(domain)
    : `You want to loosen your rules on ${domain}. Tell me what's driving that right now.`;
}

// attemptGateSend minus the user bubble: the coach speaks first. No
// userMessage — the background records its own marker turn.
async function attemptGateOpen() {
  const seq = ++gateRequestSeq;
  gateSending = true;
  // gateChange can be nulled by closeGateModal while the request is in
  // flight, so hold on to the fields the fallback needs.
  const { changeType, domain, isApp, appLabel, currentValue, newValue } = gateChange;
  const thinking = addGateMsg('assistant', '…', true);
  let resp;
  try {
    resp = await sendBgChat({
      action: 'chat',
      mode: 'settings_gate',
      domain,
      isApp,
      appLabel,
      changeType,
      currentValue,
      newValue
    });
  } catch (e) {
    if (seq !== gateRequestSeq) return;
    gateSending = false;
    thinking.remove();
    addGateMsg('assistant', gateOpenerFallback(changeType, domain));
    return;
  }
  if (seq !== gateRequestSeq) return;
  gateSending = false;
  if (!resp || resp.error) {
    thinking.remove();
    if (resp && resp.locked) {
      await closeGateModal();
      await openPaywallModal();
      return;
    }
    addGateMsg('assistant', gateOpenerFallback(changeType, domain));
    return;
  }
  thinking.classList.remove('int-thinking');
  typeGateMsg(thinking, resp.assistantText || gateOpenerFallback(changeType, domain));
  if (resp.systemNote) addGateMsg('assistant', resp.systemNote, false, true);
}

async function attemptGateSend(text, messagesEl) {
  const seq = ++gateRequestSeq;
  gateSending = true;
  const thinking = addGateMsg('assistant', '…', true);
  let resp;
  try {
    resp = await sendBgChat({
      action: 'chat',
      mode: 'settings_gate',
      domain: gateChange.domain,
      isApp: gateChange.isApp,
      appLabel: gateChange.appLabel,
      changeType: gateChange.changeType,
      currentValue: gateChange.currentValue,
      newValue: gateChange.newValue,
      userMessage: text
    });
  } catch (e) {
    if (seq !== gateRequestSeq) return;
    gateSending = false;
    thinking.remove();
    const message = e && e.message === 'timeout'
      ? "That's taking too long to answer. Check your connection and try again."
      : '[no response - background worker may be offline]';
    showGateRetryableError(messagesEl, message, text);
    return;
  }
  if (seq !== gateRequestSeq) return;
  gateSending = false;
  if (!resp) {
    thinking.remove();
    showGateRetryableError(messagesEl, '[no response - background worker may be offline]', text);
    return;
  }
  if (resp.error) {
    thinking.remove();
    if (resp.locked) {
      await closeGateModal();
      await openPaywallModal();
      return;
    }
    const message = resp.networkError ? "Can't reach the coach — check your connection." : resp.error;
    showGateRetryableError(messagesEl, message, text);
    return;
  }
  thinking.classList.remove('int-thinking');
  typeGateMsg(thinking, resp.assistantText || '(no reply)');
  if (resp.systemNote) addGateMsg('assistant', resp.systemNote, false, true);
  if (resp.approved) {
    addGateMsg('assistant', '(approved - applying your change)', false, true);
    const cb = gateChange.onApproved;
    setTimeout(async () => {
      if (cb) await cb();
      closeGateModal();
    }, 900);
  }
}

function showGateRetryableError(messagesEl, message, text) {
  const errorEl = addGateMsg('assistant', message);
  addRetryButton(messagesEl, () => {
    errorEl.remove();
    attemptGateSend(text, messagesEl);
  });
}

async function closeGateModal() {
  const modal = document.getElementById('gate-modal');
  modal.hidden = true;
  if (gateChange) {
    const historyKey = `settings_gate:${gateChange.changeType}:${gateChange.domain || 'all'}`;
    await sendBg({ action: 'clearChatHistory', historyKey });
  }
  gateChange = null;
}

function addGateMsg(role, text, isThinking, isSystem) {
  const messagesEl = document.getElementById('gate-messages');
  const div = document.createElement('div');
  div.className = `int-msg int-msg-${role}`
    + (isThinking ? ' int-thinking' : '')
    + (isSystem ? ' int-system' : '');
  div.textContent = text;
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  if (role === 'assistant' && !isSystem) attachReportPress(div);
  return div;
}

function typeGateMsg(el, text) {
  const messagesEl = document.getElementById('gate-messages');
  el.textContent = '';
  let i = 0;
  const step = Math.max(1, Math.ceil(text.length / 140));
  const timer = setInterval(() => {
    i += step;
    el.textContent = text.slice(0, i);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    if (i >= text.length) {
      clearInterval(timer);
      el.textContent = text;
    }
  }, 18);
}
