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
      outputTokens: data.usage?.output_tokens || 0
    }
  };
}

async function callOpenAI({ system, messages, tools }, options) {
  const openaiMessages = [];
  if (system) openaiMessages.push({ role: 'system', content: system });
  for (const m of messages) openaiMessages.push({ role: m.role, content: m.content });

  const body = { model: options.model || config.llm.model, messages: openaiMessages };
  if (tools && tools.length) {
    body.tools = tools.map(t => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.schema }
    }));
  }

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
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
