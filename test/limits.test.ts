// Session-creation limits under the proxy chain seen on Render: X-Forwarded-For arrives as [client, edge, proxy], and
// whatever the client sent itself is prepended. Each test starts a fresh production-mode process (cold limiter state),
// fires a concurrent burst, and counts both HTTP outcomes and the session rows actually created.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { start } from '../src/main.ts';
import { clientIp, Limiter } from '../src/http.ts';

async function burst(n: number, xff: (i: number) => string, seed = false) {
  const prev = process.env.TRUST_PROXY_HOPS;
  process.env.TRUST_PROXY_HOPS = '3';
  const app = await start({});
  if (prev === undefined) delete process.env.TRUST_PROXY_HOPS; else process.env.TRUST_PROXY_HOPS = prev;
  try {
    if (!seed) app.service.seed = async () => {};
    const t0 = Date.now();
    const codes = await Promise.all(Array.from({ length: n }, (_, i) => fetch(`http://127.0.0.1:${app.port}/api/session`, {
      headers: { 'x-rollcue': '1', cookie: 'rc_sid=nope', 'x-forwarded-for': xff(i) },
    }).then(async (r) => { await r.arrayBuffer(); return r.status; })));
    const ms = Date.now() - t0;
    const [{ n: rows }] = await app.service.db.q<{ n: number }>('select count(*)::int as n from sessions');
    if (seed) await app.service.idle();
    return { ok: codes.filter((c) => c === 200).length, limited: codes.filter((c) => c === 429).length, other: codes.filter((c) => c !== 200 && c !== 429), rows, ms };
  } finally { await app.close(); }
}

// One client behind Render: the edge and proxy entries vary per connection, the client entry does not.
const render = (client: string) => (i: number) => `${client}, 172.70.${i % 40}.${i % 7}, 10.214.${i % 3}.9`;

test('cold start, 200 concurrent new-session requests from one client: exactly 10 sessions exist afterwards', async () => {
  const r = await burst(200, render('198.51.100.7'), true);
  assert.deepEqual(r.other, []);
  assert.equal(r.ok, 10);
  assert.equal(r.limited, 190);
  assert.equal(r.rows, 10, `database rows (burst took ${r.ms} ms)`);
});

test('a client-supplied X-Forwarded-For prefix does not change the key', async () => {
  const r = await burst(60, (i) => `203.0.113.${i}, 192.0.2.${i}, ${render('198.51.100.7')(i)}`);
  assert.equal(r.ok, 10);
  assert.equal(r.rows, 10);
});

test('distinct clients each get their own budget', async () => {
  const r = await burst(60, (i) => render(`198.51.100.${i % 3}`)(i));
  assert.equal(r.ok, 30);
  assert.equal(r.rows, 30);
});

test('an IPv6 client cannot rotate addresses inside its /64 to multiply the budget', async () => {
  const r = await burst(60, (i) => render(`2001:db8:1:2::${(i + 1).toString(16)}`)(i));
  assert.equal(r.ok, 10);
  assert.equal(r.rows, 10);
});

test('clientIp: Render chain, short chain, IPv6 /64 and IPv4-mapped forms', () => {
  const req = (xff: string | undefined, remote = '10.0.0.1') => ({ headers: xff === undefined ? {} : { 'x-forwarded-for': xff }, socket: { remoteAddress: remote } }) as never;
  assert.equal(clientIp(req('198.51.100.7, 172.70.1.1, 10.214.0.9'), 3), '198.51.100.7');
  assert.equal(clientIp(req('6.6.6.6, 198.51.100.7, 172.70.1.1, 10.214.0.9'), 3), '198.51.100.7');
  assert.equal(clientIp(req('2001:db8:1:2:aaaa::1, 172.70.1.1, 10.214.0.9'), 3), '2001:db8:1:2::/64');
  assert.equal(clientIp(req('2001:DB8:1:2::ffff, 172.70.1.1, 10.214.0.9'), 3), '2001:db8:1:2::/64');
  assert.equal(clientIp(req(undefined, '::ffff:127.0.0.1'), 0), '127.0.0.1');
  // A chain shorter than the trusted hops did not come through the expected proxies: one shared bucket, not the
  // per-connection socket address of whichever proxy forwarded it.
  assert.equal(clientIp(req('172.70.1.1, 10.214.0.9', '10.214.0.9'), 3), 'short-chain');
  assert.equal(clientIp(req(undefined, '10.214.0.7'), 3), 'short-chain');
});

test('token bucket: burst, refill rate and no reset while drained', () => {
  const l = new Limiter(1 / 30, 10);
  let t = 1_000_000;
  for (let i = 0; i < 10; i++) assert.ok(l.take('k', t));
  assert.equal(l.take('k', t), false);
  t += 29_000; assert.equal(l.take('k', t), false);
  t += 1_500; assert.ok(l.take('k', t));
  assert.equal(l.take('k', t), false);
  t += 120_000; // two minutes refill four tokens, not ten
  let n = 0; while (l.take('k', t)) n++;
  assert.equal(n, 4);
});
