// Plain node:http. Every query is scoped to the session cookie; mutations need a custom header (forces a CORS preflight,
// which this server never grants), bodies are size-capped, and uploads are parsed only inside the worker.
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { HttpError, type Service } from './service.ts';
import { MAX_BYTES } from './inspect.ts';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.woff2': 'font/woff2', '.json': 'application/json', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json', '.pdf': 'application/pdf',
};
const SECURITY_HEADERS = {
  'content-security-policy': "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; font-src 'self'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY', 'cross-origin-opener-policy': 'same-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
};
const JSON_LIMIT = 64 * 1024;
const COOKIE = 'rc_sid';

export type AppOpts = { service: Service; publicDir: string; trustProxyHops: number; testHooks?: boolean; secureCookies?: boolean };

/** Per-IP token buckets: uploads are expensive, everything else is cheap. */
class Limiter {
  #b = new Map<string, { t: number; n: number }>();
  rate: number; burst: number;
  constructor(rate: number, burst: number) { this.rate = rate; this.burst = burst; }
  take(key: string, now = Date.now()) {
    const b = this.#b.get(key) ?? { t: now, n: this.burst };
    b.n = Math.min(this.burst, b.n + ((now - b.t) / 1000) * this.rate); b.t = now;
    if (this.#b.size > 10_000) this.#b.clear(); // shortcut: crude memory cap, fine for one small instance
    if (b.n < 1) { this.#b.set(key, b); return false; }
    b.n -= 1; this.#b.set(key, b); return true;
  }
}

export function clientIp(req: http.IncomingMessage, hops: number): string {
  const xff = String(req.headers['x-forwarded-for'] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  // With N trusted proxies the client is the Nth address from the right; anything further left is client-controlled.
  return (hops > 0 && xff.length >= hops ? xff[xff.length - hops] : req.socket.remoteAddress) ?? 'unknown';
}

export function createApp(o: AppOpts) {
  const { service: svc } = o;
  const general = new Limiter(10, 60), uploads = new Limiter(0.2, 8);

  const readBody = (req: http.IncomingMessage, limit: number) => new Promise<Buffer>((resolve, reject) => {
    const len = Number(req.headers['content-length'] ?? 0);
    if (len > limit) { reject(new HttpError(413, 'too-large', `Body larger than ${Math.round(limit / 1024)} KB.`)); req.resume(); return; }
    const parts: Buffer[] = []; let n = 0;
    req.on('data', (c: Buffer) => { n += c.length; if (n > limit) { reject(new HttpError(413, 'too-large', `Body larger than ${Math.round(limit / 1024)} KB.`)); req.destroy(); } else parts.push(c); });
    req.on('end', () => resolve(Buffer.concat(parts)));
    req.on('error', reject);
  });
  const json = async (req: http.IncomingMessage) => {
    const b = await readBody(req, JSON_LIMIT);
    if (!b.length) return {};
    try { return JSON.parse(b.toString('utf8')) as Record<string, unknown>; } catch { throw new HttpError(400, 'bad-json', 'Body is not valid JSON.'); }
  };

  const send = (res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
    const data = Buffer.isBuffer(body) || body instanceof Uint8Array ? Buffer.from(body as Uint8Array) : Buffer.from(JSON.stringify(body));
    res.writeHead(status, { ...SECURITY_HEADERS, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': String(data.length), ...headers });
    res.end(data);
  };

  async function serveStatic(res: http.ServerResponse, urlPath: string) {
    const rel = decodeURIComponent(urlPath).replace(/^\/+/, '');
    let file = path.resolve(o.publicDir, rel || 'index.html');
    if (!file.startsWith(path.resolve(o.publicDir) + path.sep)) throw new HttpError(404, 'not-found', 'Not found.');
    let s = await stat(file).catch(() => null);
    if (!s?.isFile()) {
      if (path.extname(rel)) throw new HttpError(404, 'not-found', 'Not found.');
      file = path.join(o.publicDir, rel.startsWith('legacy') ? 'legacy.html' : 'index.html'); // SPA routes
      s = await stat(file).catch(() => null);
      if (!s) throw new HttpError(404, 'not-found', 'Interface not built. Run npm run build.');
    }
    const body = await readFile(file);
    const immutable = rel.startsWith('assets/');
    send(res, 200, body, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache' });
  }

  async function handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://x');
    const p = url.pathname, m = req.method ?? 'GET';
    if (p === '/healthz') return send(res, 200, { ok: true });
    if (!p.startsWith('/api/')) {
      if (m !== 'GET' && m !== 'HEAD') throw new HttpError(405, 'method', 'Method not allowed.');
      return serveStatic(res, p);
    }
    const ip = clientIp(req, o.trustProxyHops);
    if (!general.take(ip)) throw new HttpError(429, 'rate-limited', 'Too many requests. Wait a moment.');
    const mutating = m !== 'GET' && m !== 'HEAD';
    if (mutating && req.headers['x-rollcue'] !== '1') throw new HttpError(403, 'csrf', 'Missing request header.');

    const cookies = Object.fromEntries(String(req.headers.cookie ?? '').split(';').map((c) => c.trim().split('=')).filter((kv) => kv.length === 2));
    const sess = await svc.session(cookies[COOKIE] ?? null);
    const sid = sess.id;
    if (sess.created) {
      res.setHeader('set-cookie', `${COOKIE}=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${48 * 3600}${o.secureCookies ? '; Secure' : ''}`);
      await svc.seed(sid);
    }

    const seg = p.split('/').filter(Boolean).slice(1); // after 'api'
    const route = `${m} /${seg.map((s, i) => (seg[i - 1] === 'jobs' || seg[i - 1] === 'proposals' || seg[i - 1] === 'samples' ? ':id' : s)).join('/')}`;
    const jid = seg[1], pid = seg[3];

    switch (route) {
      case 'GET /session': {
        const { rows } = await svc.memory(sid);
        return send(res, 200, { roll: sess.roll, samples: (await svc.samples()).map(({ id, title, story }) => ({ id, title, story })), jobs: await svc.list(sid), corrections: rows.map((r) => ({ jobId: r.job_id, filename: r.filename, from: r.from_intent, to: r.intent, at: r.created_at })), testHooks: !!o.testHooks });
      }
      case 'GET /jobs': return send(res, 200, await svc.list(sid));
      case 'POST /jobs': {
        if (!uploads.take(ip)) throw new HttpError(429, 'rate-limited', 'Too many uploads. Wait a minute.');
        const filename = decodeURIComponent(String(req.headers['x-filename'] ?? 'upload'));
        let intake: unknown = {};
        try { intake = JSON.parse(decodeURIComponent(String(req.headers['x-intake'] ?? '%7B%7D'))); } catch { throw new HttpError(400, 'bad-intake', 'Intake header is not valid JSON.'); }
        const bytes = new Uint8Array(await readBody(req, MAX_BYTES));
        return send(res, 201, { id: await svc.createJob(sid, { bytes, filename, intake }) });
      }
      case 'POST /samples/:id': return send(res, 201, { id: await svc.createSample(sid, seg[1]) });
      case 'GET /jobs/:id': return send(res, 200, await svc.view(sid, jid));
      case 'GET /jobs/:id/source.png': return send(res, 200, await svc.sourcePreview(sid, jid), { 'content-type': 'image/png', 'cache-control': 'private, max-age=3600' });
      case 'POST /jobs/:id/decide': return send(res, 200, await svc.decide(sid, jid, (await json(req)) as never));
      case 'POST /jobs/:id/intake': return send(res, 200, await svc.editIntake(sid, jid, (await json(req)) as never));
      case 'POST /jobs/:id/approve': return send(res, 200, await svc.approve(sid, jid, (await json(req)) as never));
      case 'POST /jobs/:id/retry': return send(res, 200, await svc.retry(sid, jid, (await json(req)) as never));
      case 'POST /jobs/:id/reject': return send(res, 200, await svc.reject(sid, jid, (await json(req)) as never));
      case 'GET /jobs/:id/proposals/:id/preview.png': {
        const f = await svc.proposalFile(sid, jid, pid, 'preview');
        return send(res, 200, f.bytes, { 'content-type': 'image/png', 'cache-control': 'private, max-age=3600' });
      }
      case 'GET /jobs/:id/proposals/:id/artifact.pdf': {
        const f = await svc.proposalFile(sid, jid, pid, 'artifact');
        const base = f.filename.replace(/\.[a-z0-9]+$/i, '').replace(/[^\w.-]+/g, '_').slice(0, 60) || 'job';
        const name = `${base}-${f.kind === 'production' ? 'production' : 'return-notice'}-${pid.slice(0, 6)}${f.status === 'released' ? '' : '-PROOF'}.pdf`;
        return send(res, 200, f.bytes, { 'content-type': 'application/pdf', 'content-disposition': `attachment; filename="${name}"`, 'cache-control': 'private, no-store' });
      }
      case 'POST /roll': return send(res, 200, { roll: await svc.setRoll(sid, (await json(req)).rollWidthMm) });
      case 'POST /memory/forget': await svc.forgetCorrections(sid); return send(res, 200, { ok: true });
      case 'POST /metrics': await svc.recordMetric(sid, await json(req)); return send(res, 204, Buffer.alloc(0));
      case 'POST /test/fail-next-release':
        if (!o.testHooks) break;
        svc.failNextRelease = true; return send(res, 200, { ok: true });
    }
    throw new HttpError(404, 'not-found', 'Not found.');
  }

  return http.createServer((req, res) => {
    handle(req, res).catch((e: unknown) => {
      if (res.headersSent) { res.destroy(); return; }
      if (e instanceof HttpError) return send(res, e.status, { error: e.code, message: e.message });
      console.error('[rollcue] request failed', e);
      send(res, 500, { error: 'internal', message: 'Something went wrong. Nothing was released.' });
    });
  });
}
