// Deterministic production policy. Given the measured inspection, the partial intake, the inferred (or operator-chosen)
// intent and the operator's bounded parameters, compute every check and select ONE next decision with a prepared
// action. Versioned: every approval binds POLICY_VERSION. Learning never changes anything in this file.
import { INTENT_LABEL, effectivePpi, targetSize, textGroups, type Intake, type Intent } from './features.ts';
import type { Inspection } from './inspect.ts';
import type { Prediction } from './model.ts';
import { rollLayout, cropMarkGeometry, DEFAULT_ROLL, type Layout, type RollSettings } from './layout.ts';

export const POLICY_VERSION = 'rc-policy-4';

/** Work this shop does not prepare on roll media. The model only knows four intents, so this is a hard boundary in policy, not a guess. */
// "Packaging labels" and "packaging stickers" are labels and stickers, not packaging manufacture (Codex R2-3).
export const OUT_OF_SCOPE = /\b(packaging(?!\s+(labels?|stickers?)\b)|cartons?|die-?lines?|folding box(es)?|tuck box(es)?|gable box(es)?)\b|تغليف|كرتون/i;
export const outOfScope = (intake: Pick<Intake, 'notes' | 'filename'>) => OUT_OF_SCOPE.exec(`${intake.notes} ${intake.filename}`);

export const PPI = {
  sticker: { fail: 150, warn: 240 }, label: { fail: 200, warn: 280 }, poster: { fail: 100, warn: 150 }, banner: { fail: 40, warn: 72 },
} as const satisfies Record<Intent, { fail: number; warn: number }>;
export const ASPECT_TOLERANCE = 0.02;
export const DEFAULT_OFFSET = { sticker: 2, label: 1.5 } as const;
export const GAP_MM: Record<Intent, number> = { sticker: 4, label: 3, poster: 10, banner: 20 };
export const TRIM_MARGIN_MM = 15; // page margin around posters and banners, holding bleed and crop marks
export const FILL_BLEED_MM = 3; // bleed kept from art that a fill crops anyway
export const MAX_BLEED_MM = 5;

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
  bleedMm: number; // art kept beyond the trim and declared as the BleedBox
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
  const fileShare = p.filenameShare ?? 0;
  // Notes count only when they say something about the job; "thanks" is not evidence (Codex R2-4).
  const notesSay = Object.values(textGroups(intake.notes)).some((v) => v !== 0);
  const signals = [intake.qty, intake.reqW || intake.reqH, intake.media, notesSay ? 1 : null].filter((v) => v !== null && v !== undefined && v !== 0).length;
  const reasons: string[] = [];
  if (fileShare >= 0.35) reasons.push(`Most of the evidence for ${INTENT_LABEL[p.top].toLowerCase()} is the filename.`);
  if (signals <= 1) reasons.push('The job came with almost no instructions (size, quantity, media or notes).');
  // A remembered correction can carry a reading the model alone disagrees with; similarity is not proof (Codex R2-2).
  const modelTop = (Object.entries(p.modelProbs ?? p.probs) as Array<[Intent, number]>).sort((a, b) => b[1] - a[1])[0][0];
  if (p.memory.length && modelTop !== p.top) reasons.push(`Read as ${INTENT_LABEL[p.top].toLowerCase()} only because you corrected ${p.memory[0].filename}; the model alone reads ${INTENT_LABEL[modelTop].toLowerCase()}.`);
  return { thin: reasons.length > 0, reasons, filenameShare: Math.round(fileShare * 100) / 100, contextSignals: signals };
}

export function plan(ins: Inspection, intake: Intake, pred: Prediction, params: Params, roll: RollSettings = DEFAULT_ROLL): Plan {
  const evidence = evidenceOf(pred, intake);
  const intent: Intent | null = params.intent ?? (pred.abstain ? null : pred.top);
  const intentSource = params.intent ? 'operator' : intent ? 'model' : null;
  const checks: PCheck[] = [];
  const add = (id: string, label: string, status: CheckStatus, detail: string) => checks.push({ id, label, status, detail });

  // --- scope: an explicit mention of work RollCue does not prepare stops the model's reading (the operator can override) ---
  const scopeHit = params.intent ? null : outOfScope(intake);
  if (scopeHit) {
    add('scope', 'Supported work', 'fail', `The job mentions “${scopeHit[0]}”. RollCue prepares stickers, labels, posters and banners only.`);
    const options: Option[] = [
      { id: 'send-notice', label: 'Return to customer', detail: 'Approve the prepared notice', recommended: true, params: {} },
      ...pred.ranked.slice(0, 2).map((k) => ({ id: `intent-${k}`, label: `It is ${INTENT_LABEL[k].toLowerCase()} after all`, detail: 'Prepare it as that job', params: { intent: k } })),
    ];
    return {
      intent: null, intentSource: null, evidence, checks, target: null,
      decision: {
        kind: 'return', headline: 'Outside what RollCue prepares', found: checks[0].detail,
        why: 'Packaging and dielines need a prepress operator. Preparing it as a sticker or a poster would produce the wrong file.',
        notice: { title: 'Packaging job', lines: ['We received your file for a packaging job.'], ask: 'Our prepress team prepares packaging and dielines by hand and will contact you to confirm the details.' },
        options,
      },
    };
  }

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
  // A raster's density is metadata, not an order: the 5 m cap applies to the size that would be printed (Codex R3-14).
  if (Math.max(target.w, target.h) > PARAM_LIMITS.target[1]) add('size', 'Finished size', 'fail', `${size(target.w, target.h)} (${target.source}) is larger than the 5 m RollCue prepares.`);
  else add('size', 'Finished size', 'pass', `${size(target.w, target.h)} (${target.source})`);

  // --- geometry & resolution ---
  const docAspect = ins.widthMm && ins.heightMm ? ins.widthMm / ins.heightMm : ins.pixels ? ins.pixels.w / ins.pixels.h : null;
  const aspectOff = docAspect ? Math.abs(Math.log((target.w / target.h) / docAspect)) : 0;
  const fit: BuildPlan['fit'] = aspectOff > ASPECT_TOLERANCE ? params.fit ?? 'fit' : 'scale';
  if (aspectOff > ASPECT_TOLERANCE) add('aspect', 'Proportions', 'warn', `Requested ${size(target.w, target.h)} differs from the artwork's proportions by ${Math.round(aspectOff * 100)}%.`);
  else add('aspect', 'Proportions', 'pass', 'Artwork and requested size have the same proportions.');
  const scale = ins.widthMm ? target.w / ins.widthMm : null;
  if (scale && Math.abs(scale - 1) > 0.005) add('scale', 'Scale', 'warn', `Artwork is drawn at ${Math.round(100 / scale)}% of the finished size; it will be scaled ${scale.toFixed(scale > 5 ? 0 : 2)}×.`);
  const ppi = effectivePpi(ins, target, fit);
  const floor = PPI[intent];
  if (ppi === null) add('resolution', 'Resolution at size', ins.imageCount === 0 ? 'pass' : 'unknown', ins.imageCount === 0 ? 'Vector artwork; no raster images.' : 'An image is placed with a transform that cannot be resolved.');
  else add('resolution', 'Resolution at size', ppi < floor.fail ? 'fail' : ppi < floor.warn ? 'warn' : 'pass', `${ppi} ppi at ${size(target.w, target.h)} (floor ${floor.fail}, comfortable ${floor.warn}).`);
  // Releasing page 1 of a multi-design order would silently drop the rest (Codex R3-12).
  if (ins.pages > 1) add('pages', 'Pages', 'fail', `The PDF has ${ins.pages} pages; RollCue prepares one page per job and cannot choose which one is wanted.`);
  if (ins.printableAnnots) add('annotations', 'Annotations', 'fail', `Page 1 has ${ins.printableAnnots} printable annotation${ins.printableAnnots === 1 ? '' : 's'} or form field${ins.printableAnnots === 1 ? '' : 's'}; the production file would lose ${ins.printableAnnots === 1 ? 'it' : 'them'}.`); // Codex R3-8
  if (ins.rotation) add('rotation', 'Page rotation', 'fail', `Page 1 is rotated ${ins.rotation}°; RollCue does not prepare rotated pages yet.`);

  // --- cut ---
  const m = ins.mask;
  const transparent = m.transparentFrac > 0.01;
  const rectangular = m.rectangularity >= 0.97 && m.components === 1;
  let cut: BuildPlan['cut'] = 'none';
  if (intent === 'sticker' || intent === 'label') {
    const c = ins.cut;
    if (c?.hidden) add('cut', 'Cut path', 'fail', `The "${c.name}" separation is used inside a pattern, shading or text, where a cutter does not read it.`);
    else if (c && c.exactName && c.stroked && !c.filled && c.openLoops) add('cut', 'Cut path', 'fail', `The CutContour has ${c.openLoops} open path${c.openLoops === 1 ? '' : 's'}; a cutter needs closed shapes.`);
    else if (c && c.exactName && c.stroked && !c.filled) { cut = 'keep'; add('cut', 'Cut path', 'pass', 'The file already has a stroked "CutContour" separation. It is kept as supplied.'); }
    else if (c && !c.exactName) add('cut', 'Cut path', 'fail', `The cut separation is named "${c.name}", not "CutContour". The cutter would ignore it and the printer may print it as ink.`);
    else if (c && c.filled) add('cut', 'Cut path', 'fail', 'The CutContour separation is used as a fill, not a stroke.');
    // A CutContour that is declared but never stroked (unused, zero tint, empty path) is no cut: trace one as for any file.
    else if (transparent && !(intent === 'label' && rectangular && m.coverage > 0.97)) { cut = 'contour'; add('cut', 'Cut path', 'warn', `No cut path. A contour can be traced from the artwork's transparency (${m.components} shape${m.components === 1 ? '' : 's'}).`); }
    else if (rectangular && m.whiteBorder < 0.9) { cut = 'rect'; add('cut', 'Cut path', 'warn', 'No cut path. The artwork is a filled rectangle, so a rectangular cut at the trim is exact.'); }
    else if (params.rectCut) { cut = 'rect'; add('cut', 'Cut path', 'warn', 'No cut path. Operator accepted a rectangular cut at the trim.'); }
    else add('cut', 'Cut path', 'fail', m.whiteBorder >= 0.9 ? 'No cut path, and the artwork sits on an opaque white background, so its outline cannot be separated reliably.' : 'No cut path, and the artwork has no transparency to trace a shape from.');
  } else if (ins.cut && (ins.cut.stroked || ins.cut.filled || ins.cut.hidden)) add('cut', 'Cut path', 'fail', `The file contains a "${ins.cut.name}" separation, but a ${INTENT_LABEL[intent].toLowerCase()} is not cut to shape. RollCue does not edit customer artwork, and a stray cut path can print as ink or trigger the cutter.`);

  // --- bleed (trimmed products): measured at the finished size, and only where art actually fills it (Codex R3-7) ---
  const isCut = intent === 'sticker' || intent === 'label';
  const artScale = ins.widthMm && ins.heightMm ? (fit === 'fill' ? Math.max : Math.min)(target.w / ins.widthMm, target.h / ins.heightMm) : 1;
  const bleedAtSize = r1((ins.bleedMm ?? 0) * artScale);
  const bleedFilled = ins.trimEdgeTouch === null || m.edgeTouch > 0.5; // art reaches the outer box, not only the trim
  if (!isCut) {
    if ((ins.trimEdgeTouch ?? m.edgeTouch) > 0.5 && (bleedAtSize < 2 || !bleedFilled)) add('bleed', 'Bleed', 'warn', 'Artwork runs to the trim edge without bleed; a slight white edge is possible after trimming. RollCue never invents bleed.');
    else add('bleed', 'Bleed', 'pass', bleedAtSize && bleedFilled ? `${mm(bleedAtSize)} mm bleed at the finished size.` : 'Artwork does not run to the edge.');
  }

  // --- roll fit: the footprint each item needs (cut offset or crop marks), not just the trim (Codex R3-9) ---
  const marginMm = isCut ? Math.max(5, (params.offsetMm ?? DEFAULT_OFFSET[intent as 'sticker']) + 3) : TRIM_MARGIN_MM;
  const offsetMm = cut === 'contour' ? clamp(params.offsetMm ?? DEFAULT_OFFSET[intent as 'sticker' | 'label'], PARAM_LIMITS.offsetMm) : 0;
  const bleedMm = isCut ? 0 : fit === 'fill' ? FILL_BLEED_MM : bleedFilled ? Math.min(MAX_BLEED_MM, bleedAtSize) : 0;
  const marks = cropMarkGeometry(marginMm, bleedMm);
  const ext = isCut ? offsetMm : marks.gap + marks.len;
  const layout = rollLayout(target.w + 2 * ext, target.h + 2 * ext, intake.qty ?? 1, GAP_MM[intent], roll, target.w * target.h);
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
      cut: intent === 'sticker' || intent === 'label' ? 'Please send the artwork with a stroked spot colour named exactly "CutContour", or as a PNG with a transparent background.' : 'Please send the artwork without the cut path; this job is printed and trimmed, not cut to shape.',
      roll: `The longest side that fits our roll is ${Math.floor(layout.usableWidthMm - 2 * ext)} mm. Please confirm a smaller size or a split design.`,
      rotation: 'Please export the PDF without page rotation.',
      size: 'Please tell us the finished size you want; at its embedded resolution the file is larger than 5 m.',
      pages: 'Please send one design per file, or tell us which page to print.',
      annotations: 'Please flatten the PDF so its annotations and form fields become part of the page, and send it again.',
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

  const build: BuildPlan = {
    cut, targetW: r1(target.w), targetH: r1(target.h), fit, marginMm, bleedMm, offsetMm,
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
  if (fit === 'fill') changes.push(`Fill the requested size; artwork beyond it is cropped${bleedMm ? `, keeping ${mm(bleedMm)} mm as bleed` : ''}.`);
  if (build.cropMarks) changes.push('Add crop marks outside the trim.');
  const warnings = checks.filter((c) => c.status === 'warn' && !['cut', 'scale', 'aspect'].includes(c.id)).map((c) => c.detail);
  if (params.acceptLowRes) warnings.unshift('Operator accepted printing below the resolution floor.');
  const unresolved = checks.filter((c) => c.status === 'unknown');
  for (const c of unresolved) warnings.push(`Not confirmed: ${c.label.toLowerCase()}. ${c.detail}`);

  const lead = cut === 'contour' ? { h: 'No cut path in the file', f: `This reads as ${INTENT_LABEL[intent].toLowerCase()}, but the file has no CutContour. The cutter would have nothing to follow.`, w: 'A contour from the artwork’s own transparency is ready for review.' }
    : cut === 'rect' ? { h: 'Rectangular cut needed', f: 'The file has no cut path; the artwork is a filled rectangle.', w: 'A rectangle at the trim is the exact outline, so a CutContour there is ready for review.' }
    : scale && Math.abs(scale - 1) > 0.005 ? { h: 'Artwork is not at finished size', f: `The file measures ${size(ins.widthMm!, ins.heightMm!)}; the job asks for ${size(target.w, target.h)}.`, w: 'A production file at the finished size is ready; the art is scaled, not redrawn.' }
    : { h: 'Ready for production', f: unresolved.length ? `No blocking issues for ${INTENT_LABEL[intent].toLowerCase()}, but ${unresolved.length === 1 ? 'one check' : `${unresolved.length} checks`} could not be confirmed (listed below).` : `Every check passes for ${INTENT_LABEL[intent].toLowerCase()}.`, w: 'The production file and job ticket are prepared. Approve to release them to the queue.' };
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
