// The built-in coach. Requests go to Intention's own backend, which holds the
// LLM provider key and is paid for through the platform's in-app purchase
// system; the client authenticates with the entitlement token minted when that
// purchase was verified. No user-supplied key is involved on this path, and it
// is the default everywhere — see resolveAIRoute() in background.js.
const HOSTED_PROVIDER = 'intention';
const DEFAULT_INTENTION_BACKEND_URL = 'https://api.intention.maybeitssoftware.co.uk';

// Whether this build ships inside an App Store binary: the iOS and macOS apps,
// and the Safari web extension that ships within them.
//
// App Store Review guideline 3.1.1 lets an API key unlock functionality only
// when that key is itself purchasable with In-App Purchase, in this app or in
// the provider's own App Store app. None of Anthropic, OpenAI, Groq or Gemini
// sells one that way, so no carve-out applies and the custom-key route does not
// exist on Apple at all: it is never offered, the settings field is removed
// rather than hidden, and resolveAIRoute() below ignores a key that survived
// from an older install. Hiding the UI alone is what gets rejected twice.
//
// This lives here rather than in billing.js because the background worker has
// to answer the same question and never loads a UI module. It is user-agent
// based rather than bridge based on purpose: window.intentionBilling exists
// only in the app's visible WKWebView, while this must hold in the hidden
// BackgroundJSHost web view and in the Safari extension's own contexts too.
//
// AppleWebKit-without-Chrome covers all of those — including the app's web
// views, whose default user agent carries neither "Safari" nor "Version/" —
// and excludes Chrome, Edge, Firefox and the Android app's Chromium WebView.
const IS_APPLE_BUILD = (() => {
  const ua = (typeof navigator !== 'undefined' && navigator.userAgent) || '';
  return /AppleWebKit/.test(ua) && !/Chrome|Chromium|Android/.test(ua);
})();

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
    // gpt-oss-120b holds the coach's instructions and calls its tools far
    // more reliably than the Llama it replaces as default, and costs less.
    defaultModel: 'openai/gpt-oss-120b',
    models: ['openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'llama-3.3-70b-versatile'],
    modelPlaceholder: 'openai/gpt-oss-120b / openai/gpt-oss-20b'
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
  return /failed to fetch|networkerror|load failed|network request failed|internet connection|timed? ?out|abort/i.test(e.message || e.name || '');
}

const PROVIDER_FETCH_TIMEOUT_MS = 30000;

// AbortController-based timeout so a hung provider connection fails fast
// instead of leaving the chat UI waiting forever. The resulting error's
// message/name match isNetworkError so callers don't need special-casing.
async function fetchWithTimeout(url, options, timeoutMs = PROVIDER_FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (e) {
    if (e.name === 'AbortError') {
      const err = new Error('Request timed out');
      err.code = 'timeout';
      throw err;
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function parseJsonResponse(res, providerLabel) {
  try {
    return await res.json();
  } catch (e) {
    throw new Error(`Invalid response from ${providerLabel}`);
  }
}

// Classifies a non-2xx HTTP response into a stable err.code so downstream
// callers (background.js) can map to a human-readable message without
// parsing provider-specific status text.
async function throwHttpError(res, providerLabel) {
  const text = await res.text();
  let err;
  if (res.status === 401 || res.status === 403) {
    err = new Error(`${providerLabel}: invalid API key`);
    err.code = 'auth';
  } else if (res.status === 429) {
    err = new Error(`${providerLabel}: rate limited`);
    err.code = 'rate_limit';
  } else if (res.status >= 500) {
    err = new Error(`${providerLabel} is temporarily unavailable (${res.status})`);
    err.code = 'provider_error';
  } else {
    err = new Error(`${providerLabel} ${res.status}: ${text}`);
    err.code = 'bad_request';
  }
  throw err;
}

// The system prompt travels either as one string or as the ordered block array
// splitSystemForCache (prompts.js) produces, where `cache: true` marks the
// stable prefix. Only Anthropic's API understands per-block cache hints; every
// other provider gets the blocks joined back into the single string it always
// took, so a cache-split prompt never changes what a model actually reads.
function joinSystemBlocks(system) {
  if (!Array.isArray(system)) return system == null ? '' : String(system);
  return system.map(b => (b && b.text) || '').join('\n');
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
// `balanceMicros`/`balanceGbp`/`balanceCredits` are hosted-route-only, for the
// UI to show the remaining balance after each message.
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
    // Forwarded untouched — string or cache-split block array alike. The
    // server accepts both shapes and owns mapping blocks to provider caching.
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
    balanceGbp: Number((data && data.balanceGbp) || 0),
    balanceCredits: Number((data && data.balanceCredits) || 0)
  };
}

// Reporting an offensive coach message (Play's AI-Generated Content policy
// requires the affordance; report.js is the UI).
//
// The one call in this file that must work for everyone. Someone using their
// own API key has no entitlement token at all, and they are exactly the users
// whose conversations we otherwise never see — an unreportable coach for them
// would defeat the point. So the bearer goes on when there is one and is simply
// left off when there isn't, and the server leans on its per-IP limit instead.
async function postCoachReport({ backendUrl, accessToken, reported, prompt, note, provider, model }) {
  const base = (backendUrl || DEFAULT_INTENTION_BACKEND_URL).replace(/\/+$/, '');
  const headers = { 'content-type': 'application/json' };
  if (accessToken) headers.authorization = `Bearer ${accessToken}`;
  const res = await fetchWithTimeout(`${base}/v1/report`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ reported, prompt, note, provider, model })
  }, 15000);
  if (!res.ok) {
    const err = new Error(res.status === 429
      ? "That's a lot of reports at once — give it a minute and try again."
      : `Report failed (${res.status})`);
    err.code = res.status === 429 ? 'rate_limited' : 'backend_error';
    throw err;
  }
  return true;
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
    // The block-array form carries the cache split: a block flagged `cache`
    // becomes a cache_control breakpoint, so the stable prompt prefix is
    // billed as a cache read on every turn after the first instead of being
    // re-processed because the volatile clock/usage suffix changed.
    system: Array.isArray(system)
      ? system.map(b => b && b.cache
          ? { type: 'text', text: b.text, cache_control: { type: 'ephemeral' } }
          : { type: 'text', text: (b && b.text) || '' })
      : system,
    messages: messages.map(m => ({ role: m.role, content: m.content }))
  };
  // No system at all (or an all-empty split) must mean "omit the field":
  // Anthropic rejects empty text blocks and an empty block array alike.
  if (Array.isArray(body.system) && body.system.length === 0) delete body.system;
  if (body.system === '') delete body.system;
  if (tools && tools.length) {
    body.tools = tools.map(t => ({
      name: t.name,
      description: t.description,
      input_schema: t.schema
    }));
  }
  const res = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true'
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) await throwHttpError(res, 'Anthropic');
  const data = await parseJsonResponse(res, 'Anthropic');
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
  const systemText = joinSystemBlocks(system);
  if (systemText) openaiMessages.push({ role: 'system', content: systemText });
  for (const m of messages) openaiMessages.push({ role: m.role, content: m.content });

  const body = { model, messages: openaiMessages };
  if (tools && tools.length) {
    body.tools = tools.map(t => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.schema }
    }));
  }
  const res = await fetchWithTimeout(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) await throwHttpError(res, baseUrl);
  const data = await parseJsonResponse(res, baseUrl);
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
  const systemText = joinSystemBlocks(system);
  if (systemText) body.systemInstruction = { parts: [{ text: systemText }] };
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
  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) await throwHttpError(res, 'Gemini');
  const data = await parseJsonResponse(res, 'Gemini');
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
