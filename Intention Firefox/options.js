async function loadEnv() {
  try {
    const res = await fetch(chrome.runtime.getURL('env.txt'));
    if (!res.ok) return {};
    const text = await res.text();
    const env = {};
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const index = trimmed.indexOf('=');
      if (index !== -1) {
        const key = trimmed.substring(0, index).trim();
        const value = trimmed.substring(index + 1).trim().replace(/^["']|["']$/g, '');
        env[key] = value;
      }
    }
    return env;
  } catch (e) {
    return {};
  }
}

function sendBg(msg) {
  return new Promise(resolve => chrome.runtime.sendMessage(msg, resolve));
}

async function getConfig() {
  return sendBg({ action: 'getConfig' });
}

document.addEventListener('DOMContentLoaded', async () => {
  populateProviderDropdowns();
  const state = await getConfig();
  if (state?.setupComplete) showSettingsView(state);
  else showSetupView();
});

function populateProviderDropdowns() {
  for (const id of ['provider-select', 'provider-select-2']) {
    const sel = document.getElementById(id);
    if (!sel) continue;
    sel.innerHTML = '';
    for (const [key, cfg] of Object.entries(PROVIDERS)) {
      const opt = document.createElement('option');
      opt.value = key;
      opt.textContent = cfg.label;
      sel.appendChild(opt);
    }
  }
}

let setupBlockedDomains = [];
let setupDomainLimits = {};

function showSetupView() {
  document.getElementById('setup-view').hidden = false;
  document.getElementById('settings-view').hidden = true;

  const providerSel = document.getElementById('provider-select');
  const modelInput = document.getElementById('model-input');
  const apiKeyInput = document.getElementById('api-key-input');

  const syncPlaceholder = () => {
    const p = PROVIDERS[providerSel.value];
    modelInput.placeholder = p ? p.modelPlaceholder : '';
  };

  let env = {};
  const syncEnvFields = () => {
    const provider = providerSel.value;
    const providerKey = `${provider.toUpperCase()}_API_KEY`;
    const modelKey = `${provider.toUpperCase()}_MODEL`;

    const apiKey = env[providerKey] || env.API_KEY || '';
    if (apiKey) apiKeyInput.value = apiKey;
    else apiKeyInput.value = '';

    const model = env[modelKey] || env.DEFAULT_MODEL || '';
    if (model) modelInput.value = model;
    else modelInput.value = '';
  };

  providerSel.addEventListener('change', () => {
    syncPlaceholder();
    syncEnvFields();
  });
  syncPlaceholder();

  loadEnv().then(parsedEnv => {
    env = parsedEnv;
    if (env.DEFAULT_PROVIDER && PROVIDERS[env.DEFAULT_PROVIDER]) {
      providerSel.value = env.DEFAULT_PROVIDER;
      syncPlaceholder();
    }
    syncEnvFields();
  });

  const addBtn = document.getElementById('setup-add-website-btn');
  const webInput = document.getElementById('setup-website-input');
  const limitInput = document.getElementById('setup-website-limit');
  const saveBtn = document.getElementById('setup-save-btn');

  const addDomain = () => {
    const raw = webInput.value.trim().toLowerCase();
    if (!raw) return;
    const domain = raw.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
    const limitVal = parseInt(limitInput.value, 10);
    const limit = isNaN(limitVal) ? 30 : limitVal;

    if (domain && !setupBlockedDomains.includes(domain)) {
      setupBlockedDomains.push(domain);
      setupDomainLimits[domain] = {
        maxGrants: 3,
        maxMinutes: limit
      };
      renderSetupDomains();
      webInput.value = '';
      limitInput.value = '30';
    }
  };

  addBtn.onclick = addDomain;
  webInput.onkeydown = e => { if (e.key === 'Enter') addDomain(); };
  limitInput.onkeydown = e => { if (e.key === 'Enter') addDomain(); };

  saveBtn.onclick = async () => {
    const provider = providerSel.value;
    const apiKey = apiKeyInput.value.trim();
    const model = modelInput.value.trim() || PROVIDERS[provider].defaultModel;

    if (!provider || !apiKey) {
      setStatus('setup-status', 'Choose a provider and enter an API key.');
      return;
    }

    const projectsAns = document.getElementById('setup-projects-input').value.trim();
    const reasonsAns = document.getElementById('setup-reasons-input').value.trim();

    // Create user context
    const userContext = `Projects I could be working on instead:
${projectsAns || '(not configured)'}

Why I want to stop using these sites so much:
${reasonsAns || '(not configured)'}`;

    // Build domain limits object
    const domainLimits = {};
    for (const d of setupBlockedDomains) {
      domainLimits[d] = setupDomainLimits[d] || {
        maxGrants: 3,
        maxMinutes: 30
      };
    }

    setStatus('setup-status', 'Saving setup...', 'info');

    // Save and finalize
    await sendBg({
      action: 'saveSetup',
      config: {
        provider,
        apiKey,
        model,
        userContext,
        contextProjects: projectsAns,
        contextReasons: reasonsAns,
        blockedDomains: setupBlockedDomains,
        domainLimits
      }
    });

    location.reload();
  };
}

function renderSetupDomains() {
  const list = document.getElementById('setup-websites-list');
  list.innerHTML = '';
  for (const d of setupBlockedDomains) {
    const li = document.createElement('li');
    
    const infoContainer = document.createElement('div');
    infoContainer.className = 'domain-info';
    
    const span = document.createElement('span');
    span.textContent = d;
    span.className = 'domain-name';
    infoContainer.appendChild(span);

    const limitInfo = setupDomainLimits[d] || { maxGrants: 3, maxMinutes: 30 };
    
    const limitSpan = document.createElement('span');
    limitSpan.className = 'domain-limit-badge';
    limitSpan.appendChild(document.createTextNode('Limit: '));

    const inlineInput = document.createElement('input');
    inlineInput.type = 'number';
    inlineInput.min = '1';
    inlineInput.className = 'inline-limit-input';
    inlineInput.value = limitInfo.maxMinutes;
    inlineInput.addEventListener('change', (e) => {
      const val = parseInt(e.target.value, 10);
      if (!isNaN(val) && val > 0) {
        if (!setupDomainLimits[d]) {
          setupDomainLimits[d] = { maxGrants: 3 };
        }
        setupDomainLimits[d].maxMinutes = val;
      }
    });

    limitSpan.appendChild(inlineInput);
    limitSpan.appendChild(document.createTextNode(' min/day'));
    infoContainer.appendChild(limitSpan);
    
    li.appendChild(infoContainer);
    
    const btn = document.createElement('button');
    btn.textContent = 'Remove';
    btn.className = 'delete-btn';
    btn.addEventListener('click', () => {
      setupBlockedDomains = setupBlockedDomains.filter(x => x !== d);
      delete setupDomainLimits[d];
      renderSetupDomains();
    });
    li.appendChild(btn);
    list.appendChild(li);
  }
}


async function showSettingsView(state) {
  document.getElementById('setup-view').hidden = true;
  document.getElementById('settings-view').hidden = false;

  document.getElementById('context-display').textContent =
    state.userContext || '(no context yet — talk to your coach to create one)';

  // Configurable coach instructions (system prompt) + the two settings questions.
  const instructionsInput = document.getElementById('coach-instructions-input');
  const projectsInput = document.getElementById('settings-projects-input');
  const reasonsInput = document.getElementById('settings-reasons-input');
  instructionsInput.value = state.coachInstructions || '';
  projectsInput.value = state.contextProjects || '';
  reasonsInput.value = state.contextReasons || '';

  document.getElementById('save-prompt-btn').addEventListener('click', async () => {
    await sendBg({
      action: 'saveSettings',
      config: {
        coachInstructions: instructionsInput.value.trim(),
        contextProjects: projectsInput.value.trim(),
        contextReasons: reasonsInput.value.trim()
      }
    });
    setStatus('prompt-status', 'Saved.', 'success');
  });

  document.getElementById('reset-prompt-btn').addEventListener('click', async () => {
    instructionsInput.value = state.defaultCoachInstructions || '';
    await sendBg({ action: 'saveSettings', config: { coachInstructions: '' } });
    const fresh = await getConfig();
    instructionsInput.value = fresh.coachInstructions || '';
    setStatus('prompt-status', 'Reset to default.', 'success');
  });

  const provSel = document.getElementById('provider-select-2');
  const modelInput = document.getElementById('model-input-2');
  const keyInput = document.getElementById('api-key-input-2');
  provSel.value = state.provider || 'anthropic';
  modelInput.value = state.model || '';
  keyInput.value = state.apiKey || '';

  const syncPlaceholder = () => {
    const p = PROVIDERS[provSel.value];
    modelInput.placeholder = p ? p.modelPlaceholder : '';
  };

  const syncEnvSettings = (parsedEnv) => {
    const provider = provSel.value;
    const providerKey = `${provider.toUpperCase()}_API_KEY`;
    const modelKey = `${provider.toUpperCase()}_MODEL`;

    if (!keyInput.value && (parsedEnv[providerKey] || parsedEnv.API_KEY)) {
      keyInput.value = parsedEnv[providerKey] || parsedEnv.API_KEY;
    }
    if (!modelInput.value && (parsedEnv[modelKey] || parsedEnv.DEFAULT_MODEL)) {
      modelInput.value = parsedEnv[modelKey] || parsedEnv.DEFAULT_MODEL;
    }
  };

  provSel.addEventListener('change', () => {
    syncPlaceholder();
    loadEnv().then(syncEnvSettings);
  });
  syncPlaceholder();
  loadEnv().then(syncEnvSettings);

  document.getElementById('save-provider-btn').addEventListener('click', async () => {
    const provider = provSel.value;
    const model = modelInput.value.trim() || PROVIDERS[provider].defaultModel;
    const apiKey = keyInput.value.trim();
    await sendBg({ action: 'saveSettings', config: { provider, model, apiKey } });
    setStatus('provider-status', 'Saved.', 'success');
  });

  renderDomains(state.blockedDomains || [], state.domainLimits || {});
  document.getElementById('add-btn').addEventListener('click', addDomain);
  document.getElementById('domain-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') addDomain();
  });
  document.getElementById('domain-limit-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') addDomain();
  });

  const summary = await sendBg({ action: 'getStatsSummary' });
  renderStats(summary);

  document.getElementById('open-coach-btn').addEventListener('click', openCoachModal);
  document.getElementById('close-coach-btn').addEventListener('click', closeCoachModal);
}

async function addDomain() {
  const input = document.getElementById('domain-input');
  const limitInput = document.getElementById('domain-limit-input');
  const raw = input.value.trim().toLowerCase();
  if (!raw) return;
  
  const limitVal = parseInt(limitInput.value, 10);
  const limit = isNaN(limitVal) ? 30 : limitVal;
  
  const domain = raw.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
  const state = await getConfig();
  const domains = state.blockedDomains || [];
  const limits = state.domainLimits || {};
  if (!domains.includes(domain)) {
    domains.push(domain);
    limits[domain] = { maxGrants: 3, maxMinutes: limit };
    await sendBg({ action: 'saveSettings', config: { blockedDomains: domains, domainLimits: limits } });
    renderDomains(domains, limits);
    input.value = '';
    limitInput.value = '30';
  }
}

async function removeDomain(d) {
  const state = await getConfig();
  const domains = (state.blockedDomains || []).filter(x => x !== d);
  const limits = state.domainLimits || {};
  if (limits[d]) delete limits[d];
  await sendBg({ action: 'saveSettings', config: { blockedDomains: domains, domainLimits: limits } });
  renderDomains(domains, limits);
}

function renderDomains(domains, limits = {}) {
  const list = document.getElementById('domain-list');
  list.innerHTML = '';
  for (const d of domains) {
    const li = document.createElement('li');
    
    const infoContainer = document.createElement('div');
    infoContainer.className = 'domain-info';
    
    const span = document.createElement('span');
    span.textContent = d;
    span.className = 'domain-name';
    infoContainer.appendChild(span);
    
    const limitInfo = limits[d] || { maxGrants: 3, maxMinutes: 30 };
    const mins = limitInfo.maxMinutes !== undefined ? limitInfo.maxMinutes : (limitInfo.max_minutes_per_day || 30);
    
    const limitSpan = document.createElement('span');
    limitSpan.className = 'domain-limit-badge';
    limitSpan.appendChild(document.createTextNode('Limit: '));

    const inlineInput = document.createElement('input');
    inlineInput.type = 'number';
    inlineInput.min = '1';
    inlineInput.className = 'inline-limit-input';
    inlineInput.value = mins > 0 ? mins : 30;
    inlineInput.addEventListener('change', async (e) => {
      const val = parseInt(e.target.value, 10);
      if (!isNaN(val) && val > 0) {
        const state = await getConfig();
        const currentLimits = state.domainLimits || {};
        if (!currentLimits[d]) {
          currentLimits[d] = { maxGrants: 3 };
        }
        currentLimits[d].maxMinutes = val;
        await sendBg({ action: 'saveSettings', config: { domainLimits: currentLimits } });
      }
    });

    limitSpan.appendChild(inlineInput);
    limitSpan.appendChild(document.createTextNode(' min/day'));
    infoContainer.appendChild(limitSpan);
    
    li.appendChild(infoContainer);
    
    const btn = document.createElement('button');
    btn.textContent = 'Remove';
    btn.className = 'delete-btn';
    btn.addEventListener('click', () => removeDomain(d));
    li.appendChild(btn);
    list.appendChild(li);
  }
}

function renderStats(summary) {
  const el = document.getElementById('stats-display');
  if (!summary || !summary.minutesToday) {
    el.innerHTML = '<p class="muted">No time on blocked sites yet today. Nice.</p>';
    return;
  }
  const perSite = Object.entries(summary.perSiteToday || {})
    .sort((a, b) => b[1] - a[1])
    .map(([d, m]) => `${d}: ${Math.round(m)}m`)
    .join(' · ');
  el.innerHTML = `
    <p><strong>${summary.minutesToday} min</strong> on blocked sites today.</p>
    <p class="muted">${perSite}</p>
    <p class="muted">Past 7 days: <strong>${summary.minutesWeek} min</strong>.</p>
  `;
}

let coachSending = false;

async function openCoachModal() {
  const modal = document.getElementById('coach-modal');
  modal.hidden = false;
  const messagesEl = document.getElementById('coach-messages');
  messagesEl.innerHTML = '';
  addCoachMsg('assistant', "Hey. What would you like me to know about you? Your work, goals, or what you'd like me to help you stay on top of — I'll save an updated version when we've covered enough.");

  const input = document.getElementById('coach-input');
  const send = document.getElementById('coach-send-btn');
  input.value = '';
  input.focus();

  const onSend = async () => {
    const text = input.value.trim();
    if (!text || coachSending) return;
    coachSending = true;
    addCoachMsg('user', text);
    input.value = '';
    const thinking = addCoachMsg('assistant', '…', true);
    const resp = await sendBg({ action: 'chat', mode: 'context', userMessage: text });
    coachSending = false;
    if (!resp) {
      thinking.remove();
      addCoachMsg('assistant', '[no response — background worker may be offline]');
      return;
    }
    if (resp.error) {
      thinking.remove();
      addCoachMsg('assistant', `[error: ${resp.error}]`);
      return;
    }
    thinking.classList.remove('int-thinking');
    typeCoachMsg(thinking, resp.assistantText || '(no reply)');
    if (resp.contextUpdated) {
      addCoachMsg('assistant', `(context saved — ${resp.contextUpdated.diff_summary || 'updated'})`, false, true);
      const state = await getConfig();
      document.getElementById('context-display').textContent = state.userContext || '';
    }
  };
  send.onclick = onSend;
  input.onkeydown = e => { if (e.key === 'Enter') onSend(); };
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

function setStatus(id, text, variant = '') {
  const el = document.getElementById(id);
  el.textContent = text;
  el.className = 'status ' + variant;
  if (text) setTimeout(() => { el.textContent = ''; el.className = 'status'; }, 3000);
}
