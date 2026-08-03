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
      .rejects.toMatchObject({ code: 'auth', message: expect.stringMatching(/invalid API key/) });
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

  it('PROVIDERS const exposes the hosted provider plus the four key-based ones', () => {
    const { ctx } = loadProviders({ fetch: makeMockFetch({}) });
    expect(Object.keys(ctx.PROVIDERS).sort()).toEqual(['anthropic', 'gemini', 'groq', 'intention', 'openai']);
    expect(ctx.PROVIDERS.anthropic.defaultModel).toBeTruthy();
    // The hosted provider is not a bring-your-own-key choice: it carries no
    // model list, and the options UI filters it out of the provider dropdown.
    expect(ctx.PROVIDERS.intention.hosted).toBe(true);
    expect(Object.entries(ctx.PROVIDERS).filter(([, cfg]) => !cfg.hosted).map(([k]) => k).sort())
      .toEqual(['anthropic', 'gemini', 'groq', 'openai']);
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

// ---------------------------------------------------------------------------
// The hosted provider (Intention's own backend)
// ---------------------------------------------------------------------------

describe('callIntentionHosted', () => {
  const HOSTED = { provider: 'intention', accessToken: 'tok', messages: MESSAGES };

  it('posts to /v1/chat with the entitlement token and no API key', async () => {
    const fetch = makeMockFetch({ text: 'hi', toolCalls: [] });
    const { ctx } = loadProviders({ fetch });
    await ctx.callLLM({ ...HOSTED, system: 'sys', tools: [{ name: 't', description: 'd', schema: { type: 'object' } }] });
    const call = fetch.calls[0];
    expect(call.url).toBe('https://api.intention.maybeitssoftware.uk/v1/chat');
    expect(call.init.headers.authorization).toBe('Bearer tok');
    expect(call.init.headers['x-api-key']).toBeUndefined();
    const body = JSON.parse(call.init.body);
    expect(body.system).toBe('sys');
    expect(body.tools[0].schema).toEqual({ type: 'object' });
  });

  it('honours a backend override and trims its trailing slashes', async () => {
    const fetch = makeMockFetch({ text: '', toolCalls: [] });
    const { ctx } = loadProviders({ fetch });
    await ctx.callLLM({ ...HOSTED, backendUrl: 'http://localhost:8787//' });
    expect(fetch.calls[0].url).toBe('http://localhost:8787/v1/chat');
  });

  it('returns the same { text, toolCalls } shape the key-based adapters do, plus the live balance', async () => {
    const fetch = makeMockFetch({
      text: 'ok', toolCalls: [{ id: '1', name: 'grant_access', input: { minutes: 5 } }],
      balanceMicros: 500000, balanceGbp: 0.5, balanceCredits: 500
    });
    const { ctx } = loadProviders({ fetch });
    const res = await ctx.callLLM(HOSTED);
    expect(res).toEqual({
      text: 'ok',
      toolCalls: [{ id: '1', name: 'grant_access', input: { minutes: 5 } }],
      balanceMicros: 500000,
      balanceGbp: 0.5,
      balanceCredits: 500
    });
  });

  it('refuses without a token, before making any request', async () => {
    const fetch = makeMockFetch({});
    const { ctx } = loadProviders({ fetch });
    await expect(ctx.callLLM({ provider: 'intention', messages: MESSAGES })).rejects.toThrow(/coaching credit/i);
    expect(fetch.calls.length).toBe(0);
  });

  it('surfaces entitlement problems with a code the caller can act on', async () => {
    const fetch = makeMockFetch({ status: 402, json: { code: 'entitlement_expired', error: 'gone' } });
    const { ctx } = loadProviders({ fetch });
    const error = await ctx.callLLM(HOSTED).catch(e => e);
    expect(error.code).toBe('entitlement_expired');
    expect(ctx.isEntitlementError(error)).toBe(true);
    // The user sees our copy, not the backend's raw message.
    expect(error.message).toMatch(/access has expired/i);
  });

  it('treats a bare 401 as an entitlement problem even without a code', async () => {
    const fetch = makeMockFetch({ status: 401, json: {} });
    const { ctx } = loadProviders({ fetch });
    const error = await ctx.callLLM(HOSTED).catch(e => e);
    expect(ctx.isEntitlementError(error)).toBe(true);
  });

  it('treats an exhausted balance as an entitlement problem, sent back to the paywall', async () => {
    const fetch = makeMockFetch({ status: 402, json: { code: 'balance_exhausted' } });
    const { ctx } = loadProviders({ fetch });
    const error = await ctx.callLLM(HOSTED).catch(e => e);
    expect(error.code).toBe('balance_exhausted');
    expect(ctx.isEntitlementError(error)).toBe(true);
    expect(error.message).toMatch(/out of coaching credit/i);
  });

  it('does not treat a server error as an entitlement problem', async () => {
    const { ctx: serverCtx } = loadProviders({ fetch: makeMockFetch({ status: 500, json: {} }) });
    const serverError = await serverCtx.callLLM(HOSTED).catch(e => e);
    expect(serverCtx.isEntitlementError(serverError)).toBe(false);
  });
});

describe('entitlementIsActive', () => {
  const { ctx } = loadProviders();
  const DAY = 24 * 60 * 60 * 1000;

  it('accepts an active entitlement with time left on a legacy expiry', () => {
    expect(ctx.entitlementIsActive({ active: true, expiresAt: Date.now() + DAY })).toBe(true);
  });

  // The normal shape now: a coaching-credit entitlement never expires.
  it('accepts an active entitlement with no expiry at all', () => {
    expect(ctx.entitlementIsActive({ active: true, expiresAt: null })).toBe(true);
  });

  it('rejects an inactive entitlement even if the date is in the future', () => {
    expect(ctx.entitlementIsActive({ active: false, expiresAt: Date.now() + DAY })).toBe(false);
  });

  it('rejects nothing at all', () => {
    expect(ctx.entitlementIsActive(null)).toBe(false);
    expect(ctx.entitlementIsActive(undefined)).toBe(false);
  });

  it('allows a grace period past expiry, but not indefinitely', () => {
    expect(ctx.entitlementIsActive({ active: true, expiresAt: Date.now() - 1000 })).toBe(true);
    expect(ctx.entitlementIsActive({ active: true, expiresAt: Date.now() - 2 * DAY })).toBe(false);
  });
});
