// The built-in coach. Requests go to Intention's own backend, which holds the
// LLM provider key and is paid for through the platform's in-app purchase
// system; the client authenticates with the entitlement token minted when that
// purchase was verified. No user-supplied key is involved on this path, and it
// is the default everywhere — see resolveAIRoute() in background.js.
const HOSTED_PROVIDER = 'intention';
const DEFAULT_INTENTION_BACKEND_URL = 'https://api.intention.maybeitssoftware.uk';

// A coaching-credit entitlement never expires (the balance is the only
// limit), so the server never sends `expiresAt` and the branch below always
// takes the "active forever" path. The grace window only matters for the
// legacy shape of an entitlement that does carry one (a stored device with a
// skewed clock, or a not-yet-refreshed value from before this) — it's kept
// as a defensive fallback, not something the current flow relies on.
const ENTITLEMENT_GRACE_MS = 24 * 60 * 60 * 1000;

function entitlementIsActive(entitlement) {
  if (!entitlement || !entitlement.active) return false;
  if (!entitlement.expiresAt) return true;
  return Date.now() < Number(entitlement.expiresAt) + ENTITLEMENT_GRACE_MS;
}

const PROVIDERS = {
  intention: {
    label: 'Intention AI',
    hosted: true,
    defaultModel: '',
    models: [],
    modelPlaceholder: ''
  },
  anthropic: {
    label: 'Anthropic (Claude)',
    defaultModel: 'claude-sonnet-5',
    models: ['claude-sonnet-5', 'claude-fable-5', 'claude-opus-4-8', 'claude-haiku-4-5'],
    modelPlaceholder: 'claude-sonnet-5 / claude-fable-5 / claude-opus-4-8'
  },
  openai: {
    label: 'OpenAI',
    defaultModel: 'gpt-4o',
    models: ['gpt-4o', 'gpt-4o-mini', 'o1'],
    modelPlaceholder: 'gpt-4o / gpt-4o-mini / o1'
  },
  groq: {
    label: 'Groq',
    defaultModel: 'llama-3.3-70b-versatile',
    models: ['llama-3.3-70b-versatile'],
    modelPlaceholder: 'llama-3.3-70b-versatile'
  },
  gemini: {
    label: 'Google Gemini',
    defaultModel: 'gemini-2.0-flash',
    models: ['gemini-2.0-flash', 'gemini-1.5-pro'],
    modelPlaceholder: 'gemini-2.0-flash / gemini-1.5-pro'
  }
};

// fetch() rejects with TypeError for network-layer failures (offline, DNS,
// connection refused) consistently across Chromium/Firefox/WebKit; HTTP
// error responses are thrown as plain Error with a status code baked in
// (see callAnthropic/callOpenAICompatible/callGemini below), so the two are
// cleanly distinguishable without inspecting message text in most cases.
function isNetworkError(e) {
  if (!e) return false;
  if (e instanceof TypeError) return true;
  return /failed to fetch|networkerror|load failed|network request failed|internet connection/i.test(e.message || '');
}

async function callLLM({ provider, apiKey, model, system, messages, tools, accessToken, backendUrl }) {
  if (!provider) throw new Error('No provider configured');
  // The hosted path authenticates with the entitlement token instead of a key.
  if (provider === HOSTED_PROVIDER) {
    return callIntentionHosted({ accessToken, backendUrl, model, system, messages, tools });
  }
  if (!apiKey) throw new Error('No API key configured');
  const resolvedModel = model || PROVIDERS[provider]?.defaultModel;
  if (!resolvedModel) throw new Error(`Unknown provider: ${provider}`);

  switch (provider) {
    case 'anthropic':
      return callAnthropic({ apiKey, model: resolvedModel, system, messages, tools });
    case 'openai':
      return callOpenAICompatible({ baseUrl: 'https://api.openai.com/v1', apiKey, model: resolvedModel, system, messages, tools });
    case 'groq':
      return callOpenAICompatible({ baseUrl: 'https://api.groq.com/openai/v1', apiKey, model: resolvedModel, system, messages, tools });
    case 'gemini':
      return callGemini({ apiKey, model: resolvedModel, system, messages, tools });
    default:
      throw new Error(`Unknown provider: ${provider}`);
  }
}

// Talks to Intention's own backend, which deducts the actual cost from the
// coaching-credit balance and forwards the conversation to the LLM provider
// under Intention's key. `text`/`toolCalls` match the shape every adapter
// below returns, so nothing downstream knows which route it came from;
// `balanceMicros`/`balanceGbp` are hosted-route-only, for the UI to show the
// remaining balance after each message.
//
// Entitlement problems are surfaced with a `code` so background.js can mark the
// stored entitlement stale and put the paywall back up, rather than showing the
// user a bare HTTP error.
async function callIntentionHosted({ accessToken, backendUrl, model, system, messages, tools }) {
  if (!accessToken) {
    const err = new Error('No coaching credit');
    err.code = 'entitlement_invalid';
    throw err;
  }
  const base = (backendUrl || DEFAULT_INTENTION_BACKEND_URL).replace(/\/+$/, '');
  const body = {
    system,
    messages: messages.map(m => ({ role: m.role, content: m.content }))
  };
  if (model) body.model = model;
  if (tools && tools.length) {
    body.tools = tools.map(t => ({ name: t.name, description: t.description, schema: t.schema }));
  }
  const res = await fetch(`${base}/v1/chat`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'authorization': `Bearer ${accessToken}`
    },
    body: JSON.stringify(body)
  });
  let data = null;
  try { data = await res.json(); } catch (e) {}
  if (!res.ok) {
    const code = (data && data.code) || (res.status === 401 || res.status === 402 ? 'entitlement_invalid' : 'backend_error');
    const err = new Error(HOSTED_ERROR_MESSAGES[code] || (data && data.error) || `Intention AI ${res.status}`);
    err.code = code;
    throw err;
  }
  return {
    text: (data && data.text) || '',
    toolCalls: (data && data.toolCalls) || [],
    balanceMicros: Number((data && data.balanceMicros) || 0),
    balanceGbp: Number((data && data.balanceGbp) || 0)
  };
}

const HOSTED_ERROR_MESSAGES = {
  entitlement_invalid: 'Your coaching credit could not be verified. Open Settings to restore it.',
  entitlement_expired: 'Your access has expired. Open Settings to restore it.',
  balance_exhausted: "You're out of coaching credit. Buy more to keep talking to your coach."
};

// Whether an error should send the user back to the paywall rather than just
// offering a retry. balance_exhausted must behave the same as an invalid
// token — running out of credit is exactly as much of a "go buy more" state
// as an unverifiable purchase, not just another chat error.
function isEntitlementError(e) {
  return !!e && (
    e.code === 'entitlement_invalid' ||
    e.code === 'entitlement_expired' ||
    e.code === 'balance_exhausted'
  );
}

async function callAnthropic({ apiKey, model, system, messages, tools }) {
  const body = {
    model,
    max_tokens: 1024,
    system,
    messages: messages.map(m => ({ role: m.role, content: m.content }))
  };
  if (tools && tools.length) {
    body.tools = tools.map(t => ({
      name: t.name,
      description: t.description,
      input_schema: t.schema
    }));
  }
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true'
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
  const data = await res.json();
  let text = '';
  const toolCalls = [];
  for (const block of data.content || []) {
    if (block.type === 'text') text += block.text;
    else if (block.type === 'tool_use') toolCalls.push({ id: block.id, name: block.name, input: block.input });
  }
  return { text, toolCalls };
}

async function callOpenAICompatible({ baseUrl, apiKey, model, system, messages, tools }) {
  const openaiMessages = [];
  if (system) openaiMessages.push({ role: 'system', content: system });
  for (const m of messages) openaiMessages.push({ role: m.role, content: m.content });

  const body = { model, messages: openaiMessages };
  if (tools && tools.length) {
    body.tools = tools.map(t => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.schema }
    }));
  }
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`${baseUrl} ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const msg = data.choices?.[0]?.message || {};
  const text = msg.content || '';
  const toolCalls = (msg.tool_calls || []).map(tc => {
    let parsed = {};
    try { parsed = JSON.parse(tc.function.arguments || '{}'); } catch (e) {}
    return { id: tc.id, name: tc.function.name, input: parsed };
  });
  return { text, toolCalls };
}

async function callGemini({ apiKey, model, system, messages, tools }) {
  const contents = messages.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }]
  }));
  const body = { contents };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  if (tools && tools.length) {
    body.tools = [{
      functionDeclarations: tools.map(t => ({
        name: t.name,
        description: t.description,
        parameters: t.schema
      }))
    }];
  }
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const parts = data.candidates?.[0]?.content?.parts || [];
  let text = '';
  const toolCalls = [];
  for (const part of parts) {
    if (part.text) text += part.text;
    if (part.functionCall) {
      toolCalls.push({
        id: part.functionCall.name,
        name: part.functionCall.name,
        input: part.functionCall.args || {}
      });
    }
  }
  return { text, toolCalls };
}
