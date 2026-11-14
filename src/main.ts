import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { openDb } from './db.ts';
import { Pool } from './pool.ts';
import { Service } from './service.ts';
import { createApp } from './http.ts';
import type { ModelFile } from './model.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = process.env;

export async function start(o: { port?: number; dbUrl?: string; dbDir?: string; testHooks?: boolean } = {}) {
  // The hooks are process-wide (one visitor could fail another's release), so production refuses to start with them (Codex R6-6).
  if (o.testHooks && env.NODE_ENV === 'production') throw new Error('Test hooks cannot be enabled when NODE_ENV=production.');
  const db = await openDb({ url: o.dbUrl, dir: o.dbDir });
  const pool = new Pool(Number(env.RC_TASK_TIMEOUT_MS ?? 25_000));
  const model = JSON.parse(await readFile(path.join(root, 'src/model.json'), 'utf8')) as ModelFile;
  const service = new Service({ db, pool, model, samplesDir: path.join(root, 'samples') });
  await service.purgeExpired(); // expired data is gone before anything is recovered
  const recovered = await service.recover();
  const server = createApp({
    service, publicDir: path.join(root, 'public'), trustProxyHops: Number(env.TRUST_PROXY_HOPS ?? 0), testHooks: o.testHooks,
    secureCookies: env.NODE_ENV === 'production',
  });
  await new Promise<void>((r) => server.listen(o.port ?? 0, r));
  const purge = setInterval(() => void service.purgeExpired().catch((e) => console.error('[rollcue] purge failed', e)), 3600_000);
  purge.unref();
  const port = (server.address() as { port: number }).port;
  return {
    port, service, server, recovered,
    async close() { clearInterval(purge); await new Promise((r) => server.close(r)); await service.idle(); await pool.close(); await db.close(); },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = await start({ port: Number(env.PORT ?? 3000), dbUrl: env.DATABASE_URL, dbDir: env.DATABASE_URL ? undefined : (env.RC_DATA_DIR ?? path.join(root, 'data/pglite')), testHooks: env.RC_TEST_HOOKS === '1' });
  console.log(`[rollcue] listening on :${app.port} (db ${app.service.db.kind}; recovered ${JSON.stringify(app.recovered)})`);
  const stop = async () => { await app.close(); process.exit(0); };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
}
