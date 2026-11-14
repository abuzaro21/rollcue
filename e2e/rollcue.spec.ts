import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';

const ready = async (page: Page) => {
  await expect(page.locator('.headline')).toBeVisible();
  await expect(page.locator('[aria-busy=true]')).toHaveCount(0, { timeout: 30_000 });
};
const openJob = async (page: Page, name: RegExp) => { await page.locator('.qchip', { hasText: name }).first().click(); await ready(page); };
const hooks = !process.env.E2E_BASE_URL;

test('first visit: a prepared job and its next decision, no setup', async ({ page }) => {
  await page.goto('/');
  await ready(page);
  await expect(page.locator('.qchip')).toHaveCount(4);
  await expect(page.getByRole('button', { name: 'Try a sample job' })).toBeVisible();
  await openJob(page, /olive-market-sticker/);
  await expect(page.locator('.intent-name')).toHaveText('Die-cut stickers');
  await expect(page.locator('.headline')).toHaveText('No cut path in the file');
  await expect(page.locator('path.cut')).toHaveCount(1);
  await expect(page.locator('.changes li').first()).toContainText('CutContour');
  await expect(page.getByRole('button', { name: 'Approve and release' })).toBeEnabled();
});

test('approve: bound to the artifact, then a verified receipt and a valid PDF', async ({ page }) => {
  await page.goto('/');
  await ready(page);
  await openJob(page, /olive-market-sticker/);
  const bound = await page.locator('.binding').textContent();
  await page.getByRole('button', { name: 'Approve and release' }).click();
  await expect(page.locator('.stamp')).toHaveText('Released');
  await expect(page.locator('.ticket')).toContainText(/(\d+)\/\1 re-verified/);
  expect(bound).toMatch(/Approves file [0-9a-f]{8}/);
  const [dl] = await Promise.all([page.waitForEvent('download'), page.locator('.side').getByRole('link', { name: 'Download production PDF' }).click()]);
  expect(dl.suggestedFilename()).toMatch(/production.*\.pdf$/);
  const bytes = readFileSync((await dl.path())!);
  expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');
  expect(bytes.toString('latin1')).toContain('/CutContour');
  await expect(page.locator('.qchip.released')).toHaveCount(1);
});

test('wrong guess: flagged, corrected in one step, remembered, re-prepared', async ({ page }) => {
  await page.goto('/');
  await ready(page);
  await openJob(page, /stickers-final/);
  await expect(page.locator('.chip.thin')).toBeVisible();
  await expect(page.locator('.thin-note')).toContainText('Check this one');
  const oldFile = await page.locator('.binding').textContent();
  await page.getByRole('button', { name: 'Not this?' }).click();
  await page.locator('.alt', { hasText: 'Poster' }).click();
  await ready(page);
  await expect(page.locator('.intent-name')).toHaveText('Poster');
  await expect(page.locator('.chip.set')).toHaveText('set by you');
  await expect(page.getByRole('button', { name: /Remembers 1 correction/ })).toBeVisible();
  await expect(page.locator('.binding')).not.toHaveText(oldFile!);
  await expect(page.locator('path.cut')).toHaveCount(0);
  await page.locator('.evidence summary').click();
  await expect(page.locator('.events')).toContainText('proposal-superseded');
  await expect(page.locator('.events')).toContainText('intent-corrected');
  // A similar file arriving later is read as a poster because of the correction.
  await page.getByRole('button', { name: 'Try a sample job' }).click();
  await page.locator('.sheet .option', { hasText: 'stickers-final.pdf' }).click();
  await ready(page);
  await expect(page.locator('.intent-name')).toHaveText('Poster');
  await expect(page.locator('.intent .chip.memory')).toHaveText('from your correction');
});

test('return path: soft artwork gets a prepared notice instead of a blurry print', async ({ page }) => {
  await page.goto('/');
  await ready(page);
  await openJob(page, /window-poster/);
  await expect(page.locator('.headline')).toHaveText('Too soft to print at this size');
  await expect(page.locator('.notice-text')).toContainText('Please send the artwork');
  await page.getByRole('button', { name: 'Approve return' }).click();
  await expect(page.locator('.stamp')).toHaveText('Returned');
});

test('execution failure: nothing released, retry recovers', async ({ page }) => {
  test.skip(!hooks, 'needs the test hook');
  await page.goto('/#hooks');
  await ready(page);
  await openJob(page, /honey-jar-labels/);
  await page.getByRole('button', { name: 'Fail next release' }).click();
  await page.getByRole('button', { name: 'Approve and release' }).click();
  await expect(page.locator('.toast')).toContainText('Nothing was released');
  await expect(page.locator('.failure')).toBeVisible();
  await page.getByRole('button', { name: 'Prepare again' }).click();
  await ready(page);
  await page.getByRole('button', { name: 'Approve and release' }).click();
  await expect(page.locator('.stamp')).toHaveText('Released');
});

test('upload: a real file through intake, reading and decision', async ({ page }) => {
  await page.goto('/');
  await ready(page);
  await page.getByRole('button', { name: '+ Upload' }).click();
  await page.locator('.drop input[type=file]').setInputFiles('samples/jam-labels-misnamed.pdf');
  await page.getByLabel('Quantity').fill('2000');
  await page.getByLabel('Media').selectOption('label_stock');
  await page.getByLabel('Customer notes').fill('labels for the jam jars');
  await page.getByRole('button', { name: 'Let RollCue read it' }).click();
  await ready(page);
  await expect(page.locator('.card-meta .file')).toHaveText('jam-labels-misnamed.pdf');
  await expect(page.locator('.intent-name')).toHaveText('Rectangular roll labels');
});

test('unsupported upload is refused with a clear message', async ({ page }) => {
  await page.goto('/');
  await ready(page);
  await page.getByRole('button', { name: '+ Upload' }).click();
  await page.locator('.drop input[type=file]').setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') });
  await page.getByRole('button', { name: 'Let RollCue read it' }).click();
  await expect(page.locator('.toast.error')).toContainText('Only PDF, PNG and JPEG');
});

test('keyboard: compare slider and dialog work without a pointer', async ({ page }) => {
  await page.goto('/');
  await ready(page);
  await openJob(page, /olive-market-sticker/);
  const slider = page.getByRole('slider', { name: /Compare the customer file/ });
  await slider.focus();
  const before = await slider.inputValue();
  await page.keyboard.press('ArrowRight');
  expect(Number(await slider.inputValue())).toBeGreaterThan(Number(before));
  await page.getByRole('button', { name: 'Try a sample job' }).click();
  await expect(page.locator('dialog.sheet')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('dialog.sheet')).toBeHidden();
});

test('refresh keeps the work: state is on the server, not in the tab', async ({ page }) => {
  await page.goto('/');
  await ready(page);
  await openJob(page, /stickers-final/);
  await page.getByRole('button', { name: 'Not this?' }).click();
  await page.locator('.alt', { hasText: 'Poster' }).click();
  await ready(page);
  await page.reload();
  await ready(page);
  await openJob(page, /stickers-final/);
  await expect(page.locator('.intent-name')).toHaveText('Poster');
  await expect(page.getByRole('button', { name: /Remembers 1 correction/ })).toBeVisible();
});

test('no horizontal overflow at this viewport', async ({ page }) => {
  await page.goto('/');
  await ready(page);
  const [sw, cw] = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
  expect(sw).toBeLessThanOrEqual(cw);
});
