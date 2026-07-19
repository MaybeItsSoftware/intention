import { describe, it, expect } from 'vitest';
import { loadProviders, makeMockFetch } from './load.js';

const TOOLS = [{
  name: 'grant_access',
  description: 'Grant time.',
  schema: { type: 'object', properties: { minutes: { type: 'number' } }, required: ['minutes'] }
}];

const MESSAGES = [{ role: 'user', content: 'hi' }];

function lastBody(fetch) {
  const init = fetch.calls[fetch.calls.length - 1].init;
  return JSON.parse(init.body);
}

describe('callAnthropic', () => {
  it('builds the right request and parses text + tool calls', async () => {
    const fetch = makeMockFetch({
      json: {
        content: [
          { type: 'text', text: 'Hello there.' },
          { type: 'tool_use', id: 'tu_1', name: 'grant_access', input: { minutes: 10 } }
        ]
      }
    });
    const { ctx } = loadProviders({ fetch });
    const out = await ctx.callAnthropic({
      apiKey: 'sk-ant', model: 'claude-sonnet-4-6',
      system: 'SYS', messages: MESSAGES, tools: TOOLS
    });

    const { url, init } = fetch.calls[0];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(init.method).toBe('POST');
    expect(init.headers['x-api-key']).toBe('sk-ant');
    expect(init.headers['anthropic-version']).toBe('2023-06-01');

    const body = JSON.parse(init.body);
    expect(body.model).toBe('claude-sonnet-4-6');
    expect(body.system).toBe('SYS');
    expect(body.max_tokens).toBe(1024);
    // anthropic tool format: input_schema
    expect(body.tools[0].name).toBe('grant_access');
    expect(body.tools[0].input_schema).toEqual(TOOLS[0].schema);
    expect(body.tools[0].input_schema).toBeDefined();

    expect(out.text).toBe('Hello there.');
    expect(out.toolCalls).toEqual([{ id: 'tu_1', name: 'grant_access', input: { minutes: 10 } }]);
  });

  it('throws on non-ok response', async () => {
    const fetch = makeMockFetch({ status: 401, json: 'unauthorized' });
    const { ctx } = loadProviders({ fetch });
    await expect(ctx.callAnthropic({ apiKey: 'x', model: 'm', system: 's', messages: MESSAGES }))
      .rejects.toThrow(/Anthropic 401/);
  });
});

describe('callOpenAICompatible', () => {
  it('builds OpenAI-shaped request and parses tool_calls', async () => {
    const fetch = makeMockFetch({
      json: {
        choices: [{
          message: {
            content: 'Sure.',
            tool_calls: [{ id: 'call_1', function: { name: 'grant_access', arguments: '{"minutes":15}' } }]
          }
        }]
      }
    });
    const { ctx } = loadProviders({ fetch });
    const out = await ctx.callOpenAICompatible({
      baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-oa', model: 'gpt-4o',
      system: 'SYS', messages: MESSAGES, tools: TOOLS
    });

    const { url, init } = fetch.calls[0];
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    expect(init.headers['authorization']).toBe('Bearer sk-oa');

    const body = JSON.parse(init.body);
    // system folded into messages[0]
    expect(body.messages[0]).toEqual({ role: 'system', content: 'SYS' });
    expect(body.messages[1]).toEqual({ role: 'user', content: 'hi' });
    // openai tool format: type function + parameters
    expect(body.tools[0].type).toBe('function');
    expect(body.tools[0].function.name).toBe('grant_access');
    expect(body.tools[0].function.parameters).toEqual(TOOLS[0].schema);

    expect(out.text).toBe('Sure.');
    expect(out.toolCalls).toEqual([{ id: 'call_1', name: 'grant_access', input: { minutes: 15 } }]);
  });

  it('tolerates malformed tool arguments (parses to empty object)', async () => {
    const fetch = makeMockFetch({
      json: { choices: [{ message: { content: '', tool_calls: [{ id: 'c', function: { name: 'grant_access', arguments: 'not json' } }] } }] }
    });
    const { ctx } = loadProviders({ fetch });
    const out = await ctx.callOpenAICompatible({ baseUrl: 'https://x/v1', apiKey: 'k', model: 'm', messages: MESSAGES });
    expect(out.toolCalls[0].input).toEqual({});
  });
});

describe('callGemini', () => {
  it('builds Gemini request with systemInstruction and functionDeclarations, parses functionCall', async () => {
    const fetch = makeMockFetch({
      json: {
        candidates: [{
          content: {
            parts: [
              { text: 'Hi.' },
              { functionCall: { name: 'grant_access', args: { minutes: 20 } } }
            ]
          }
        }]
      }
    });
    const { ctx } = loadProviders({ fetch });
    const out = await ctx.callGemini({
      apiKey: 'g-key', model: 'gemini-2.0-flash',
      system: 'SYS', messages: [{ role: 'assistant', content: 'prev' }, { role: 'user', content: 'hi' }],
      tools: TOOLS
    });

    const { url, init } = fetch.calls[0];
    expect(url).toContain('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent');
    expect(url).toContain('key=g-key');

    const body = JSON.parse(init.body);
    expect(body.systemInstruction).toEqual({ parts: [{ text: 'SYS' }] });
    // assistant role mapped to 'model'
    expect(body.contents[0].role).toBe('model');
    expect(body.contents[1].role).toBe('user');
    expect(body.tools[0].functionDeclarations[0].name).toBe('grant_access');
    expect(body.tools[0].functionDeclarations[0].parameters).toEqual(TOOLS[0].schema);

    expect(out.text).toBe('Hi.');
    expect(out.toolCalls).toEqual([{ id: 'grant_access', name: 'grant_access', input: { minutes: 20 } }]);
  });
});

describe('callLLM dispatch', () => {
  it('dispatches anthropic to the anthropic endpoint', async () => {
    const fetch = makeMockFetch({ json: { content: [{ type: 'text', text: 'a' }] } });
    const { ctx } = loadProviders({ fetch });
    await ctx.callLLM({ provider: 'anthropic', apiKey: 'k', system: 's', messages: MESSAGES });
    expect(fetch.calls[0].url).toContain('api.anthropic.com');
  });

  it('dispatches openai to openai endpoint and uses default model', async () => {
    const fetch = makeMockFetch({ json: { choices: [{ message: { content: 'x' } }] } });
    const { ctx } = loadProviders({ fetch });
    await ctx.callLLM({ provider: 'openai', apiKey: 'k', system: 's', messages: MESSAGES });
    expect(fetch.calls[0].url).toContain('api.openai.com');
    expect(lastBody(fetch).model).toBe('gpt-4o'); // PROVIDERS.openai.defaultModel
  });

  it('dispatches groq to the groq base url', async () => {
    const fetch = makeMockFetch({ json: { choices: [{ message: { content: 'x' } }] } });
    const { ctx } = loadProviders({ fetch });
    await ctx.callLLM({ provider: 'groq', apiKey: 'k', system: 's', messages: MESSAGES });
    expect(fetch.calls[0].url).toContain('api.groq.com');
  });

  it('dispatches gemini to the gemini endpoint', async () => {
    const fetch = makeMockFetch({ json: { candidates: [{ content: { parts: [{ text: 'x' }] } }] } });
    const { ctx } = loadProviders({ fetch });
    await ctx.callLLM({ provider: 'gemini', apiKey: 'k', system: 's', messages: MESSAGES });
    expect(fetch.calls[0].url).toContain('generativelanguage.googleapis.com');
  });

  it('throws without provider or apiKey', async () => {
    const { ctx } = loadProviders({ fetch: makeMockFetch({}) });
    await expect(ctx.callLLM({ apiKey: 'k', messages: MESSAGES })).rejects.toThrow(/No provider/);
    await expect(ctx.callLLM({ provider: 'anthropic', messages: MESSAGES })).rejects.toThrow(/No API key/);
  });

  it('throws on unknown provider', async () => {
    const { ctx } = loadProviders({ fetch: makeMockFetch({}) });
    await expect(ctx.callLLM({ provider: 'nope', apiKey: 'k', messages: MESSAGES })).rejects.toThrow(/Unknown provider/);
  });

  it('PROVIDERS const exposes the four providers with default models', () => {
    const { ctx } = loadProviders({ fetch: makeMockFetch({}) });
    expect(Object.keys(ctx.PROVIDERS).sort()).toEqual(['anthropic', 'gemini', 'groq', 'openai']);
    expect(ctx.PROVIDERS.anthropic.defaultModel).toBeTruthy();
  });
});

describe('isNetworkError', () => {
  it('treats fetch TypeErrors and known browser network-failure messages as network errors', () => {
    const { ctx } = loadProviders();
    expect(ctx.isNetworkError(new TypeError('Failed to fetch'))).toBe(true);
    expect(ctx.isNetworkError(new Error('NetworkError when attempting to fetch resource.'))).toBe(true);
    expect(ctx.isNetworkError(new Error('Load failed'))).toBe(true);
  });

  it('does not treat HTTP error responses as network errors', () => {
    const { ctx } = loadProviders();
    expect(ctx.isNetworkError(new Error('Anthropic 401: {"error":"invalid api key"}'))).toBe(false);
    expect(ctx.isNetworkError(new Error('No API key configured'))).toBe(false);
  });

  it('marks a callLLM rejection caused by an offline fetch as a network error', async () => {
    const fetch = async () => { throw new TypeError('Failed to fetch'); };
    const { ctx } = loadProviders({ fetch });
    let caught;
    try {
      await ctx.callLLM({ provider: 'anthropic', apiKey: 'k', messages: MESSAGES });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
    expect(ctx.isNetworkError(caught)).toBe(true);
  });
});
