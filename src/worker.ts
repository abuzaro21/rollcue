// Runs inside a worker thread with V8 heap limits; the pool terminates it on timeout. Untrusted bytes are parsed here,
// never on the request thread.
import { parentPort } from 'node:worker_threads';
import { createHash } from 'node:crypto';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { inspect, Rejected, type Inspection, type Kind } from './inspect.ts';
import { binaryAlpha, rectLoop, traceContour, type Pt } from './geom.ts';
import { buildProduction, buildReturnNotice, renderFrame, verifyArtifact, type Check, type Expect } from './pdfout.ts';
import type { BuildPlan } from './policy.ts';

export type AnalyseTask = { type: 'analyse'; bytes: Uint8Array };
export type AnalyseResult = { inspection: Inspection; preview: Uint8Array };

export type PrepareTask =
  | { type: 'prepare-release'; kind: Kind; bytes: Uint8Array; inspection: Inspection; preview: Uint8Array; build: BuildPlan; title: string; subject: string; stamp: string }
  | { type: 'prepare-notice'; filename: string; notice: { title: string; lines: string[]; ask: string }; stamp: string };
export type Overlay = { pageW: number; pageH: number; trim: { x: number; y: number; w: number; h: number }; frame: { x: number; y: number; w: number; h: number }; loops: Pt[][]; tolMm: number | null };
export type PrepareResult = { artifact: Uint8Array; sha256: string; preview: Uint8Array | null; checks: Check[]; overlay: Overlay | null; contour: { loops: number; points: number; droppedSpecks: number; pxMm: number } | null; expect: Expect | null };

export type VerifyTask = { type: 'verify'; artifact: Uint8Array; expect: Parameters<typeof verifyArtifact>[1] };

export type Task = AnalyseTask | PrepareTask | VerifyTask;

async function analyse(t: AnalyseTask): Promise<AnalyseResult> {
  const { inspection, render } = await inspect(t.bytes);
  return { inspection, preview: new Uint8Array(render.png) };
}

export async function prepare(t: PrepareTask): Promise<PrepareResult> {
  const stamp = new Date(t.stamp);
  if (t.type === 'prepare-notice') {
    const artifact = await buildReturnNotice({ filename: t.filename, ...t.notice, stamp });
    const v = await verifyArtifact(artifact, { pageW: 210, pageH: 297, trim: { x: 0, y: 0, w: 0, h: 0 }, cutLoops: 0, notice: true });
    return { artifact, sha256: sha(artifact), preview: v.preview && new Uint8Array(v.preview), checks: v.checks, overlay: null, contour: null, expect: null };
  }
  const b = t.build;
  const art = { kind: t.kind, bytes: t.bytes, inspection: t.inspection, targetW: b.targetW, targetH: b.targetH, fit: b.fit };
  const frame = renderFrame(art);
  let loops: Pt[][] | null = null, contour: PrepareResult['contour'] = null, tolMm: number | null = null;
  if (b.cut === 'contour') {
    const img = await loadImage(Buffer.from(t.preview));
    const cv = createCanvas(img.width, img.height);
    const ctx = cv.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const mask = binaryAlpha(ctx.getImageData(0, 0, img.width, img.height).data, img.width, img.height);
    const pxMm = frame.w / img.width;
    // Fill crops the art at the bleed; trace only what will be printed, or the cut follows art that is not there (Codex R3-5).
    if (b.fit === 'fill') {
      for (let py = 0; py < img.height; py++) for (let px = 0; px < img.width; px++) {
        const x = frame.x + (px + 0.5) * pxMm, y = frame.y + frame.h - (py + 0.5) * pxMm;
        if (x < -b.bleedMm || y < -b.bleedMm || x > b.targetW + b.bleedMm || y > b.targetH + b.bleedMm) mask[py * img.width + px] = 0;
      }
    }
    const c = traceContour(mask, img.width, img.height, pxMm, b.offsetMm);
    loops = c.loops.map((l) => l.map(([x, y]) => [r3(x + frame.x), r3(y + frame.y)] as Pt));
    tolMm = r3(pxMm);
    contour = { loops: loops.length, points: loops.reduce((s, l) => s + l.length, 0), droppedSpecks: c.droppedSpecks, pxMm: r3(pxMm) };
    if (!loops.length) throw new Rejected('no-contour', 'No closed outline could be traced from the artwork transparency.');
  } else if (b.cut === 'rect') {
    loops = [rectLoop(0, 0, b.targetW, b.targetH, b.radiusMm)];
  }
  const artifact = await buildProduction({ ...art, marginMm: b.marginMm, bleedMm: b.bleedMm, cut: loops, cropMarks: b.cropMarks, title: t.title, subject: t.subject, stamp });
  const pageW = b.targetW + 2 * b.marginMm, pageH = b.targetH + 2 * b.marginMm;
  const trim = { x: b.marginMm, y: b.marginMm, w: b.targetW, h: b.targetH };
  // The art region is what the page shows of the frame: all of it, or the part a fill keeps.
  const fx = frame.x + b.marginMm, fy = frame.y + b.marginMm, lo = b.marginMm - b.bleedMm;
  const region = b.fit === 'fill'
    ? { x: Math.max(fx, lo), y: Math.max(fy, lo), w: Math.min(fx + frame.w, lo + b.targetW + 2 * b.bleedMm) - Math.max(fx, lo), h: Math.min(fy + frame.h, lo + b.targetH + 2 * b.bleedMm) - Math.max(fy, lo) }
    : { x: fx, y: fy, w: frame.w, h: frame.h };
  const expect: Expect = {
    pageW, pageH, trim, bleedMm: b.bleedMm, keepsCut: b.cut === 'keep',
    cutLoops: b.cut === 'keep' ? t.inspection.cut?.loops ?? 0 : loops?.length ?? 0,
    art: { region, coverage: t.inspection.mask.coverage },
  };
  const v = await verifyArtifact(artifact, expect);
  return {
    artifact, sha256: sha(artifact), preview: v.preview && new Uint8Array(v.preview), checks: v.checks, contour, expect,
    overlay: { pageW, pageH, trim, frame: { x: frame.x + b.marginMm, y: frame.y + b.marginMm, w: frame.w, h: frame.h }, loops: (loops ?? []).map((l) => l.map(([x, y]) => [r3(x + b.marginMm), r3(y + b.marginMm)] as Pt)), tolMm },
  };
}

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const r3 = (v: number) => Math.round(v * 1000) / 1000;

parentPort?.on('message', async ({ id, task }: { id: number; task: Task }) => {
  try {
    const result = task.type === 'analyse' ? await analyse(task) : task.type === 'verify' ? await verifyArtifact(task.artifact, task.expect) : await prepare(task);
    parentPort!.postMessage({ id, ok: true, result });
  } catch (e) {
    const err = e as Rejected;
    parentPort!.postMessage({ id, ok: false, error: { code: err instanceof Rejected ? err.code : 'internal', message: err instanceof Rejected ? err.message : 'Processing failed.' }, detail: String(err?.stack ?? err).slice(0, 2000) });
  }
});
