// One SQL dialect everywhere: real Postgres via `pg` when DATABASE_URL is set, PGlite (Postgres compiled to WASM)
// otherwise, in memory for tests or in a directory for local runs.
import { mkdirSync } from 'node:fs';
import pg from 'pg';
import { PGlite } from '@electric-sql/pglite';

export type Q = <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T[]>;
export type Db = { q: Q; tx: <T>(fn: (q: Q) => Promise<T>) => Promise<T>; close: () => Promise<void>; kind: 'pg' | 'pglite' };

const SCHEMA = `
create table if not exists sessions (
  id text primary key,
  created_at timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  roll jsonb not null
);
create table if not exists jobs (
  id text primary key,
  session_id text not null references sessions(id) on delete cascade,
  created_at timestamptz not null default now(),
  filename text not null,
  sample text,
  kind text not null,
  source bytea not null,
  source_sha256 text not null,
  intake jsonb not null,
  params jsonb not null default '{}',
  revision int not null default 1,
  status text not null,
  error text,
  inspection jsonb,
  features jsonb,
  preview bytea,
  prediction jsonb,
  plan jsonb
);
create index if not exists jobs_session on jobs(session_id, created_at);
create table if not exists proposals (
  id text primary key,
  job_id text not null references jobs(id) on delete cascade,
  revision int not null,
  created_at timestamptz not null default now(),
  status text not null,
  kind text not null,
  intent text,
  build jsonb,
  params jsonb not null,
  params_hash text not null,
  policy_version text not null,
  model_version text not null,
  memory_version text not null,
  artifact bytea,
  artifact_sha256 text,
  preview bytea,
  verification jsonb,
  overlay jsonb,
  binding_hash text,
  approved_at timestamptz,
  approved_by text,
  released_at timestamptz,
  ticket jsonb,
  error text
);
create index if not exists proposals_job on proposals(job_id, created_at);
-- The decision the operator sees, frozen with the proposal it produced (Codex R4-1).
alter table proposals add column if not exists decision jsonb;
-- At most one approvable proposal per job, on either database (Codex R4-2).
create unique index if not exists proposals_one_open on proposals(job_id) where status in ('preparing','prepared','approved');
create table if not exists corrections (
  id serial primary key,
  session_id text not null references sessions(id) on delete cascade,
  job_id text not null,
  filename text not null,
  from_intent text,
  intent text not null,
  x jsonb not null,
  created_at timestamptz not null default now()
);
create table if not exists events (
  job_id text not null references jobs(id) on delete cascade,
  seq int not null,
  at timestamptz not null default now(),
  type text not null,
  data jsonb not null,
  prev_hash text not null,
  hash text not null,
  primary key (job_id, seq)
);
create table if not exists metrics (
  id serial primary key,
  session_id text not null references sessions(id) on delete cascade,
  job_id text,
  surface text not null,
  data jsonb not null,
  created_at timestamptz not null default now()
);
`;

export async function openDb(opts: { url?: string; dir?: string } = {}): Promise<Db> {
  let db: Db;
  if (opts.url) {
    const pool = new pg.Pool({ connectionString: opts.url, max: 5, ssl: /sslmode=require|render\.com/.test(opts.url) ? { rejectUnauthorized: false } : undefined });
    const q: Q = async (sql, params = []) => (await pool.query(sql, params)).rows;
    db = {
      kind: 'pg', q,
      tx: async (fn) => {
        const c = await pool.connect();
        try {
          await c.query('begin');
          const r = await fn(async (sql, params = []) => (await c.query(sql, params)).rows);
          await c.query('commit');
          return r;
        } catch (e) { await c.query('rollback'); throw e; } finally { c.release(); }
      },
      close: () => pool.end(),
    };
  } else {
    if (opts.dir) mkdirSync(opts.dir, { recursive: true }); // a fresh clone has no data/ yet; PGlite will not create parents
    const lite = new PGlite(opts.dir);
    await lite.waitReady;
    // PGlite is a single connection: serialise transactions so concurrent requests cannot interleave statements.
    let chain: Promise<unknown> = Promise.resolve();
    const q: Q = async (sql, params = []) => (await lite.query(sql, params)).rows as never;
    db = {
      kind: 'pglite', q,
      tx: (fn) => {
        const run = chain.then(() => lite.transaction((t) => fn(async (sql, params = []) => (await t.query(sql, params)).rows as never)));
        chain = run.catch(() => undefined);
        return run;
      },
      close: () => lite.close(),
    };
  }
  await (db.kind === 'pglite' ? db.q('select 1') : Promise.resolve());
  for (const stmt of SCHEMA.split(';').map((s) => s.trim()).filter(Boolean)) await db.q(stmt);
  return db;
}
