// Roll arrangement estimate: a simple grid, optionally rotated 90°. It is an estimate, not nesting, and the UI says so.

export type RollSettings = { rollWidthMm: number; sideMarginMm: number };
export const DEFAULT_ROLL: RollSettings = { rollWidthMm: 1600, sideMarginMm: 15 };

export type Layout = {
  fits: boolean;
  across: number;
  rows: number;
  rotated: boolean;
  itemW: number; // as placed across the roll
  itemH: number;
  gapMm: number;
  lengthMm: number; // media consumed, excluding leader and trailer
  usableWidthMm: number;
  utilisation: number; // printed item area ÷ consumed media area
};

/** Crop marks start `gap` outside the trim (never inside the bleed) and run `len`; both fit inside the page margin. */
export const cropMarkGeometry = (marginMm: number, bleedMm: number) => { const gap = Math.max(2, bleedMm); return { gap, len: Math.min(marginMm - gap - 1, 8) }; };

/** `w` × `h` is the footprint each item needs on the roll (trim plus cut offset or marks); `itemArea` is the finished area. */
export function rollLayout(w: number, h: number, qty: number, gapMm: number, roll: RollSettings = DEFAULT_ROLL, itemArea = w * h): Layout {
  const usable = roll.rollWidthMm - 2 * roll.sideMarginMm;
  const options = [false, true].map((rotated) => {
    const iw = rotated ? h : w, ih = rotated ? w : h;
    const across = Math.max(0, Math.floor((usable + gapMm) / (iw + gapMm)));
    const rows = across ? Math.ceil(qty / across) : 0;
    const lengthMm = rows ? rows * ih + (rows - 1) * gapMm : Infinity;
    return { rotated, iw, ih, across, rows, lengthMm };
  }).filter((o) => o.across > 0);
  if (!options.length) {
    return { fits: false, across: 0, rows: 0, rotated: false, itemW: w, itemH: h, gapMm, lengthMm: 0, usableWidthMm: usable, utilisation: 0 };
  }
  const best = options.reduce((a, b) => (b.lengthMm < a.lengthMm - 0.001 ? b : a));
  const consumed = best.lengthMm * roll.rollWidthMm;
  return {
    fits: true, across: Math.min(best.across, qty), rows: best.rows, rotated: best.rotated, itemW: best.iw, itemH: best.ih, gapMm,
    lengthMm: Math.round(best.lengthMm), usableWidthMm: usable,
    utilisation: Math.round(((itemArea * qty) / consumed) * 1000) / 1000,
  };
}
