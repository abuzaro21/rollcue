// Live verification against a deployed URL. Usage:
//   node scripts/live-check.ts <base-url> checks <state-file>   all checks; leaves one prepared job pending
//   node scripts/live-check.ts <base-url> resume <state-file>   after a restart: the pending job is still there and approvable
// The state file holds a session cookie, so keep it outside the repository. Prints one line per check, exits 1 on any failure.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { pdfStructure } from '../src/inspect.ts';

const [base, mode, stateFile] = process.argv.slice(2);
if (!base || !['checks', 'resume'].includes(mode) || !stateFile) { console.error('usage: live-check.ts <base-url> checks|resume <state-file>'); process.exit(2); }

let failed = 0;
const check = (ok: boolean, name: string, detail = '') => { if (!ok) failed++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? '  ' + detail : ''}`); };
const seen: string[] = []; // every response body and header, scanned for secrets at the end

function client(cookie = '') {
  const call = async (method: string, p: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(base + p, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { ...(cookie ? { cookie } : {}), 'x-rollcue': '1', 'content-type': 'application/json', ...headers } });
    const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    const ct = res.headers.get('content-type') ?? '';
    const out = ct.includes('json') ? await res.json() : new Uint8Array(await res.arrayBuffer());
    seen.push(JSON.stringify([...res.headers]), ct.includes('json') ? JSON.stringify(out) : Buffer.from(out as Uint8Array).toString('latin1')); // binary bodies too (Codex R8-8)
    return { status: res.status, headers: res.headers, body: out as any };
  };
  return { call, get: (p: string) => call('GET', p), post: (p: string, b: unknown = {}) => call('POST', p, b), cookie: () => cookie };
}
type C = ReturnType<typeof client>;

// The free instance is slow and may be waking up; wait for the worker rather than assume timings.
async function prepared(c: C, sample: string, timeoutMs = 180_000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const jobs = (await c.get('/api/jobs')).body as any[];
    const j = jobs.filter((x) => x.sample === sample).at(-1);
    if (j) { const v = (await c.get(`/api/jobs/${j.id}`)).body; if (v.proposal?.status === 'prepared') return v; }
    if (Date.now() > end) throw new Error(`${sample}: no prepared proposal after ${timeoutMs / 1000} s`);
    await new Promise((r) => setTimeout(r, 2000));
  }
}

if (mode === 'checks') {
  const health = await fetch(base + '/healthz');
  check(base.startsWith('https://') && health.ok, 'HTTPS health', `${health.status}`);
  const plain = await fetch(base.replace('https://', 'http://') + '/healthz', { redirect: 'manual' });
  check(plain.status >= 300 && plain.status < 400 && (plain.headers.get('location') ?? '').startsWith('https://'), 'plain HTTP redirects to HTTPS', `${plain.status}`);
  const page = await fetch(base + '/');
  const html = await page.text();
  check(page.ok && /Try a sample job/i.test(html + (await bundle(html))), 'page served; "Try a sample job" present');
  check(page.headers.get('x-frame-options') === 'DENY' && !!page.headers.get('content-security-policy'), 'security headers', `xfo=${page.headers.get('x-frame-options')}`);

  const noHeader = await fetch(base + '/api/session');
  check(noHeader.status === 403, 'session refused without the x-rollcue header', `${noHeader.status}`);

  const op = client();
  const s = await op.get('/api/session');
  check(s.status === 200 && s.body.jobs.length >= 4, 'first visit seeds sample jobs', `${s.body.jobs?.length} jobs`);
  if (s.status !== 200) { console.log(`stopping: session start answered ${s.status} ${s.body.error ?? ''} (a 429 means this address's session budget is spent; wait a few minutes)`); process.exit(1); }
  const sticker = await prepared(op, 'market-stickers');
  check(sticker.events.some((e: any) => e.type === 'proposal-prepared') && !sticker.events.some((e: any) => e.type === 'approved'), 'proactive: prepared before the operator acted');
  check(sticker.prediction?.top === 'sticker' && sticker.plan.intentSource === 'model', 'inference: market-stickers read as stickers by the model', `${sticker.prediction?.top} p=${sticker.prediction?.probs?.sticker?.toFixed?.(2) ?? '?'}`);

  const pdf = (await op.get(sticker.proposal.downloadUrl)).body as Uint8Array;
  check(createHash('sha256').update(pdf).digest('hex') === sticker.proposal.artifact_sha256, 'artifact bytes match the proposal hash');
  const wrong = await op.post(`/api/jobs/${sticker.id}/approve`, { proposalId: sticker.proposal.id, artifactSha256: '0'.repeat(64) });
  check(wrong.status === 409, 'approval bound to the artifact hash', `${wrong.status} ${wrong.body.error}`);
  const ok = await op.post(`/api/jobs/${sticker.id}/approve`, { proposalId: sticker.proposal.id, artifactSha256: sticker.proposal.artifact_sha256 });
  check(ok.status === 200 && ok.body.status === 'released' && ok.body.proposal.ticket.verification.every((c: any) => c.pass), 'approval releases a verified ticket', `${ok.status} ${ok.body.status}`);
  // The same structural reader the release gate uses: a separation named exactly CutContour that is stroked, closed and painted (Codex R8-8).
  const st = await pdfStructure(pdf).catch(() => null);
  check(!!st && st.pages >= 1 && !!st.cut?.exactName && st.cut.stroked && !st.cut.filled && !st.cut.hidden && st.cut.loops > 0 && st.cut.openLoops === 0, 'released artifact parses and strokes a closed CutContour separation', st ? `${st.pages} page(s), ${st.cut?.loops ?? 0} cut loop(s)` : 'unreadable');

  const amb = await prepared(op, 'stickers-final');
  check(amb.prediction?.top === 'sticker' && amb.plan.evidence.thin === true, 'ambiguous intent flagged as thin evidence');
  const fix = await op.post(`/api/jobs/${amb.id}/decide`, { revision: amb.revision, params: { intent: 'poster' } });
  check(fix.status === 200, 'correction accepted', `${fix.status}`);
  const fixed = await prepared(op, 'stickers-final');
  check(fixed.plan.intent === 'poster' && fixed.plan.intentSource === 'operator' && fixed.proposal.id !== amb.proposal.id && fixed.history.some((p: any) => p.id === amb.proposal.id && p.status === 'superseded'), 'correction re-prepares and supersedes the old proposal');
  const stale = await op.post(`/api/jobs/${amb.id}/approve`, { proposalId: amb.proposal.id, artifactSha256: amb.proposal.artifact_sha256 });
  check(stale.status === 409 && stale.body.error === 'superseded', 'superseded proposal cannot be approved', `${stale.status} ${stale.body.error}`);

  const other = client();
  await other.get('/api/session');
  const iso = [(await other.get(`/api/jobs/${sticker.id}`)).status, (await other.get(sticker.proposal.downloadUrl)).status, (await other.post(`/api/jobs/${fixed.id}/approve`, { proposalId: fixed.proposal.id, artifactSha256: fixed.proposal.artifact_sha256 })).status];
  check(iso.every((x) => x === 404), 'another session cannot see, download or approve', iso.join(','));

  const pending = await prepared(op, 'honey-labels');
  writeFileSync(stateFile, JSON.stringify({ cookie: op.cookie(), jobId: pending.id, proposalId: pending.proposal.id, sha: pending.proposal.artifact_sha256 }));
  check(true, 'left honey-labels prepared and pending for the restart check');

  const burst = await Promise.all(Array.from({ length: 150 }, () => other.get('/api/jobs').then((r) => r.status)));
  check(burst.includes(429), 'rate limit answers a burst with 429', `${burst.filter((x) => x === 429).length}/150 limited`);

  const secrets = /postgres(ql)?:\/\/|DATABASE_URL|dpg-[a-z0-9]{10}|rnd_[A-Za-z0-9]{8}|BEGIN [A-Z ]*PRIVATE KEY/;
  check(!secrets.test(seen.join('\n') + html + (await bundle(html))), 'no secrets in responses, headers or the client bundle');
} else {
  const st = JSON.parse(readFileSync(stateFile, 'utf8'));
  const op = client(st.cookie);
  const v = (await op.get(`/api/jobs/${st.jobId}`)).body;
  check(v.proposal?.id === st.proposalId && v.proposal.status === 'prepared' && v.chainOk, 'after restart: session, job and prepared proposal are intact', `${v.proposal?.status}`);
  const r = await op.post(`/api/jobs/${st.jobId}/approve`, { proposalId: st.proposalId, artifactSha256: st.sha });
  check(r.status === 200 && r.body.status === 'released', 'after restart: the pending proposal is approved and released', `${r.status} ${r.body.status}`);
}

async function bundle(html: string) {
  const srcs = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+\.(?:js|css))"/g)].map((m) => m[1]);
  return (await Promise.all(srcs.map((s) => fetch(base + s).then((r) => r.text())))).join('\n');
}

console.log(failed ? `${failed} check(s) failed` : 'all checks passed');
process.exit(failed ? 1 : 0);
