// Regression tests for Codex review R7 (final diff). Each failed on 2ca15c5 and passes after the fix.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync, deflateRawSync } from 'node:zlib';
import http from 'node:http';
import { createCanvas } from '@napi-rs/canvas';
import { PDFDocument, PDFName } from 'pdf-lib';
import { start } from '../src/main.ts';
import { pdfStructure, Rejected } from '../src/inspect.ts';
import { addressKey, Limiter } from '../src/http.ts';

let app: Awaited<ReturnType<typeof start>>;
let base = '';
before(async () => { app = await start({ testHooks: true }); base = `http://127.0.0.1:${app.port}`; });
after(async () => { await app.close(); });

function client() {
  let cookie = '';
  const call = async (method: string, p: string, body?: unknown) => {
    const res = await fetch(base + p, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { ...(cookie ? { cookie } : {}), 'x-rollcue': '1', 'content-type': 'application/json' } });
    const sc = res.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    return { status: res.status, body: res.status !== 204 && (res.headers.get('content-type') ?? '').includes('json') ? await res.json() : null };
  };
  return { get: (p: string) => call('GET', p), post: (p: string, x: unknown = {}) => call('POST', p, x) };
}
type C = ReturnType<typeof client>;
const svc = () => app.service;
const fresh = async () => { const c = client(); assert.equal((await c.get('/api/session')).status, 200); await svc().idle(); return c; };
const job = async (c: C, id: string) => (await c.get(`/api/jobs/${id}`)).body;
const add = async (c: C, sample: string) => { const { body } = await c.post(`/api/samples/${sample}`); await svc().idle(); return job(c, body.id); };
const approve = (c: C, v: any) => c.post(`/api/jobs/${v.id}/approve`, { proposalId: v.proposal.id, artifactSha256: v.proposal.artifact_sha256 });
const sidOf = async (jid: string) => (await svc().db.q<{ session_id: string }>('select session_id from jobs where id = $1', [jid]))[0].session_id;

/** The release's final write fails twice, leaving an approved proposal whose release never finished (as in R4-3). */
function failFinalTx(n: number) {
  const s = svc(), run = s.pool.run.bind(s.pool), tx = s.db.tx;
  s.pool.run = (async (task: any, t?: any) => {
    const r = await run(task, t);
    if (task.type === 'verify') {
      s.db.tx = (async (fn: any) => { if (n-- > 0) throw new Error('injected: database unavailable'); s.db.tx = tx; return tx(fn); }) as never;
      s.pool.run = run as never;
    }
    return r;
  }) as never;
}

test('R7-2 concurrent requests cannot overshoot the worker capacity', async () => {
  const c = await fresh();
  let open!: () => void;
  const gate = new Promise<void>((ok) => { open = ok; });
  const png = new Uint8Array(createCanvas(10, 10).toBuffer('image/png'));
  const held = svc().pool.run(async () => { await gate; return { type: 'analyse', bytes: png }; }); // the worker is busy
  try {
    const rs = await Promise.all(Array.from({ length: 20 }, () => c.post('/api/samples/market-stickers')));
    const ok = rs.filter((r) => r.status === 201).length;
    assert.ok(ok <= 7, `${ok} accepted with one task running and a capacity of 8`);
    assert.ok(rs.every((r) => r.status === 201 || r.status === 503));
    assert.ok(svc().pool.backlog <= 8);
  } finally { open(); await held; await svc().idle(); }
});

test('R7-4 resuming a stranded approval re-checks the current roll', async () => {
  const c = await fresh();
  const v = await add(c, 'market-stickers');
  failFinalTx(2);
  assert.equal((await approve(c, v)).status, 500);
  assert.equal((await job(c, v.id)).proposal.status, 'approved');
  // The roll changed and is committed, but reconciliation has not reached this job yet.
  await svc().db.q(`update sessions set roll = jsonb_set(roll, '{rollWidthMm}', '800') where id = $1`, [await sidOf(v.id)]);
  const r = await approve(c, v);
  assert.equal(r.status, 409);
  assert.equal(r.body.error, 'superseded');
  await svc().idle();
  assert.notEqual((await job(c, v.id)).status, 'released');
});

test('R7-5 session-wide changes count against the change limit', async () => {
  const c = await fresh();
  const v = await add(c, 'market-stickers');
  await svc().db.q('update jobs set revision = 200 where id = $1', [v.id]);
  assert.equal((await c.post('/api/roll', { rollWidthMm: 800 })).status, 200);
  await svc().idle();
  const after = await job(c, v.id);
  assert.equal(after.revision, 200);
  assert.equal(after.status, 'rejected');
  const open = await svc().db.q<{ n: number }>(`select count(*)::int as n from proposals where job_id = $1 and status in ('preparing','prepared','approved')`, [v.id]);
  assert.equal(open[0].n, 0, 'nothing obsolete stays approvable');
});

test('R7-6 an impossible size can be undone from the return card', async () => {
  const c = await fresh();
  const v = await add(c, 'market-stickers');
  const r = await c.post(`/api/jobs/${v.id}/decide`, { revision: v.revision, params: { targetW: 3000, targetH: 3000 } });
  assert.equal(r.status, 200);
  await svc().idle();
  const big = await job(c, v.id);
  assert.equal(big.plan.decision.kind, 'return');
  const undo = big.plan.decision.options.find((o: any) => o.id === 'size-change');
  assert.ok(undo, 'Change size is offered on the return card');
  assert.equal((await c.post(`/api/jobs/${v.id}/decide`, { revision: big.revision, params: undo.params })).status, 200);
  await svc().idle();
  const back = await job(c, v.id);
  assert.equal(back.plan.decision.kind, 'release');
  assert.equal(back.plan.intent, v.plan.intent, 'no type change was needed');
});

// ---------- hostile files ----------

async function pdfWith(add: (doc: PDFDocument) => void) {
  const doc = await PDFDocument.create();
  doc.addPage([200, 200]);
  add(doc);
  return doc.save({ useObjectStreams: false });
}
type Dict = Parameters<PDFDocument['context']['stream']>[1];
const contents = (doc: PDFDocument, bytes: Uint8Array, dict: Dict = {}) =>
  doc.getPage(0).node.set(PDFName.of('Contents'), doc.context.register(doc.context.stream(bytes, dict)));
const rejects = (p: Promise<unknown>, code: string) => assert.rejects(p, (e: unknown) => e instanceof Rejected && e.code === code);

test('R7-1 a Flate stream with a small window is still counted', async () => {
  const z = deflateSync(Buffer.alloc(80 * 1024 * 1024, 0x20), { windowBits: 9 });
  assert.notEqual(z[0], 0x78, 'a valid zlib header other than the common one');
  const bomb = await pdfWith((d) => contents(d, z, { Filter: 'FlateDecode' }));
  await rejects(pdfStructure(bomb), 'too-large');
});

test('R7-3 a DeviceN stroke with zero CutContour tint is not a cut path', async () => {
  const cutFile = (tints: string) => pdfWith((d) => {
    const fn = d.context.register(d.context.obj({ FunctionType: 2, Domain: [0, 1], C0: [0, 0, 0, 0], C1: [0, 1, 0, 0], N: 1 }));
    const cs = d.context.obj([PDFName.of('DeviceN'), [PDFName.of('CutContour'), PDFName.of('Varnish')], PDFName.of('DeviceCMYK'), fn]);
    d.getPage(0).node.set(PDFName.of('Resources'), d.context.obj({ ColorSpace: { CS0: cs } }));
    contents(d, Buffer.from(`/CS0 CS ${tints} SCN 1 w 20 20 m 180 20 l 180 180 l 20 180 l h S`));
  });
  const on = (await pdfStructure(await cutFile('1 0'))).cut;
  assert.equal(on?.name, 'CutContour', 'control: a full CutContour tint is found');
  assert.ok(on?.stroked);
  const off = (await pdfStructure(await cutFile('0 1'))).cut;
  assert.ok(!(off?.name === 'CutContour' && off.stroked), 'only Varnish was painted');
});

test('R7-7 image objects and inline images share one pixel budget', async () => {
  const side = 7746; // about 60 megapixels each, 120 together
  const file = await pdfWith((d) => {
    d.context.register(d.context.stream(Buffer.alloc(10), { Type: 'XObject', Subtype: 'Image', Width: side, Height: side, BitsPerComponent: 8, ColorSpace: 'DeviceGray' }));
    contents(d, Buffer.from(`q BI /W ${side} /H ${side} /CS /G /BPC 8 ID x EI Q`));
  });
  await rejects(pdfStructure(file), 'too-large');
});

// ---------- R7b: focused check of the R7 fixes ----------

test('R7b-1 a literal endstream inside compressed data does not hide its expansion', async () => {
  const head = Buffer.from('%endstream\n');
  const stored = Buffer.concat([Buffer.from([0x78, 0x01, 0x00, head.length, 0, ~head.length & 0xff, 0xff]), head]); // zlib header, then a stored block
  const bulk = Buffer.alloc(80 * 1024 * 1024, 0x20);
  let a = 1, b = 0;
  for (const buf of [head, bulk]) for (let i = 0; i < buf.length; i++) { a = (a + buf[i]) % 65521; b = (b + a) % 65521; }
  const adler = Buffer.alloc(4); adler.writeUInt32BE(((b << 16) | a) >>> 0);
  const z = Buffer.concat([stored, deflateRawSync(bulk), adler]);
  const bomb = await pdfWith((d) => contents(d, z, { Filter: 'FlateDecode' }));
  await rejects(pdfStructure(bomb), 'too-large');
});

test('R7b-2 a client that leaves before its upload is read gives its slot back', async () => {
  const c = await fresh();
  const s = svc(), session = s.session.bind(s);
  let open!: () => void, waiting = 0;
  const gate = new Promise<void>((ok) => { open = ok; });
  s.session = (async (...a: Parameters<typeof session>) => { waiting++; await gate; return session(...a); }) as typeof s.session;
  const sid = (await s.db.q<{ id: string }>('select id from sessions order by created_at desc limit 1'))[0].id; // the session fresh() just made
  try {
    const reqs = Array.from({ length: 8 }, () => {
      const r = http.request(`${base}/api/jobs`, { method: 'POST', headers: { cookie: `rc_sid=${sid}`, 'x-rollcue': '1', 'content-length': '1000' } });
      r.on('error', () => undefined);
      r.write(Buffer.alloc(10));
      return r;
    });
    while (waiting < 8) await new Promise((ok) => setTimeout(ok, 10));
    for (const r of reqs) r.destroy();
    await new Promise((ok) => setTimeout(ok, 100));
  } finally { open(); s.session = session; }
  await new Promise((ok) => setTimeout(ok, 300));
  assert.equal(s.pool.backlog, 0);
  const r = await c.post('/api/samples/market-stickers');
  assert.equal(r.status, 201, 'all eight slots came back');
  await s.idle();
});

test('R7b-3 malformed colour operands never paint a cut', async () => {
  const cutFile = (ops: string) => pdfWith((d) => {
    const fn = d.context.register(d.context.obj({ FunctionType: 2, Domain: [0, 1], C0: [0, 0, 0, 0], C1: [0, 1, 0, 0], N: 1 }));
    const cs = d.context.obj([PDFName.of('DeviceN'), [PDFName.of('Varnish'), PDFName.of('CutContour')], PDFName.of('DeviceCMYK'), fn]);
    d.getPage(0).node.set(PDFName.of('Resources'), d.context.obj({ ColorSpace: { CS0: cs } }));
    contents(d, Buffer.from(`/CS0 CS ${ops} 1 w 20 20 160 160 re S`));
  });
  assert.equal((await pdfStructure(await cutFile('0 1 SCN'))).cut?.stroked, true, 'control: a well-formed CutContour tint is found');
  // Since R8-2 a malformed colour is refused outright instead of being read as no colour.
  for (const ops of ['0 0 SCN 0 1 /P SCN', '0 SCN']) await rejects(pdfStructure(await cutFile(ops)), 'malformed');
});

// ---------- R8: final review ----------

test('R8-1 a second compression layer is refused before any parser decodes it', async () => {
  const z = deflateSync(deflateSync(Buffer.alloc(80 * 1024 * 1024, 0x20)));
  for (const names of [['FlateDecode', 'FlateDecode'], ['Fl', 'FlateDecode']]) {
    const bomb = await pdfWith((d) => contents(d, z, { Filter: d.context.obj(names.map((n) => PDFName.of(n))) }));
    await rejects(pdfStructure(bomb), 'unsupported');
  }
  const indirect = await pdfWith((d) => contents(d, z, { Filter: d.context.register(d.context.obj([PDFName.of('FlateDecode'), PDFName.of('FlateDecode')])) }));
  await rejects(pdfStructure(indirect), 'unsupported');
  const one = await pdfWith((d) => contents(d, deflateSync(Buffer.from('0 0 m 10 10 l S')), { Filter: 'FlateDecode' }));
  assert.equal((await pdfStructure(one)).pages, 1, 'control: one Flate layer is fine');
});

test('R8-2 malformed colour or path operands are refused, well-formed ones still read', async () => {
  const sep = (ops: string) => pdfWith((d) => {
    const fn = d.context.register(d.context.obj({ FunctionType: 2, Domain: [0, 1], C0: [0, 0, 0, 0], C1: [0, 1, 0, 0], N: 1 }));
    d.getPage(0).node.set(PDFName.of('Resources'), d.context.obj({ ColorSpace: { CS0: [PDFName.of('Separation'), PDFName.of('CutContour'), PDFName.of('DeviceCMYK'), fn] } }));
    contents(d, Buffer.from(`/CS0 CS ${ops}`));
  });
  const bad = ['0 SCN 1 (bad) SCN 20 20 160 160 re S', '1 SCN 20 20 160 160 (bad) re S', '1 SCN [20] 20 m 180 180 l S', '1 SCN 20 20 160 re S', '1 SCN 1 0 0 1 0 0 0 cm 20 20 160 160 re S'];
  for (const ops of bad) await rejects(pdfStructure(await sep(ops)), 'malformed');
  const ok = (await pdfStructure(await sep('1 SCN BT (text ok) Tj ET [3 2] 0 d 20 20 160 160 re S'))).cut;
  assert.ok(ok?.stroked && ok.loops === 1, 'control: strings and arrays elsewhere, and a well-formed cut');
});

test('R8-4 filling the limiter with other keys does not reset a drained bucket', () => {
  const l = new Limiter(1 / 30, 10), t = 5_000_000;
  for (let i = 0; i < 10; i++) l.take('victim', t);
  assert.equal(l.take('victim', t), false);
  for (let i = 0; i < 9_999; i++) l.take(`k${i}`, t); // the table now holds 10,000 buckets, all refilling
  assert.equal(l.take('victim', t), false, 'still drained');
  let fresh = 0;
  for (let i = 0; i < 50; i++) if (l.take(`new${i}`, t)) fresh++;
  assert.equal(fresh, 10, 'unseen keys share one bucket while every tracked bucket is refilling');
  let later = 0;
  for (let i = 0; i < 50; i++) if (l.take(`later${i}`, t + 300_000)) later++;
  assert.equal(later, 50, 'once buckets have refilled they are dropped and unseen keys get their own again');
});

test('R8-5 every spelling of one address gives one key; garbage shares one key', () => {
  const same = (k: string, ...ips: string[]) => { for (const ip of ips) assert.equal(addressKey(ip), k, ip); };
  same('2001:db8:1:2::/64', '2001:db8:1:2::192.0.2.1', '2001:db8:1:2::192.0.2.2', '2001:0DB8:0001:0002:0:0:0:9', '2001:db8:1:2::1%eth0');
  same('192.0.2.1', '192.0.2.1', '::ffff:192.0.2.1', '::FFFF:c000:201', '0:0:0:0:0:ffff:192.0.2.1', '::ffff:192.0.2.1%1');
  same('invalid', 'nope', '1.2.3', '256.1.1.1', '2001:db8::1::2', '2001:db8:1:2::999.1.1.1', 'unknown', '');
  assert.notEqual(addressKey('::ffff:c000:201'), addressKey('::ffff:c000:202'), 'mapped IPv4 clients stay distinct');
});

test('R8-6 concurrent new sessions cannot pass the global ceiling', async () => {
  const s = svc(), q = s.db.q.bind(s.db);
  const [{ n: before }] = await q<{ n: number }>('select count(*)::int as n from sessions');
  // Pretend the table already holds 4,999 sessions, and hold the first count so both requests overlap.
  s.db.q = (async (sql: string, p?: unknown[]) => {
    if (sql.startsWith('select count(*)::int as n from sessions')) {
      const [{ n }] = await q<{ n: number }>(sql);
      await new Promise((ok) => setTimeout(ok, 200));
      return [{ n: n - before + 4_999 }];
    }
    return q(sql, p as never);
  }) as typeof s.db.q;
  try {
    const r = await Promise.allSettled([s.session(null, true), s.session(null, true)]);
    assert.deepEqual(r.map((x) => x.status).sort(), ['fulfilled', 'rejected'], 'one is created, the other is told RollCue is busy');
  } finally { s.db.q = q; }
});
