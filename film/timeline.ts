// Shared by capture and assembly: where each scene and narration segment sits in the film.
import { readFileSync } from 'node:fs';

export const TOTAL = 89.6, LEAD = 0.5, GAP = 0.5, TAIL = 0.6;
export const SCENES = [
  { id: 's1-arrive', segs: ['arrive', 'prepared'] },
  { id: 's2-sticker', segs: ['sticker'] },
  { id: 's3-approve', segs: ['approve'] },
  { id: 's4-pdf', segs: ['pdf'] },
  { id: 's5-wrong', segs: ['wrong'] },
  { id: 's6-memory', segs: ['memory'] },
  { id: 's7-legacy', segs: ['legacy'] },
  { id: 's8-end', segs: ['end'] },
] as const;

export type Scene = { id: string; start: number; len: number; segs: { id: string; at: number; d: number }[] };

export function timeline(d: Record<string, number> = JSON.parse(readFileSync('film/tts/durations.json', 'utf8'))): Scene[] {
  let t = 0;
  return SCENES.map((s) => {
    let r = LEAD;
    const segs = s.segs.map((id) => { const x = { id, at: r, d: d[id] }; r += d[id] + GAP; return x; });
    let len = r - GAP + TAIL;
    if (s.id === 's8-end') len = Math.max(len, TOTAL - t);
    const out = { id: s.id, start: t, len: Math.round(len * 1000) / 1000, segs };
    t += out.len;
    return out;
  });
}
