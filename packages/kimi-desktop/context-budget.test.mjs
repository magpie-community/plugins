import { test, expect, spyOn } from 'bun:test';
import { buildCountRequest, countContextTokens } from './context-budget.mjs';

const UNAVAILABLE = 'context_count_unavailable';

function buildSupported(payload) {
  let dto;
  expect(() => { dto = buildCountRequest(payload); }).not.toThrow();
  return dto;
}

function stubFetch(handler) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    return await handler(url, init);
  };
  impl.calls = calls;
  return impl;
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

async function rejection(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  return null;
}

function expectUnavailable(error) {
  expect(error).not.toBeNull();
  expect(error.code).toBe(UNAVAILABLE);
  expect(error.message).toBe(UNAVAILABLE);
}

const basePayload = () => ({
  model: 'kimi-real-model',
  messages: [{ role: 'user', content: 'hello' }],
});

// ---------------------------------------------------------------- conversion

test('buildCountRequest: plain system/user/assistant DTO object equality', () => {
  const payload = {
    model: 'kimi-real-model',
    messages: [
      { role: 'system', content: 'be terse' },
      { role: 'developer', content: 'tool policy' },
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
    ],
  };
  const dto = buildSupported(payload);
  expect(dto).toStrictEqual({
    model: 'kimi-real-model',
    system: [{ type: 'text', text: 'be terse' }, { type: 'text', text: 'tool policy' }],
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
    ],
  });
  expect(Object.keys(dto).sort()).toStrictEqual(['messages', 'model', 'system']);
  expect(payload.messages[0].content).toBe('be terse');
});

test('buildCountRequest: system text parts kept in original order, images in system refused', async () => {
  const dto = buildSupported({
    model: 'm',
    messages: [
      { role: 'system', content: [{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }] },
      { role: 'developer', content: [{ type: 'text', text: 'three' }] },
      { role: 'user', content: 'u' },
    ],
  });
  expect(dto.system).toStrictEqual([
    { type: 'text', text: 'one' },
    { type: 'text', text: 'two' },
    { type: 'text', text: 'three' },
  ]);
  const error = await rejection(
    Promise.resolve().then(() =>
      buildCountRequest({
        model: 'm',
        messages: [
          { role: 'system', content: [{ type: 'image_url', image_url: { url: 'https://x.example/i.png' } }] },
          { role: 'user', content: 'u' },
        ],
      }),
    ),
  );
  expectUnavailable(error);
});

test('buildCountRequest: image data URLs map to base64 sources for jpeg/png/gif/webp', () => {
  for (const subtype of ['jpeg', 'png', 'gif', 'webp']) {
    const data = `QUJD${subtype}`;
    const dto = buildSupported({
      model: 'm',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'see' },
            { type: 'image_url', image_url: { url: `data:image/${subtype};base64,${data}` } },
          ],
        },
      ],
    });
    expect(dto.messages[0].content).toStrictEqual([
      { type: 'text', text: 'see' },
      { type: 'image', source: { type: 'base64', media_type: `image/${subtype}`, data } },
    ]);
  }
});

test('buildCountRequest: http(s) image_url maps to url source; malformed or non-http URLs refused', async () => {
  const dto = buildSupported({
    model: 'm',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: 'https://cdn.example/a.png' },
          { type: 'image_url', image_url: { url: 'http://cdn.example/b.jpg' } },
        ],
      },
    ],
  });
  expect(dto.messages[0].content).toStrictEqual([
    { type: 'image', source: { type: 'url', url: 'https://cdn.example/a.png' } },
    { type: 'image', source: { type: 'url', url: 'http://cdn.example/b.jpg' } },
  ]);

  for (const url of ['http://', 'ftp://cdn.example/a.png', 'data:image/svg+xml;base64,AAAA', 'not a url', 'data:image/png;base64,   ']) {
    const error = await rejection(
      Promise.resolve().then(() =>
        buildCountRequest({
          model: 'm',
          messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url } }] }],
        }),
      ),
    );
    expectUnavailable(error);
  }
});

test('buildCountRequest: unknown audio/video parts are refused, never skipped', async () => {
  const audio = await rejection(
    Promise.resolve().then(() =>
      buildCountRequest({
        model: 'm',
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'input_audio', input_audio: { data: 'x', format: 'wav' } }] },
        ],
      }),
    ),
  );
  expectUnavailable(audio);
  const video = await rejection(
    Promise.resolve().then(() =>
      buildCountRequest({
        model: 'm',
        messages: [{ role: 'user', content: [{ type: 'video_url', video_url: { url: 'https://v.example/1.mp4' } }] }],
      }),
    ),
  );
  expectUnavailable(video);
});

test('buildCountRequest: assistant content + tool_calls preserved together, arguments parsed to input', () => {
  const dto = buildSupported({
    model: 'm',
    messages: [
      { role: 'user', content: 'run it' },
      {
        role: 'assistant',
        content: 'calling',
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'get_balance', arguments: '{"account":"A-1","amount":12.5}' },
          },
        ],
      },
    ],
  });
  expect(dto.messages[1]).toStrictEqual({
    role: 'assistant',
    content: [
      { type: 'text', text: 'calling' },
      { type: 'tool_use', id: 'call_1', name: 'get_balance', input: { account: 'A-1', amount: 12.5 } },
    ],
  });
});

test('buildCountRequest: reasoning_content becomes ordinary text, no thinking signature', () => {
  const dto = buildSupported({
    model: 'm',
    messages: [
      { role: 'user', content: 'q' },
      { role: 'assistant', content: null, reasoning_content: 'internal chain', tool_calls: [{ id: 'c1', function: { name: 'f', arguments: '{}' } }] },
    ],
  });
  expect(dto.messages[1].content).toStrictEqual([
    { type: 'text', text: 'internal chain' },
    { type: 'tool_use', id: 'c1', name: 'f', input: {} },
  ]);
  expect(dto.messages[1].content[0].signature).toBeUndefined();
});

test('buildCountRequest: non-string reasoning_content, legacy function_call, misplaced tool_calls refused', async () => {
  const cases = [
    { role: 'assistant', content: 'x', reasoning_content: 42 },
    { role: 'assistant', content: 'x', reasoning_content: { text: 'x' } },
    { role: 'assistant', content: 'x', function_call: { name: 'f', arguments: '{}' } },
    { role: 'user', content: 'x', tool_calls: [] },
    { role: 'tool', tool_call_id: 'c', content: 'r', tool_calls: [] },
  ];
  for (const message of cases) {
    const error = await rejection(
      Promise.resolve().then(() => buildCountRequest({ model: 'm', messages: [{ role: 'user', content: 'q' }, message] })),
    );
    expectUnavailable(error);
  }
});

test('buildCountRequest: role tool becomes user/tool_result keeping id, text and image', () => {
  const dto = buildSupported({
    model: 'm',
    messages: [
      { role: 'user', content: 'q' },
      { role: 'tool', tool_call_id: 'call_9', content: 'balance is 42' },
      {
        role: 'tool',
        tool_call_id: 'call_10',
        content: [
          { type: 'text', text: 'chart' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
        ],
      },
    ],
  });
  expect(dto.messages[1]).toStrictEqual({
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: 'call_9', content: [{ type: 'text', text: 'balance is 42' }] }],
  });
  expect(dto.messages[2]).toStrictEqual({
    role: 'user',
    content: [
      {
        type: 'tool_result',
        tool_use_id: 'call_10',
        content: [
          { type: 'text', text: 'chart' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
        ],
      },
    ],
  });
});

test('buildCountRequest: tools map name/description/parameters, schema reference preserved, no-arg gets object schema', () => {
  const schema = { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] };
  const dto = buildSupported({
    model: 'm',
    messages: [{ role: 'user', content: 'q' }],
    tools: [
      { type: 'function', function: { name: 'search_db', description: 'query', parameters: schema } },
      { type: 'function', function: { name: 'ping' } },
    ],
  });
  expect(dto.tools).toStrictEqual([
    { name: 'search_db', description: 'query', input_schema: schema },
    { name: 'ping', input_schema: { type: 'object', properties: {} } },
  ]);
  expect(dto.tools[0].input_schema).toBe(schema);
});

test('buildCountRequest: bad tool shapes are refused (type, args JSON/null/empty/missing, schema shape)', async () => {
  const cases = [
    { model: 'm', messages: [{ role: 'user', content: 'q' }], tools: [{ type: 'retrieval', name: 'r' }] },
    { model: 'm', messages: [{ role: 'user', content: 'q' }], tools: [{ type: 'function', function: { name: 'f', parameters: [] } }] },
    { model: 'm', messages: [{ role: 'user', content: 'q' }], tools: [{ type: 'function', function: { name: 'f', parameters: null } }] },
    {
      model: 'm',
      messages: [
        { role: 'user', content: 'q' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'c', function: { name: 'f', arguments: '{not json' } }] },
      ],
    },
    {
      model: 'm',
      messages: [
        { role: 'user', content: 'q' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'c', function: { name: 'f', arguments: null } }] },
      ],
    },
    {
      model: 'm',
      messages: [
        { role: 'user', content: 'q' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'c', function: { name: 'f', arguments: '' } }] },
      ],
    },
    {
      model: 'm',
      messages: [
        { role: 'user', content: 'q' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'c', function: { name: 'f' } }] },
      ],
    },
    {
      model: 'm',
      messages: [{ role: 'user', content: 'q' }, { role: 'assistant', content: null, tool_calls: [{ function: { name: 'f', arguments: '{}' } }] }],
    },
  ];
  for (const payload of cases) {
    const error = await rejection(Promise.resolve().then(() => buildCountRequest(payload)));
    expectUnavailable(error);
  }
});

test('buildCountRequest: deeply frozen payload converts and is not mutated', () => {
  const payload = deepFreeze({
    model: 'kimi-real-model',
    messages: [
      { role: 'system', content: 'sys' },
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      { role: 'assistant', content: 'ok', tool_calls: [{ id: 'c1', function: { name: 'f', arguments: '{"a":1}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: 'done' },
    ],
    tools: [{ type: 'function', function: { name: 'f', parameters: { type: 'object', properties: {} } } }],
    max_tokens: 4096,
  });
  const snapshot = JSON.stringify(payload);
  const dto = buildSupported(payload);
  expect(dto.messages).toHaveLength(3);
  expect(dto.tools[0].name).toBe('f');
  expect(JSON.stringify(payload)).toBe(snapshot);
  expect(dto.max_tokens).toBeUndefined();
  expect(dto.context).toBeUndefined();
  expect(dto.usage).toBeUndefined();
});

// ---------------------------------------------------------------- counting

test('countContextTokens: stubbed fetch returns 37 via /messages/count_tokens', async () => {
  const fetchImpl = stubFetch(() => jsonResponse({ input_tokens: 37 }));
  const payload = basePayload();
  const n = await countContextTokens(payload, {
    gatewayURL: 'https://gw.example/base/',
    gatewayKey: 'sk-test',
    fetchImpl,
  });
  expect(n).toBe(37);
  expect(fetchImpl.calls).toHaveLength(1);
  expect(fetchImpl.calls[0].url).toBe('https://gw.example/base/messages/count_tokens');
  expect(fetchImpl.calls[0].init.method).toBe('POST');
  expect(JSON.parse(fetchImpl.calls[0].init.body)).toStrictEqual(buildCountRequest(payload));
  expect(payload).toStrictEqual(basePayload());
});

test('countContextTokens: default headers are exactly content-type, authorization, user-agent', async () => {
  const fetchImpl = stubFetch(() => jsonResponse({ input_tokens: 1 }));
  await countContextTokens(basePayload(), { gatewayURL: 'https://gw.example', gatewayKey: 'sk-key', fetchImpl });
  const headers = fetchImpl.calls[0].init.headers;
  expect(Object.keys(headers).sort()).toStrictEqual(['authorization', 'content-type', 'user-agent']);
  expect(headers['content-type']).toBe('application/json');
  expect(headers.authorization).toBe('Bearer sk-key');
  expect(headers['user-agent']).toBe('Desktop Kimi Work');
});

test('countContextTokens: requestHeaders forwards only the 5 lowercase whitelisted names, user-agent overrides', async () => {
  const fetchImpl = stubFetch(() => jsonResponse({ input_tokens: 2 }));
  await countContextTokens(basePayload(), {
    gatewayURL: 'https://gw.example',
    gatewayKey: 'sk-key',
    fetchImpl,
    requestHeaders: {
      'user-agent': 'Custom UA/1.0',
      'x-msh-version': '9.9',
      'r-timezone': 'Asia/Singapore',
      'x-session-id': 'sess-1',
      session_id: 'sess-2',
      authorization: 'Bearer native-secret',
      origin: 'app://native',
      cookie: 'a=b',
      'x-not-allowed': 'nope',
    },
  });
  const headers = fetchImpl.calls[0].init.headers;
  expect(headers['user-agent']).toBe('Custom UA/1.0');
  expect(headers['x-msh-version']).toBe('9.9');
  expect(headers['r-timezone']).toBe('Asia/Singapore');
  expect(headers['x-session-id']).toBe('sess-1');
  expect(headers.session_id).toBe('sess-2');
  expect(headers.authorization).toBe('Bearer sk-key');
  expect(headers.origin).toBeUndefined();
  expect(headers.cookie).toBeUndefined();
  expect(headers['x-not-allowed']).toBeUndefined();
  const userAgentKeys = Object.keys(headers).filter((k) => k.toLowerCase() === 'user-agent');
  expect(userAgentKeys).toStrictEqual(['user-agent']);
  expect(Object.keys(headers).every((k) => k === k.toLowerCase())).toBe(true);
});

test('countContextTokens: strips all trailing slashes and posts once, no retry', async () => {
  const fetchImpl = stubFetch(() => jsonResponse({ input_tokens: 3 }));
  await countContextTokens(basePayload(), { gatewayURL: 'https://gw.example/base///', gatewayKey: 'k', fetchImpl });
  expect(fetchImpl.calls[0].url).toBe('https://gw.example/base/messages/count_tokens');
  expect(fetchImpl.calls).toHaveLength(1);
});

test('countContextTokens: accepts 0 and rejects invalid input_tokens shapes', async () => {
  const zero = stubFetch(() => jsonResponse({ input_tokens: 0 }));
  expect(await countContextTokens(basePayload(), { gatewayURL: 'https://gw.example', gatewayKey: 'k', fetchImpl: zero })).toBe(0);

  for (const bad of [-1, 1.5, '37', null, undefined, Number.MAX_SAFE_INTEGER + 2, Number.NaN]) {
    const fetchImpl = stubFetch(() => jsonResponse({ input_tokens: bad }));
    const error = await rejection(
      countContextTokens(basePayload(), { gatewayURL: 'https://gw.example', gatewayKey: 'k', fetchImpl }),
    );
    expectUnavailable(error);
  }
});

test('countContextTokens: non-OK, bad JSON and fetch errors all map to fixed unavailable without leaking', async () => {
  const errorCases = [
    stubFetch(() => jsonResponse({ input_tokens: 1 }, 500)),
    stubFetch(() => new Response('not json', { status: 200 })),
    stubFetch(() => new Response(new Uint8Array([
      ...new TextEncoder().encode('{"input_tokens":1,"padding":"'), 255, ...new TextEncoder().encode('"}'),
    ]))),
    stubFetch(() => {
      throw new Error('ECONNREFUSED sk-secret-123');
    }),
    stubFetch(() => jsonResponse({ nope: 1 })),
    stubFetch(() => {
      throw Object.assign(new Error('provider secret body'), { code: UNAVAILABLE });
    }),
  ];
  for (const fetchImpl of errorCases) {
    const error = await rejection(
      countContextTokens(basePayload(), { gatewayURL: 'https://gw.example', gatewayKey: 'sk-secret-123', fetchImpl }),
    );
    expectUnavailable(error);
    expect(error.message).not.toContain('sk-secret-123');
    expect(error.message).not.toContain('ECONNREFUSED');
    expect(error.message).not.toContain('provider secret');
    expect(error.message).not.toContain('input_tokens');
    expect(fetchImpl.calls).toHaveLength(1);
  }
});

test('countContextTokens: response body over 8KiB is refused (bounded read)', async () => {
  const fetchImpl = stubFetch(() => jsonResponse({ input_tokens: 5, pad: 'a'.repeat(9000) }));
  const error = await rejection(
    countContextTokens(basePayload(), { gatewayURL: 'https://gw.example', gatewayKey: 'k', fetchImpl }),
  );
  expectUnavailable(error);
});

test('countContextTokens: parent signal is honored and combined, aborted parent rejects', async () => {
  const controller = new AbortController();
  controller.abort();
  const fetchImpl = stubFetch((_url, init) => {
    if (init.signal && init.signal.aborted) throw new Error('aborted');
    return jsonResponse({ input_tokens: 4 });
  });
  const error = await rejection(
    countContextTokens(basePayload(), {
      gatewayURL: 'https://gw.example',
      gatewayKey: 'k',
      fetchImpl,
      signal: controller.signal,
    }),
  );
  expectUnavailable(error);
});

test('countContextTokens: missing gateway config fails closed without calling fetch', async () => {
  for (const options of [
    { gatewayURL: '', gatewayKey: 'k' },
    { gatewayURL: 'https://gw.example', gatewayKey: '' },
    { gatewayKey: 'k' },
  ]) {
    const fetchImpl = stubFetch(() => jsonResponse({ input_tokens: 1 }));
    const error = await rejection(countContextTokens(basePayload(), { ...options, fetchImpl }));
    expectUnavailable(error);
    expect(fetchImpl.calls).toHaveLength(0);
  }
});


test('buildCountRequest: nullable call fields and empty assistant text retain financial tool input and result', () => {
  const payload = deepFreeze({ model: 'fixture/provider-model', messages: [
    { role: 'system', content: 'policy', function_call: null },
    { role: 'user', content: 'query', tool_calls: null },
    { role: 'assistant', content: [], function_call: null, tool_calls: [
      { id: 'finance-1', type: 'function', function: { name: 'finance_database_query', arguments: '{"ticker":"ABC"}' } },
    ] },
    { role: 'tool', tool_call_id: 'finance-1', content: '{"price":123}' },
    { role: 'assistant', content: 'answer', tool_calls: null, reasoning_content: null },
  ], authorization: { fixture: 'native-permission' }, billing: { fixture: 'native-billing' } });
  let dto;
  expect(() => { dto = buildCountRequest(payload); }).not.toThrow();
  expect(dto.messages[1].content).toStrictEqual([
    { type: 'tool_use', id: 'finance-1', name: 'finance_database_query', input: { ticker: 'ABC' } },
  ]);
  expect(dto.messages[2].content).toStrictEqual([
    { type: 'tool_result', tool_use_id: 'finance-1', content: [{ type: 'text', text: '{"price":123}' }] },
  ]);
  expect(dto.messages[3].content).toStrictEqual([{ type: 'text', text: 'answer' }]);
  expect(payload.authorization).toStrictEqual({ fixture: 'native-permission' });
  expect(payload.billing).toStrictEqual({ fixture: 'native-billing' });
  expect(dto.max_tokens).toBeUndefined();
});

test('countContextTokens: non-OK response body is cancelled without reading provider text', async () => {
  let cancelled = false, reads = 0;
  const body = {
    cancel: async () => { cancelled = true; },
    getReader: () => { reads++; throw Error('provider-secret'); },
  };
  const error = await rejection(countContextTokens(basePayload(), {
    gatewayURL: 'https://gw.example', gatewayKey: 'fixture-key', fetchImpl: async () => ({ ok: false, body }),
  }));
  expectUnavailable(error);
  expect(cancelled).toBe(true);
  expect(reads).toBe(0);
});

test('countContextTokens: oversized count JSON cancels the reader before further consumption', async () => {
  const bytes = new TextEncoder().encode(JSON.stringify({ input_tokens: 5, padding: 'x'.repeat(9000) }));
  let reads = 0, cancelled = false;
  const reader = {
    read: async () => reads++ === 0 ? { done: false, value: bytes } : { done: true },
    cancel: async () => { cancelled = true; },
  };
  const error = await rejection(countContextTokens(basePayload(), {
    gatewayURL: 'https://gw.example', gatewayKey: 'fixture-key',
    fetchImpl: async () => ({ ok: true, body: { getReader: () => reader } }),
  }));
  expectUnavailable(error);
  expect(cancelled).toBe(true);
  expect(reads).toBe(1);
});

test('countContextTokens: a valid count JSON at exactly 8KiB is accepted', async () => {
  const overhead = JSON.stringify({ input_tokens: 5, padding: '' }).length;
  const json = JSON.stringify({ input_tokens: 5, padding: 'x'.repeat(8192 - overhead) });
  expect(new TextEncoder().encode(json).byteLength).toBe(8192);
  await expect(countContextTokens(basePayload(), {
    gatewayURL: 'https://gw.example', gatewayKey: 'fixture-key', fetchImpl: async () => new Response(json),
  })).resolves.toBe(5);
});

test('countContextTokens: the internal six-second timeout is combined with the parent signal', async () => {
  const timeout = new AbortController(), parent = new AbortController();
  const timeoutSpy = spyOn(AbortSignal, 'timeout').mockReturnValue(timeout.signal);
  let forwarded;
  try {
    await expect(countContextTokens(basePayload(), {
      gatewayURL: 'https://gw.example', gatewayKey: 'fixture-key', signal: parent.signal,
      fetchImpl: async (_url, options) => { forwarded = options.signal; return jsonResponse({ input_tokens: 1 }); },
    })).resolves.toBe(1);
    expect(timeoutSpy).toHaveBeenCalledWith(6000);
    expect(forwarded).not.toBe(parent.signal);
    expect(forwarded).not.toBe(timeout.signal);
    expect(forwarded.aborted).toBe(false);
    timeout.abort();
    expect(forwarded.aborted).toBe(true);
  } finally { timeoutSpy.mockRestore(); }
});


test('countContextTokens: refuses redirects like the existing gateway transport', async () => {
  const fetchImpl = stubFetch(() => jsonResponse({ input_tokens: 1 }));
  await countContextTokens(basePayload(), { gatewayURL: 'https://gw.example', gatewayKey: 'synthetic-key', fetchImpl });
  expect(fetchImpl.calls[0].init.redirect).toBe('error');
});

test('countContextTokens: bypasses environment proxies like the local gateway transport', async () => {
  const fetchImpl = stubFetch(() => jsonResponse({ input_tokens: 1 }));
  await countContextTokens(basePayload(), { gatewayURL: 'https://gw.example', gatewayKey: 'synthetic-key', fetchImpl });
  expect(fetchImpl.calls[0].init.proxy).toBe('');
});


function emptyTextPayload() {
  return deepFreeze({
    model: 'fixture/provider-model',
    messages: [
      { role: 'system', content: '' },
      { role: 'system', content: ['', { type: 'text', text: '' }, { type: 'text', text: '  policy  ' }] },
      { role: 'developer', content: '' },
      { role: 'developer', content: ['', { type: 'text', text: '' }, '\n'] },
      { role: 'user', content: ['', { type: 'text', text: '' }, ' ', { type: 'text', text: 'query' }] },
      { role: 'assistant', content: '', reasoning_content: '', tool_calls: [
        { id: 'finance-empty', type: 'function', function: { name: 'finance_database_query', arguments: '{"ticker":"ABC","empty":""}' } },
      ] },
      { role: 'tool', tool_call_id: 'finance-empty', content: '' },
      { role: 'assistant', content: [{ type: 'text', text: '' }, { type: 'text', text: 'answer ' }, ''] },
    ],
    tools: [{ type: 'function', function: { name: 'finance_database_query', parameters: { type: 'object', properties: { ticker: { type: 'string' } } } } }],
    authorization: { fixture: 'native-permission' }, billing: { fixture: 'native-billing' },
  });
}

test('buildCountRequest: drops only zero-length text and retains financial tool data', () => {
  const payload = emptyTextPayload(), original = JSON.stringify(payload);
  const dto = buildSupported(payload);
  expect(dto).toStrictEqual({
    model: 'fixture/provider-model',
    system: [{ type: 'text', text: '  policy  ' }, { type: 'text', text: '\n' }],
    messages: [
      { role: 'user', content: [{ type: 'text', text: ' ' }, { type: 'text', text: 'query' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'finance-empty', name: 'finance_database_query', input: { ticker: 'ABC', empty: '' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'finance-empty', content: [] }] },
      { role: 'assistant', content: [{ type: 'text', text: 'answer ' }] },
    ],
    tools: [{ name: 'finance_database_query', input_schema: payload.tools[0].function.parameters }],
  });
  expect(JSON.stringify(payload)).toBe(original);
  expect(dto.tools[0].input_schema).toBe(payload.tools[0].function.parameters);
});

test('buildCountRequest: omits empty system and refuses empty-only assistant without tools', async () => {
  const dto = buildSupported({ model: 'm', messages: [
    { role: 'system', content: '' }, { role: 'developer', content: ['', { type: 'text', text: '' }] },
    { role: 'user', content: 'query' },
  ] });
  expect(dto.system).toBeUndefined();
  for (const content of ['', [], ['', { type: 'text', text: '' }]]) {
    expectUnavailable(await rejection(Promise.resolve().then(() => buildCountRequest({
      model: 'm', messages: [{ role: 'user', content: 'query' }, { role: 'assistant', content }],
    }))));
  }
});

test('countContextTokens: empty-text source passes a provider schema check without mutating generation payload', async () => {
  const payload = emptyTextPayload(), original = JSON.stringify(payload);
  function hasEmptyText(value) {
    if (!value || typeof value !== 'object') return false;
    if (value.type === 'text' && value.text === '') return true;
    return Object.values(value).some(hasEmptyText);
  }
  const fetchImpl = stubFetch((_url, init) => {
    const dto = JSON.parse(init.body);
    return hasEmptyText(dto)
      ? jsonResponse({ error: 'schema_empty_text' }, 400)
      : jsonResponse({ input_tokens: 59 });
  });
  await expect(countContextTokens(payload, {
    gatewayURL: 'https://gw.example', gatewayKey: 'fixture-key', fetchImpl,
  })).resolves.toBe(59);
  expect(fetchImpl.calls).toHaveLength(1);
  expect(JSON.stringify(payload)).toBe(original);
  expect(payload.messages[5].content).toBe('');
  expect(payload.messages[6].content).toBe('');
  expect(payload.authorization).toStrictEqual({ fixture: 'native-permission' });
  expect(payload.billing).toStrictEqual({ fixture: 'native-billing' });
});
