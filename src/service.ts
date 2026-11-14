// The job lifecycle. Separate, persisted states: inspected → inferred → planned → proposal prepared (artifact built and
// verified) → approved (bound to exact bytes and versions) → released (re-verified). Every operator change bumps the
// job revision and supersedes open proposals in the same transaction; workers that finish late cannot publish.
import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Db, Q } from './db.ts';
import { Pool, TaskError } from './pool.ts';
import { featurize, INTENTS, MEDIA, INTENT_LABEL, type Intake, type Intent } from './features.ts';
import { predict, memoryOf, type ModelFile, type Prediction } from './model.ts';
import { plan, POLICY_VERSION, PARAM_LIMITS, type Params, type Plan } from './policy.ts';

// Everything the decision card shows (text, layout, notice, check details) counts; otherwise the operator could approve
// a view that no longer matches the bound proposal (Codex R4-1).
const signature = (x: Plan | null) => canon([x?.intent, x?.intentSource, x?.decision, x?.checks]);
import { sniff, MAX_BYTES } from './inspect.ts';
import { DEFAULT_ROLL, type RollSettings } from './layout.ts';
import type { AnalyseResult, PrepareResult, PrepareTask } from './worker.ts';
import type { Check } from './pdfout.ts';

export const MAX_JOBS_PER_SESSION = 30;
export const RETENTION_HOURS = 48;
const EMPTY = new Uint8Array(0);
export const MAX_SESSIONS = 5000; // all live sessions on the instance
const MAX_REVISIONS = 200; // changes per job
const MAX_METRICS = 200; // client metrics per session
const MAX_REFUSALS = 50; // refused approvals logged per job

export class HttpError extends Error {
  status: number; code: string;
  constructor(status: number, code: string, message: string) { super(message); this.status = status; this.code = code; }
}

const id = () => randomBytes(9).toString('base64url');
const sha = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');
/** Canonical JSON: sorted keys, so equal values always hash equally. */
export const canon = (v: unknown): string =>
  v === null || typeof v !== 'object' ? JSON.stringify(v) ?? 'null'
    : Array.isArray(v) ? `[${v.map(canon).join(',')}]`
      : `{${Object.keys(v as object).filter((k) => (v as Record<string, unknown>)[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canon((v as Record<string, unknown>)[k])}`).join(',')}}`;

type JobRow = {
  id: string; session_id: string; created_at: Date; filename: string; sample: string | null; kind: string; source: Uint8Array; source_sha256: string;
  intake: Intake; params: Params; revision: number; status: string; error: string | null; inspection: AnalyseResult['inspection'] | null;
  features: number[] | null; preview: Uint8Array | null; prediction: Prediction | null; plan: Plan | null;
};
type ProposalRow = {
  id: string; job_id: string; revision: number; created_at: Date; status: string; kind: string; intent: string | null; build: unknown; decision: Plan['decision'] | null; params: Params; params_hash: string;
  policy_version: string; model_version: string; memory_version: string; artifact: Uint8Array | null; artifact_sha256: string | null; preview: Uint8Array | null;
  verification: { checks: Check[]; contour: PrepareResult['contour']; expect?: PrepareResult['expect'] } | null; overlay: PrepareResult['overlay']; binding_hash: string | null;
  approved_at: Date | null; approved_by: string | null; released_at: Date | null; ticket: Record<string, unknown> | null; error: string | null;
};

const OPEN_PROPOSAL = `status in ('preparing','prepared','approved')`;
const CLOSED_JOB = ['released', 'returned', 'rejected'];

export function bindingHash(j: { id: string; source_sha256: string; revision: number }, p: Pick<ProposalRow, 'id' | 'kind' | 'params_hash' | 'artifact_sha256' | 'policy_version' | 'model_version' | 'memory_version'>): string {
  return sha(canon([j.id, j.source_sha256, j.revision, p.id, p.kind, p.params_hash, p.artifact_sha256, p.policy_version, p.model_version, p.memory_version]));
}

export function validateParams(raw: unknown): Params & { intent?: Intent | null } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new HttpError(400, 'bad-params', 'Parameters must be an object.');
  const out: Record<string, unknown> = {};
  const num = (k: string, [lo, hi]: readonly [number, number]) => {
    const v = (raw as Record<string, unknown>)[k];
    if (v === undefined) return;
    if (v === null && k.startsWith('target')) { out[k] = null; return; } // clears an operator-chosen size
    if (typeof v !== 'number' || !Number.isFinite(v) || v < lo || v > hi) throw new HttpError(400, 'bad-params', `${k} must be between ${lo} and ${hi}.`);
    out[k] = Math.round(v * 10) / 10;
  };
  for (const k of Object.keys(raw)) if (!['intent', 'targetW', 'targetH', 'fit', 'offsetMm', 'radiusMm', 'acceptLowRes', 'rectCut'].includes(k)) throw new HttpError(400, 'bad-params', `Unknown parameter ${k}.`);
  const r = raw as Record<string, unknown>;
  if ('intent' in r) { if (r.intent !== null && !INTENTS.includes(r.intent as Intent)) throw new HttpError(400, 'bad-params', 'Unknown intent.'); out.intent = r.intent; }
  num('targetW', PARAM_LIMITS.target); num('targetH', PARAM_LIMITS.target); num('offsetMm', PARAM_LIMITS.offsetMm); num('radiusMm', PARAM_LIMITS.radiusMm);
  if (('targetW' in out) !== ('targetH' in out)) throw new HttpError(400, 'bad-params', 'targetW and targetH go together.');
  if ('fit' in r) { if (r.fit !== 'fit' && r.fit !== 'fill') throw new HttpError(400, 'bad-params', 'fit must be fit or fill.'); out.fit = r.fit; }
  for (const k of ['acceptLowRes', 'rectCut']) if (k in r) { if (typeof r[k] !== 'boolean') throw new HttpError(400, 'bad-params', `${k} must be true or false.`); out[k] = r[k]; }
  return out as Params;
}

export function validateIntake(raw: unknown, filename: string): Intake {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const pos = (v: unknown, max: number) => (typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= max ? Math.round(v * 10) / 10 : null);
  const media = typeof r.media === 'string' && (MEDIA as readonly string[]).includes(r.media) ? (r.media as Intake['media']) : null;
  const notes = typeof r.notes === 'string' ? r.notes.slice(0, 600) : '';
  return { filename: cleanName(filename), qty: pos(r.qty, 1_000_000) && Math.round(r.qty as number), reqW: pos(r.reqW, 5000), reqH: pos(r.reqH, 5000), media, notes };
}

/** Display-only filename: never used as a path. */
export const cleanName = (s: string) => (s.replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, '_').replace(/^\.+/, '').trim().slice(0, 120) || 'upload');

export type Sample = { id: string; title: string; story: string; context?: string; file: string; seed?: boolean; intake: Omit<Intake, 'filename'> & { filename?: string } };

export type ServiceOpts = { db: Db; pool: Pool; model: ModelFile; samplesDir: string; now?: () => Date };

export class Service {
  db: Db; pool: Pool; model: ModelFile; samplesDir: string; now: () => Date;
  failNextRelease = false; // test hook: simulate an execution failure
  slowNextPrepareMs = 0; // test hook: hold the next preparation open
  #executing = new Set<string>();
  #reserved = 0; // proposals whose release is running in this process
  #pending = new Set<Promise<unknown>>();
  #samples: Sample[] | null = null;

  constructor(o: ServiceOpts) { this.db = o.db; this.pool = o.pool; this.model = o.model; this.samplesDir = o.samplesDir; this.now = o.now ?? (() => new Date()); }

  /** Wait for background analysis/preparation (tests, graceful shutdown). */
  async idle() { while (this.#pending.size) await Promise.allSettled([...this.#pending]); }
  #bg(p: Promise<unknown>) { const t = p.catch((e) => console.error('[rollcue] background task failed', e)).finally(() => this.#pending.delete(t)); this.#pending.add(t); }

  // ---------- sessions ----------

  async session(sid: string | null, create = true): Promise<{ id: string; created: boolean; roll: RollSettings } | null> {
    if (sid && /^[A-Za-z0-9_-]{20,64}$/.test(sid)) {
      const [s] = await this.db.q<{ id: string; roll: RollSettings }>(`update sessions set last_seen = now() where id = $1 and created_at > now() - interval '${RETENTION_HOURS} hours' returning id, roll`, [sid]);
      if (s) return { ...s, created: false };
    }
    if (!create) return null;
    const [{ n }] = await this.db.q<{ n: number }>('select count(*)::int as n from sessions');
    if (n >= MAX_SESSIONS) throw new HttpError(503, 'busy', 'RollCue has too many visitors right now. Try again later.');
    const nid = randomBytes(24).toString('base64url');
    await this.db.q('insert into sessions (id, roll) values ($1, $2::jsonb)', [nid, JSON.stringify(DEFAULT_ROLL)]);
    return { id: nid, created: true, roll: DEFAULT_ROLL };
  }

  async setRoll(sid: string, rollWidthMm: unknown) {
    if (typeof rollWidthMm !== 'number' || !Number.isFinite(rollWidthMm) || rollWidthMm < 300 || rollWidthMm > 5000) throw new HttpError(400, 'bad-params', 'Roll width must be between 300 and 5000 mm.');
    const roll = { ...DEFAULT_ROLL, rollWidthMm: Math.round(rollWidthMm) };
    await this.db.q('update sessions set roll = $2::jsonb where id = $1', [sid, JSON.stringify(roll)]);
    await this.#refreshOpenJobs(sid, 'roll-width-changed');
    return roll;
  }

  async memory(sid: string, q: Q = this.db.q) {
    const rows = await q<{ job_id: string; filename: string; intent: Intent; from_intent: string | null; x: number[]; created_at: Date }>('select job_id, filename, intent, from_intent, x, created_at from corrections where session_id = $1 order by id', [sid]);
    return { memory: memoryOf(rows.map((r) => ({ jobId: r.job_id, filename: r.filename, intent: r.intent, x: r.x }))), rows };
  }

  async forgetCorrections(sid: string) {
    await this.db.q('delete from corrections where session_id = $1', [sid]);
    await this.#refreshOpenJobs(sid, 'corrections-forgotten');
  }

  async purgeExpired() {
    // Absolute lifetime: activity does not extend it, so stored work cannot be kept alive indefinitely (Codex R6-8).
    const rows = await this.db.q<{ n: number }>(`with d as (delete from sessions where created_at < now() - interval '${RETENTION_HOURS} hours' returning 1) select count(*)::int as n from d`);
    return rows[0]?.n ?? 0;
  }

  // ---------- samples ----------

  async samples(): Promise<Sample[]> {
    this.#samples ??= JSON.parse(await readFile(path.join(this.samplesDir, 'manifest.json'), 'utf8')).samples as Sample[];
    return this.#samples;
  }

  /** First visit: queue the samples marked `seed`, so the operator arrives to work RollCue has already prepared. */
  /**
   * Takes a worker slot at once, so concurrent requests cannot all pass the capacity check. The slot is given back when
   * the job's analysis is queued (from then on the pool's backlog counts it) or when creating the job fails (Codex R7-2).
   */
  reserve(max: number): (() => void) | null {
    if (this.pool.backlog + this.#reserved >= max) return null;
    this.#reserved++;
    let held = true;
    return () => { if (held) { held = false; this.#reserved--; } };
  }

  /** First visit: queue the samples marked `seed` while capacity lasts; under load a new visitor starts with fewer. */
  async seed(sid: string, max: number) {
    for (const s of (await this.samples()).filter((x) => x.seed)) {
      const slot = this.reserve(max);
      if (!slot) return;
      try { await this.createSample(sid, s.id, slot); } catch (e) { slot(); throw e; }
    }
  }

  async createSample(sid: string, sampleId: unknown, slot?: () => void) {
    const s = (await this.samples()).find((x) => x.id === sampleId);
    if (!s) throw new HttpError(404, 'no-sample', 'Unknown sample.');
    const bytes = new Uint8Array(await readFile(path.join(this.samplesDir, path.basename(s.file))));
    return this.createJob(sid, { bytes, filename: s.intake.filename ?? path.basename(s.file), intake: s.intake, sample: s.id }, slot);
  }

  // ---------- jobs ----------

  async createJob(sid: string, input: { bytes: Uint8Array; filename: string; intake: unknown; sample?: string }, slot?: () => void) {
    if (!input.bytes.length) throw new HttpError(400, 'empty', 'The file is empty.');
    if (input.bytes.length > MAX_BYTES) throw new HttpError(413, 'too-large', `The file is larger than ${MAX_BYTES / 1024 / 1024} MB.`);
    const kind = sniff(input.bytes);
    if (!kind) throw new HttpError(415, 'unsupported', 'Only PDF, PNG and JPEG files are supported.');
    const intake = validateIntake(input.intake, input.filename);
    const jid = id();
    await this.db.tx(async (q) => {
      const [{ n }] = await q<{ n: number }>('select count(*)::int as n from jobs where session_id = $1', [sid]);
      if (n >= MAX_JOBS_PER_SESSION) throw new HttpError(429, 'quota', `This session already has ${MAX_JOBS_PER_SESSION} jobs.`);
      await q(`insert into jobs (id, session_id, filename, sample, kind, source, source_sha256, intake, status) values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,'analysing')`,
        [jid, sid, intake.filename, input.sample ?? null, kind, input.bytes, sha(input.bytes), JSON.stringify(intake)]);
      await this.#event(q, jid, 'received', { filename: intake.filename, bytes: input.bytes.length, kind, sourceSha256: sha(input.bytes), intake, sample: input.sample ?? null });
    });
    this.#bg(this.#analyse(jid, slot));
    return jid;
  }

  async #source(jid: string) {
    const [j] = await this.db.q<{ source: Uint8Array }>('select source from jobs where id = $1', [jid]);
    if (!j) throw new TaskError('internal', 'The job no longer exists.');
    return new Uint8Array(j.source);
  }

  async #analyse(jid: string, slot?: () => void) {
    const [job] = await this.db.q<Pick<JobRow, 'intake'>>('select intake from jobs where id = $1', [jid]).catch((e) => { slot?.(); throw e; });
    if (!job) { slot?.(); return; }
    let res: AnalyseResult;
    try {
      const run = this.pool.run<AnalyseResult>(async () => ({ type: 'analyse', bytes: await this.#source(jid) }));
      slot?.(); // the pool's backlog counts it now
      res = await run;
    } catch (e) {
      slot?.();
      const err = e as TaskError;
      await this.db.tx(async (q) => {
        await q(`update jobs set status = 'failed', error = $2 where id = $1`, [jid, err.message]);
        await this.#event(q, jid, 'input-rejected', { code: err.code ?? 'internal', message: err.message });
      });
      return;
    }
    const features = featurize(res.inspection, job.intake);
    await this.db.tx(async (q) => {
      await q(`update jobs set inspection = $2::jsonb, features = $3::jsonb, preview = $4 where id = $1`, [jid, JSON.stringify(res.inspection), JSON.stringify(features), res.preview]);
      const i = res.inspection;
      await this.#event(q, jid, 'inspected', { kind: i.kind, pages: i.pages, size: i.widthMm ? `${i.widthMm} × ${i.heightMm} mm (${i.sizeSource})` : 'unknown', spots: i.spots, cut: i.cut, transparentFrac: i.mask.transparentFrac, shapes: i.mask.components, ppi: i.densityPpi, warnings: i.warnings });
    });
    await this.#replan(jid, { reason: 'inspected' });
  }

  /**
   * Infer → plan → open a proposal → prepare its artifact in the worker. `bump` increments the revision first (used
   * when something outside the job changed, e.g. session memory). Prepared results from an older revision are discarded.
   */
  async #replan(jid: string, o: { reason: string; bump?: boolean; onlyIfChanged?: boolean }) {
    const prep = await this.#planJob(jid, o);
    if (prep) await this.#prepare(jid, prep.pid, prep.task);
  }

  /** What RollCue would decide now, from the stored job, the session's memory and roll, and the operator's choices. */
  async #freshPlan(q: Q, job: JobRow, params: Params = job.params) {
    const [{ roll }] = await q<{ roll: RollSettings }>('select roll from sessions where id = $1', [job.session_id]);
    const { memory } = await this.memory(job.session_id, q);
    const pred = predict(this.model, job.features!, memory);
    return { pred, p: plan(job.inspection!, job.intake, pred, params, roll) };
  }

  /** The planning half of #replan: one transaction, no worker. Returns the preparation to run, if any. */
  async #planJob(jid: string, o: { reason: string; bump?: boolean; onlyIfChanged?: boolean }) {
    return this.db.tx(async (q) => {
      const [job] = await q<JobRow>('select * from jobs where id = $1 for update', [jid]);
      if (!job || !job.inspection || !job.features || CLOSED_JOB.includes(job.status)) return null;
      let { pred, p } = await this.#freshPlan(q, job);
      // Choices made for one job type (border, fit, size preset, overrides) do not carry to another (Codex R5-2).
      const stale = Object.keys(job.params).filter((k) => k !== 'intent');
      if (job.plan?.intent && p.intent !== job.plan.intent && stale.length) {
        job.params = job.params.intent ? { intent: job.params.intent } : {};
        await q('update jobs set params = $2::jsonb where id = $1', [jid, JSON.stringify(job.params)]);
        await this.#event(q, jid, 'options-reset', { cleared: stale, from: job.plan.intent, to: p.intent });
        ({ pred, p } = await this.#freshPlan(q, job));
      }
      if (o.onlyIfChanged && job.plan && signature(job.plan) === signature(p) && job.prediction?.top === pred.top) {
        await q('update jobs set prediction = $2::jsonb, plan = $3::jsonb where id = $1', [jid, JSON.stringify(pred), JSON.stringify(p)]);
        return null;
      }
      if (o.bump && job.revision >= MAX_REVISIONS) {
        // Session-wide changes count against the same limit as direct ones. At the limit the job is closed, so nothing
        // obsolete stays approvable and nothing more is stored for it (Codex R7-5).
        await this.#supersede(q, jid, o.reason);
        await q(`update jobs set status = 'rejected', error = $2 where id = $1`, [jid, 'Changed too many times. Upload it again to continue.']);
        await this.#event(q, jid, 'change-limit', { reason: o.reason, revision: job.revision });
        return null;
      }
      const revision = job.revision + (o.bump ? 1 : 0);
      // Always: an overlapping replan at the same revision must not leave two approvable proposals (Codex R4-2).
      await this.#supersede(q, jid, o.reason);
      await q(`update jobs set prediction = $2::jsonb, plan = $3::jsonb, revision = $4, status = 'ready', error = null where id = $1`, [jid, JSON.stringify(pred), JSON.stringify(p), revision]);
      await this.#event(q, jid, 'inferred', {
        reason: o.reason, revision, model: pred.modelVersion, memory: pred.memoryVersion, top: pred.top, pTop: pred.pTop, band: pred.band, abstain: pred.abstain,
        ranked: pred.ranked, memoryMatches: pred.memory, evidenceThin: p.evidence.thin, intent: p.intent, intentSource: p.intentSource,
      });
      await this.#event(q, jid, 'decision-surfaced', { kind: p.decision.kind, headline: p.decision.headline, failing: p.checks.filter((c) => c.status === 'fail').map((c) => c.id) });
      if (p.decision.kind !== 'release' && p.decision.kind !== 'return') return null;
      const pid = id();
      const kind = p.decision.kind === 'release' ? 'production' : 'return-notice';
      const params = { intent: p.intent, ...job.params };
      await q(`insert into proposals (id, job_id, revision, status, kind, intent, build, decision, params, params_hash, policy_version, model_version, memory_version) values ($1,$2,$3,'preparing',$4,$5,$6::jsonb,$7::jsonb,$8::jsonb,$9,$10,$11,$12)`,
        [pid, jid, revision, kind, p.intent, JSON.stringify(p.decision.kind === 'release' ? p.decision.build : null), JSON.stringify(p.decision), JSON.stringify(params), sha(canon([params, p.decision])), POLICY_VERSION, this.model.version, pred.memoryVersion]);
      await this.#event(q, jid, 'proposal-preparing', { proposal: pid, kind, revision, initiatedBy: 'rollcue' });
      const task: PrepareTask = p.decision.kind === 'release'
        ? { type: 'prepare-release', kind: job.kind as never, bytes: EMPTY, inspection: job.inspection, preview: EMPTY /* filled when the worker is free */, build: p.decision.build, title: `${job.filename} — ${INTENT_LABEL[p.intent!]}`, subject: `RollCue job ${jid}, source sha256 ${job.source_sha256}`, stamp: job.created_at.toISOString() }
        : { type: 'prepare-notice', filename: job.filename, notice: p.decision.notice, stamp: job.created_at.toISOString() };
      return { pid, task };
    });
  }

  async #prepare(jid: string, pid: string, task: PrepareTask) {
    let res: PrepareResult | null = null, error: string | null = null;
    if (this.slowNextPrepareMs) { const ms = this.slowNextPrepareMs; this.slowNextPrepareMs = 0; await new Promise((ok) => setTimeout(ok, ms)); }
    const load = async (): Promise<PrepareTask> => {
      if (task.type !== 'prepare-release') return task;
      const [j] = await this.db.q<{ source: Uint8Array; preview: Uint8Array }>('select source, preview from jobs where id = $1', [jid]);
      if (!j) throw new TaskError('internal', 'The job no longer exists.');
      return { ...task, bytes: new Uint8Array(j.source), preview: new Uint8Array(j.preview) };
    };
    try { res = await this.pool.run<PrepareResult>(load); } catch (e) { error = (e as Error).message; }
    await this.db.tx(async (q) => {
      const [job] = await q<JobRow>('select id, source_sha256, revision, status from jobs where id = $1 for update', [jid]);
      const [p] = await q<ProposalRow>('select * from proposals where id = $1 for update', [pid]);
      if (!job || !p) return;
      if (p.status !== 'preparing' || p.revision !== job.revision) {
        await this.#event(q, jid, 'stale-result-discarded', { proposal: pid, proposalRevision: p.revision, jobRevision: job.revision });
        if (p.status === 'preparing') await q(`update proposals set status = 'superseded' where id = $1`, [pid]);
        return;
      }
      if (!res) {
        await q(`update proposals set status = 'failed', error = $2 where id = $1`, [pid, error]);
        await this.#event(q, jid, 'proposal-failed', { proposal: pid, error });
        return;
      }
      const ok = res.checks.every((c) => c.pass);
      const binding = bindingHash(job, { ...p, artifact_sha256: res.sha256 });
      await q(`update proposals set status = $2, artifact = $3, artifact_sha256 = $4, preview = $5, verification = $6::jsonb, overlay = $7::jsonb, binding_hash = $8, error = $9 where id = $1`,
        [pid, ok ? 'prepared' : 'failed', res.artifact, res.sha256, res.preview, JSON.stringify({ checks: res.checks, contour: res.contour, expect: res.expect }), JSON.stringify(res.overlay), binding, ok ? null : 'Verification failed.']);
      await this.#event(q, jid, ok ? 'proposal-prepared' : 'proposal-failed', { proposal: pid, artifactSha256: res.sha256, bindingHash: binding, checks: res.checks.map((c) => `${c.pass ? 'pass' : 'FAIL'} ${c.id}`), contour: res.contour });
    });
  }

  async #supersede(q: Q, jid: string, reason: string) {
    // The hashes stay as evidence; the bytes of a proposal nobody can approve are not kept (Codex R6-3).
    const rows = await q<{ id: string; status: string }>(`update proposals set status = 'superseded', artifact = null, preview = null where job_id = $1 and ${OPEN_PROPOSAL} returning id, status`, [jid]);
    for (const r of rows) await this.#event(q, jid, 'proposal-superseded', { proposal: r.id, reason });
  }

  /** Something session-wide changed (memory, roll): re-plan every open job; bump revisions only where the plan moved. */
  async #refreshOpenJobs(sid: string, reason: string, except?: string) {
    const rows = await this.db.q<{ id: string }>(`select id from jobs where session_id = $1 and status = 'ready' order by created_at`, [sid]);
    // Invalidate every affected job first, then prepare: no stale proposal waits behind another job's preparation (Codex R5-1).
    const preps: Array<[string, { pid: string; task: PrepareTask }]> = [];
    for (const r of rows) if (r.id !== except) { const p = await this.#planJob(r.id, { reason, bump: true, onlyIfChanged: true }); if (p) preps.push([r.id, p]); }
    for (const [jid, p] of preps) await this.#prepare(jid, p.pid, p.task);
  }

  async #lockJob(q: Q, sid: string, jid: string) {
    const [job] = await q<JobRow>('select * from jobs where id = $1 and session_id = $2 for update', [jid, sid]);
    if (!job) throw new HttpError(404, 'not-found', 'No such job in this session.');
    return job;
  }

  /** Operator answers the current decision (or corrects the intent, or edits a bounded parameter). */
  async decide(sid: string, jid: string, body: { revision: unknown; params: unknown; manual?: unknown }) {
    const params = validateParams(body.params);
    let corrected = false;
    await this.db.tx(async (q) => {
      const job = await this.#lockJob(q, sid, jid);
      if (CLOSED_JOB.includes(job.status)) throw new HttpError(409, 'closed', `This job is already ${job.status}.`);
      if (job.status !== 'ready') throw new HttpError(409, 'busy', 'This job is still being analysed.');
      if (body.revision !== job.revision) throw new HttpError(409, 'stale', 'The job changed since this view was loaded. Review the current decision.');
      if (job.revision >= MAX_REVISIONS) throw new HttpError(429, 'too-many-changes', 'This job has been changed too many times. Reject it and upload it again.');
      let next: Params = { ...job.params };
      if ('intent' in params) {
        // A new job type invalidates every type-specific choice made so far.
        // Sizes too: a preset chosen for stickers is not a poster size (Codex R5-2).
        next = params.intent ? { intent: params.intent } : {};
      }
      for (const [k, v] of Object.entries(params)) if (k !== 'intent') { if (v === null) delete (next as Record<string, unknown>)[k]; else (next as Record<string, unknown>)[k] = v; }
      const revision = job.revision + 1;
      await q('update jobs set params = $2::jsonb, revision = $3 where id = $1', [jid, JSON.stringify(next), revision]);
      await this.#supersede(q, jid, 'operator-decision');
      await this.#event(q, jid, 'operator-decision', { params, revision, manual: !!body.manual });
      const modelTop = job.prediction?.top;
      if (params.intent && !body.manual && modelTop && params.intent !== (job.plan?.intent ?? modelTop)) {
        // One active lesson per job: correcting a correction replaces it; the history stays in the audit trail (Codex R5-3).
        await q('delete from corrections where session_id = $1 and job_id = $2', [sid, jid]);
        await q('insert into corrections (session_id, job_id, filename, from_intent, intent, x) values ($1,$2,$3,$4,$5,$6::jsonb)', [sid, jid, job.filename, job.plan?.intent ?? modelTop, params.intent, JSON.stringify(job.features)]);
        await this.#event(q, jid, 'intent-corrected', { from: job.plan?.intent ?? modelTop, to: params.intent, modelPTop: job.prediction?.pTop, remembered: true });
        corrected = true;
      }
      if ('intent' in params && !params.intent) {
        // "Use RollCue's reading again" withdraws this job's correction too; otherwise memory would keep answering for it.
        const gone = await q('delete from corrections where session_id = $1 and job_id = $2 returning id', [sid, jid]);
        if (gone.length) { await this.#event(q, jid, 'correction-withdrawn', { count: gone.length }); corrected = true; }
      }
    });
    if (corrected) this.#bg(this.#refreshOpenJobs(sid, 'session-memory-updated', jid));
    await this.#replan(jid, { reason: corrected ? 'intent-corrected' : 'operator-decision' });
    return this.view(sid, jid);
  }

  async editIntake(sid: string, jid: string, body: { revision: unknown; intake: unknown }) {
    await this.db.tx(async (q) => {
      const job = await this.#lockJob(q, sid, jid);
      if (CLOSED_JOB.includes(job.status)) throw new HttpError(409, 'closed', `This job is already ${job.status}.`);
      if (body.revision !== job.revision) throw new HttpError(409, 'stale', 'The job changed since this view was loaded.');
      if (job.revision >= MAX_REVISIONS) throw new HttpError(429, 'too-many-changes', 'This job has been changed too many times. Reject it and upload it again.');
      const intake = validateIntake({ ...job.intake, ...(body.intake as object) }, job.filename);
      await q('update jobs set intake = $2::jsonb, features = $3::jsonb, revision = $4 where id = $1', [jid, JSON.stringify(intake), JSON.stringify(job.inspection ? featurize(job.inspection, intake) : null), job.revision + 1]);
      await this.#supersede(q, jid, 'intake-edited');
      await this.#event(q, jid, 'intake-edited', { intake, revision: job.revision + 1 });
    });
    await this.#replan(jid, { reason: 'intake-edited' });
    return this.view(sid, jid);
  }

  /**
   * Approval is bound to the exact artifact bytes, parameters, versions and job revision. Execution then re-verifies
   * the stored bytes before anything is called released.
   */
  async approve(sid: string, jid: string, body: { proposalId: unknown; artifactSha256: unknown }) {
    let refused: { proposal: string; error: HttpError } | null = null, claimed: string | null = null;
    const approved = await this.db.tx(async (q) => {
      const job = await this.#lockJob(q, sid, jid);
      const [p] = await q<ProposalRow>('select * from proposals where id = $1 and job_id = $2 for update', [body.proposalId, jid]);
      if (!p) throw new HttpError(404, 'not-found', 'No such proposal for this job.');
      // Idempotent: a repeat (double click, retry after a dropped response) never executes twice.
      if (p.status === 'released' || (p.status === 'approved' && this.#executing.has(p.id))) return null;
      const refuse = (status: number, code: string, message: string) => { refused = { proposal: p.id, error: new HttpError(status, code, message) }; return null; };
      if (job.status !== 'ready') return refuse(409, 'closed', `This job is already ${job.status}.`);
      // Approved but its release never finished (the final write failed): approving again resumes it (Codex R4-3), after
      // the same checks as a first approval, because memory or the roll may have moved meanwhile (Codex R7-4).
      const resume = p.status === 'approved' && p.revision === job.revision;
      if (resume) { /* checked below */ } else if (p.status === 'superseded' || p.revision !== job.revision) return refuse(409, 'superseded', 'This proposal was replaced after the job changed. Review the current one.');
      else if (p.status !== 'prepared') return refuse(409, 'not-ready', p.status === 'failed' ? 'This proposal failed verification and cannot be approved.' : 'This proposal is not ready yet.');
      if (body.artifactSha256 !== p.artifact_sha256) return refuse(409, 'artifact-mismatch', 'The approval does not match the prepared artifact.');
      if (p.policy_version !== POLICY_VERSION || p.model_version !== this.model.version) return refuse(409, 'policy-changed', 'Policy or model changed since this was prepared.');
      if (!p.artifact || sha(p.artifact) !== p.artifact_sha256 || bindingHash(job, p) !== p.binding_hash) return refuse(409, 'binding-mismatch', 'Stored artifact does not match its binding.');
      // Memory or roll may have moved since this was prepared, and reconciling other jobs takes time: approve only what
      // RollCue would still decide right now (Codex R5-1).
      if (signature((await this.#freshPlan(q, job)).p) !== signature(job.plan)) return refuse(409, 'superseded', 'RollCue’s reading of this job changed after a correction or setting. Review the current decision.');
      if (resume) { this.#executing.add(claimed = p.id); return p; }
      const by = 'operator:' + sha(sid).slice(0, 8);
      const [row] = await q<ProposalRow>(`update proposals set status = 'approved', approved_at = now(), approved_by = $2 where id = $1 returning *`, [p.id, by]);
      await this.#event(q, jid, 'approved', { proposal: p.id, artifactSha256: p.artifact_sha256, bindingHash: p.binding_hash, by });
      this.#executing.add(claimed = p.id);
      return row;
    }).catch((e) => { if (claimed) this.#executing.delete(claimed); throw e; });
    if (refused) {
      const r = refused as { proposal: string; error: HttpError };
      // Recorded in its own transaction so the refusal is part of the audit trail.
      await this.db.tx(async (q) => {
        const [{ n }] = await q<{ n: number }>(`select count(*)::int as n from events where job_id = $1 and type = 'approval-refused'`, [jid]);
        if (n < MAX_REFUSALS) await this.#event(q, jid, 'approval-refused', { proposal: r.proposal, code: r.error.code });
      });
      // Bring the job up to date now, so the operator's reload shows the current decision being prepared.
      if (r.error.code === 'superseded') { const prep = await this.#planJob(jid, { reason: 'reading-changed', bump: true, onlyIfChanged: true }); if (prep) this.#bg(this.#prepare(jid, prep.pid, prep.task)); }
      throw r.error;
    }
    if (approved) try { await this.#execute(jid, approved); } finally { this.#executing.delete(approved.id); }
    return this.view(sid, jid);
  }

  async #execute(jid: string, p: ProposalRow) {
    let checks: Check[] = [], error: string | null = null;
    try {
      if (this.failNextRelease) { this.failNextRelease = false; throw new Error('Simulated execution failure (test hook).'); }
      const b = p.build as { targetW: number; targetH: number; marginMm: number; cut: string } | null;
      // Re-check against exactly what preparation expected (loop count, bleed, art); older rows fall back to the build.
      const expect = p.verification?.expect ?? (b
        ? { pageW: b.targetW + 2 * b.marginMm, pageH: b.targetH + 2 * b.marginMm, trim: { x: b.marginMm, y: b.marginMm, w: b.targetW, h: b.targetH }, cutLoops: b.cut === 'contour' || b.cut === 'rect' ? 1 : 0, keepsCut: b.cut === 'keep' }
        : { pageW: 210, pageH: 297, trim: { x: 0, y: 0, w: 0, h: 0 }, cutLoops: 0, notice: true });
      const bytes = new Uint8Array(p.artifact!);
      const v = await this.pool.run<{ checks: Check[] }>({ type: 'verify', artifact: bytes, expect }, [bytes.buffer as ArrayBuffer]);
      checks = v.checks;
      if (!checks.every((c) => c.pass)) error = 'Release verification failed.';
    } catch (e) { error = (e as Error).message; }
    const final = this.db.tx(async (q) => {
      const [job] = await q<JobRow>('select * from jobs where id = $1 for update', [jid]);
      const [cur] = await q<ProposalRow>('select status, revision from proposals where id = $1 for update', [p.id]);
      if (!job || job.status !== 'ready' || cur.status !== 'approved' || cur.revision !== job.revision) {
        await this.#event(q, jid, 'release-aborted', { proposal: p.id, reason: 'job changed during execution' });
        return;
      }
      if (error) {
        await q(`update proposals set status = 'failed', error = $2 where id = $1`, [p.id, error]);
        await this.#event(q, jid, 'release-failed', { proposal: p.id, error, retry: 'Use Retry to prepare and verify again.' });
        return;
      }
      const ticket = {
        job: jid, file: job.filename, sourceSha256: job.source_sha256, intent: p.intent, intentLabel: p.intent ? INTENT_LABEL[p.intent as Intent] : null,
        intentSource: job.plan?.intentSource, quantity: job.intake.qty, media: job.intake.media, build: p.build, layout: p.decision?.kind === 'release' ? p.decision.layout : null,
        artifact: { kind: p.kind, sha256: p.artifact_sha256 }, approval: { at: p.approved_at && new Date(p.approved_at).toISOString(), by: p.approved_by, bindingHash: p.binding_hash },
        versions: { policy: p.policy_version, model: p.model_version, memory: p.memory_version }, verification: checks.map((c) => ({ id: c.id, pass: c.pass, detail: c.detail })),
        note: 'Released to the production queue of this demo. RollCue does not print, cut or send anything.',
      };
      await q(`update proposals set status = 'released', released_at = now(), ticket = $2::jsonb where id = $1`, [p.id, JSON.stringify(ticket)]);
      await q(`update jobs set status = $2 where id = $1`, [jid, p.kind === 'return-notice' ? 'returned' : 'released']);
      await this.#event(q, jid, 'released', { proposal: p.id, artifactSha256: p.artifact_sha256, ticketSha256: sha(canon(ticket)), verified: checks.length });
    });
    try { await final; } catch (e) {
      // The final write failed: record a retryable failure so the proposal is not stranded in 'approved' (Codex R4-3).
      // If even that fails, it stays 'approved' and approving again resumes it.
      await this.db.tx(async (q) => {
        const done = await q(`update proposals set status = 'failed', error = $2 where id = $1 and status = 'approved' returning id`, [p.id, 'Release could not be recorded. Nothing was released.']);
        if (done.length) await this.#event(q, jid, 'release-failed', { proposal: p.id, error: (e as Error).message, retry: 'Use Retry to prepare and verify again.' });
      });
    }
  }

  /** After a failed preparation or release: prepare again from the current state (new proposal, same revision rules). */
  async retry(sid: string, jid: string, body: { revision: unknown }) {
    await this.db.tx(async (q) => {
      const job = await this.#lockJob(q, sid, jid);
      if (job.status !== 'ready') throw new HttpError(409, 'closed', 'Nothing to retry.');
      if (body.revision !== job.revision) throw new HttpError(409, 'stale', 'The job changed since this view was loaded.');
      // Only a failure can be retried; rebuilding a good proposal would only grow storage (Codex R6-3).
      const [last] = await q<{ status: string }>('select status from proposals where job_id = $1 and revision = $2 order by created_at desc limit 1', [jid, job.revision]);
      if (last?.status !== 'failed') throw new HttpError(409, 'nothing-to-retry', 'Nothing failed, so there is nothing to retry.');
      if (job.revision >= MAX_REVISIONS) throw new HttpError(429, 'too-many-changes', 'This job has been changed too many times. Reject it and upload it again.');
      await this.#event(q, jid, 'retry-requested', { revision: job.revision });
    });
    await this.#replan(jid, { reason: 'retry', bump: true });
    return this.view(sid, jid);
  }

  async reject(sid: string, jid: string, body: { revision: unknown; reason?: unknown }) {
    await this.db.tx(async (q) => {
      const job = await this.#lockJob(q, sid, jid);
      if (CLOSED_JOB.includes(job.status)) throw new HttpError(409, 'closed', `This job is already ${job.status}.`);
      if (body.revision !== job.revision) throw new HttpError(409, 'stale', 'The job changed since this view was loaded.');
      await this.#supersede(q, jid, 'job-rejected');
      await q(`update jobs set status = 'rejected', revision = revision + 1 where id = $1`, [jid]);
      await this.#event(q, jid, 'job-rejected', { reason: typeof body.reason === 'string' ? body.reason.slice(0, 200) : null });
    });
    return this.view(sid, jid);
  }

  // ---------- reads ----------

  async list(sid: string) {
    const rows = await this.db.q<{ id: string; filename: string; status: string; sample: string | null; plan: Plan | null; created_at: Date; revision: number }>(
      'select id, filename, status, sample, plan, created_at, revision from jobs where session_id = $1 order by created_at', [sid]);
    return rows.map((r) => ({ id: r.id, filename: r.filename, status: r.status, sample: r.sample, revision: r.revision, intent: r.plan?.intent ?? null, headline: r.plan?.decision.headline ?? null, createdAt: r.created_at }));
  }

  async view(sid: string, jid: string) {
    const [job] = await this.db.q<JobRow>('select * from jobs where id = $1 and session_id = $2', [jid, sid]);
    if (!job) throw new HttpError(404, 'not-found', 'No such job in this session.');
    const props = await this.db.q<ProposalRow>('select id, revision, created_at, status, kind, intent, build, decision, params, artifact_sha256, verification, overlay, binding_hash, approved_at, approved_by, released_at, ticket, error, policy_version, model_version, memory_version from proposals where job_id = $1 order by created_at', [jid]);
    const events = await this.db.q<{ seq: number; at: Date; type: string; data: unknown; prev_hash: string; hash: string }>('select * from events where job_id = $1 order by seq', [jid]);
    const current = props.filter((p) => p.revision === job.revision && p.status !== 'superseded').at(-1) ?? null;
    const i = job.inspection;
    return {
      id: job.id, filename: job.filename, sample: job.sample, createdAt: job.created_at, status: job.status, revision: job.revision, error: job.error,
      intake: job.intake, params: job.params, sourceSha256: job.source_sha256, kind: job.kind,
      inspection: i && { ...i },
      prediction: job.prediction, plan: job.plan,
      proposal: current && { ...current, executing: this.#executing.has(current.id), previewUrl: `/api/jobs/${jid}/proposals/${current.id}/preview.png`, downloadUrl: `/api/jobs/${jid}/proposals/${current.id}/artifact.pdf` },
      history: props.map((p) => ({ id: p.id, revision: p.revision, status: p.status, kind: p.kind, intent: p.intent, createdAt: p.created_at, artifactSha256: p.artifact_sha256 })),
      events: events.map((e) => ({ seq: e.seq, at: e.at, type: e.type, data: e.data, hash: e.hash.slice(0, 12) })),
      chainOk: verifyChain(jid, events),
    };
  }

  async sourcePreview(sid: string, jid: string) {
    const [r] = await this.db.q<{ preview: Uint8Array | null }>('select preview from jobs where id = $1 and session_id = $2', [jid, sid]);
    if (!r?.preview) throw new HttpError(404, 'not-found', 'No preview.');
    return r.preview;
  }

  async proposalFile(sid: string, jid: string, pid: string, which: 'preview' | 'artifact') {
    const [r] = await this.db.q<{ preview: Uint8Array | null; artifact: Uint8Array | null; status: string; filename: string; kind: string }>(
      'select p.preview, p.artifact, p.status, j.filename, p.kind from proposals p join jobs j on j.id = p.job_id where p.id = $1 and j.id = $2 and j.session_id = $3', [pid, jid, sid]);
    const bytes = r?.[which];
    if (!r || !bytes) throw new HttpError(404, 'not-found', 'Not available.');
    return { bytes, status: r.status, filename: r.filename, kind: r.kind };
  }

  async recordMetric(sid: string, body: { jobId?: unknown; surface?: unknown; data?: unknown }) {
    if (body.surface !== 'decision' && body.surface !== 'legacy') throw new HttpError(400, 'bad-params', 'surface must be decision or legacy.');
    const data = JSON.stringify(body.data ?? {});
    if (data.length > 2000) throw new HttpError(413, 'too-large', 'Metric too large.');
    // Client-reported and untrusted; capped per session so it cannot grow storage (Codex R6-3).
    await this.db.q(`insert into metrics (session_id, job_id, surface, data) select $1,$2,$3,$4::jsonb where (select count(*) from metrics where session_id = $1) < ${MAX_METRICS}`, [sid, typeof body.jobId === 'string' ? body.jobId.slice(0, 40) : null, body.surface, data]);
  }

  /** Restart recovery: re-run analysis for jobs interrupted mid-analysis, and re-prepare proposals interrupted mid-build. */
  async recover() {
    const analysing = await this.db.q<{ id: string }>(`select id from jobs where status = 'analysing'`);
    for (const j of analysing) {
      await this.db.tx((q) => this.#supersede(q, j.id, 'restart-recovery')); // nothing prepared before the crash stays approvable
      this.#bg(this.#analyse(j.id));
    }
    const preparing = await this.db.q<{ job_id: string }>(`select distinct job_id from proposals where status in ('preparing','approved')`);
    for (const p of preparing) this.#bg(this.#replan(p.job_id, { reason: 'restart-recovery', bump: true }));
    return { analysing: analysing.length, preparing: preparing.length };
  }

  // ---------- audit ----------

  async #event(q: Q, jid: string, type: string, data: unknown) {
    // Serialise sequence allocation per job on Postgres; re-locking a row this transaction already holds is free (Codex R4-4).
    await q('select id from jobs where id = $1 for update', [jid]);
    const [last] = await q<{ seq: number; hash: string }>('select seq, hash from events where job_id = $1 order by seq desc limit 1', [jid]);
    const seq = (last?.seq ?? 0) + 1, prev = last?.hash ?? 'genesis';
    const at = this.now().toISOString();
    const hash = sha(canon([jid, seq, at, type, data, prev]));
    await q('insert into events (job_id, seq, at, type, data, prev_hash, hash) values ($1,$2,$3,$4,$5::jsonb,$6,$7)', [jid, seq, at, type, JSON.stringify(data), prev, hash]);
  }
}

export function verifyChain(jid: string, events: Array<{ seq: number; at: Date; type: string; data: unknown; prev_hash: string; hash: string }>): boolean {
  let prev = 'genesis';
  for (const e of events) {
    if (e.prev_hash !== prev || sha(canon([jid, e.seq, new Date(e.at).toISOString(), e.type, e.data, prev])) !== e.hash) return false;
    prev = e.hash;
  }
  return true;
}

export type JobView = Awaited<ReturnType<Service['view']>>;
export type JobSummary = Awaited<ReturnType<Service['list']>>[number];
