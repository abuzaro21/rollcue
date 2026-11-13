// Deterministic production policy. Given the measured inspection, the partial intake, the inferred (or operator-chosen)
// intent and the operator's bounded parameters, compute every check and select ONE next decision with a prepared
// action. Versioned: every approval binds POLICY_VERSION. Learning never changes anything in this file.
import { INTENT_LABEL, effectivePpi, targetSize, type Intake, type Intent } from './features.ts';
import type { Inspection } from './inspect.ts';
import type { Prediction } from './model.ts';
import { rollLayout, DEFAULT_ROLL, type Layout, type RollSettings } from './layout.ts';

export const POLICY_VERSION = 'rc-policy-1';

export const PPI = {
  sticker: { fail: 150, warn: 240 }, label: { fail: 200, warn: 280 }, poster: { fail: 100, warn: 150 }, banner: { fail: 40, warn: 72 },
} as const satisfies Record<Intent, { fail: number; warn: number }>;
export const ASPECT_TOLERANCE = 0.02;
export const DEFAULT_OFFSET = { sticker: 2, label: 1.5 } as const;
export const GAP_MM: Record<Intent, number> = { sticker: 4, label: 3, poster: 10, banner: 20 };

export type Params = {
  intent?: Intent; // operator correction; overrides the model
  targetW?: number; targetH?: number; // operator-chosen finished size, mm
  fit?: 'fit' | 'fill'; // when the requested aspect differs from the art
  offsetMm?: number; // contour offset outside the art
  radiusMm?: number; // corner radius for a rectangular cut
  acceptLowRes?: boolean; // operator overrides the resolution floor
  rectCut?: boolean; // operator accepts a rectangular cut for opaque sticker art
};

export const PARAM_LIMITS = { offsetMm: [0, 6], radiusMm: [0, 10], target: [5, 5000] } as const;

export type CheckStatus = 'pass' | 'warn' | 'fail' | 'unknown';
export type PCheck = { id: string; label: string; status: CheckStatus; detail: string };

export type Evidence = { thin: boolean; reasons: string[]; filenameShare: number; contextSignals: number };

export type BuildPlan = {
  cut: 'contour' | 'rect' | 'keep' | 'none';
  targetW: number; targetH: number;
  marginMm: number;
  offsetMm: number;
  radiusMm: number;
  cropMarks: boolean;
  fit: 'scale' | 'fit' | 'fill';
};

export type Option = { id: string; label: string; detail: string; recommended?: boolean; params: Params };

export type Decision =
  | { kind: 'intent'; headline: string; found: string; why: string; options: Option[] }
  | { kind: 'size'; headline: string; found: string; why: string; options: Option[] }
  | { kind: 'return'; headline: string; found: string; why: string; notice: { title: string; lines: string[]; ask: string }; options: Option[] }
  | { kind: 'release'; headline: string; found: string; why: string; build: BuildPlan; layout: Layout; changes: string[]; keeps: string[]; warnings: string[]; options: Option[] };

export type Plan = { intent: Intent | null; intentSource: 'model' | 'operator' | null; evidence: Evidence; checks: PCheck[]; decision: Decision; target: { w: number; h: number } | null };

const mm = (v: number) => (v >= 100 ? Math.round(v) : Math.round(v * 10) / 10).toString();
const size = (w: number, h: number) => `${mm(w)} × ${mm(h)} mm`;

/**
 * Evidence sufficiency. The model's probability is calibrated on synthetic data, so when a call leans mostly on the
 * filename, or the job arrived with almost no instructions, the surface must say so instead of looking certain.
 */
export function evidenceOf(p: Prediction, intake: Intake): Evidence {
  const pos = p.forTop.reduce((s, e) => s + e.weight, 0);
  const fileShare = pos > 0 ? p.forTop.filter((e) => e.feature.startsWith('file_')).reduce((s, e) => s + e.weight, 0) / pos : 0;
  const signals = [intake.qty, intake.reqW, intake.media, /\S/.test(intake.notes) ? 1 : null].filter((v) => v !== null && v !== undefined && v !== 0).length;
  const reasons: string[] = [];
  if (fileShare >= 0.35) reasons.push(`Most of the evidence for ${INTENT_LABEL[p.top].toLowerCase()} is the filename.`);
  if (signals <= 1) reasons.push('The job came with almost no instructions (size, quantity, media or notes).');
  return { thin: reasons.length > 0, reasons, filenameShare: Math.round(fileShare * 100) / 100, contextSignals: signals };
}

export function plan(ins: Inspection, intake: Intake, pred: Prediction, params: Params, roll: RollSettings = DEFAULT_ROLL): Plan {
  const evidence = evidenceOf(pred, intake);
  const intent: Intent | null = params.intent ?? (pred.abstain ? null : pred.top);
  const intentSource = params.intent ? 'operator' : intent ? 'model' : null;
  const checks: PCheck[] = [];
  const add = (id: string, label: string, status: CheckStatus, detail: string) => checks.push({ id, label, status, detail });

  // --- intent ---
  if (!intent) {
    const options = pred.ranked.slice(0, 3).map((k, i) => ({
      id: `intent-${k}`, label: INTENT_LABEL[k], detail: pred.forEach[k].map((e) => e.label).slice(0, 2).join(' · ') || 'weak evidence', recommended: i === 0, params: { intent: k },
    }));
    add('intent', 'Job type', 'unknown', `Model abstained: top ${Math.round(pred.pTop * 100)}%, margin ${Math.round(pred.margin * 100)} points.`);
    return {
      intent: null, intentSource: null, evidence, checks, target: null,
      decision: { kind: 'intent', headline: 'Which job is this?', found: `It reads as ${INTENT_LABEL[pred.ranked[0]].toLowerCase()} or ${INTENT_LABEL[pred.ranked[1]].toLowerCase()}, and the evidence does not separate them.`, why: 'Stickers, labels, posters and banners need different cuts, sizes and checks. Guessing here would prepare the wrong file.', options },
    };
  }
  add('intent', 'Job type', 'pass', `${INTENT_LABEL[intent]} (${intentSource === 'operator' ? 'set by operator' : `model, ${pred.band}`})`);

  // --- size ---
  const req = targetSize(ins, intake);
  const target = params.targetW && params.targetH ? { w: params.targetW, h: params.targetH, source: 'operator' as const } : req;
  if (!target) {
    const px = ins.pixels!;
    const at300 = { w: (px.w / 300) * 25.4, h: (px.h / 300) * 25.4 };
    const presetsLong: Record<Intent, number[]> = { sticker: [50, 75, 100], label: [60, 90, 120], poster: [420, 594, 841], banner: [2000, 3000, 4000] };
    const ar = px.h / px.w;
    const opts: Option[] = [];
    if (intent === 'sticker' || intent === 'label') opts.push({ id: 'size-300', label: `As supplied at 300 ppi`, detail: size(at300.w, at300.h), params: { targetW: r1(at300.w), targetH: r1(at300.h) } });
    for (const L of presetsLong[intent]) {
      const w = ar <= 1 ? L : L / ar, h = ar <= 1 ? L * ar : L;
      opts.push({ id: `size-${L}`, label: `${mm(L)} mm long side`, detail: `${size(w, h)} · ${Math.round(px.w / (w / 25.4))} ppi`, params: { targetW: r1(w), targetH: r1(h) } });
    }
    // Recommend the largest preset that still meets the resolution floor; else the smallest.
    const ok = opts.filter((o) => px.w / (o.params.targetW! / 25.4) >= PPI[intent].warn);
    (ok.at(-1) ?? opts[0]).recommended = true;
    add('size', 'Finished size', 'unknown', 'The image has no density metadata and the job gives no size.');
    return {
      intent, intentSource, evidence, checks, target: null,
      decision: { kind: 'size', headline: 'What size should this print?', found: `The image is ${px.w} × ${px.h} px with no size information, and the job does not give one.`, why: 'Size decides resolution, cut geometry and how much media the job uses.', options: opts },
    };
  }
  add('size', 'Finished size', 'pass', `${size(target.w, target.h)} (${target.source})`);

  // --- geometry & resolution ---
  const docAspect = ins.widthMm && ins.heightMm ? ins.widthMm / ins.heightMm : ins.pixels ? ins.pixels.w / ins.pixels.h : null;
  const aspectOff = docAspect ? Math.abs(Math.log((target.w / target.h) / docAspect)) : 0;
  const fit: BuildPlan['fit'] = aspectOff > ASPECT_TOLERANCE ? params.fit ?? 'fit' : 'scale';
  if (aspectOff > ASPECT_TOLERANCE) add('aspect', 'Proportions', 'warn', `Requested ${size(target.w, target.h)} differs from the artwork's proportions by ${Math.round(aspectOff * 100)}%.`);
  else add('aspect', 'Proportions', 'pass', 'Artwork and requested size have the same proportions.');
  const scale = ins.widthMm ? target.w / ins.widthMm : null;
  if (scale && Math.abs(scale - 1) > 0.005) add('scale', 'Scale', 'warn', `Artwork is drawn at ${Math.round(100 / scale)}% of the finished size; it will be scaled ${scale.toFixed(scale > 5 ? 0 : 2)}×.`);
  const ppi = effectivePpi(ins, target);
  const floor = PPI[intent];
  if (ppi === null) add('resolution', 'Resolution at size', ins.imageCount === 0 ? 'pass' : 'unknown', ins.imageCount === 0 ? 'Vector artwork; no raster images.' : 'An image is placed with a transform that cannot be resolved.');
  else add('resolution', 'Resolution at size', ppi < floor.fail ? 'fail' : ppi < floor.warn ? 'warn' : 'pass', `${ppi} ppi at ${size(target.w, target.h)} (floor ${floor.fail}, comfortable ${floor.warn}).`);
  if (ins.pages > 1) add('pages', 'Pages', 'warn', `${ins.pages} pages; only page 1 is prepared.`);
  if (ins.rotation) add('rotation', 'Page rotation', 'fail', `Page 1 is rotated ${ins.rotation}°; RollCue does not prepare rotated pages yet.`);

  // --- cut ---
  const m = ins.mask;
  const transparent = m.transparentFrac > 0.01;
  const rectangular = m.rectangularity >= 0.97 && m.components === 1;
  let cut: BuildPlan['cut'] = 'none';
  if (intent === 'sticker' || intent === 'label') {
    const c = ins.cut;
    if (c && c.exactName && c.stroked && !c.filled) { cut = 'keep'; add('cut', 'Cut path', 'pass', 'The file already has a stroked "CutContour" separation. It is kept as supplied.'); }
    else if (c && !c.exactName) add('cut', 'Cut path', 'fail', `The cut separation is named "${c.name}", not "CutContour". The cutter would ignore it and the printer may print it as ink.`);
    else if (c && c.filled) add('cut', 'Cut path', 'fail', 'The CutContour separation is used as a fill, not a stroke.');
    else if (transparent && !(intent === 'label' && rectangular && m.coverage > 0.97)) { cut = 'contour'; add('cut', 'Cut path', 'warn', `No cut path. A contour can be traced from the artwork's transparency (${m.components} shape${m.components === 1 ? '' : 's'}).`); }
    else if (rectangular && m.whiteBorder < 0.9) { cut = 'rect'; add('cut', 'Cut path', 'warn', 'No cut path. The artwork is a filled rectangle, so a rectangular cut at the trim is exact.'); }
    else if (params.rectCut) { cut = 'rect'; add('cut', 'Cut path', 'warn', 'No cut path. Operator accepted a rectangular cut at the trim.'); }
    else add('cut', 'Cut path', 'fail', m.whiteBorder >= 0.9 ? 'No cut path, and the artwork sits on an opaque white background, so its outline cannot be separated reliably.' : 'No cut path, and the artwork has no transparency to trace a shape from.');
  } else if (ins.cut) add('cut', 'Cut path', 'warn', `The file contains a "${ins.cut.name}" separation, but a ${INTENT_LABEL[intent].toLowerCase()} is not cut to shape. It will be left out of the print.`);

  // --- bleed (trimmed products) ---
  if (intent === 'poster' || intent === 'banner') {
    if (m.edgeTouch > 0.5 && (ins.bleedMm ?? 0) < 2) add('bleed', 'Bleed', 'warn', 'Artwork runs to the trim edge without bleed; a slight white edge is possible after trimming. RollCue never invents bleed.');
    else add('bleed', 'Bleed', 'pass', ins.bleedMm ? `${ins.bleedMm} mm bleed.` : 'Artwork does not run to the edge.');
  }

  // --- roll fit ---
  const layout = rollLayout(target.w, target.h, intake.qty ?? 1, GAP_MM[intent], roll);
  add('roll', 'Fits the roll', layout.fits ? 'pass' : 'fail', layout.fits ? `${layout.across} across${layout.rotated ? ' (rotated)' : ''} on ${roll.rollWidthMm} mm, about ${(layout.lengthMm / 1000).toFixed(2)} m of media for ${intake.qty ?? 1}.` : `Neither side fits the usable roll width of ${layout.usableWidthMm} mm; tiling is not supported.`);

  // --- decide ---
  const fails = checks.filter((c) => c.status === 'fail' && !(c.id === 'resolution' && params.acceptLowRes));
  if (fails.length) {
    const first = fails[0];
    const options: Option[] = [{ id: 'send-notice', label: 'Return to customer', detail: 'Approve the prepared notice', recommended: true, params: {} }];
    if (first.id === 'resolution') options.push({ id: 'accept-lowres', label: 'Print anyway', detail: 'Soft print accepted by operator', params: { acceptLowRes: true } });
    if (first.id === 'cut' && (intent === 'sticker' || intent === 'label') && !ins.cut) options.push({ id: 'rect-cut', label: 'Cut as a rectangle', detail: 'Ignore the shape, cut at the trim', params: { rectCut: true } });
    const asks: Record<string, string> = {
      resolution: `Please send the artwork at ${floor.warn} ppi or more at ${size(target.w, target.h)}, or as vector PDF.`,
      cut: 'Please send the artwork with a stroked spot colour named exactly "CutContour", or as a PNG with a transparent background.',
      roll: `The longest side that fits our roll is ${layout.usableWidthMm} mm. Please confirm a smaller size or a split design.`,
      rotation: 'Please export the PDF without page rotation.',
    };
    return {
      intent, intentSource, evidence, checks, target,
      decision: {
        kind: 'return', headline: first.id === 'resolution' ? 'Too soft to print at this size' : first.id === 'roll' ? 'Too large for the roll' : first.id === 'cut' ? 'No usable cut path' : 'Cannot prepare this file',
        found: first.detail, why: whyFor(first.id, intent),
        notice: { title: first.label, lines: fails.map((f) => f.detail), ask: asks[first.id] ?? 'Please send a corrected file.' }, options,
      },
    };
  }

  const isCut = intent === 'sticker' || intent === 'label';
  const build: BuildPlan = {
    cut, targetW: r1(target.w), targetH: r1(target.h), fit,
    marginMm: isCut ? Math.max(5, (params.offsetMm ?? DEFAULT_OFFSET[intent as 'sticker']) + 3) : 15,
    offsetMm: cut === 'contour' ? clamp(params.offsetMm ?? DEFAULT_OFFSET[intent as 'sticker' | 'label'], PARAM_LIMITS.offsetMm) : 0,
    radiusMm: cut === 'rect' ? clamp(params.radiusMm ?? 0, PARAM_LIMITS.radiusMm) : 0,
    cropMarks: !isCut,
  };
  const changes: string[] = [];
  const keeps = ['The uploaded original is never modified.', ins.kind === 'pdf' ? 'Artwork is embedded as-is: vectors, fonts and colours unchanged.' : 'Image pixels are embedded unchanged.'];
  if (cut === 'contour') changes.push(`Add a CutContour line ${mm(build.offsetMm)} mm outside the artwork, traced from its transparency.`);
  if (cut === 'rect') changes.push(`Add a rectangular CutContour at the trim${build.radiusMm ? ` with ${mm(build.radiusMm)} mm corners` : ''}.`);
  if (cut === 'keep') keeps.push('The supplied CutContour is kept exactly as drawn.');
  if (scale && Math.abs(scale - 1) > 0.005) changes.push(`Scale artwork ${scale.toFixed(2)}× to ${size(target.w, target.h)}.`);
  if (fit === 'fit') changes.push('Fit artwork inside the requested size; the uncovered area stays unprinted.');
  if (fit === 'fill') changes.push('Fill the requested size; artwork beyond it is cropped.');
  if (build.cropMarks) changes.push('Add crop marks outside the trim.');
  if (ins.cut && !isCut) changes.push(`Leave out the "${ins.cut.name}" separation (not used for ${INTENT_LABEL[intent].toLowerCase()}).`);
  const warnings = checks.filter((c) => c.status === 'warn' && !['cut', 'scale', 'aspect'].includes(c.id)).map((c) => c.detail);
  if (params.acceptLowRes) warnings.unshift('Operator accepted printing below the resolution floor.');

  const lead = cut === 'contour' ? { h: 'No cut path in the file', f: `This reads as ${INTENT_LABEL[intent].toLowerCase()}, but the file has no CutContour. The cutter would have nothing to follow.`, w: 'A contour from the artwork’s own transparency is ready for review.' }
    : cut === 'rect' ? { h: 'Rectangular cut needed', f: 'The file has no cut path; the artwork is a filled rectangle.', w: 'A rectangle at the trim is the exact outline, so a CutContour there is ready for review.' }
    : scale && Math.abs(scale - 1) > 0.005 ? { h: 'Artwork is not at finished size', f: `The file measures ${size(ins.widthMm!, ins.heightMm!)}; the job asks for ${size(target.w, target.h)}.`, w: 'A production file at the finished size is ready; the art is scaled, not redrawn.' }
    : { h: 'Ready for production', f: `Every check passes for ${INTENT_LABEL[intent].toLowerCase()}.`, w: 'The production file and job ticket are prepared. Approve to release them to the queue.' };
  const options: Option[] = [];
  if (cut === 'contour') for (const o of [1, 2, 3]) if (o !== build.offsetMm) options.push({ id: `offset-${o}`, label: `${o} mm border`, detail: 'Re-trace the contour', params: { offsetMm: o } });
  if (fit !== 'scale') options.push({ id: `fit-${fit === 'fit' ? 'fill' : 'fit'}`, label: fit === 'fit' ? 'Fill and crop' : 'Fit inside', detail: 'Change how the art meets the size', params: { fit: fit === 'fit' ? 'fill' : 'fit' } });
  return {
    intent, intentSource, evidence, checks, target,
    decision: { kind: 'release', headline: lead.h, found: lead.f, why: lead.w, build, layout, changes, keeps, warnings, options },
  };
}

function whyFor(id: string, intent: Intent): string {
  switch (id) {
    case 'resolution': return `Below ${PPI[intent].fail} ppi a ${INTENT_LABEL[intent].toLowerCase()} prints visibly soft; the customer should decide, not the press.`;
    case 'cut': return 'Without a usable cut path the cutter either does nothing or cuts the wrong line; a guessed outline would waste media.';
    case 'roll': return 'Printing larger than the roll means tiling, which this shop does not prepare automatically.';
    default: return 'Preparing it anyway would produce a file that cannot be trusted.';
  }
}

const clamp = (v: number, [lo, hi]: readonly [number, number]) => Math.min(hi, Math.max(lo, v));
const r1 = (v: number) => Math.round(v * 10) / 10;
