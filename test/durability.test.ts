// Restart while approval is pending: state lives in the database, not in memory. A prepared proposal survives a restart
// and can still be approved; a job interrupted mid-analysis is picked up again; the session cookie still works.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { start } from '../src/main.ts';

test('restart preserves pending approvals and resumes interrupted work', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rc-dur-'));
  const dir = path.join(root, 'data', 'pglite'); // missing parents, as in a fresh clone
  let app = await start({ dbDir: dir });
  try {
    let base = `http://127.0.0.1:${app.port}`;
    const s = await fetch(`${base}/api/session`);
    const cookie = s.headers.get('set-cookie')!.split(';')[0];
    const h = { cookie, 'x-rollcue': '1', 'content-type': 'application/json' };
    await app.service.idle();
    const jobs = await (await fetch(`${base}/api/jobs`, { headers: h })).json();
    const sticker = jobs.find((j: any) => j.sample === 'market-stickers');
    const before = await (await fetch(`${base}/api/jobs/${sticker.id}`, { headers: h })).json();
    assert.equal(before.proposal.status, 'prepared');

    // A job that is mid-analysis when the process dies.
    const mid = await (await fetch(`${base}/api/samples/honey-labels`, { method: 'POST', headers: h })).json();
    await app.service.idle();
    await app.service.db.q(`update jobs set status = 'analysing', inspection = null, plan = null where id = $1`, [mid.id]);
    await app.close();

    app = await start({ dbDir: dir });
    base = `http://127.0.0.1:${app.port}`;
    assert.ok(app.recovered.analysing >= 1);
    await app.service.idle();
    const after = await (await fetch(`${base}/api/jobs/${sticker.id}`, { headers: h })).json();
    assert.equal(after.proposal.id, before.proposal.id);
    assert.equal(after.proposal.artifact_sha256, before.proposal.artifact_sha256);
    assert.ok(after.chainOk);
    const ok = await fetch(`${base}/api/jobs/${sticker.id}/approve`, { method: 'POST', headers: h, body: JSON.stringify({ proposalId: before.proposal.id, artifactSha256: before.proposal.artifact_sha256 }) });
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).status, 'released');
    const resumed = await (await fetch(`${base}/api/jobs/${mid.id}`, { headers: h })).json();
    assert.equal(resumed.status, 'ready');
    assert.equal(resumed.proposal.status, 'prepared');
  } finally {
    await app.close().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
});
