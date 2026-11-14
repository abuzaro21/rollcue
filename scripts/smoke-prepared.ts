// Used by docker-smoke.sh: a new session's four seeded jobs must each reach a prepared proposal whose verification
// checks all pass, not merely a ready job (Codex R8-7). Usage: node scripts/smoke-prepared.ts <base-url>
const base = process.argv[2];
const h = { 'x-rollcue': '1', cookie: '' };
const s = await fetch(`${base}/api/session`, { headers: h });
if (s.status !== 200) throw new Error(`session: ${s.status}`);
h.cookie = (s.headers.get('set-cookie') ?? '').split(';')[0];
const get = async (p: string) => (await fetch(base + p, { headers: h })).json();
let good = 0, states: string[] = [];
for (let i = 0; i < 90; i++) {
  const jobs = await get('/api/jobs') as { id: string }[];
  const views = await Promise.all(jobs.map((j) => get(`/api/jobs/${j.id}`)));
  states = views.map((v) => `${v.filename}:${v.proposal?.status ?? 'none'}`);
  good = views.filter((v) => v.proposal?.status === 'prepared' && v.proposal.verification?.checks?.length && v.proposal.verification.checks.every((c: { pass: boolean }) => c.pass)).length;
  if (good >= 4 || views.some((v) => v.proposal?.status === 'failed')) break;
  await new Promise((r) => setTimeout(r, 1000));
}
console.log(`prepared and verified: ${good} (${states.join(', ')})`);
if (good < 4) process.exit(1);
