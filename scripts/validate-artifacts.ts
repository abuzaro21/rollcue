// Artifact validation: every sample goes through the real service over HTTP (inference, preparation, approval,
// release), then the released file is checked independently of the service's own verifier: hash matches the
// approval, pdf-lib re-parses it, and Ghostscript's tiffsep device finds a CutContour plate exactly when a cut was
// planned. RC_REQUIRE_GS=1 makes a missing Ghostscript a failure instead of a skip (CI sets it).
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { PDFDocument } from 'pdf-lib';
import { start } from '../src/main.ts';
import { ghostscriptPlates } from '../test/gs.ts';

const EXPECT: Record<string, 'release' | 'return'> = {
  'market-stickers': 'release', 'stickers-final': 'release', 'honey-labels': 'release', 'soft-poster': 'return',
  'shop-banner': 'release', 'jam-labels-misnamed': 'release', 'misnamed-cut': 'return',
};
const requireGs = process.env.RC_REQUIRE_GS === '1';
const app = await start({});
const base = `http://127.0.0.1:${app.port}`;
let cookie = '';
const call = async (method: string, p: string, body?: unknown) => {
  const r = await fetch(base + p, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { ...(cookie ? { cookie } : {}), 'x-rollcue': '1', 'content-type': 'application/json' } });
  const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  return (r.headers.get('content-type') ?? '').includes('json') ? r.json() : new Uint8Array(await r.arrayBuffer());
};

const rows: Record<string, unknown>[] = [];
let failed = 0;
try {
  await call('GET', '/api/session');
  await app.service.idle();
  for (const id of Object.keys(EXPECT)) {
    const fails: string[] = [];
    const check = (ok: boolean, msg: string) => { if (!ok) fails.push(msg); };
    let jobs = await call('GET', '/api/jobs') as any[];
    if (!jobs.some((j) => j.sample === id)) { await call('POST', `/api/samples/${id}`); await app.service.idle(); jobs = await call('GET', '/api/jobs') as any[]; }
    const v = await call('GET', `/api/jobs/${jobs.filter((j) => j.sample === id).at(-1).id}`) as any;
    check(v.proposal?.status === 'prepared', `proposal ${v.proposal?.status}`);
    check(v.plan?.decision.kind === EXPECT[id], `decision ${v.plan?.decision.kind}, expected ${EXPECT[id]}`);
    const done = await call('POST', `/api/jobs/${v.id}/approve`, { proposalId: v.proposal.id, artifactSha256: v.proposal.artifact_sha256 }) as any;
    check(done.status === (EXPECT[id] === 'release' ? 'released' : 'returned'), `job ${done.status}`);
    const t = done.proposal?.ticket;
    check(!!t && t.verification.every((c: any) => c.pass), 'service verification');
    const bytes = await call('GET', v.proposal.downloadUrl) as Uint8Array;
    check(createHash('sha256').update(bytes).digest('hex') === v.proposal.artifact_sha256, 'released bytes differ from approved hash');
    let pages = 0;
    try { pages = (await PDFDocument.load(bytes)).getPageCount(); } catch (e) { check(false, `pdf-lib: ${(e as Error).message}`); }
    check(pages >= 1, 'no pages');
    const cut = v.proposal.build?.cut ?? 'none';
    const plates = await ghostscriptPlates(bytes);
    if (plates === null) check(!requireGs, 'ghostscript required but not available');
    else check(plates.includes('CutContour') === (EXPECT[id] === 'release' && cut !== 'none'), `plates [${plates.join(', ')}] vs cut ${cut}`);
    rows.push({ sample: id, intent: v.proposal.intent, decision: v.plan?.decision.kind, cut, pages, sha256: v.proposal.artifact_sha256.slice(0, 16), verifiedChecks: t?.verification.length ?? 0, plates, pass: fails.length === 0, fails });
    if (fails.length) failed++;
    console.log(`${fails.length ? 'FAIL' : 'ok  '} ${id.padEnd(20)} ${String(v.plan?.decision.kind).padEnd(8)} cut=${cut.padEnd(8)} plates=${plates ? plates.join('|') : 'skipped'}${fails.length ? '  ' + fails.join('; ') : ''}`);
  }
} finally { await app.close(); }
mkdirSync('docs/evidence', { recursive: true });
writeFileSync('docs/evidence/artifact-validation.json', JSON.stringify({ ghostscript: rows.every((r) => r.plates !== null), samples: rows }, null, 2) + '\n');
console.log(`${rows.length - failed}/${rows.length} samples valid`);
process.exit(failed ? 1 : 0);
