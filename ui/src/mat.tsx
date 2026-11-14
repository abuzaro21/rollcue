// The working object, at true scale on a millimetre mat. "After" is the server's render of the real production PDF;
// "before" is the customer's file placed where the production file places it. The cut line is the traced CutContour.
import { useId, useState, type CSSProperties } from 'react';
import type { JobView } from './api.ts';

type Rect = { x: number; y: number; w: number; h: number };

function niceStep(span: number) {
  for (const s of [5, 10, 20, 50, 100, 200, 500, 1000]) if (span / s <= 14) return s;
  return 2000;
}

/** `onPreview` reports whether the production render for a proposal actually loaded; approval waits for it (Codex R4-5). */
export function Mat({ job, onPreview }: { job: JobView; onPreview?: (proposalId: string, ok: boolean) => void }) {
  const uid = useId().replace(/:/g, '');
  const [split, setSplit] = useState(0.5);
  const [showCut, setShowCut] = useState(true);
  const p = job.proposal;
  const ov = p && p.kind === 'production' && p.overlay && p.status !== 'failed' ? p.overlay : null;
  const ins = job.inspection;
  const source = `/api/jobs/${job.id}/source.png?r=${job.sourceSha256.slice(0, 8)}`;

  // Page geometry in mm (y down). Without a known size, fall back to pixel proportions and hide the rulers.
  let page: { w: number; h: number }, art: Rect, known = true;
  if (ov) {
    page = { w: ov.pageW, h: ov.pageH };
    art = { x: ov.frame.x, y: ov.pageH - (ov.frame.y + ov.frame.h), w: ov.frame.w, h: ov.frame.h };
  } else if (job.plan?.target || (ins?.widthMm && ins.heightMm)) {
    // The size it would print at (ordered or chosen), else the document's own size.
    page = job.plan?.target ? { ...job.plan.target } : { w: ins!.widthMm!, h: ins!.heightMm! };
    art = { x: 0, y: 0, ...page };
  } else {
    const px = ins?.pixels ?? { w: 1, h: 1 };
    const s = 100 / Math.max(px.w, px.h);
    page = { w: px.w * s, h: px.h * s }; art = { x: 0, y: 0, ...page }; known = false;
  }
  const trim = ov ? { x: ov.trim.x, y: ov.pageH - (ov.trim.y + ov.trim.h), w: ov.trim.w, h: ov.trim.h } : art;
  const long = Math.max(page.w, page.h);
  const pad = long * 0.09;
  const fs = long / 58;
  const step = niceStep(long);
  const vb = { x: -pad, y: -pad, w: page.w + pad * 1.4, h: page.h + pad * 1.4 };
  const cutPath = ov?.loops.map((l) => 'M' + l.map(([x, y]) => `${x.toFixed(2)} ${(ov.pageH - y).toFixed(2)}`).join('L') + 'Z').join('') ?? '';
  const hasAfter = !!(ov && p?.previewUrl);
  const splitX = vb.x + vb.w * split;

  const ticks: number[] = [];
  for (let v = 0; v <= Math.max(page.w, page.h) + 0.01; v += step) ticks.push(v);

  return (
    <figure className="mat" style={{ '--ar': `${vb.w} / ${vb.h}`, '--arn': vb.w / vb.h, '--sw': `${long / 380}px`, '--tw': `${long / 650}px`, '--td': `${long / 120}px ${long / 200}px`, '--rw': `${long / 900}px` } as CSSProperties} aria-label={`${job.filename} on the mat`}>
      {hasAfter && <div className="mat-tags" aria-hidden><span>Customer file</span><span>Production file</span></div>}
      <div className="mat-stage">
        <svg viewBox={`${vb.x} ${vb.y} ${vb.w} ${vb.h}`} role="img" aria-label={hasAfter ? 'Customer file on the left, prepared production file on the right' : 'Customer file'}>
          <defs>
            <pattern id={`g${uid}`} width={step / 5} height={step / 5} patternUnits="userSpaceOnUse" x={0} y={0}>
              <path d={`M ${step / 5} 0 L 0 0 0 ${step / 5}`} className="mat-grid-minor" />
            </pattern>
            <pattern id={`G${uid}`} width={step} height={step} patternUnits="userSpaceOnUse" x={0} y={0}>
              <rect width={step} height={step} fill={`url(#g${uid})`} />
              <path d={`M ${step} 0 L 0 0 0 ${step}`} className="mat-grid-major" />
            </pattern>
            <pattern id={`c${uid}`} width={long / 40} height={long / 40} patternUnits="userSpaceOnUse">
              <rect width={long / 40} height={long / 40} className="checker-a" />
              <rect width={long / 80} height={long / 80} className="checker-b" />
              <rect x={long / 80} y={long / 80} width={long / 80} height={long / 80} className="checker-b" />
            </pattern>
            <clipPath id={`L${uid}`}><rect x={vb.x} y={vb.y} width={splitX - vb.x} height={vb.h} /></clipPath>
            <clipPath id={`R${uid}`}><rect x={splitX} y={vb.y} width={vb.x + vb.w - splitX} height={vb.h} /></clipPath>
          </defs>
          <rect x={vb.x} y={vb.y} width={vb.w} height={vb.h} fill={`url(#G${uid})`} />

          {/* before: the customer's file, transparency shown as a checkerboard */}
          <g clipPath={hasAfter ? `url(#L${uid})` : undefined}>
            <rect x={art.x} y={art.y} width={art.w} height={art.h} fill={`url(#c${uid})`} />
            {ins && <image href={source} x={art.x} y={art.y} width={art.w} height={art.h} preserveAspectRatio="none" />}
          </g>

          {/* after: render of the production PDF on white media, with the traced cut */}
          {hasAfter && (
            <g clipPath={`url(#R${uid})`}>
              <rect x={0} y={0} width={page.w} height={page.h} className="media" />
              <image key={p!.id} href={p!.previewUrl} x={0} y={0} width={page.w} height={page.h} preserveAspectRatio="none"
                onLoad={() => onPreview?.(p!.id, true)} onError={() => onPreview?.(p!.id, false)} />
              {showCut && cutPath && <path key={p!.id} d={cutPath} className="cut" pathLength={1} />}
            </g>
          )}

          <rect x={trim.x} y={trim.y} width={trim.w} height={trim.h} className="trim" />

          {known && (
            <g className="ruler" fontSize={fs}>
              {ticks.filter((v) => v <= page.w + 0.01).map((v) => (
                <g key={`x${v}`}>
                  <line x1={v} x2={v} y1={-pad * 0.32} y2={-pad * 0.1} />
                  <text x={v} y={-pad * 0.42} textAnchor="middle">{v}</text>
                </g>
              ))}
              {ticks.filter((v) => v <= page.h + 0.01).map((v) => (
                <g key={`y${v}`}>
                  <line y1={v} y2={v} x1={-pad * 0.32} x2={-pad * 0.1} />
                  <text y={v + fs * 0.35} x={-pad * 0.42} textAnchor="end">{v}</text>
                </g>
              ))}
            </g>
          )}
          {hasAfter && <line x1={splitX} x2={splitX} y1={vb.y} y2={vb.y + vb.h} className="split-line" />}
        </svg>
        {hasAfter && (
          <>
            <input className="split" type="range" min={0} max={1} step={0.005} value={split} onChange={(e) => setSplit(Number(e.target.value))}
              aria-label="Compare the customer file with the production file" aria-valuetext={`${Math.round((1 - split) * 100)}% production file`} />
            <span className="handle" style={{ left: `${split * 100}%` }} aria-hidden />
          </>
        )}
      </div>
      <figcaption className="mat-caption">
        <span className="mono">{known ? `${fmt(trim.w)} × ${fmt(trim.h)} mm${ov ? ' finished' : ''}` : `${ins?.pixels?.w ?? '?'} × ${ins?.pixels?.h ?? '?'} px · size unknown`}</span>
        {ov && <span className="legend"><i className="sw trim-sw" />trim</span>}
        {ov && cutPath && (
          <label className="legend toggle">
            <input type="checkbox" checked={showCut} onChange={(e) => setShowCut(e.target.checked)} />
            <i className="sw cut-sw" />CutContour{ov.tolMm ? ` · traced at ${ov.tolMm} mm/px` : ''}
          </label>
        )}
        {hasAfter && <a className="legend" href={p!.downloadUrl}>Download {p!.status === 'released' ? 'production' : 'proof'} PDF</a>}
      </figcaption>
    </figure>
  );
}

export const fmt = (v: number) => (Math.round(v * 10) / 10).toLocaleString('en-US');
