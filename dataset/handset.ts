// Hand-written edge cases, kept apart from the generator's train/val/test data and never used for training or
// threshold selection. Written by the build agent (Claude) from print-shop scenarios, not taken from real customers.
// Some are deliberately hard or genuinely ambiguous; a miss here is reported, not hidden.
import type { FileSpec } from './gen.ts';
import type { Intake, Intent } from '../src/features.ts';

export type HandCase = { id: string; intent: Intent; why: string; file: Omit<FileSpec, 'seed'>; intake: Partial<Intake> & { filename: string } };

const png = (shape: FileSpec['shape'], w: number, h: number, ppi: number | null, opaqueBg = false): Omit<FileSpec, 'seed'> =>
  ({ format: 'png', shape, wMm: w, hMm: h, opaqueBg, px: Math.round((Math.max(w, h) / 25.4) * (ppi ?? 300)), densityMeta: ppi !== null });
const pdf = (shape: FileSpec['shape'], w: number, h: number, extra: Partial<FileSpec> = {}): Omit<FileSpec, 'seed'> =>
  ({ format: 'pdf', shape, wMm: w, hMm: h, opaqueBg: !['circle', 'blob', 'star', 'badge', 'multi'].includes(shape), ...extra });

export const HANDSET: HandCase[] = [
  { id: 'coffee-round-sticker', intent: 'sticker', why: 'Round transparent logo, vinyl, hundreds of pieces.', file: png('circle', 60, 60, 300), intake: { filename: 'coffee-logo.png', qty: 500, media: 'vinyl', notes: 'for the coffee bags' } },
  { id: 'jar-lid-round-label', intent: 'label', why: 'Same geometry as a round sticker; label stock and "jars" say label.', file: png('circle', 50, 50, 300), intake: { filename: 'honey_lid.png', qty: 2000, media: 'label_stock', notes: 'lids of the honey jars' } },
  { id: 'stickers-final-window', intent: 'poster', why: 'Ambiguous on purpose: transparent shape, sticker filename, no size or notes. The customer said on the phone it is one window poster.', file: pdf('blob', 210, 297), intake: { filename: 'stickers-final.pdf', qty: 1 } },
  { id: 'a4-posters-many', intent: 'poster', why: 'Small poster in a large quantity.', file: pdf('poster-full', 210, 297, { bleedMm: 3 }), intake: { filename: 'event_A4.pdf', qty: 150, media: 'paper', notes: 'flyers for the event, print as posters' } },
  { id: 'wall-decal', intent: 'sticker', why: 'Large sticker, tiny quantity.', file: pdf('blob', 800, 600), intake: { filename: 'kids-room.pdf', qty: 2, media: 'vinyl', notes: 'wall decal for the kids room, cut to shape' } },
  { id: 'table-banner', intent: 'banner', why: 'Short banner.', file: pdf('banner-bands', 1000, 300), intake: { filename: 'fair-table.pdf', qty: 1, media: 'pvc_banner', notes: 'table front for the fair' } },
  { id: 'roll-up', intent: 'banner', why: 'Portrait banner, roll-up stand.', file: pdf('banner-bands', 850, 2000), intake: { filename: 'stand.pdf', qty: 1, notes: 'roll-up stand print' } },
  { id: 'negated-sticker', intent: 'poster', why: 'Notes negate "stickers"; filename says sticker.', file: pdf('poster-margin', 594, 841), intake: { filename: 'sticker-design.pdf', qty: 3, media: 'photo_paper', notes: 'not stickers this time, just big prints for the wall' } },
  { id: 'banner-named-label', intent: 'label', why: 'Misleading filename.', file: png('rect', 80, 50, 300, true), intake: { filename: 'banner_logo.png', qty: 5000, media: 'label_stock' } },
  { id: 'arabic-label', intent: 'label', why: 'Arabic notes.', file: pdf('rect-rounded', 90, 60), intake: { filename: 'honey.pdf', qty: 3000, notes: 'ليبلات للعسل' } },
  { id: 'arabic-banner-1to10', intent: 'banner', why: 'Supplied at 1:10 with the real size given; Arabic notes.', file: pdf('banner-bands', 300, 100), intake: { filename: 'shop.pdf', qty: 1, reqW: 3000, reqH: 1000, notes: 'يافطة للمحل' } },
  { id: 'no-info-circle', intent: 'sticker', why: 'Almost no evidence: a circle PNG without density or intake. Abstaining is the right answer.', file: png('circle', 70, 70, null), intake: { filename: 'IMG_2231.png' } },
  { id: 'square-sticker', intent: 'sticker', why: 'Rounded square with transparent corners, but stickers.', file: png('rect-rounded', 70, 70, 300), intake: { filename: 'square.png', qty: 300, media: 'vinyl', notes: 'square stickers for the laptops' } },
  { id: 'drum-label', intent: 'label', why: 'Large label, small run.', file: pdf('rect', 250, 180), intake: { filename: 'drum.pdf', qty: 80, media: 'label_stock', notes: 'labels for the 20 L drums' } },
  { id: 'scaffold-mesh', intent: 'banner', why: 'Very long, mesh.', file: pdf('banner-split', 4000, 1200), intake: { filename: 'site.pdf', qty: 1, notes: 'mesh for scaffolding' } },
  { id: 'cutout-window-poster', intent: 'poster', why: 'Transparent artwork, but a poster for a window.', file: png('poster-margin', 420, 594, 150), intake: { filename: 'window.png', qty: 2, media: 'photo_paper', notes: 'poster for the shop window' } },
  { id: 'low-res-photo-poster', intent: 'poster', why: 'Phone photo for an A1 poster; resolution will be poor.', file: { format: 'jpeg', shape: 'poster-full', wMm: 594, hMm: 841, opaqueBg: true, px: 600, densityMeta: false }, intake: { filename: 'photo.jpg', qty: 1, reqW: 594, reqH: 841 } },
  { id: 'sticker-sheet', intent: 'sticker', why: 'Several shapes on one A4 sheet.', file: pdf('multi', 210, 297), intake: { filename: 'sheet.pdf', qty: 50, media: 'paper', notes: 'sticker sheets, kiss cut each sticker' } },
  { id: 'typo-poster-for-jars', intent: 'label', why: 'Customer wrote "poster" but everything else is a label.', file: pdf('rect', 100, 70), intake: { filename: 'jam.pdf', qty: 1000, media: 'vinyl', notes: 'poster for the jars' } },
  { id: 'sticker-with-cut', intent: 'sticker', why: 'Already has a CutContour.', file: pdf('blob', 80, 80, { cutSpot: { name: 'CutContour' } }), intake: { filename: 'ready.pdf', qty: 500 } },
  { id: 'label-with-cut', intent: 'label', why: 'Rectangle with a CutContour, label stock.', file: pdf('rect', 100, 60, { cutSpot: { name: 'CutContour' } }), intake: { filename: 'lbl.pdf', qty: 2000, media: 'label_stock' } },
  { id: 'a2-png-no-density', intent: 'poster', why: 'Size only from the intake.', file: png('poster-full', 420, 594, null, true), intake: { filename: 'art.png', qty: 5, media: 'paper', reqW: 420, reqH: 594 } },
  { id: 'banner-named-poster', intent: 'banner', why: 'Filename says poster, shape says banner.', file: pdf('banner-bands', 2000, 500), intake: { filename: 'poster_v2.pdf', qty: 1 } },
  { id: 'tiny-label', intent: 'label', why: 'Very small, very many.', file: pdf('rect', 25, 15), intake: { filename: 'price.pdf', qty: 10000 } },
  { id: 'opaque-badge-sticker', intent: 'sticker', why: 'Sticker art on an opaque white background (no shape to trace).', file: png('badge', 90, 90, 300, true), intake: { filename: 'badge.png', qty: 250, media: 'vinyl', notes: 'die-cut stickers' } },
  { id: 'vinyl-wall-print', intent: 'poster', why: 'Rectangular wall print on vinyl.', file: pdf('poster-full', 600, 900), intake: { filename: 'wall.pdf', qty: 1, media: 'vinyl', notes: 'print on vinyl, it goes on the wall' } },
  { id: 'bare-pdf-poster', intent: 'poster', why: 'No intake at all.', file: pdf('poster-full', 297, 420), intake: { filename: 'file.pdf' } },
  { id: 'record-label-party', intent: 'poster', why: '"label" in a non-product sense.', file: pdf('poster-grid', 594, 841), intake: { filename: 'label-launch-poster.pdf', qty: 4, notes: 'for the record label launch party' } },
  { id: 'arabic-sticker', intent: 'sticker', why: 'Arabic notes.', file: png('blob', 50, 50, 300), intake: { filename: 'logo.png', qty: 400, notes: 'ستيكرات مقصوصة للابتوب' } },
  { id: 'eyelets-no-size', intent: 'banner', why: 'Size unknown; notes say eyelets.', file: png('banner-split', 300, 100, null, true), intake: { filename: 'shop.png', notes: 'eyelets in each corner please' } },
  { id: 'bottle-neck-label', intent: 'label', why: 'Round label for bottles.', file: pdf('circle', 60, 60), intake: { filename: 'neck.pdf', qty: 3000, media: 'label_stock', notes: 'bottle neck labels' } },
  { id: 'decal-named-poster', intent: 'poster', why: 'Filename says decal; photo-paper print.', file: { format: 'jpeg', shape: 'poster-full', wMm: 420, hMm: 594, opaqueBg: true, px: 4961, densityMeta: true }, intake: { filename: 'decal_final.jpg', qty: 10, media: 'photo_paper' } },
];

export function handIntake(c: HandCase): Intake {
  return { filename: c.intake.filename, qty: c.intake.qty ?? null, reqW: c.intake.reqW ?? null, reqH: c.intake.reqH ?? null, media: c.intake.media ?? null, notes: c.intake.notes ?? '' };
}
