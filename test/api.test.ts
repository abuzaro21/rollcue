// End to end over real HTTP: seeded proactive work, approval binding, stale/superseded refusals, correction memory,
// session isolation, failure + retry, and input rejection. In-memory PGlite, real worker thread, real PDFs.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { start } from '../src/main.ts';

let app: Awaited<ReturnType<typeof start>>;
let base = '';
before(async () => { app = await start({ testHooks: true }); base = `http://127.0.0.1:${app.port}`; });
after(async () => { await app.close(); });

type R = { status: number; body: any; headers: Headers };
function client() {
  let cookie = '';
  const call = async (method: string, p: string, body?: unknown, headers: Record<string, string> = {}): Promise<R> => {
    const raw = body instanceof Uint8Array;
    const res = await fetch(base + p, {
      method, body: body === undefined ? undefined : raw ? (body as Uint8Array<ArrayBuffer>) : JSON.stringify(body),
      headers: { ...(cookie ? { cookie } : {}), 'x-rollcue': '1', ...(raw ? {} : { 'content-type': 'application/json' }), ...headers },
    });
    const sc = res.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    const ct = res.headers.get('content-type') ?? '';
    return { status: res.status, headers: res.headers, body: ct.includes('json') ? await res.json() : new Uint8Array(await res.arrayBuffer()) };
  };
  return { call, get: (p: string) => call('GET', p), post: (p: string, b: unknown = {}, h?: Record<string, string>) => call('POST', p, b, h) };
}
const jobBySample = async (c: ReturnType<typeof client>, sample: string) => {
  const { body } = await c.get('/api/jobs');
  const j = body.filter((x: any) => x.sample === sample).at(-1);
  return (await c.get(`/api/jobs/${j.id}`)).body;
};

const op = client();

test('first visit seeds jobs that RollCue has already prepared', async () => {
  const s = await op.get('/api/session');
  assert.equal(s.status, 200);
  assert.match(s.headers.get('set-cookie') ?? '', /rc_sid=.+HttpOnly; SameSite=Lax/);
  assert.equal(s.headers.get('x-frame-options'), 'DENY');
  assert.ok(s.body.jobs.length >= 4);
  await app.service.idle();
  const v = await jobBySample(op, 'market-stickers');
  assert.equal(v.status, 'ready');
  assert.equal(v.plan.decision.kind, 'release');
  assert.equal(v.plan.decision.build.cut, 'contour');
  assert.equal(v.proposal.status, 'prepared');
  assert.ok(v.proposal.verification.checks.every((c: any) => c.pass));
  assert.ok(v.proposal.overlay.loops.length >= 1);
  assert.ok(v.chainOk);
  assert.deepEqual(v.events.map((e: any) => e.type).slice(0, 6), ['received', 'inspected', 'inferred', 'decision-surfaced', 'proposal-preparing', 'proposal-prepared']);
});

test('mutations need the custom header', async () => {
  const v = await jobBySample(op, 'market-stickers');
  const r = await fetch(`${base}/api/jobs/${v.id}/approve`, { method: 'POST', body: '{}' });
  assert.equal(r.status, 403);
});

test('approval is bound to the exact artifact and is idempotent', async () => {
  const v = await jobBySample(op, 'market-stickers');
  const pdf = (await op.get(v.proposal.downloadUrl)).body as Uint8Array;
  assert.equal(createHash('sha256').update(pdf).digest('hex'), v.proposal.artifact_sha256);
  const wrong = await op.post(`/api/jobs/${v.id}/approve`, { proposalId: v.proposal.id, artifactSha256: '0'.repeat(64) });
  assert.equal(wrong.status, 409);
  assert.equal(wrong.body.error, 'artifact-mismatch');
  const ok = await op.post(`/api/jobs/${v.id}/approve`, { proposalId: v.proposal.id, artifactSha256: v.proposal.artifact_sha256 });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.status, 'released');
  assert.equal(ok.body.proposal.status, 'released');
  assert.equal(ok.body.proposal.ticket.artifact.sha256, v.proposal.artifact_sha256);
  assert.match(ok.body.proposal.ticket.note, /does not print/);
  const again = await op.post(`/api/jobs/${v.id}/approve`, { proposalId: v.proposal.id, artifactSha256: v.proposal.artifact_sha256 });
  assert.equal(again.status, 200);
  assert.equal(again.body.events.filter((e: any) => e.type === 'released').length, 1);
  assert.ok(again.body.chainOk);
});

test('wrong guess: correction supersedes the old proposal, is remembered, and carries to a similar job only', async () => {
  const v = await jobBySample(op, 'stickers-final');
  assert.equal(v.prediction.top, 'sticker');
  assert.ok(v.plan.evidence.thin);
  const stale = await op.post(`/api/jobs/${v.id}/decide`, { revision: v.revision - 1, params: { intent: 'poster' } });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error, 'stale');
  const labelsBefore = await jobBySample(op, 'honey-labels');

  const fixed = await op.post(`/api/jobs/${v.id}/decide`, { revision: v.revision, params: { intent: 'poster' } });
  assert.equal(fixed.status, 200);
  await app.service.idle();
  const after1 = (await op.get(`/api/jobs/${v.id}`)).body;
  assert.equal(after1.plan.intent, 'poster');
  assert.equal(after1.plan.intentSource, 'operator');
  assert.ok(after1.history.some((p: any) => p.id === v.proposal.id && p.status === 'superseded'));
  assert.ok(after1.events.some((e: any) => e.type === 'intent-corrected'));
  assert.notEqual(after1.proposal.id, v.proposal.id);
  assert.equal(after1.proposal.build.cut, 'none');

  const old = await op.post(`/api/jobs/${v.id}/approve`, { proposalId: v.proposal.id, artifactSha256: v.proposal.artifact_sha256 });
  assert.equal(old.status, 409);
  assert.equal(old.body.error, 'superseded');

  const s = (await op.get('/api/session')).body;
  assert.equal(s.corrections.length, 1);
  assert.equal(s.corrections[0].to, 'poster');

  // The same kind of file arriving again is now read as a poster by the model (not by the operator).
  await op.post('/api/samples/stickers-final');
  await app.service.idle();
  const repeat = await jobBySample(op, 'stickers-final');
  assert.notEqual(repeat.id, v.id);
  assert.equal(repeat.prediction.top, 'poster');
  assert.equal(repeat.plan.intentSource, 'model');
  assert.ok(repeat.prediction.memory.length >= 1);

  // An unrelated open job keeps its proposal: no collateral revision bump.
  const labelsAfter = await jobBySample(op, 'honey-labels');
  assert.equal(labelsAfter.revision, labelsBefore.revision);
  assert.equal(labelsAfter.proposal.id, labelsBefore.proposal.id);
});

test('sessions are isolated', async () => {
  const v = await jobBySample(op, 'honey-labels');
  const other = client();
  await other.get('/api/session');
  assert.equal((await other.get(`/api/jobs/${v.id}`)).status, 404);
  assert.equal((await other.post(`/api/jobs/${v.id}/approve`, { proposalId: v.proposal.id, artifactSha256: v.proposal.artifact_sha256 })).status, 404);
  assert.equal((await other.get(v.proposal.downloadUrl)).status, 404);
});

test('an execution failure is reported, nothing is released, and retry recovers', async () => {
  const v = await jobBySample(op, 'honey-labels');
  await op.post('/api/test/fail-next-release');
  const r = await op.post(`/api/jobs/${v.id}/approve`, { proposalId: v.proposal.id, artifactSha256: v.proposal.artifact_sha256 });
  assert.equal(r.status, 200);
  assert.equal(r.body.status, 'ready');
  assert.ok(r.body.events.some((e: any) => e.type === 'release-failed'));
  assert.ok(!r.body.events.some((e: any) => e.type === 'released'));
  const retry = await op.post(`/api/jobs/${v.id}/retry`, { revision: r.body.revision });
  assert.equal(retry.status, 200);
  await app.service.idle();
  const v2 = (await op.get(`/api/jobs/${v.id}`)).body;
  assert.equal(v2.proposal.status, 'prepared');
  assert.equal(v2.proposal.artifact_sha256, v.proposal.artifact_sha256, 'deterministic output: same bytes on retry');
  const ok = await op.post(`/api/jobs/${v.id}/approve`, { proposalId: v2.proposal.id, artifactSha256: v2.proposal.artifact_sha256 });
  assert.equal(ok.body.status, 'released');
});

test('return path: soft poster gets a verified notice, approval returns the job', async () => {
  const v = await jobBySample(op, 'soft-poster');
  assert.equal(v.plan.decision.kind, 'return');
  assert.equal(v.proposal.kind, 'return-notice');
  assert.equal(v.proposal.status, 'prepared');
  const ok = await op.post(`/api/jobs/${v.id}/approve`, { proposalId: v.proposal.id, artifactSha256: v.proposal.artifact_sha256 });
  assert.equal(ok.body.status, 'returned');
});

test('bad input is refused before any parsing work', async () => {
  const junk = await op.post('/api/jobs', new TextEncoder().encode('#!/bin/sh\necho hi\n'), { 'x-filename': 'run.sh' });
  assert.equal(junk.status, 415);
  const big = await op.post('/api/jobs', new Uint8Array(10 * 1024 * 1024 + 1), { 'x-filename': 'big.pdf' });
  assert.equal(big.status, 413);
  const params = await op.post(`/api/jobs/${(await jobBySample(op, 'stickers-final')).id}/decide`, { revision: 1, params: { offsetMm: 99 } });
  assert.equal(params.status, 400);
});

test('duplicate submission: the same file twice is two jobs; double-clicked approval releases once', async () => {
  const a = await op.post('/api/samples/market-stickers');
  const b = await op.post('/api/samples/market-stickers');
  assert.notEqual(a.body.id, b.body.id);
  await app.service.idle();
  const v = (await op.get(`/api/jobs/${a.body.id}`)).body;
  const body = { proposalId: v.proposal.id, artifactSha256: v.proposal.artifact_sha256 };
  const [r1, r2] = await Promise.all([op.post(`/api/jobs/${v.id}/approve`, body), op.post(`/api/jobs/${v.id}/approve`, body)]);
  assert.deepEqual([r1.status, r2.status], [200, 200]);
  const after = (await op.get(`/api/jobs/${v.id}`)).body;
  assert.equal(after.status, 'released');
  assert.equal(after.events.filter((e: any) => e.type === 'released').length, 1);
  assert.equal(after.events.filter((e: any) => e.type === 'approved').length, 1);
});

test('approval after the job changed is refused (intake edited under a prepared proposal)', async () => {
  const id = (await op.post('/api/samples/market-stickers')).body.id;
  await app.service.idle();
  const v = (await op.get(`/api/jobs/${id}`)).body;
  const edited = await op.post(`/api/jobs/${id}/intake`, { revision: v.revision, intake: { qty: 5000 } });
  assert.equal(edited.status, 200);
  await app.service.idle();
  const r = await op.post(`/api/jobs/${id}/approve`, { proposalId: v.proposal.id, artifactSha256: v.proposal.artifact_sha256 });
  assert.equal(r.status, 409);
  assert.equal(r.body.error, 'superseded');
  const now = (await op.get(`/api/jobs/${id}`)).body;
  assert.equal(now.intake.qty, 5000);
  assert.notEqual(now.proposal.id, v.proposal.id);
  assert.ok(now.events.some((e: any) => e.type === 'approval-refused'));
});

test('"Use RollCue\'s reading again" withdraws the correction, so memory no longer answers for the job (Codex R1-5)', async () => {
  const c = client();
  await c.get('/api/session');
  await app.service.idle();
  const v = await jobBySample(c, 'stickers-final');
  const fixed = await c.post(`/api/jobs/${v.id}/decide`, { revision: v.revision, params: { intent: 'poster' } });
  assert.equal(fixed.status, 200);
  await app.service.idle();
  assert.equal((await c.get('/api/session')).body.corrections.length, 1);
  const cur = (await c.get(`/api/jobs/${v.id}`)).body;
  const back = await c.post(`/api/jobs/${v.id}/decide`, { revision: cur.revision, params: { intent: null } });
  assert.equal(back.status, 200);
  await app.service.idle();
  const after = (await c.get(`/api/jobs/${v.id}`)).body;
  assert.equal(after.plan.intent, 'sticker');
  assert.equal(after.plan.intentSource, 'model');
  assert.equal(after.prediction.memory.length, 0);
  assert.equal((await c.get('/api/session')).body.corrections.length, 0);
  assert.ok(after.events.some((e: any) => e.type === 'correction-withdrawn'));
});

test('a proposal prepared under an older policy or model version cannot be approved; a tampered artifact neither', async () => {
  const id = (await op.post('/api/samples/honey-labels')).body.id;
  await app.service.idle();
  const v = (await op.get(`/api/jobs/${id}`)).body;
  const body = { proposalId: v.proposal.id, artifactSha256: v.proposal.artifact_sha256 };
  await app.service.db.q(`update proposals set policy_version = 'policy-old' where id = $1`, [v.proposal.id]);
  const r = await op.post(`/api/jobs/${id}/approve`, body);
  assert.equal(r.status, 409);
  assert.equal(r.body.error, 'policy-changed');
  await app.service.db.q(`update proposals set policy_version = $2, artifact = $3 where id = $1`, [v.proposal.id, v.proposal.policy_version, new Uint8Array([37, 80, 68, 70])]);
  const t = await op.post(`/api/jobs/${id}/approve`, body);
  assert.equal(t.status, 409);
  assert.equal(t.body.error, 'binding-mismatch');
  const after = (await op.get(`/api/jobs/${id}`)).body;
  assert.equal(after.status, 'ready');
  assert.equal(after.events.filter((e: any) => e.type === 'approval-refused').length, 2);
});

test('a broken PDF fails cleanly inside the worker', async () => {
  const r = await op.post('/api/jobs', new TextEncoder().encode('%PDF-1.7\n1 0 obj << /Type /Catalog >> endobj\ntrailer << >>\n%%EOF'), { 'x-filename': 'broken.pdf' });
  assert.equal(r.status, 201);
  await app.service.idle();
  const v = (await op.get(`/api/jobs/${r.body.id}`)).body;
  assert.equal(v.status, 'failed');
  assert.ok(v.events.some((e: any) => e.type === 'input-rejected'));
  assert.equal(v.proposal, null);
});
