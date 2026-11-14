// Records the film's scenes and the README screenshots from the real app. Usage: node film/capture.ts [film|shots|all]
// A fresh local server (own data directory, no test hooks) is started; Playwright drives it like an operator would.
// Scenes are recorded with Chrome's screencast (one JPEG per painted frame, with its timestamp); film/assemble.ts turns
// them into video. A small cursor overlay is drawn so viewers can follow the real pointer; nothing in the app is mocked.
import { chromium, devices, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync, copyFileSync } from 'node:fs';
import { pdfStructure, renderPdfPage } from '../src/inspect.ts';
import { timeline, type Scene } from './timeline.ts';

const PORT = 3388, BASE = `http://127.0.0.1:${PORT}`, CAP = 'film/capture', SHOTS = 'docs/screenshots';
const H = { 'x-rollcue': '1' };
const mode = process.argv[2] ?? 'all';
const scenes = Object.fromEntries(timeline().map((s) => [s.id, s]));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------- server ----------
rmSync(`${CAP}/data`, { recursive: true, force: true });
const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/main.ts'], { env: { ...process.env, PORT: String(PORT), RC_DATA_DIR: `${CAP}/data`, NODE_ENV: 'development' }, stdio: 'ignore' });
for (let i = 0; ; i++) { try { if ((await fetch(`${BASE}/healthz`)).ok) break; } catch { /* starting */ } if (i > 120) throw new Error('server did not start'); await sleep(250); }

// ---------- helpers ----------
const CURSOR = `addEventListener('DOMContentLoaded', () => {
  // Film only: the app's toast moves to the top so the burned-in captions at the bottom never cover it.
  const st = document.createElement('style');
  st.textContent = '.toast { bottom: auto !important; top: 70px; transform: translate(-50%, -260%) !important; } .toast:not(:empty) { transform: translate(-50%, 0) !important; }';
  document.head.appendChild(st);
  const c = document.createElement('div');
  c.innerHTML = '<svg width="28" height="28" viewBox="0 0 24 24"><path d="M4 2 L4 19 L8.5 14.8 L11.6 21.6 L14.6 20.3 L11.6 13.6 L17.8 13.6 Z" fill="#16150f" stroke="#fff" stroke-width="1.5" stroke-linejoin="round"/></svg>';
  Object.assign(c.style, { position: 'fixed', left: '0', top: '0', zIndex: '2147483647', pointerEvents: 'none', transform: 'translate(-60px,-60px)' });
  document.body.appendChild(c);
  addEventListener('mousemove', (e) => { c.style.transform = 'translate(' + (e.clientX - 4) + 'px,' + (e.clientY - 2) + 'px)'; }, true);
  addEventListener('mousedown', (e) => {
    const r = document.createElement('div');
    Object.assign(r.style, { position: 'fixed', left: e.clientX - 18 + 'px', top: e.clientY - 18 + 'px', width: '36px', height: '36px', borderRadius: '50%', border: '2.5px solid #e5007e', zIndex: '2147483646', pointerEvents: 'none', transition: 'transform .5s ease-out, opacity .5s ease-out' });
    document.body.appendChild(r);
    requestAnimationFrame(() => requestAnimationFrame(() => { r.style.transform = 'scale(1.7)'; r.style.opacity = '0'; }));
    setTimeout(() => r.remove(), 600);
  }, true);
});`;

const pos = new WeakMap<Page, [number, number]>();
const ease = (k: number) => (k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2);
async function glide(page: Page, x: number, y: number, ms = 550) {
  const [x0, y0] = pos.get(page) ?? [640, 420];
  // Paced by the clock, not by a step count: a move that makes the page repaint (a drag) takes longer per step.
  const t0 = Date.now();
  for (let e = 0; e < ms; e = Date.now() - t0) { const k = ease(e / ms); await page.mouse.move(x0 + (x - x0) * k, y0 + (y - y0) * k); await sleep(16); }
  await page.mouse.move(x, y);
  pos.set(page, [x, y]);
}
async function center(l: Locator) { await l.scrollIntoViewIfNeeded(); const b = (await l.boundingBox())!; return [b.x + b.width / 2, b.y + b.height / 2] as const; }
async function hover(page: Page, l: Locator, ms = 550) { const [x, y] = await center(l); await glide(page, x, y, ms); }
async function click(page: Page, l: Locator, ms = 550) { await hover(page, l, ms); await sleep(110); await page.mouse.down(); await sleep(70); await page.mouse.up(); }
async function ready(page: Page) {
  await page.locator('.headline').first().waitFor({ state: 'visible', timeout: 60_000 });
  await page.waitForFunction(() => !document.querySelector('[aria-busy=true]'), null, { timeout: 60_000 });
}
async function seeded(ctx: BrowserContext) {
  for (let i = 0; i < 240; i++) {
    const jobs = await (await ctx.request.get(`${BASE}/api/jobs`, { headers: H })).json() as { id: string }[];
    const views = await Promise.all(jobs.map(async (j) => (await ctx.request.get(`${BASE}/api/jobs/${j.id}`, { headers: H })).json()));
    if (views.length >= 4 && views.every((v) => v.proposal && v.proposal.status !== 'preparing')) return;
    await sleep(500);
  }
  throw new Error('sample jobs were not prepared');
}
async function fresh(browser: Browser, opts: Parameters<Browser['newContext']>[0], cursor: boolean) {
  const ctx = await browser.newContext(opts);
  if (cursor) await ctx.addInitScript(CURSOR);
  const page = await ctx.newPage();
  await page.goto(BASE + '/');
  await ready(page);
  await seeded(ctx);
  await page.reload(); await ready(page);
  return { ctx, page };
}

/** Chrome screencast of one page: every painted frame with its timestamp, plus the scene's start on the same clock. */
class Rec {
  frames: { f: string; ts: number }[] = [];
  t0 = 0;
  dir: string;
  cdp!: Awaited<ReturnType<BrowserContext['newCDPSession']>>;
  page: Page; name: string; w: number; h: number;
  constructor(page: Page, name: string, w = 1920, h = 1080) { this.page = page; this.name = name; this.w = w; this.h = h; this.dir = `${CAP}/${name}`; }
  async start() {
    rmSync(this.dir, { recursive: true, force: true }); mkdirSync(this.dir, { recursive: true });
    this.cdp = await this.page.context().newCDPSession(this.page);
    this.cdp.on('Page.screencastFrame', (f) => {
      const file = `${String(this.frames.length).padStart(5, '0')}.jpg`;
      writeFileSync(`${this.dir}/${file}`, Buffer.from(f.data, 'base64'));
      this.frames.push({ f: file, ts: f.metadata.timestamp! });
      this.cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => undefined);
    });
    await this.cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92, maxWidth: this.w, maxHeight: this.h, everyNthFrame: 1 });
    this.t0 = Date.now() / 1000;
  }
  /** Waits until `sec` into the scene; reports when an action runs late so the edit can be checked. */
  async at(sec: number) { const late = Date.now() / 1000 - this.t0 - sec; if (late > 0.25) console.warn(`  ${this.name}: ${late.toFixed(2)} s late at ${sec}`); else await sleep(Math.max(0, (this.t0 + sec) * 1000 - Date.now())); }
  async stop(len: number) {
    await this.at(len);
    const end = Date.now() / 1000;
    await this.cdp.send('Page.stopScreencast');
    await sleep(150);
    writeFileSync(`${this.dir}/frames.json`, JSON.stringify({ t0: this.t0, end, len, frames: this.frames }));
    console.log(`${this.name}: ${this.frames.length} frames, ${(end - this.t0).toFixed(2)} s recorded for ${len.toFixed(2)} s`);
  }
}

// ---------- the downloaded PDF, read back ----------
async function proofHtml(pdf: Uint8Array, approvedSha: string) {
  const st = await pdfStructure(pdf);
  const r = await renderPdfPage(pdf, { ppi: 220 });
  const sha = createHash('sha256').update(pdf).digest('hex');
  const b = st.boxes!, c = st.cut;
  const facts = [
    [sha === approvedSha ? 'Matches the approved file' : 'DOES NOT MATCH the approved file', `SHA-256 ${sha.slice(0, 16)}…`],
    ['Page', `${b.media.w.toFixed(1)} × ${b.media.h.toFixed(1)} mm${b.trim ? `, trim ${b.trim.w.toFixed(1)} × ${b.trim.h.toFixed(1)} mm` : ''}${st.bleedMm ? `, bleed ${st.bleedMm} mm` : ''}`],
    ['Spot colour', c ? `named exactly “${c.name}”` : 'none'],
    ['Cut line', c ? `${c.stroked && !c.filled ? 'stroked, not filled' : 'NOT a stroke'} · ${c.loops} loop${c.loops === 1 ? '' : 's'} · ${c.openLoops === 0 ? 'closed' : `${c.openLoops} open`}` : 'none'],
  ];
  const ok = sha === approvedSha && !!c?.exactName && c.stroked && !c.filled && c.loops > 0 && c.openLoops === 0;
  if (!ok) throw new Error('downloaded PDF failed its read-back: ' + JSON.stringify(facts));
  const img = `data:image/png;base64,${r.png.toString('base64')}`;
  return { ok, facts, html: `<!doctype html><html><head><meta charset="utf-8"><style>
@font-face { font-family: RCInter; src: url(${BASE}/assets/inter-latin-wght-normal-Dx4kXJAl.woff2) format('woff2'); font-weight: 100 900; }
@font-face { font-family: RCSerif; src: url(${BASE}/assets/instrument-serif-latin-400-normal-DnYpCC2O.woff2) format('woff2'); }
@font-face { font-family: RCMono; src: url(${BASE}/assets/jetbrains-mono-latin-wght-normal-B9CIFXIH.woff2) format('woff2'); font-weight: 100 900; }
html, body { margin: 0; height: 100%; background: #1c2521; color: #f4f1ea; font-family: RCInter, sans-serif; overflow: hidden; }
body { display: grid; grid-template-columns: 1.05fr 1fr; align-items: center; gap: 56px; padding: 0 72px; box-sizing: border-box;
  background-image: linear-gradient(rgba(214,232,222,.06) 1px, transparent 1px), linear-gradient(90deg, rgba(214,232,222,.06) 1px, transparent 1px); background-size: 32px 32px; }
.sheet { justify-self: center; background: #fff; padding: 14px; border-radius: 4px; box-shadow: 0 30px 60px rgba(0,0,0,.45); animation: in .7s cubic-bezier(.2,.8,.2,1) both; }
.sheet img { display: block; max-height: 560px; max-width: 540px; }
.eyebrow { font-size: 15px; letter-spacing: .14em; text-transform: uppercase; color: rgba(214,232,222,.6); margin: 0 0 10px; }
h1 { font-family: RCSerif; font-weight: 400; font-size: 54px; line-height: 1.02; margin: 0 0 28px; letter-spacing: -.01em; }
ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 16px; }
li { display: grid; grid-template-columns: 26px 1fr; gap: 12px; align-items: start; opacity: 0; animation: in .5s ease-out both; }
li:nth-child(1) { animation-delay: .7s } li:nth-child(2) { animation-delay: 1.1s } li:nth-child(3) { animation-delay: 1.5s } li:nth-child(4) { animation-delay: 1.9s }
.tick { width: 22px; height: 22px; border-radius: 50%; background: #3fa66b; display: grid; place-items: center; color: #fff; font-weight: 800; font-size: 13px; margin-top: 2px; }
b { display: block; font-size: 21px; font-weight: 600; }
span.d { font-family: RCMono; font-size: 15.5px; color: rgba(214,232,222,.75); }
@keyframes in { from { opacity: 0; transform: translateY(14px) } to { opacity: 1; transform: none } }
</style></head><body><div class="sheet"><img src="${img}" alt="Production PDF page"></div>
<div><p class="eyebrow">The downloaded production PDF, read back</p><h1>olive-market-sticker<br>production.pdf</h1>
<ul>${facts.map(([k, v]) => `<li><span class="tick">✓</span><div><b>${k}</b><span class="d">${v}</span></div></li>`).join('')}</ul></div></body></html>` };
}

// ---------- the end card ----------
function endCard() {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
@font-face { font-family: RCInter; src: url(${BASE}/assets/inter-latin-wght-normal-Dx4kXJAl.woff2) format('woff2'); font-weight: 100 900; }
@font-face { font-family: RCSerif; src: url(${BASE}/assets/instrument-serif-latin-400-normal-DnYpCC2O.woff2) format('woff2'); }
html, body { margin: 0; height: 100%; background: #1c2521; color: #f4f1ea; font-family: RCInter, sans-serif; overflow: hidden; }
body { display: grid; place-items: center; background-image: linear-gradient(rgba(214,232,222,.05) 1px, transparent 1px), linear-gradient(90deg, rgba(214,232,222,.05) 1px, transparent 1px); background-size: 32px 32px; }
.wrap { display: grid; justify-items: center; gap: 22px; margin-top: -60px; }
.logo { position: relative; width: 760px; height: 230px; }
svg.cut { position: absolute; inset: 0; overflow: visible; }
.word { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; gap: 26px; font-family: RCSerif; font-size: 150px; letter-spacing: -.02em; line-height: 1;
  opacity: 0; animation: rise 1s .35s cubic-bezier(.2,.8,.2,1) both; }
.mark { width: 92px; height: 92px; border-radius: 50%; border: 9px dashed #e5007e; position: relative; box-sizing: border-box; animation: spin 2.4s .2s cubic-bezier(.2,.8,.2,1) both; }
.mark::after { content: ''; position: absolute; inset: 17px; border-radius: 50%; background: #f4f1ea; }
.tag { font-family: RCSerif; font-size: 50px; color: #f4f1ea; opacity: 0; animation: rise .9s 1.7s ease-out both; }
.url { font-size: 24px; font-weight: 500; color: rgba(214,232,222,.85); letter-spacing: .01em; opacity: 0; animation: rise .8s 2.6s ease-out both; }
.small { font-size: 17px; color: rgba(214,232,222,.55); opacity: 0; animation: rise .8s 3.0s ease-out both; }
@keyframes rise { from { opacity: 0; transform: translateY(16px) } to { opacity: 1; transform: none } }
@keyframes spin { from { transform: rotate(-200deg) scale(.4); opacity: 0 } to { transform: none; opacity: 1 } }
@keyframes draw { to { stroke-dashoffset: 0 } }
</style></head><body><div class="wrap">
<div class="logo">
  <svg class="cut" viewBox="0 0 760 230"><defs><mask id="m"><rect x="-20" y="-20" width="800" height="270" fill="black"/>
    <rect x="6" y="6" width="748" height="218" rx="109" fill="none" stroke="white" stroke-width="12" pathLength="1" stroke-dasharray="1" stroke-dashoffset="1" style="animation: draw 1.6s .15s cubic-bezier(.6,0,.3,1) forwards"/></mask></defs>
    <rect x="6" y="6" width="748" height="218" rx="109" fill="none" stroke="#e5007e" stroke-width="4" stroke-dasharray="16 10" mask="url(#m)"/></svg>
  <div class="word"><span class="mark"></span>RollCue</div>
</div>
<div class="tag">The next decision, not another dashboard.</div>
<div class="url">github.com/abuzaro21/rollcue</div>
<div class="small">Synthetic sample files · synthetic voice · nothing was printed</div>
</div></body></html>`;
}

// ---------- film ----------
async function film(browser: Browser) {
  const view = { viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1.5, acceptDownloads: true };
  const { ctx, page } = await fresh(browser, view, true);
  await page.locator('.qchip', { hasText: /olive-market-sticker/ }).first().click(); await ready(page);
  await page.mouse.move(900, 380); pos.set(page, [900, 380]);
  await sleep(2500); // the cut line has finished drawing

  let s = scenes['s1-arrive'], r = new Rec(page, s.id);
  await r.start();
  await r.at(0.6); await click(page, page.locator('.qadd.sample'));
  await page.locator('dialog.sheet').waitFor();
  await r.at(1.9); await click(page, page.locator('.sheet .option', { hasText: 'poster-for-jars.pdf' }), 700);
  await ready(page);
  await r.at(5.6); await click(page, page.locator('.side .evidence summary'));
  await page.locator('.side .evidence .probs').evaluate((e) => e.scrollIntoView({ behavior: 'smooth', block: 'center' }));
  await r.at(8.2); await hover(page, page.locator('.side .evidence p', { hasText: /^For / }).first(), 900);
  await r.at(11.2); await click(page, page.locator('.side .evidence summary'));
  await page.locator('.side .intent-name').evaluate((e) => e.scrollIntoView({ behavior: 'smooth', block: 'center' }));
  await r.at(12.0); await hover(page, page.locator('.side .intent-name'));
  await r.at(15.0); await page.locator('.side .eyebrow').evaluate((e) => e.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  await r.at(15.8); await hover(page, page.locator('.side .eyebrow'), 800);
  await r.at(19.0); await hover(page, page.getByRole('button', { name: 'Approve and release' }), 900);
  await r.stop(s.len);

  s = scenes['s2-sticker']; r = new Rec(page, s.id);
  await r.start();
  await r.at(0.4); await click(page, page.locator('.qchip', { hasText: /olive-market-sticker/ }).first());
  await ready(page);
  const mat = (await page.locator('.mat-stage').boundingBox())!;
  const my = mat.y + mat.height * 0.55, mx = (k: number) => mat.x + mat.width * k;
  await r.at(4.6); await glide(page, mx(0.5), my, 600); await page.mouse.down();
  await glide(page, mx(0.9), my, 1500);
  await r.at(7.4); await glide(page, mx(0.1), my, 1900);
  await glide(page, mx(0.5), my, 700); await page.mouse.up();
  await r.stop(s.len);

  s = scenes['s3-approve']; r = new Rec(page, s.id);
  const view0 = await (await ctx.request.get(`${BASE}/api/jobs`, { headers: H })).json() as { id: string; filename: string }[];
  const olive = view0.find((j) => j.filename === 'olive-market-sticker.pdf')!;
  const before = await (await ctx.request.get(`${BASE}/api/jobs/${olive.id}`, { headers: H })).json();
  await r.start();
  await r.at(2.6); await hover(page, page.locator('.side .binding'), 900);
  await r.at(4.6); await click(page, page.getByRole('button', { name: 'Approve and release' }));
  await page.locator('.side .stamp').waitFor();
  await r.at(6.8); await hover(page, page.locator('.side .ticket'), 800);
  const dlWait = page.waitForEvent('download');
  await r.at(8.3); await click(page, page.locator('.side').getByRole('link', { name: 'Download production PDF' }), 600);
  const dl = await dlWait;
  await r.stop(s.len);
  const pdf = new Uint8Array(readFileSync((await dl.path())!));
  writeFileSync(`${CAP}/olive-production.pdf`, pdf);

  const proof = await proofHtml(pdf, before.proposal.artifact_sha256);
  writeFileSync(`${CAP}/proof.json`, JSON.stringify(proof.facts, null, 1));
  s = scenes['s4-pdf']; r = new Rec(page, s.id);
  await page.mouse.move(-50, -50); pos.set(page, [-50, -50]);
  await page.goto(BASE + '/healthz'); await page.setContent('<html><body style="margin:0;background:#1c2521"></body></html>');
  await r.start();
  await page.setContent(proof.html, { waitUntil: 'load' });
  await r.stop(s.len);
  writeFileSync(`${CAP}/proof.html`, proof.html);

  await page.goto(BASE + '/'); await ready(page);
  await page.mouse.move(640, 300); pos.set(page, [640, 300]);
  s = scenes['s5-wrong']; r = new Rec(page, s.id);
  await r.start();
  await r.at(0.5); await click(page, page.locator('.qchip', { hasText: /stickers-final/ }).first());
  await ready(page);
  await r.at(5.2); await hover(page, page.locator('.side .chip.thin'), 700);
  await r.at(6.3); await hover(page, page.locator('.side .thin-note'), 600);
  await r.at(7.3); await click(page, page.getByRole('button', { name: 'Not this?' }), 500);
  await r.at(8.3); await click(page, page.locator('.alt', { hasText: 'Poster' }), 600);
  await ready(page);
  await r.at(11.6); await hover(page, page.locator('.side .chip.set'), 700);
  await r.at(12.8); await hover(page, page.locator('.side .binding'), 800);
  await r.stop(s.len);

  s = scenes['s6-memory']; r = new Rec(page, s.id);
  await r.start();
  await r.at(0.4); await click(page, page.locator('.qadd.sample'));
  await page.locator('dialog.sheet').waitFor();
  await r.at(1.4); await click(page, page.locator('.sheet .option', { hasText: 'stickers-final.pdf' }), 650);
  await ready(page);
  await r.at(4.0); await hover(page, page.locator('.side .intent .chip.memory'), 700);
  await r.at(5.3); await hover(page, page.locator('.side .intent .memory-note'), 700);
  await r.stop(s.len);
  await ctx.close();

  // Side by side: the same sticker job on two fresh sessions, the legacy flow and RollCue, recorded at the same time.
  s = scenes['s7-legacy'];
  const half = { viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 };
  const L = await fresh(browser, half, true), R = await fresh(browser, half, true);
  await L.page.goto(BASE + '/legacy'); await L.page.locator('.lg-table').waitFor();
  await R.page.locator('.qchip', { hasText: /honey-jar-labels/ }).first().click(); await ready(R.page);
  for (const p of [L.page, R.page]) { await p.mouse.move(640, 360); pos.set(p, [640, 360]); }
  const tally = async (p: Page, c: number, f: number) => p.evaluate(([c, f]) => {
    let b = document.getElementById('rc-tally');
    if (!b) { b = document.createElement('div'); b.id = 'rc-tally'; Object.assign(b.style, { position: 'fixed', right: '18px', bottom: '18px', zIndex: '2147483640', background: '#16150f', color: '#f4f1ea', font: '600 22px/1.2 Inter, system-ui, sans-serif', padding: '12px 18px', borderRadius: '12px', boxShadow: '0 8px 24px rgba(0,0,0,.25)' }); document.body.appendChild(b); }
    b.textContent = `${c} click${c === 1 ? '' : 's'} · ${f} typed field${f === 1 ? '' : 's'}`;
  }, [c, f]);
  await tally(L.page, 0, 0); await tally(R.page, 0, 0);
  const rl = new Rec(L.page, `${s.id}-legacy`, 1280, 720), rr = new Rec(R.page, `${s.id}-rollcue`, 1280, 720);
  await Promise.all([rl.start(), rr.start()]);
  const legacy = (async () => {
    const p = L.page; let c = 0, f = 0;
    const tap = async (l: Locator, ms = 420) => { await click(p, l, ms); await tally(p, ++c, f); };
    const field = async (l: Locator, fn: () => Promise<unknown>) => { await hover(p, l, 380); await fn(); await tally(p, c, ++f); };
    await rl.at(0.3); await tap(p.locator('tr', { hasText: 'olive-market-sticker.pdf' }).first().getByRole('button', { name: 'Open' }));
    await field(p.locator('select'), () => p.locator('select').selectOption({ label: 'Die-cut stickers' }));
    await tap(p.getByRole('button', { name: 'Save ticket' }));
    await p.locator('.lg-status', { hasText: 'Ticket saved' }).waitFor({ timeout: 30_000 });
    await tap(p.getByRole('tab', { name: 'Preflight' }));
    await tap(p.getByRole('button', { name: 'Run preflight' }));
    await tap(p.getByRole('tab', { name: 'Cut & offsets' }));
    await field(p.locator('input[name=cut][value=contour]'), () => p.locator('input[name=cut][value=contour]').check());
    await field(p.locator('input[type=number]'), () => p.locator('input[type=number]').fill('2'));
    await tap(p.getByRole('button', { name: 'Apply' }));
    await p.locator('.lg-status', { hasText: 'Cut settings applied' }).waitFor({ timeout: 30_000 });
    await tap(p.getByRole('tab', { name: 'Output' }));
    await tap(p.getByRole('button', { name: 'Generate output' }));
    await tap(p.getByRole('button', { name: /Approve & send/ }));
    await p.locator('.lg-status', { hasText: /released|returned/ }).waitFor({ timeout: 30_000 });
    return { clicks: c, fields: f };
  })();
  const rollcue = (async () => {
    const p = R.page; let c = 0;
    await rr.at(0.3); await click(p, p.locator('.qchip', { hasText: /olive-market-sticker/ }).first()); await tally(p, ++c, 0);
    await ready(p);
    await rr.at(2.6); await click(p, p.getByRole('button', { name: 'Approve and release' })); await tally(p, ++c, 0);
    await p.locator('.side .stamp').waitFor();
    return { clicks: c, fields: 0 };
  })();
  const counts = { legacy: await legacy, rollcue: await rollcue };
  await Promise.all([rl.stop(s.len), rr.stop(s.len)]);
  writeFileSync(`${CAP}/${s.id}-counts.json`, JSON.stringify(counts));
  console.log('side-by-side counts', JSON.stringify(counts));
  await L.ctx.close(); await R.ctx.close();

  // Background for the side-by-side, rendered by the browser so the brand fonts are used.
  const bg = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  await bg.goto(BASE + '/healthz'); // same origin, so the app's fonts load
  await bg.setContent(`<!doctype html><html><head><style>
@font-face { font-family: RCInter; src: url(${BASE}/assets/inter-latin-wght-normal-Dx4kXJAl.woff2) format('woff2'); font-weight: 100 900; }
@font-face { font-family: RCSerif; src: url(${BASE}/assets/instrument-serif-latin-400-normal-DnYpCC2O.woff2) format('woff2'); }
body { margin: 0; width: 1920px; height: 1080px; background: #16150f; color: #f4f1ea; font-family: RCInter, sans-serif; position: relative; }
h2 { position: absolute; top: 150px; margin: 0; font-family: RCSerif; font-weight: 400; font-size: 46px; }
p { position: absolute; top: 208px; margin: 0; font-size: 17px; color: rgba(244,241,234,.6); }
</style></head><body>
<h2 style="left:24px">The old way</h2><p style="left:24px">A representative multi-tab preflight, built for this comparison</p>
<h2 style="left:984px">RollCue</h2><p style="left:984px">Same sample job, same backend</p></body></html>`, { waitUntil: 'load' });
  await bg.evaluate(() => document.fonts.ready);
  await bg.screenshot({ path: `${CAP}/${s.id}-bg.png` });

  s = scenes['s8-end'];
  const end = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1.5 });
  await end.goto(BASE + '/healthz'); await end.setContent('<html><body style="margin:0;background:#1c2521"></body></html>');
  r = new Rec(end, s.id);
  await r.start();
  await end.setContent(endCard(), { waitUntil: 'load' });
  await r.stop(s.len);
  writeFileSync(`${CAP}/end-card.html`, endCard());
  await end.close(); await bg.close();
}

// ---------- README screenshots ----------
async function shots(browser: Browser) {
  mkdirSync(SHOTS, { recursive: true });
  const { ctx, page } = await fresh(browser, { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1.5 }, false);
  const shot = (name: string) => page.screenshot({ path: `${SHOTS}/${name}.png` });
  await page.locator('.qchip', { hasText: /olive-market-sticker/ }).first().click(); await ready(page); await sleep(2500);
  await shot('01-first-visit');
  const mat = (await page.locator('.mat-stage').boundingBox())!;
  await page.mouse.move(mat.x + mat.width / 2, mat.y + mat.height / 2); await page.mouse.down();
  await page.mouse.move(mat.x + mat.width * 0.36, mat.y + mat.height / 2, { steps: 10 }); await page.mouse.up();
  await page.mouse.move(5, 5); await sleep(300);
  await shot('03-before-after');
  await page.getByRole('button', { name: 'Approve and release' }).click(); await page.locator('.side .stamp').waitFor(); await sleep(600);
  await shot('04-approved');
  await page.locator('.qadd.sample').click(); await page.locator('.sheet .option', { hasText: 'poster-for-jars.pdf' }).click(); await ready(page);
  await page.locator('.side .evidence summary').click(); await sleep(500);
  await shot('02-proactive');
  await page.locator('.qchip', { hasText: /stickers-final/ }).first().click(); await ready(page);
  await page.getByRole('button', { name: 'Not this?' }).click(); await sleep(400);
  await shot('05-wrong-guess');
  await page.locator('.alt', { hasText: 'Poster' }).click(); await ready(page); await sleep(600);
  await shot('06-corrected');
  await ctx.close();
  copyFileSync('docs/evidence/comparison.png', `${SHOTS}/07-legacy-vs-rollcue.png`);
  // The verified PDF, as shown in the film.
  const pdf = readFileSync(`${CAP}/olive-production.pdf`);
  const p2 = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1.5 });
  await p2.goto(BASE + '/healthz');
  await p2.setContent(readFileSync(`${CAP}/proof.html`, 'utf8'), { waitUntil: 'load' }); await sleep(3000);
  await p2.screenshot({ path: `${SHOTS}/08-verified-pdf.png` }); await p2.close();
  void pdf;
  // Phone.
  const m = await fresh(browser, { ...devices['Pixel 7'] }, false);
  await m.page.locator('.qchip', { hasText: /olive-market-sticker/ }).first().click(); await ready(m.page); await sleep(2500);
  await m.page.screenshot({ path: `${SHOTS}/mobile-01-decision.png` });
  await m.page.getByRole('button', { name: 'Approve and release' }).scrollIntoViewIfNeeded(); await sleep(400);
  await m.page.screenshot({ path: `${SHOTS}/mobile-02-approve.png` });
  await m.ctx.close();
}

const browser = await chromium.launch();
try {
  if (mode === 'film' || mode === 'all') await film(browser);
  if (mode === 'shots' || mode === 'all') await shots(browser);
} finally {
  await browser.close();
  server.kill();
}
