// Regression tests for Codex review R6 (security). Each failed on 140e3e1 and passes after the fix.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { createCanvas } from '@napi-rs/canvas';
import { PDFDocument, PDFName, PDFNumber } from 'pdf-lib';
import { start } from '../src/main.ts';
import { Pool, TaskError } from '../src/pool.ts';
import { pdfStructure, Rejected } from '../src/inspect.ts';

let app: Awaited<ReturnType<typeof start>>;
let base = '';
before(async () => { app = await start({ testHooks: true }); base = `http://127.0.0.1:${app.port}`; });
after(async () => { await app.close(); });

function client(b = () => base) {
  let cookie = '';
  const call = async (method: string, p: string, body?: unknown, header = true) => {
    const res = await fetch(b() + p, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { ...(cookie ? { cookie } : {}), ...(header ? { 'x-rollcue': '1' } : {}), 'content-type': 'application/json' } });
    const sc = res.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    return { status: res.status, cookie: sc, body: res.status !== 204 && (res.headers.get('content-type') ?? '').includes('json') ? await res.json() : null };
  };
  return { call, get: (p: string, header = true) => call('GET', p, undefined, header), post: (p: string, x: unknown = {}) => call('POST', p, x) };
}
type C = ReturnType<typeof client>;
const svc = () => app.service;
const count = async (sql: string, args: unknown[] = []) => (await svc().db.q<{ n: number }>(sql, args))[0].n;
const fresh = async () => { const c = client(); assert.equal((await c.get('/api/session')).status, 200); await svc().idle(); return c; };
const job = async (c: C, id: string) => (await c.get(`/api/jobs/${id}`)).body;
const add = async (c: C, sample: string) => { const { body } = await c.post(`/api/samples/${sample}`); await svc().idle(); return job(c, body.id); };

test('R6-1 only the header-protected start-up call creates a session', async () => {
  const before = await count('select count(*)::int as n from sessions');
  const c = client();
  for (const p of ['/api/jobs', '/api/samples', '/api/nope']) {
    const r = await c.get(p, false);
    assert.equal(r.status, 401, p);
    assert.equal(r.cookie, null, `${p} set no cookie`);
  }
  assert.equal((await c.get('/api/session', false)).status, 403, 'a cross-site GET cannot start a session');
  assert.equal(await count('select count(*)::int as n from sessions'), before, 'no session row and no seeded work');
  const ok = await c.get('/api/session');
  assert.equal(ok.status, 200);
  assert.match(ok.cookie ?? '', /rc_sid=/);
  await svc().idle();
});

test('R6-1 new sessions are rate-limited per address outside test mode', async () => {
  const prod = await start({});
  try {
    prod.service.seed = async () => {}; // the limit is what is under test, not seeding
    const codes: number[] = [];
    for (let i = 0; i < 11; i++) codes.push((await client(() => `http://127.0.0.1:${prod.port}`).get('/api/session')).status);
    assert.deepEqual(codes.slice(0, 10), Array(10).fill(200));
    assert.equal(codes[10], 429);
  } finally { await prod.close(); }
});

test('R6-2 new work is refused while the worker backlog is full', async () => {
  const c = await fresh();
  Object.defineProperty(svc().pool, 'backlog', { get: () => 8, configurable: true });
  try {
    const r = await c.post('/api/samples/market-stickers');
    assert.equal(r.status, 503);
    assert.equal(r.body.error, 'busy');
  } finally { delete (svc().pool as unknown as Record<string, unknown>).backlog; }
});

test('R6-3 retry needs a failure, superseded proposals drop their bytes, metrics are capped', async () => {
  const c = await fresh();
  const v = await add(c, 'market-stickers');
  assert.equal(v.proposal.status, 'prepared');
  const r = await c.post(`/api/jobs/${v.id}/retry`, { revision: v.revision });
  assert.equal(r.status, 409);
  assert.equal(r.body.error, 'nothing-to-retry');

  assert.equal((await c.post(`/api/jobs/${v.id}/decide`, { revision: v.revision, params: { offsetMm: 2.5 } })).status, 200);
  await svc().idle();
  const [old] = await svc().db.q<{ status: string; artifact: unknown; preview: unknown; artifact_sha256: string }>('select status, artifact, preview, artifact_sha256 from proposals where id = $1', [v.proposal.id]);
  assert.equal(old.status, 'superseded');
  assert.equal(old.artifact, null);
  assert.equal(old.preview, null);
  assert.equal(old.artifact_sha256, v.proposal.artifact_sha256, 'the hash stays as evidence');

  const [{ session_id: sid }] = await svc().db.q<{ session_id: string }>('select session_id from jobs where id = $1', [v.id]);
  assert.equal((await c.post('/api/metrics', { surface: 'decision', data: {} })).status, 204);
  for (let i = 0; i < 204; i++) await svc().recordMetric(sid, { surface: 'decision', data: { i } }); // past the HTTP rate limit
  assert.equal(await count('select count(*)::int as n from metrics where session_id = $1', [sid]), 200);
});

test('R6-3 a job cannot be changed without limit', async () => {
  const c = await fresh();
  const v = await add(c, 'market-stickers');
  await svc().db.q('update jobs set revision = 200 where id = $1', [v.id]);
  const r = await c.post(`/api/jobs/${v.id}/decide`, { revision: 200, params: { offsetMm: 2.5 } });
  assert.equal(r.status, 429);
});

test('R6-6 test hooks refuse to start in production', async () => {
  const was = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try { await assert.rejects(start({ testHooks: true }), /Test hooks/); } finally { process.env.NODE_ENV = was; }
});

test('R6-8 retention is absolute: activity does not keep a session alive', async () => {
  const c = await fresh();
  const v = await add(c, 'market-stickers');
  const [{ session_id: sid }] = await svc().db.q<{ session_id: string }>('select session_id from jobs where id = $1', [v.id]);
  await svc().db.q(`update sessions set created_at = now() - interval '49 hours', last_seen = now() where id = $1`, [sid]);
  assert.equal((await c.get(`/api/jobs/${v.id}`)).status, 401, 'an expired session is not resumed');
  assert.ok(await svc().purgeExpired() >= 1);
  assert.equal(await count('select count(*)::int as n from jobs where id = $1', [v.id]), 0);
});

// ---------- hostile files ----------

async function pdfWith(add: (doc: PDFDocument) => void) {
  const doc = await PDFDocument.create();
  doc.addPage([200, 200]);
  add(doc);
  return doc.save({ useObjectStreams: false });
}
const contents = (doc: PDFDocument, bytes: Uint8Array, dict: Parameters<PDFDocument['context']['stream']>[1] = {}) =>
  doc.getPage(0).node.set(PDFName.of('Contents'), doc.context.register(doc.context.stream(bytes, dict)));
const rejects = (p: Promise<unknown>, code: string) => assert.rejects(p, (e: unknown) => e instanceof Rejected && e.code === code);

test('R6-4 a compressed stream that inflates past the budget is refused before parsing', async () => {
  const bomb = await pdfWith((d) => contents(d, deflateSync(Buffer.alloc(80 * 1024 * 1024, 0x20)), { Filter: 'FlateDecode' }));
  assert.ok(bomb.length < 1024 * 1024, 'small on the wire');
  await rejects(pdfStructure(bomb), 'too-large');
});

test('R6-4 filters that cannot be bounded are refused', async () => {
  await rejects(pdfStructure(await pdfWith((d) => contents(d, Buffer.from('q Q'), { Filter: 'LZWDecode' }))), 'unsupported');
  await rejects(pdfStructure(await pdfWith((d) => contents(d, Buffer.from('q Q'), { Filter: ['ASCII85Decode', 'FlateDecode'] }))), 'unsupported');
});

test('R6-5 an image cannot declare a negative or non-integer size', async () => {
  const img = (w: number) => (d: PDFDocument) => { d.context.register(d.context.stream(Buffer.alloc(10), { Type: 'XObject', Subtype: 'Image', Width: PDFNumber.of(w), Height: 10, BitsPerComponent: 8, ColorSpace: 'DeviceGray' })); };
  await rejects(pdfStructure(await pdfWith(img(-1))), 'malformed');
  await rejects(pdfStructure(await pdfWith(img(1.5))), 'malformed');
});

test('R6-5 inline images count against the image budget', async () => {
  await rejects(pdfStructure(await pdfWith((d) => contents(d, Buffer.from('q BI /W 100000 /H 100000 /CS /G /BPC 8 ID x EI Q')))), 'too-large');
});

test('R6-7 a task queued behind a timed-out one gets a fresh worker', async () => {
  const pool = new Pool(1); // the first task times out while the worker is still starting
  try {
    const png = new Uint8Array(createCanvas(20, 20).toBuffer('image/png'));
    const a = pool.run({ type: 'analyse', bytes: png });
    pool.timeoutMs = 25_000;
    const b = pool.run({ type: 'analyse', bytes: png.slice() });
    await assert.rejects(a, (e: unknown) => e instanceof TaskError && e.code === 'timeout');
    const r = await b as { inspection: { kind: string } };
    assert.equal(r.inspection.kind, 'png');
  } finally { await pool.close(); }
});

test('R6-2 a queued task reads its file only when the worker is free', async () => {
  const pool = new Pool();
  try {
    const png = new Uint8Array(createCanvas(20, 20).toBuffer('image/png'));
    const built: string[] = [];
    const a = pool.run(async () => { built.push('a'); return { type: 'analyse', bytes: png }; });
    const b = pool.run(async () => { built.push('b'); return { type: 'analyse', bytes: png.slice() }; });
    await new Promise((ok) => setTimeout(ok, 20));
    assert.deepEqual(built, ['a'], 'the queued task holds no bytes yet');
    await a; await b;
    assert.deepEqual(built, ['a', 'b']);
  } finally { await pool.close(); }
});
