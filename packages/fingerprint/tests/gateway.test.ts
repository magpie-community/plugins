import { expect, test } from 'bun:test';
import { Gateway, accountHeader } from '../src/gateway';

test('catalog reads cached local and remote subscription accounts without leaking quota data', async () => {
  const paths: string[] = [];
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      paths.push(url.pathname + url.search);
      return Response.json(
        url.pathname === '/v1/models'
          ? { data: [{ id: 'vendor/model' }] }
          : {
              data: [
                {
                  provider: 'vendor',
                  user: 'local-account',
                  name: 'Vendor',
                  alias: 'Local',
                  balance: '$42',
                  secret: 'excluded',
                },
                {
                  provider: 'vendor',
                  user: 'remote-account',
                  name: 'Vendor',
                  kind: 'subscription',
                },
                { provider: 'vendor', user: 'key-card', name: 'Key', kind: 'balance' },
                { provider: 'vendor', kind: 'subscription' },
              ],
            },
      );
    },
  });
  try {
    const { accounts } = await new Gateway(`http://127.0.0.1:${server.port}`).catalog();
    expect(paths).toContain('/v1/magpie/quotas?kept=1');
    expect(accounts).toEqual([
      { provider: 'vendor', id: 'local-account', name: 'Local' },
      // name is the provider's; an account with no alias is named by its user
      { provider: 'vendor', id: 'remote-account', name: 'remote-account' },
    ]);
  } finally {
    server.stop(true);
  }
});

// fetch refuses a header value that isn't ASCII (StockRabbit's 北冥,
// plugins#615): such a name goes percent-encoded, an ASCII one as it is
test('X-Magpie-Account carries a name that is not ASCII percent-encoded', async () => {
  expect(accountHeader('北冥')).toBe('%E5%8C%97%E5%86%A5');
  expect(decodeURIComponent(accountHeader('北冥'))).toBe('北冥');
  expect(accountHeader('csmlovenn@gmail.com')).toBe('csmlovenn@gmail.com');
  const seen: string[] = [];
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(req) {
      seen.push(req.headers.get('x-magpie-account') || '');
      return new Response('ok');
    },
  });
  try {
    const url = `http://127.0.0.1:${server.port}/`;
    // the reporter's error, raw
    const raw = await (async () => fetch(url, { headers: { 'X-Magpie-Account': '北冥' } }))().then(
      () => '',
      (e) => String(e),
    );
    expect(raw).toMatch(/invalid/i);
    await fetch(url, { headers: { 'X-Magpie-Account': accountHeader('北冥') } });
    expect(seen).toEqual(['%E5%8C%97%E5%86%A5']);
  } finally {
    server.stop(true);
  }
});
