import type { JobView, JobSummary } from '../../src/service.ts';
import type { Intake } from '../../src/features.ts';
import type { Params } from '../../src/policy.ts';
export type { JobView, JobSummary };

export type Session = {
  roll: { rollWidthMm: number; sideMarginMm: number };
  samples: Array<{ id: string; title: string; story: string; context?: string }>;
  jobs: JobSummary[];
  corrections: Array<{ jobId: string; filename: string; from: string | null; to: string; at: string }>;
  testHooks: boolean;
};

export class ApiError extends Error {
  status: number; code: string;
  constructor(status: number, code: string, message: string) { super(message); this.status = status; this.code = code; }
}

async function call<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
  const raw = body instanceof Blob || body instanceof ArrayBuffer;
  const res = await fetch(path, {
    method, credentials: 'same-origin',
    headers: { ...(method !== 'GET' ? { 'x-rollcue': '1' } : {}), ...(body !== undefined && !raw ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body === undefined ? undefined : raw ? (body as BodyInit) : JSON.stringify(body),
  });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error ?? 'error', data.message ?? `Request failed (${res.status}).`);
  return data as T;
}

export const api = {
  session: () => call<Session>('GET', '/api/session'),
  jobs: () => call<JobSummary[]>('GET', '/api/jobs'),
  job: (id: string) => call<JobView>('GET', `/api/jobs/${id}`),
  sample: (id: string) => call<{ id: string }>('POST', `/api/samples/${id}`),
  upload: (file: File, intake: Partial<Intake>) =>
    call<{ id: string }>('POST', '/api/jobs', file, { 'x-filename': encodeURIComponent(file.name), 'x-intake': encodeURIComponent(JSON.stringify(intake)), 'content-type': 'application/octet-stream' }),
  decide: (j: JobView, params: Params & { intent?: string | null }, manual = false) => call<JobView>('POST', `/api/jobs/${j.id}/decide`, { revision: j.revision, params, manual }),
  intake: (j: JobView, intake: Partial<Intake>) => call<JobView>('POST', `/api/jobs/${j.id}/intake`, { revision: j.revision, intake }),
  approve: (j: JobView) => call<JobView>('POST', `/api/jobs/${j.id}/approve`, { proposalId: j.proposal!.id, artifactSha256: j.proposal!.artifact_sha256 }),
  retry: (j: JobView) => call<JobView>('POST', `/api/jobs/${j.id}/retry`, { revision: j.revision }),
  reject: (j: JobView, reason?: string) => call<JobView>('POST', `/api/jobs/${j.id}/reject`, { revision: j.revision, reason }),
  forget: () => call<{ ok: true }>('POST', '/api/memory/forget'),
  roll: (rollWidthMm: number) => call<{ roll: Session['roll'] }>('POST', '/api/roll', { rollWidthMm }),
  failNext: () => call<{ ok: true }>('POST', '/api/test/fail-next-release'),
  metric: (surface: 'decision' | 'legacy', jobId: string, data: Record<string, unknown>) => call<void>('POST', '/api/metrics', { surface, jobId, data }).catch(() => undefined),
};

/** A job is "working" while the server is still reading it or building its proposal. */
export const isWorking = (j: JobView | null) =>
  !!j && (j.status === 'analysing' || (j.status === 'ready' && (!j.plan || j.proposal?.status === 'preparing' || (j.proposal?.status === 'approved' && j.proposal.executing) || ((j.plan.decision.kind === 'release' || j.plan.decision.kind === 'return') && !j.proposal))));

/** Counts the operator's physical work on a surface, for the side-by-side comparison. */
export function interactionCounter() {
  const c = { clicks: 0, keys: 0, fields: 0, screens: 1, started: performance.now() };
  const onClick = (e: MouseEvent) => { if ((e.target as Element).closest('button, a, input, select, label, [role=tab], [role=radio]')) c.clicks++; };
  const onKey = () => { c.keys++; };
  const onChange = () => { c.fields++; };
  addEventListener('click', onClick, true); addEventListener('keydown', onKey, true); addEventListener('change', onChange, true);
  return {
    counts: c,
    screen() { c.screens++; },
    snapshot() { return { clicks: c.clicks, keys: c.keys, fields: c.fields, screens: c.screens, seconds: Math.round((performance.now() - c.started) / 100) / 10 }; },
    reset() { Object.assign(c, { clicks: 0, keys: 0, fields: 0, screens: 1, started: performance.now() }); },
  };
}
