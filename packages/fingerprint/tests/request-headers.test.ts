import { expect, test } from 'bun:test';
import { parseRequestHeaders, requestHeaders } from '../src/request-headers';

test('request headers accept client identity fields and retain colons in values', () => {
  expect(
    parseRequestHeaders('User-Agent: my-client/1.0\r\nX-Client-URL: https://example.com\n'),
  ).toEqual({
    'user-agent': 'my-client/1.0',
    'x-client-url': 'https://example.com',
  });
  expect(requestHeaders(undefined)).toEqual({});
  expect(parseRequestHeaders(' \n')).toEqual({});
  expect(parseRequestHeaders('Anthropic-Beta: enabled')).toEqual({ 'anthropic-beta': 'enabled' });
});

test('request headers cannot override credentials, routing or transport framing', () => {
  for (const name of [
    'Authorization',
    'X-API-Key',
    'Cookie',
    'Host',
    'Content-Type',
    'Content-Length',
    'Connection',
    'Transfer-Encoding',
    'Origin',
    'X-Magpie-Account',
    'X-Magpie-Session',
    'Sec-Fetch-Site',
    'Proxy-Authorization',
  ])
    expect(() => requestHeaders({ [name]: 'forbidden' })).toThrow('cannot be overridden');
});

test('request headers reject duplicates, malformed data and unbounded values', () => {
  expect(() => requestHeaders({ 'User-Agent': 'first', 'user-agent': 'second' })).toThrow(
    'Duplicate',
  );
  expect(() => parseRequestHeaders('User-Agent: first\nuser-agent: second')).toThrow('Duplicate');
  expect(() => parseRequestHeaders('missing colon')).toThrow('Name: value');
  expect(() => requestHeaders({ 'bad name': 'value' })).toThrow('name');
  for (const value of ['line\r\nbreak', 'nul\0', '中文', 1, null])
    expect(() => requestHeaders({ 'X-Client': value })).toThrow('ASCII');
  for (const value of [null, [], 'text']) expect(() => requestHeaders(value)).toThrow('object');
  expect(() => requestHeaders({ 'X-Long': 'a'.repeat(2049) })).toThrow('2048');
  expect(() =>
    requestHeaders(
      Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`x-${i}`, 'a'.repeat(2048)])),
    ),
  ).toThrow('KiB');
  expect(() =>
    requestHeaders(Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`x-${i}`, 'v']))),
  ).toThrow('24');
});
