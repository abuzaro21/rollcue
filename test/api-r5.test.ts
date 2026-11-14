// Codex R5 (wrong-guess recovery): one regression test per reproducible finding, named after it.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { start } from '../src/main.ts';
import { plan } from '../src/policy.ts';
import { genCase, makeFile } from '../dataset/gen.ts';

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
    return { status: res.status, body: (res.headers.get('content-type') ?? '').includes('json') ? await res.json() : null };
  };
  return { get: (p: string) => call('GET', p), post: (p: string, b: unknown = {}) => call('POST', p, b) };
}
type C = ReturnType<typeof client>;
const svc = () => app.service;
const fresh = async () => { const c = client(); await c.get('/api/session'); await svc().idle(); return c; };
const job = async (c: C, id: string) => (await c.get(`/api/jobs/${id}`)).body;
const add = async (c: C, sample: string) => { const { body } = await c.post(`/api/samples/${sample}`); await svc().idle(); return job(c, body.id); };
const sidOf = async (jid: string) => (await svc().db.q<{ session_id: string }>('select session_id from jobs where id = $1', [jid]))[0].session_id;
const approve = (c: C, v: any) => c.post(`/api/jobs/${v.id}/approve`, { proposalId: v.proposal.id, artifactSha256: v.proposal.artifact_sha256 });
const decide = async (c: C, v: any, params: Record<string, unknown>) => { const r = await c.post(`/api/jobs/${v.id}/decide`, { revision: v.revision, params }); assert.equal(r.status, 200, JSON.stringify(r.body)); await svc().idle(); return job(c, v.id); };

test('R5-1 approval is refused while memory says something else than the prepared proposal', async () => {
  const c = await fresh();
  const a = await add(c, 'market-stickers'), b = await add(c, 'market-stickers');
  assert.equal(b.plan.intent, 'sticker');
  // A correction committed but not yet reconciled into B (the state while other jobs are still being prepared).
  const [row] = await svc().db.q<{ x: unknown }>('select features as x from jobs where id = $1', [a.id]);
  await svc().db.q(`insert into corrections (session_id, job_id, filename, from_intent, intent, x) values ($1,$2,'a.pdf','sticker','poster',$3::jsonb)`, [await sidOf(a.id), a.id, JSON.stringify(row.x)]);
  const r = await approve(c, b);
  assert.equal(r.status, 409);
  assert.equal(r.body.error, 'superseded');
  await svc().idle();
  const b2 = await job(c, b.id);
  assert.equal(b2.plan.intent, 'poster', 'the refusal brings the job up to date');
  // The reverse: memory forgotten behind the job's back. Its remembered reading must not be approvable either.
  await svc().db.q('delete from corrections where job_id = $1', [a.id]);
  assert.equal((await approve(c, b2)).status, 409);
});

test('R5-1 correcting one job leaves no old proposal approvable on its twin', async () => {
  const c = await fresh();
  const a = await add(c, 'market-stickers'), b = await add(c, 'market-stickers');
  await c.post(`/api/jobs/${a.id}/decide`, { revision: a.revision, params: { intent: 'poster' } });
  assert.equal((await approve(c, b)).status, 409);
  await svc().idle();
});

test('R5-2 a memory-driven type change drops options chosen for the old type', async () => {
  const c = await fresh();
  const a = await add(c, 'market-stickers');
  let b = await add(c, 'market-stickers');
  b = await decide(c, b, { offsetMm: 3 });
  assert.equal(b.params.offsetMm, 3);
  await decide(c, a, { intent: 'label' });
  const b2 = await job(c, b.id);
  assert.equal(b2.plan.intent, 'label');
  assert.equal(b2.params.offsetMm, undefined);
  assert.ok(b2.events.some((e: any) => e.type === 'options-reset'));
});

test('R5-2 an explicit type change drops a size chosen for the old type', async () => {
  const c = await fresh();
  let a = await add(c, 'market-stickers');
  a = await decide(c, a, { targetW: 60, targetH: 60 });
  a = await decide(c, a, { intent: 'poster' });
  assert.deepEqual(a.params, { intent: 'poster' });
});

test('R5-3 correcting a correction leaves one lesson, and the next similar job follows the latest', async () => {
  const c = await fresh();
  let a = await add(c, 'stickers-final');
  a = await decide(c, a, { intent: 'poster' });
  a = await decide(c, a, { intent: 'banner' });
  const rows = await svc().db.q<{ intent: string }>('select intent from corrections where job_id = $1', [a.id]);
  assert.deepEqual(rows.map((r) => r.intent), ['banner']);
  const n = await add(c, 'stickers-final');
  assert.equal(n.plan.intent, 'banner');
});

test('R5-4 a correction does not silently re-type a different job (Codex cases label-1949 → sticker-2512)', async () => {
  const c = await fresh();
  const sid = await sidOf((await c.get('/api/jobs')).body[0].id);
  const mk = async (intent: 'label' | 'sticker', seed: number) => {
    const g = genCase(intent, seed);
    const id = await svc().createJob(sid, { bytes: await makeFile(g.file), filename: g.intake.filename, intake: g.intake });
    await svc().idle();
    return job(c, id);
  };
  const lab = await mk('label', 1949), stk = await mk('sticker', 2512);
  assert.equal(stk.plan.intent, 'sticker');
  if (lab.plan.intent !== 'label') await decide(c, lab, { intent: 'label' });
  const after = await job(c, stk.id);
  const m = after.prediction.memory[0];
  assert.ok(!m || !m.nearDuplicate, 'the two files are distinct');
  assert.notEqual(after.plan.intent, 'label', 'the model’s accepted reading is not overturned by a distinct job’s correction');
  assert.equal(after.prediction.top, 'label', 'memory alone would have flipped it (the case Codex reproduced)');
  assert.equal(after.plan.decision.kind, 'intent');
  assert.equal(after.plan.decision.options[0].params.intent, 'label', 'the remembered answer is offered first');
});

test('R5-4 / R5-8 policy: a near-duplicate correction applies; a distinct one asks; abstention offers every type', async () => {
  const c = await fresh();
  const v = await add(c, 'market-stickers');
  const [row] = await svc().db.q<any>('select inspection, intake, params, prediction from jobs where id = $1', [v.id]);
  const p0 = row.prediction;
  const flipped = { ...p0, top: 'label', ranked: ['label', ...p0.ranked.filter((k: string) => k !== 'label')], abstain: false };
  const asks = plan(row.inspection, row.intake, { ...flipped, memory: [{ jobId: 'x', filename: 'x.pdf', intent: 'label', similarity: 0.777, nearDuplicate: false }] }, {});
  assert.equal(asks.decision.kind, 'intent');
  assert.match(asks.decision.found, /resembles x\.pdf/);
  const applies = plan(row.inspection, row.intake, { ...flipped, memory: [{ jobId: 'x', filename: 'x.pdf', intent: 'label', similarity: 0.95, nearDuplicate: true }] }, {});
  assert.equal(applies.intent, 'label');
  const abstains = plan(row.inspection, row.intake, { ...p0, abstain: true }, {});
  assert.equal(abstains.decision.kind, 'intent');
  assert.equal((abstains.decision as any).options.length, 4);
});

test('R5-5 a chosen size and a soft-print override can both be taken back from the decision', async () => {
  const c = await fresh();
  let a = await add(c, 'market-stickers');
  a = await decide(c, a, { targetW: 60, targetH: 60 });
  const change = a.plan.decision.options.find((o: any) => o.id === 'size-change');
  assert.ok(change);
  const old = a;
  a = await decide(c, a, change.params);
  assert.equal(a.params.targetW, undefined);
  assert.equal((await approve(c, old)).status, 409);

  let s = await add(c, 'soft-poster');
  assert.equal(s.plan.decision.kind, 'return');
  s = await decide(c, s, { acceptLowRes: true });
  assert.equal(s.plan.decision.kind, 'release');
  const undo = s.plan.decision.options.find((o: any) => o.id === 'lowres-undo');
  assert.ok(undo, 'Print anyway can be withdrawn');
  s = await decide(c, s, undo.params);
  assert.equal(s.plan.decision.kind, 'return');
});

test('R5-6 a wrong traced contour can be replaced by a rectangle without changing the job type', async () => {
  const c = await fresh();
  let a = await add(c, 'market-stickers');
  assert.equal(a.plan.decision.build.cut, 'contour');
  const rect = a.plan.decision.options.find((o: any) => o.id === 'cut-rect');
  assert.ok(rect);
  const old = a;
  a = await decide(c, a, rect.params);
  assert.equal(a.plan.intent, 'sticker');
  assert.equal(a.plan.decision.build.cut, 'rect');
  assert.equal(a.proposal.status, 'prepared');
  assert.equal((await approve(c, old)).status, 409);
  assert.ok(a.plan.decision.options.some((o: any) => o.id === 'cut-contour'));
});
