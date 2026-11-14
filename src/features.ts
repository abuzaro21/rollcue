// Feature extraction: inspection (measured) + intake (partial, operator/customer supplied) → named numeric vector.
// Customer notes and filenames are untrusted text. They are only matched against a fixed lexicon; nothing in them
// is ever executed or interpreted as an instruction.
import type { Inspection } from './inspect.ts';

export const INTENTS = ['sticker', 'label', 'poster', 'banner'] as const;
export type Intent = (typeof INTENTS)[number];
export const INTENT_LABEL: Record<Intent, string> = {
  sticker: 'Die-cut stickers', label: 'Rectangular roll labels', poster: 'Poster', banner: 'Banner',
};

export const MEDIA = ['vinyl', 'label_stock', 'paper', 'photo_paper', 'pvc_banner'] as const;
export type Media = (typeof MEDIA)[number];
export const MEDIA_LABEL: Record<Media, string> = {
  vinyl: 'Vinyl', label_stock: 'Label stock', paper: 'Paper', photo_paper: 'Photo paper', pvc_banner: 'PVC banner',
};

export type Intake = {
  filename: string;
  qty: number | null;
  reqW: number | null; // requested finished size, mm
  reqH: number | null;
  media: Media | null;
  notes: string;
};

// ---------- text ----------

const GROUPS = {
  sticker: ['sticker', 'decal', 'ملصق', 'ستيكر', 'لاصق'],
  label: ['label', 'jar', 'bottle', 'barcode', 'ليبل', 'علبة', 'عبوة', 'زجاجة'],
  poster: ['poster', 'a0', 'a1', 'a2', 'a3', 'framed', 'frame', 'gallery', 'exhibition', 'artprint', 'بوستر', 'لوحة', 'معرض'],
  banner: ['banner', 'eyelet', 'grommet', 'hem', 'pvc', 'mesh', 'fence', 'rollup', 'بانر', 'يافطة', 'لافتة', 'رول'],
  cut: ['cut', 'cutting', 'contour', 'shaped', 'diecut', 'kisscut', 'قص', 'مقصوص', 'كونتور'],
  outdoor: ['outdoor', 'outside', 'weatherproof', 'waterproof', 'street', 'خارجي', 'مقاوم'],
  window: ['window', 'glass', 'shopfront', 'storefront', 'واجهة', 'زجاج'],
} as const;
export type TextGroup = keyof typeof GROUPS;
const NEGATORS = new Set(['no', 'not', 'dont', 'without', 'never', 'isnt', 'arent', 'neither', 'nor', 'بدون', 'لا', 'مش', 'ليس', 'غير']);

/** Lowercase tokens; joins common compounds ("die-cut" → "diecut") and strips Arabic definite article / plural noise. */
export function tokens(s: string): string[] {
  const norm = s.toLowerCase()
    .replace(/\b(die|kiss)[\s-]+cut/g, '$1cut').replace(/\broll[\s-]+up\b/g, 'rollup').replace(/\bart[\s-]+print/g, 'artprint')
    .replace(/[’']/g, '');
  return (norm.match(/[\p{L}\p{N}]+/gu) ?? []).map((t) => t.replace(/^(ال|و)(?=\p{L}{3,})/u, '').replace(/(ات|ين)$/u, ''));
}

/** For each group: +1 if mentioned, −1 if only mentioned under a negation ("no cutting", "not a sticker"), else 0. */
export function textGroups(s: string): Record<TextGroup, number> {
  const toks = tokens(s);
  const out = Object.fromEntries(Object.keys(GROUPS).map((g) => [g, 0])) as Record<TextGroup, number>;
  const pos = new Set<string>(), neg = new Set<string>();
  toks.forEach((t, i) => {
    for (const [g, stems] of Object.entries(GROUPS)) {
      if (!stems.some((st) => t === st || (st.length >= 4 && t.startsWith(st)))) continue;
      const negated = toks.slice(Math.max(0, i - 3), i).some((p) => NEGATORS.has(p));
      (negated ? neg : pos).add(g);
    }
  });
  for (const g of Object.keys(GROUPS) as TextGroup[]) out[g] = pos.has(g) ? 1 : neg.has(g) ? -1 : 0;
  return out;
}

// ---------- geometry helpers ----------

/** Finished size the job will be printed at: requested size if given, else the document's own size, else unknown. */
export function targetSize(ins: Inspection, intake: Intake): { w: number; h: number; source: 'requested' | 'document' } | null {
  if (intake.reqW && intake.reqH) return { w: intake.reqW, h: intake.reqH, source: 'requested' };
  if (intake.reqW && ins.widthMm && ins.heightMm) return { w: intake.reqW, h: (intake.reqW * ins.heightMm) / ins.widthMm, source: 'requested' };
  if (intake.reqH && ins.widthMm && ins.heightMm) return { w: (intake.reqH * ins.widthMm) / ins.heightMm, h: intake.reqH, source: 'requested' };
  if (ins.widthMm && ins.heightMm) return { w: ins.widthMm, h: ins.heightMm, source: 'document' };
  return null;
}

/** Effective resolution of the raster content at the target size, or null when it cannot be known. */
export function effectivePpi(ins: Inspection, target: { w: number } | null): number | null {
  if (!target) return null;
  if (ins.pixels) return Math.round(ins.pixels.w / (target.w / 25.4));
  if (ins.densityPpi && ins.widthMm) return Math.round(ins.densityPpi * (ins.widthMm / target.w));
  return null;
}

// ---------- the vector ----------

export type FeatureInfo = { name: string; label: string };

export const FEATURES: FeatureInfo[] = [
  { name: 'size_known', label: 'Finished size is known' },
  { name: 'log_area', label: 'Finished area' },
  { name: 'log_long', label: 'Longest side' },
  { name: 'aspect', label: 'Elongated shape' },
  { name: 'qty_known', label: 'Quantity given' },
  { name: 'log_qty', label: 'Quantity' },
  { name: 'media_known', label: 'Media given' },
  ...MEDIA.map((m) => ({ name: `media_${m}`, label: `Media: ${MEDIA_LABEL[m]}` })),
  { name: 'transparent', label: 'Transparent background' },
  { name: 'transparent_frac', label: 'Share of page that is transparent' },
  { name: 'rectangularity', label: 'Artwork fills rectangles' },
  { name: 'islands', label: 'Number of separate shapes' },
  { name: 'edge_touch', label: 'Artwork runs to the page edge' },
  { name: 'cut_spot', label: 'File already has a stroked cut separation' },
  { name: 'bleed', label: 'File has bleed' },
  { name: 'is_raster', label: 'Raster image file' },
  { name: 'vector_only', label: 'Vector-only PDF' },
  { name: 'ppi_known', label: 'Resolution at size is known' },
  { name: 'log_ppi', label: 'Resolution at finished size' },
  { name: 'size_mismatch', label: 'Requested size differs from file size' },
  { name: 'notes_empty', label: 'No customer notes' },
  ...(['sticker', 'label', 'poster', 'banner', 'cut', 'outdoor', 'window'] as const).map((g) => ({ name: `note_${g}`, label: `Notes mention “${g}”` })),
  ...(['sticker', 'label', 'poster', 'banner'] as const).map((g) => ({ name: `file_${g}`, label: `Filename suggests “${g}”` })),
];
export const FEATURE_NAMES = FEATURES.map((f) => f.name);

export function featurize(ins: Inspection, intake: Intake): number[] {
  const t = targetSize(ins, intake);
  const notes = textGroups(intake.notes);
  const file = textGroups(intake.filename.replace(/\.[a-z0-9]{2,4}$/i, '').replace(/[_.]+/g, ' '));
  const ppi = effectivePpi(ins, t);
  const m = ins.mask;
  const aspectFromFile = ins.widthMm && ins.heightMm ? Math.max(ins.widthMm, ins.heightMm) / Math.min(ins.widthMm, ins.heightMm)
    : ins.pixels ? Math.max(ins.pixels.w, ins.pixels.h) / Math.min(ins.pixels.w, ins.pixels.h) : null; // Codex R2-2: no density ≠ square
  const aspect = t ? Math.max(t.w, t.h) / Math.min(t.w, t.h) : aspectFromFile ?? 1;
  const mismatch = intake.reqW && ins.widthMm ? Math.abs(Math.log(intake.reqW / ins.widthMm)) : 0;
  const v: Record<string, number> = {
    size_known: t ? 1 : 0,
    log_area: t ? Math.log((t.w * t.h) / 100) : 0, // cm²
    log_long: t ? Math.log(Math.max(t.w, t.h)) : 0,
    aspect: Math.log(aspect),
    qty_known: intake.qty ? 1 : 0,
    log_qty: intake.qty ? Math.log(intake.qty) : 0,
    media_known: intake.media ? 1 : 0,
    ...Object.fromEntries(MEDIA.map((md) => [`media_${md}`, intake.media === md ? 1 : 0])),
    transparent: m.transparentFrac > 0.01 ? 1 : 0,
    transparent_frac: m.transparentFrac,
    rectangularity: m.rectangularity,
    islands: Math.log(1 + m.components),
    edge_touch: m.edgeTouch,
    cut_spot: ins.cut?.stroked ? 1 : 0,
    bleed: (ins.bleedMm ?? 0) >= 1 ? 1 : 0,
    is_raster: ins.kind === 'pdf' ? 0 : 1,
    vector_only: ins.kind === 'pdf' && ins.imageCount === 0 ? 1 : 0,
    ppi_known: ppi ? 1 : 0,
    log_ppi: ppi ? Math.log(Math.min(ppi, 1200)) : 0,
    size_mismatch: Math.min(mismatch, 3),
    notes_empty: intake.notes.trim() ? 0 : 1,
    ...Object.fromEntries((['sticker', 'label', 'poster', 'banner', 'cut', 'outdoor', 'window'] as const).map((g) => [`note_${g}`, notes[g]])),
    ...Object.fromEntries((['sticker', 'label', 'poster', 'banner'] as const).map((g) => [`file_${g}`, file[g]])),
  };
  return FEATURE_NAMES.map((n) => v[n]);
}
