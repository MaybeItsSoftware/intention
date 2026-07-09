const PROVIDERS = {
  anthropic: {
    label: 'Anthropic (Claude)',
    defaultModel: 'claude-sonnet-4-6',
    modelPlaceholder: 'claude-sonnet-4-6 / claude-opus-4-7 / claude-haiku-4-5'
  },
  openai: {
    label: 'OpenAI',
    defaultModel: 'gpt-4o',
    modelPlaceholder: 'gpt-4o / gpt-4o-mini / o1'
  },
  groq: {
    label: 'Groq',
    defaultModel: 'llama-3.3-70b-versatile',
    modelPlaceholder: 'llama-3.3-70b-versatile'
  },
  gemini: {
    label: 'Google Gemini',
    defaultModel: 'gemini-2.0-flash',
    modelPlaceholder: 'gemini-2.0-flash / gemini-1.5-pro'
  }
};

async function callLLM({ provider, apiKey, model, system, messages, tools }) {
  if (!provider) throw new Error('No provider configured');
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
