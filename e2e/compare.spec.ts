// Side-by-side evidence: the same sample job, same backend, completed on each surface by the shortest path that surface
// allows (legacy gates output on ticket, preflight and cut). Every operator action goes through `act`, so the counts are what was actually done.
import { test, expect, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createCanvas, loadImage } from '@napi-rs/canvas';

type Tally = { clicks: number; fields: number; screens: number; decisions: string[]; ms: number };
const OUT = 'docs/evidence';
const results: Record<string, Record<string, Tally>> = {};
const shots: Record<string, Buffer> = {};

function tally() {
  const t: Tally = { clicks: 0, fields: 0, screens: 1, decisions: [], ms: 0 };
  const t0 = Date.now();
  return {
    t,
    click: async (p: Page, sel: Parameters<Page['locator']>[0] | ReturnType<Page['locator']>, screen = false) => {
      await (typeof sel === 'string' ? p.locator(sel) : sel).click(); t.clicks++; if (screen) t.screens++;
    },
    field: async (fn: () => Promise<unknown>, what: string) => { await fn(); t.fields++; t.decisions.push(what); },
    decide: (what: string) => t.decisions.push(what),
    done: () => { t.ms = Date.now() - t0; return t; },
  };
}
const idle = (p: Page) => expect(p.locator('[aria-busy=true]')).toHaveCount(0, { timeout: 30_000 });

async function rollcue(page: Page, sample: string, chip: RegExp, correct?: string) {
  await page.goto('/');
  await expect(page.locator('.headline')).toBeVisible();
  await idle(page);
  const k = tally();
  await k.click(page, page.locator('.qchip', { hasText: chip }).first(), true);
  await idle(page);
  if (correct) {
    await k.click(page, page.getByRole('button', { name: 'Not this?' }));
    await k.click(page, page.locator('.alt', { hasText: correct }));
    k.decide(`correct intent → ${correct}`);
    await idle(page);
  }
  await page.waitForTimeout(1900); // let the cut line finish drawing
  shots[`rollcue-${sample}`] = await page.screenshot();
  await k.click(page, page.getByRole('button', { name: /^Approve/ }));
  k.decide('approve prepared file');
  await expect(page.locator('.stamp')).toBeVisible();
  return k.done();
}

async function legacy(page: Page, chipFile: string, product: string, cut: { method: string; offset?: string } | null) {
  await page.goto('/legacy');
  await expect(page.locator('.lg-table')).toBeVisible();
  const k = tally();
  await k.click(page, page.locator('tr', { hasText: chipFile }).first().getByRole('button', { name: 'Open' }), true);
  await expect(page.locator('select')).toBeVisible();
  await k.field(() => page.locator('select').selectOption({ label: product }), `choose product type: ${product}`);
  await k.click(page, page.getByRole('button', { name: 'Save ticket' }));
  await expect(page.locator('.lg-status')).toContainText('Ticket saved', { timeout: 30_000 });
  await k.click(page, page.getByRole('tab', { name: 'Preflight' }), true);
  await k.click(page, page.getByRole('button', { name: 'Run preflight' }));
  k.decide('read preflight table');
  if (cut) {
    await k.click(page, page.getByRole('tab', { name: 'Cut & offsets' }), true);
    await k.field(() => page.locator(`input[name=cut][value=${cut.method}]`).check(), `choose cut method: ${cut.method}`);
    if (cut.offset) await k.field(() => page.locator('input[type=number]').fill(cut.offset!), `enter offset ${cut.offset} mm`);
    await k.click(page, page.getByRole('button', { name: 'Apply' }));
    await expect(page.locator('.lg-status')).toContainText('Cut settings applied', { timeout: 30_000 });
  }
  await k.click(page, page.getByRole('tab', { name: 'Output' }), true);
  await k.click(page, page.getByRole('button', { name: 'Generate output' }));
  shots[`legacy-${chipFile}`] = await page.screenshot();
  await k.click(page, page.getByRole('button', { name: /Approve & send/ }));
  k.decide('approve output');
  await expect(page.locator('.lg-status')).toContainText(/released|returned/, { timeout: 30_000 });
  return k.done();
}

test.describe.configure({ mode: 'serial' });

test('clean sticker job: RollCue vs legacy', async ({ browser }) => {
  const a = await browser.newPage(), b = await browser.newPage();
  results['market-stickers'] = {
    rollcue: await rollcue(a, 'market-stickers', /olive-market-sticker/),
    legacy: await legacy(b, 'olive-market-sticker.pdf', 'Die-cut stickers', { method: 'contour', offset: '2' }),
  };
  await a.close(); await b.close();
});

test('wrong-guess job: RollCue correction vs legacy manual entry', async ({ browser }) => {
  const a = await browser.newPage(), b = await browser.newPage();
  results['stickers-final'] = {
    rollcue: await rollcue(a, 'stickers-final', /stickers-final/, 'Poster'),
    legacy: await legacy(b, 'stickers-final.pdf', 'Poster', { method: 'none' }),
  };
  await a.close(); await b.close();
});

test.afterAll(async () => {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(`${OUT}/comparison.json`, JSON.stringify({
    method: 'Playwright drives each surface by the shortest path it allows (legacy will not output until ticket, preflight and cut are done) for the same sample job on the same backend, in a fresh session. Clicks, form fields and screen changes are counted as the script performs them. Time includes server work. Legacy is a representative multi-tab preflight built for this comparison, not a real product.',
    generatedAt: new Date().toISOString().slice(0, 10),
    results,
  }, null, 2) + '\n');
  // Composite: legacy left, RollCue right, for the clean job at the moment of approval.
  const L = shots['legacy-olive-market-sticker.pdf'], R = shots['rollcue-market-stickers'];
  if (L && R) {
    const [li, ri] = await Promise.all([loadImage(L), loadImage(R)]);
    const W = 1920, gap = 24, w = (W - gap * 3) / 2, h = Math.round(w * li.height / li.width), H = h + 120;
    const cv = createCanvas(W, H), c = cv.getContext('2d');
    c.fillStyle = '#16150f'; c.fillRect(0, 0, W, H);
    c.drawImage(li, gap, 90, w, h); c.drawImage(ri, gap * 2 + w, 90, w, h);
    c.fillStyle = '#f4f1ea'; c.font = '600 28px sans-serif';
    const m = results['market-stickers'];
    c.fillText(`Legacy preflight: ${m.legacy.clicks} clicks, ${m.legacy.fields} fields, ${m.legacy.screens} screens`, gap, 56);
    c.fillText(`RollCue: ${m.rollcue.clicks} clicks, ${m.rollcue.fields} fields, ${m.rollcue.screens} screens`, gap * 2 + w, 56);
    writeFileSync(`${OUT}/comparison.png`, cv.toBuffer('image/png'));
  }
});
