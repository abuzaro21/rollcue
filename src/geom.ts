// Pixel-mask geometry: alpha statistics and cut-contour derivation. Pure functions, no I/O.

export type MaskStats = {
  transparentFrac: number; // share of pixels with alpha < 50%
  coverage: number; // share of opaque pixels
  components: number; // opaque islands larger than 0.2% of the page
  rectangularity: number; // opaque area ÷ bounding-box area, summed over islands (1 = every island is a filled rectangle)
  edgeTouch: number; // share of border pixels that are opaque
  largestFrac: number; // largest island ÷ all opaque pixels
  whiteBorder: number; // share of border pixels that are opaque and near-white (art sitting on a white box)
};

export function binaryAlpha(rgba: Uint8ClampedArray, w: number, h: number): Uint8Array {
  const m = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) m[i] = rgba[i * 4 + 3] >= 128 ? 1 : 0;
  return m;
}

export function analyseMask(rgba: Uint8ClampedArray, w: number, h: number): MaskStats {
  const m = binaryAlpha(rgba, w, h);
  const n = w * h;
  let opaque = 0;
  for (let i = 0; i < n; i++) opaque += m[i];
  let border = 0, borderOpaque = 0;
  let borderWhite = 0;
  const white = (i: number) => (m[i] && rgba[i * 4] >= 245 && rgba[i * 4 + 1] >= 245 && rgba[i * 4 + 2] >= 245 ? 1 : 0);
  for (let x = 0; x < w; x++) { border += 2; borderOpaque += m[x] + m[(h - 1) * w + x]; borderWhite += white(x) + white((h - 1) * w + x); }
  for (let y = 1; y < h - 1; y++) { border += 2; borderOpaque += m[y * w] + m[y * w + w - 1]; borderWhite += white(y * w) + white(y * w + w - 1); }
  const comps = components(m, w, h);
  const minArea = Math.max(4, n * 0.002);
  const big = comps.filter((c) => c.area >= minArea);
  const area = big.reduce((s, c) => s + c.area, 0);
  const bbox = big.reduce((s, c) => s + c.bboxArea, 0);
  const r3 = (v: number) => Math.round(v * 1000) / 1000;
  return {
    transparentFrac: r3(1 - opaque / n),
    coverage: r3(opaque / n),
    components: big.length,
    rectangularity: r3(bbox ? area / bbox : 0),
    edgeTouch: r3(border ? borderOpaque / border : 0),
    largestFrac: r3(opaque ? Math.max(0, ...big.map((c) => c.area)) / opaque : 0),
    whiteBorder: r3(border ? borderWhite / border : 0),
  };
}

type Comp = { area: number; bboxArea: number; x0: number; y0: number; x1: number; y1: number };

/** 4-connected islands of value 1. Iterative flood fill. */
export function components(m: Uint8Array, w: number, h: number): Comp[] {
  const seen = new Uint8Array(w * h);
  const out: Comp[] = [];
  const stack = new Int32Array(w * h);
  for (let s = 0; s < w * h; s++) {
    if (!m[s] || seen[s]) continue;
    let top = 0, area = 0, x0 = w, y0 = h, x1 = 0, y1 = 0;
    stack[top++] = s; seen[s] = 1;
    while (top) {
      const i = stack[--top], x = i % w, y = (i - x) / w;
      area++;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (x > 0 && m[i - 1] && !seen[i - 1]) { seen[i - 1] = 1; stack[top++] = i - 1; }
      if (x < w - 1 && m[i + 1] && !seen[i + 1]) { seen[i + 1] = 1; stack[top++] = i + 1; }
      if (y > 0 && m[i - w] && !seen[i - w]) { seen[i - w] = 1; stack[top++] = i - w; }
      if (y < h - 1 && m[i + w] && !seen[i + w]) { seen[i + w] = 1; stack[top++] = i + w; }
    }
    out.push({ area, bboxArea: (x1 - x0 + 1) * (y1 - y0 + 1), x0, y0, x1, y1 });
  }
  return out;
}

const INF = 1e20;

/** Felzenszwalb–Huttenlocher squared Euclidean distance transform to the nearest pixel where m = 1. */
export function edt2(m: Uint8Array, w: number, h: number): Float64Array {
  const d = new Float64Array(w * h);
  for (let i = 0; i < w * h; i++) d[i] = m[i] ? 0 : INF;
  const n = Math.max(w, h);
  const f = new Float64Array(n), out = new Float64Array(n), v = new Int32Array(n), z = new Float64Array(n + 1);
  const pass = (len: number) => {
    let k = 0; v[0] = 0; z[0] = -INF; z[1] = INF;
    for (let q = 1; q < len; q++) {
      let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      while (s <= z[k]) { k--; s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]); }
      k++; v[k] = q; z[k] = s; z[k + 1] = INF;
    }
    k = 0;
    for (let q = 0; q < len; q++) { while (z[k + 1] < q) k++; out[q] = (q - v[k]) ** 2 + f[v[k]]; }
  };
  for (let x = 0; x < w; x++) { for (let y = 0; y < h; y++) f[y] = d[y * w + x]; pass(h); for (let y = 0; y < h; y++) d[y * w + x] = out[y]; }
  for (let y = 0; y < h; y++) { for (let x = 0; x < w; x++) f[x] = d[y * w + x]; pass(w); for (let x = 0; x < w; x++) d[y * w + x] = out[x]; }
  return d;
}

export type Pt = [number, number];

/** Marching squares over a 0/1 grid whose border row/column is 0. Returns closed loops in corner-grid coordinates. */
export function marchingSquares(g: Uint8Array, w: number, h: number): Pt[][] {
  // Edge ids: horizontal edge on corner-row y between columns x and x+1 → 2*(y*w+x); vertical edge on column x between rows y, y+1 → 2*(y*w+x)+1.
  const H = (x: number, y: number) => 2 * (y * w + x), V = (x: number, y: number) => 2 * (y * w + x) + 1;
  const point = (id: number): Pt => {
    const cell = id >> 1, x = cell % w, y = (cell - x) / w;
    return id & 1 ? [x, y + 0.5] : [x + 0.5, y];
  };
  const link = new Map<number, number[]>();
  const add = (a: number, b: number) => {
    (link.get(a) ?? link.set(a, []).get(a)!).push(b);
    (link.get(b) ?? link.set(b, []).get(b)!).push(a);
  };
  for (let y = 0; y < h - 1; y++) {
    for (let x = 0; x < w - 1; x++) {
      const tl = g[y * w + x], tr = g[y * w + x + 1], br = g[(y + 1) * w + x + 1], bl = g[(y + 1) * w + x];
      const c = tl * 8 + tr * 4 + br * 2 + bl;
      if (c === 0 || c === 15) continue;
      const T = H(x, y), B = H(x, y + 1), L = V(x, y), R = V(x + 1, y);
      switch (c) {
        case 1: case 14: add(L, B); break;
        case 2: case 13: add(B, R); break;
        case 3: case 12: add(L, R); break;
        case 4: case 11: add(T, R); break;
        case 6: case 9: add(T, B); break;
        case 7: case 8: add(L, T); break;
        case 5: add(L, B); add(T, R); break; // saddle: keep diagonal corners apart
        case 10: add(L, T); add(B, R); break;
      }
    }
  }
  const loops: Pt[][] = [];
  const used = new Set<number>();
  for (const start of link.keys()) {
    if (used.has(start)) continue;
    const loop: Pt[] = [];
    let prev = -1, cur = start;
    for (let guard = 0; guard < 4 * w * h; guard++) {
      used.add(cur);
      loop.push(point(cur));
      const nbrs = link.get(cur)!;
      const next = nbrs[0] !== prev ? nbrs[0] : nbrs[1];
      if (next === undefined || next === start) break;
      prev = cur; cur = next;
      if (used.has(cur)) break;
    }
    if (loop.length >= 3) loops.push(loop);
  }
  return loops;
}

/** Ramer–Douglas–Peucker on a closed loop (iterative). */
export function simplifyLoop(loop: Pt[], tol: number): Pt[] {
  if (loop.length < 4) return loop;
  // Split at the point farthest from loop[0] so both halves are open polylines.
  let far = 0, best = -1;
  for (let i = 1; i < loop.length; i++) { const d = (loop[i][0] - loop[0][0]) ** 2 + (loop[i][1] - loop[0][1]) ** 2; if (d > best) { best = d; far = i; } }
  const half = (pts: Pt[]) => {
    const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
    const stack: Array<[number, number]> = [[0, pts.length - 1]];
    while (stack.length) {
      const [a, b] = stack.pop()!;
      const [ax, ay] = pts[a], [bx, by] = pts[b];
      const len = Math.hypot(bx - ax, by - ay) || 1e-9;
      let idx = -1, dmax = tol;
      for (let i = a + 1; i < b; i++) {
        const d = Math.abs((bx - ax) * (ay - pts[i][1]) - (ax - pts[i][0]) * (by - ay)) / len;
        if (d > dmax) { dmax = d; idx = i; }
      }
      if (idx >= 0) { keep[idx] = 1; stack.push([a, idx], [idx, b]); }
    }
    return pts.filter((_, i) => keep[i]);
  };
  const a = half(loop.slice(0, far + 1)), b = half([...loop.slice(far), loop[0]]);
  return [...a, ...b.slice(1, -1)];
}

export function loopArea(loop: Pt[]): number {
  let s = 0;
  for (let i = 0; i < loop.length; i++) { const [x1, y1] = loop[i], [x2, y2] = loop[(i + 1) % loop.length]; s += x1 * y2 - x2 * y1; }
  return Math.abs(s) / 2;
}

export type Contour = {
  loops: Pt[][]; // mm, PDF orientation (origin bottom-left of the art), may extend past the art by the offset
  pxMm: number; // derivation pixel size in mm: the stated tolerance of the traced edge
  droppedSpecks: number;
};

/**
 * Cut contour from an alpha mask: dilate by `offsetMm` with an exact distance transform, fill interior holes, trace outer
 * boundaries, simplify to `tolMm`. `pxMm` is the physical size of one mask pixel at the final print size.
 */
export function traceContour(mask: Uint8Array, w: number, h: number, pxMm: number, offsetMm: number, tolMm = 0.1, minAreaMm2 = 4): Contour {
  const off = offsetMm / pxMm;
  const pad = Math.ceil(off) + 2;
  const W = w + 2 * pad, Hh = h + 2 * pad;
  const g = new Uint8Array(W * Hh);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) g[(y + pad) * W + x + pad] = mask[y * w + x];
  let solid = g;
  if (off > 0) {
    const d = edt2(g, W, Hh), lim = off * off;
    solid = new Uint8Array(W * Hh);
    for (let i = 0; i < W * Hh; i++) solid[i] = d[i] <= lim ? 1 : 0;
  }
  // Fill holes: anything not reachable from the border through empty pixels is inside.
  const outside = new Uint8Array(W * Hh), stack = new Int32Array(W * Hh);
  let top = 0;
  const push = (i: number) => { if (!solid[i] && !outside[i]) { outside[i] = 1; stack[top++] = i; } };
  for (let x = 0; x < W; x++) { push(x); push((Hh - 1) * W + x); }
  for (let y = 0; y < Hh; y++) { push(y * W); push(y * W + W - 1); }
  while (top) {
    const i = stack[--top], x = i % W;
    if (x > 0) push(i - 1); if (x < W - 1) push(i + 1); if (i >= W) push(i - W); if (i < W * (Hh - 1)) push(i + W);
  }
  const filled = new Uint8Array(W * Hh);
  for (let i = 0; i < W * Hh; i++) filled[i] = outside[i] ? 0 : 1;
  for (let x = 0; x < W; x++) filled[x] = filled[(Hh - 1) * W + x] = 0;
  for (let y = 0; y < Hh; y++) filled[y * W] = filled[y * W + W - 1] = 0;

  const raw = marchingSquares(filled, W, Hh);
  const toMm = (p: Pt): Pt => [round3((p[0] - pad + 0.5) * pxMm), round3((h - (p[1] - pad + 0.5)) * pxMm)];
  let dropped = 0;
  const loops: Pt[][] = [];
  for (const l of raw) {
    const mm = simplifyLoop(l, tolMm / pxMm).map(toMm);
    if (loopArea(mm) < minAreaMm2) { dropped++; continue; }
    loops.push(mm);
  }
  return { loops, pxMm, droppedSpecks: dropped };
}

export function rectLoop(x: number, y: number, w: number, h: number, r = 0): Pt[] {
  if (r <= 0) return [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
  const pts: Pt[] = [];
  const corner = (cx: number, cy: number, a0: number) => {
    for (let i = 0; i <= 6; i++) { const a = a0 + (i / 6) * (Math.PI / 2); pts.push([round3(cx + r * Math.cos(a)), round3(cy + r * Math.sin(a))]); }
  };
  corner(x + w - r, y + r, -Math.PI / 2); corner(x + w - r, y + h - r, 0); corner(x + r, y + h - r, Math.PI / 2); corner(x + r, y + r, Math.PI);
  return pts;
}

const round3 = (v: number) => Math.round(v * 1000) / 1000;
