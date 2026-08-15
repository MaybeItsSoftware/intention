import { config } from './config.js';

// The hosted coach's LLM call, made under Intention's own provider key.
//
// Input and output match what the client's provider adapters already speak
// ({ system, messages, tools } in, { text, toolCalls } out), so the app's gate
// logic is identical on the hosted and bring-your-own-key routes.

export class UpstreamError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
}

// Provider calls are bounded by a hard timeout: a hung upstream connection
// used to hold the /v1/chat credit reservation forever (holds never expire,
// and the per-subject in-flight cap is 2), so two wedged calls could
// soft-brick a subject until a restart. An abort surfaces as an
// UpstreamError, whose hold chatEndpoint's finally block already releases.
const UPSTREAM_TIMEOUT_MS = 60_000;

async function fetchWithTimeout(url, options, timeoutMs = UPSTREAM_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (e) {
    if (e.name === 'AbortError') {
      throw new UpstreamError('Upstream LLM call timed out', 504);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

export async function callCoachLLM({ system, messages, tools }, options = {}) {
  const provider = options.provider || config.llm.provider;
  switch (provider) {
    case 'anthropic':
      return callAnthropic({ system, messages, tools }, options);
    case 'openai':
      return callOpenAI({ system, messages, tools }, options);
    default:
      throw new UpstreamError(`Unsupported hosted provider: ${provider}`, 500);
  }
}

async function callAnthropic({ system, messages, tools }, options) {
  const body = {
    model: options.model || config.llm.model,
    max_tokens: options.maxTokens || config.llm.maxTokens,
    messages: messages.map(m => ({ role: m.role, content: m.content }))
  };
  // `system` arrives from app.js as a normalized block array ([{ text,
  // cache? }]); blocks flagged cache:true become Anthropic prompt-cache
  // breakpoints. A bare string (defensive back-compat) passes through
  // unchanged — Anthropic accepts both forms.
  if (Array.isArray(system)) {
    if (system.length) {
      body.system = system.map(b => ({
        type: 'text',
        text: b.text,
        ...(b.cache ? { cache_control: { type: 'ephemeral' } } : {})
      }));
    }
  } else if (system) {
    body.system = system;
  }
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
      'x-api-key': options.apiKey || config.llm.apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    throw new UpstreamError(`Anthropic ${res.status}`, res.status === 429 ? 429 : 502);
  }
  const data = await res.json();
  let text = '';
  const toolCalls = [];
  for (const block of data.content || []) {
    if (block.type === 'text') text += block.text;
    else if (block.type === 'tool_use') toolCalls.push({ id: block.id, name: block.name, input: block.input });
  }
  return {
    text,
    toolCalls,
    usage: {
      inputTokens: data.usage?.input_tokens || 0,
      outputTokens: data.usage?.output_tokens || 0,
      // Both counts are EXCLUDED from input_tokens and billed at their own
      // rates — see priceMicros in app.js.
      cacheReadTokens: data.usage?.cache_read_input_tokens || 0,
      cacheWriteTokens: data.usage?.cache_creation_input_tokens || 0
    }
  };
}

async function callOpenAI({ system, messages, tools }, options) {
  const openaiMessages = [];
  // OpenAI has no client-visible cache blocks, so the block array joins into
  // the one system message. Its automatic prompt caching discounts cached
  // input upstream (on our bill); charging the user the full input rate for
  // it stays conservative-honest, so usage parsing is unchanged.
  const systemText = Array.isArray(system) ? system.map(b => b.text).join('\n') : (system || '');
  if (systemText) openaiMessages.push({ role: 'system', content: systemText });
  for (const m of messages) openaiMessages.push({ role: m.role, content: m.content });

  const body = { model: options.model || config.llm.model, messages: openaiMessages };
  if (tools && tools.length) {
    body.tools = tools.map(t => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.schema }
    }));
  }

  const res = await fetchWithTimeout('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${options.apiKey || config.llm.apiKey}`
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    throw new UpstreamError(`OpenAI ${res.status}`, res.status === 429 ? 429 : 502);
  }
  const data = await res.json();
  const message = data.choices?.[0]?.message || {};
  const toolCalls = (message.tool_calls || []).map(tc => {
    let input = {};
    try { input = JSON.parse(tc.function.arguments || '{}'); } catch (e) {}
    return { id: tc.id, name: tc.function.name, input };
  });
  return {
    text: message.content || '',
    toolCalls,
    usage: {
      inputTokens: data.usage?.prompt_tokens || 0,
      outputTokens: data.usage?.completion_tokens || 0
    }
  };
}
