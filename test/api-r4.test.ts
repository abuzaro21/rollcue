// Codex R4 (approval and execution): one regression test per reproducible finding, named after it.
// Faults are injected by wrapping the real service, database and worker pool; nothing in src/ knows about them.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { start } from '../src/main.ts';

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
const fresh = async () => { const c = client(); await c.get('/api/session'); await app.service.idle(); return c; };
const job = async (c: C, id: string) => (await c.get(`/api/jobs/${id}`)).body;
const bySample = async (c: C, sample: string) => {
  let j = (await c.get('/api/jobs')).body.filter((x: any) => x.sample === sample).at(-1);
  if (!j) { j = (await c.post(`/api/samples/${sample}`)).body; await app.service.idle(); }
  return job(c, j.id);
};
const approve = (c: C, v: any) => c.post(`/api/jobs/${v.id}/approve`, { proposalId: v.proposal.id, artifactSha256: v.proposal.artifact_sha256 });
const roll = async (c: C, mm: number) => { assert.equal((await c.post('/api/roll', { rollWidthMm: mm })).status, 200); await app.service.idle(); };

/** Make the next `n` database transactions that start after a release verification fail. */
function failFinalTx(n: number) {
  const svc = app.service, run = svc.pool.run.bind(svc.pool), tx = svc.db.tx;
  svc.pool.run = (async (task: any, t?: any) => {
    const r = await run(task, t);
    if (task.type === 'verify') {
      svc.db.tx = (async (fn: any) => { if (n-- > 0) throw new Error('injected: database unavailable'); svc.db.tx = tx; return tx(fn); }) as never;
      svc.pool.run = run as never;
    }
    return r;
  }) as never;
}

test('R4-1 a roll change that alters the layout invalidates the approval and the ticket shows the bound layout', async () => {
  const c = await fresh();
  await roll(c, 1600);
  const a = await bySample(c, 'market-stickers');
  assert.equal(a.proposal.status, 'prepared');
  await roll(c, 800);
  const b = await bySample(c, 'market-stickers');
  assert.notDeepEqual(b.plan.decision.layout, a.plan.decision.layout);
  assert.ok(b.revision > a.revision, 'a changed layout must bump the revision');
  const stale = await approve(c, a);
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error, 'superseded');
  assert.deepEqual(b.proposal.decision, b.plan.decision, 'the card shows exactly the bound decision');
  const ok = await approve(c, b);
  assert.equal(ok.body.status, 'released');
  assert.deepEqual(ok.body.proposal.ticket.layout, b.plan.decision.layout);
});

test('R4-1 a roll change that alters a return notice invalidates the approval', async () => {
  const c = await fresh();
  await roll(c, 500);
  const a = await bySample(c, 'shop-banner');
  assert.equal(a.plan.decision.kind, 'return');
  await roll(c, 600);
  const b = await bySample(c, 'shop-banner');
  assert.notEqual(canonNotice(b), canonNotice(a));
  assert.ok(b.revision > a.revision);
  assert.equal((await approve(c, a)).status, 409);
  assert.deepEqual(b.proposal.decision, b.plan.decision);
});
const canonNotice = (v: any) => JSON.stringify(v.plan.decision.notice);

test('R4-2 overlapping edits leave one approvable proposal and one terminal outcome', async () => {
  const c = await fresh();
  const v = await bySample(c, 'market-stickers');
  const [{ session_id: sid }] = await app.service.db.q<{ session_id: string }>('select session_id from jobs where id = $1', [v.id]);
  // Queued back to back: both edits commit before either replan runs, so both replans see the same revision.
  await Promise.all([
    app.service.decide(sid, v.id, { revision: v.revision, params: { offsetMm: 2 } }),
    app.service.decide(sid, v.id, { revision: v.revision + 1, params: { offsetMm: 3 } }),
  ]);
  await app.service.idle();
  const open = await app.service.db.q<{ id: string; artifact_sha256: string }>(`select id, artifact_sha256 from proposals where job_id = $1 and status in ('preparing','prepared','approved')`, [v.id]);
  assert.equal(open.length, 1);
  const prepared = await app.service.db.q<{ id: string; artifact_sha256: string }>(`select id, artifact_sha256 from proposals where job_id = $1 and status = 'prepared'`, [v.id]);
  for (const p of prepared) await c.post(`/api/jobs/${v.id}/approve`, { proposalId: p.id, artifactSha256: p.artifact_sha256 });
  const after = await job(c, v.id);
  assert.equal(after.events.filter((e: any) => e.type === 'released').length, 1);
});

test('R4-2 approval is refused once the job is closed', async () => {
  const c = await fresh();
  const v = await bySample(c, 'market-stickers');
  // Simulate a second open proposal surviving from before the fix: release one, then try to approve on a closed job.
  assert.equal((await approve(c, v)).body.status, 'released');
  await app.service.db.q(`update proposals set status = 'prepared' where id = $1`, [v.proposal.id]);
  const again = await approve(c, v);
  assert.equal(again.status, 409);
  assert.equal(again.body.error, 'closed');
});

test('R4-3 a failed final write leaves a retryable failure, not a stranded approval', async () => {
  const c = await fresh();
  const v = await bySample(c, 'market-stickers');
  failFinalTx(1);
  const r = await approve(c, v);
  assert.equal(r.status, 200);
  assert.equal(r.body.status, 'ready');
  assert.equal(r.body.proposal.status, 'failed');
  assert.equal(r.body.proposal.ticket, null);
  const retried = await c.post(`/api/jobs/${v.id}/retry`, { revision: r.body.revision });
  await app.service.idle();
  const w = await job(c, retried.body.id);
  assert.equal(w.proposal.status, 'prepared');
  assert.equal((await approve(c, w)).body.status, 'released');
});

test('R4-3 if even the failure cannot be recorded, approving again resumes the release', async () => {
  const c = await fresh();
  const v = await bySample(c, 'market-stickers');
  failFinalTx(2);
  const r = await approve(c, v);
  assert.equal(r.status, 500);
  const stuck = await job(c, v.id);
  assert.equal(stuck.proposal.status, 'approved');
  assert.equal(stuck.proposal.executing, false, 'the UI must not show it as still working');
  const again = await approve(c, v);
  assert.equal(again.status, 200);
  assert.equal(again.body.status, 'released');
  assert.equal(again.body.events.filter((e: any) => e.type === 'released').length, 1);
});

test('R4-6 an error after the release committed does not claim nothing was released', async () => {
  const c = await fresh();
  const v = await bySample(c, 'market-stickers');
  const svc = app.service as any, view = svc.view;
  let armed = true;
  svc.view = async (...a: unknown[]) => { if (armed) { armed = false; throw new Error('injected: read failed'); } return view.apply(svc, a); };
  try {
    const r = await approve(c, v);
    assert.equal(r.status, 500);
    assert.doesNotMatch(r.body.message, /Nothing was released/);
  } finally { svc.view = view; }
  assert.equal((await job(c, v.id)).status, 'released');
});

test('R4-7 the ticket records the committed approval, not the execution moment', async () => {
  const c = await fresh();
  const v = await bySample(c, 'market-stickers');
  const r = await approve(c, v);
  const t = r.body.proposal.ticket;
  assert.ok(r.body.proposal.approved_by);
  assert.equal(t.approval.by, r.body.proposal.approved_by);
  assert.equal(new Date(t.approval.at).toISOString(), new Date(r.body.proposal.approved_at).toISOString());
});
