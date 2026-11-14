import { useState, type ReactNode } from 'react';
import { INTENTS, INTENT_LABEL, MEDIA_LABEL, type Intent } from '../../src/features.ts';
import type { Option, PCheck } from '../../src/policy.ts';
import { isWorking, type JobView } from './api.ts';
import { fmt } from './mat.tsx';

export type Act = {
  decide: (params: Record<string, unknown>, note?: string) => void;
  approve: () => void;
  retry: () => void;
  reject: () => void;
  next: (() => void) | null;
  busy: boolean;
};

const pct = (v: number) => (v > 0 && v < 0.005 ? '<1%' : `${Math.round(v * 100)}%`);
// Softmax is never exactly 0; a stored 0 is rounding, so a probability reads "<1%".
const prob = (v: number) => (v < 0.005 ? '<1%' : pct(v));
const short = (h?: string | null) => (h ? h.slice(0, 8) : '');
const lower = (i: string) => INTENT_LABEL[i as Intent].toLowerCase();

export function Card({ job, act, notice }: { job: JobView; act: Act; notice: ReactNode }) {
  if (job.status === 'failed') return <Failed job={job} act={act} />;
  if (isWorking(job)) return <Reading job={job} />;
  if (job.status === 'released' || job.status === 'returned') return <Receipt job={job} act={act} />;
  if (job.status === 'rejected') return <Closed job={job} act={act} />;
  return <Decision job={job} act={act} notice={notice} />;
}

function Meta({ job }: { job: JobView }) {
  const i = job.intake;
  const bits = [i.qty ? `${i.qty.toLocaleString('en-US')} pcs` : 'qty not given', i.media ? MEDIA_LABEL[i.media] : 'media not given', i.reqW && i.reqH ? `ordered ${fmt(i.reqW)} × ${fmt(i.reqH)} mm` : null].filter(Boolean);
  return (
    <header className="card-meta">
      <span className="file" title={job.filename}>{job.filename}{job.sample && <span className="chip sample-tag">sample job</span>}</span>
      <span className="muted">{bits.join(' · ')}</span>
      {i.notes && <q className="notes" dir="auto">{i.notes}</q>}
    </header>
  );
}

/** Real progress: each line appears when the server has recorded that step. */
function Reading({ job }: { job: JobView }) {
  const has = (t: string) => job.events.some((e) => e.type === t);
  const ins = job.inspection;
  const steps: Array<[string, boolean, string | null]> = [
    ['Received', has('received'), `${job.kind.toUpperCase()} · sha256 ${short(job.sourceSha256)}`],
    ['Read the file', has('inspected'), ins && [ins.widthMm ? `${fmt(ins.widthMm)} × ${fmt(ins.heightMm!)} mm` : 'no physical size', ins.cut ? `cut path “${ins.cut.name}”` : 'no cut path', ins.mask.transparentFrac > 0.02 ? `${pct(ins.mask.transparentFrac)} transparent` : 'opaque'].join(' · ')],
    ['Worked out the job', has('inferred'), job.plan && (job.plan.intent ? INTENT_LABEL[job.plan.intent] : 'not sure yet')],
    ['Prepared the production file', has('proposal-prepared') || has('proposal-failed'), job.proposal?.artifact_sha256 ? `sha256 ${short(job.proposal.artifact_sha256)}` : null],
  ];
  const cur = steps.findIndex((s) => !s[1]);
  return (
    <section className="card" aria-busy="true" aria-live="polite">
      <Meta job={job} />
      <h2 className="headline">Reading the job…</h2>
      <ol className="steps">
        {steps.map(([label, done, detail], k) => (
          <li key={label} className={done ? 'done' : k === cur ? 'now' : 'todo'}>
            <span className="dot" aria-hidden />
            <span>{label}{done && detail ? <small className="mono">{detail}</small> : null}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}

function IntentLine({ job, open, setOpen }: { job: JobView; open: boolean; setOpen: (v: boolean) => void }) {
  const plan = job.plan!, pred = job.prediction!;
  const mem = pred.memory.find((m) => m.intent === plan.intent && m.jobId !== job.id);
  if (!plan.intent) return null;
  return (
    <div className="intent">
      <div className="intent-row">
        <span className="intent-name">{INTENT_LABEL[plan.intent]}</span>
        {plan.intentSource === 'operator' ? <span className="chip set">set by you</span>
          : mem ? <span className="chip memory">from your correction</span>
            : <span className={`chip ${plan.evidence.thin ? 'thin' : pred.band}`}>{plan.evidence.thin ? 'thin evidence' : pred.band}</span>}
        <button type="button" className="link" aria-expanded={open} onClick={() => setOpen(!open)}>Not this?</button>
      </div>
      {plan.intentSource === 'model' && plan.evidence.thin && !mem && (
        <p className="thin-note" role="note">
          <strong>Check this one.</strong> {plan.evidence.reasons.join(' ')}
        </p>
      )}
      {mem && plan.intentSource === 'model' && (
        <p className="memory-note" role="note">Read as {lower(mem.intent)} because you corrected <span className="mono">{mem.filename}</span> earlier in this session ({pct(mem.similarity)} similar).</p>
      )}
    </div>
  );
}

function NotThis({ job, act, close }: { job: JobView; act: Act; close: () => void }) {
  const pred = job.prediction!, plan = job.plan!;
  const others = pred.ranked.filter((c) => c !== plan.intent);
  return (
    <div className="notthis" role="group" aria-label="Choose a different job type">
      <p className="muted">Pick what this job really is. RollCue re-prepares it and treats similar files the same way for the rest of this session.</p>
      <ul>
        {others.map((c) => (
          <li key={c}>
            <button type="button" className="alt" disabled={act.busy} onClick={() => { close(); act.decide({ intent: c }, `Corrected to ${lower(c)}.`); }}>
              <span className="alt-name">{INTENT_LABEL[c]}</span>
              <span className="alt-p mono" title="The model alone, before your corrections">{prob((pred.modelProbs ?? pred.probs)[c])}</span>
              <span className="alt-why">{pred.forEach[c].length ? pred.forEach[c].map((e) => e.label).join(' · ') : 'little supporting evidence'}</span>
            </button>
          </li>
        ))}
      </ul>
      {plan.intentSource === 'operator' && (
        <button type="button" className="link" disabled={act.busy} onClick={() => { close(); act.decide({ intent: null }, 'Back to RollCue’s reading.'); }}>Use RollCue’s reading again</button>
      )}
    </div>
  );
}

function optionActive(job: JobView, o: Option, all: Option[]) {
  const params = job.params as Record<string, unknown>;
  const set = all.find((x) => Object.entries(x.params).every(([k, v]) => params[k] === v));
  return set ? set.id === o.id : false; // "suggested" is not "applied": a suggestion stays clickable (Codex R1-4)
}

function Options({ job, act, options, legend }: { job: JobView; act: Act; options: Option[]; legend: string }) {
  if (!options.length) return null;
  return (
    <fieldset className="options">
      <legend>{legend}</legend>
      <div className="option-grid">
        {options.map((o) => {
          const on = optionActive(job, o, options);
          return (
            <button key={o.id} type="button" role="radio" aria-checked={on} className={`option${on ? ' on' : ''}`} disabled={act.busy || on}
              onClick={() => act.decide(o.params as Record<string, unknown>, `${o.label}.`)}>
              <span className="option-label">{o.label}{o.recommended && <em>suggested</em>}</span>
              <span className="option-detail">{o.detail}</span>
            </button>
          );
        })}
      </div>
    </fieldset>
  );
}

function Decision({ job, act, notice }: { job: JobView; act: Act; notice: ReactNode }) {
  const [alt, setAlt] = useState(false);
  const plan = job.plan!, d = plan.decision, p = job.proposal;
  const failed = p?.status === 'failed';
  const choose = d.kind === 'intent' || d.kind === 'size';
  return (
    <section className="card" aria-live="polite">
      <Meta job={job} />
      {d.kind !== 'intent' && <IntentLine job={job} open={alt} setOpen={setAlt} />}
      {alt && <NotThis job={job} act={act} close={() => setAlt(false)} />}
      {notice}
      {!choose && p?.status === 'prepared' && <p className="eyebrow">Prepared automatically · waiting for your approval</p>}
      <h2 className="headline">{d.headline}</h2>
      <p className="found">{d.found}</p>
      <p className="why">{d.why}</p>

      {d.kind === 'intent' && (
        <fieldset className="options">
          <legend>Which is it?</legend>
          <div className="option-grid">
            {d.options.map((o) => (
              <button key={o.id} type="button" className="option" disabled={act.busy} onClick={() => act.decide(o.params as Record<string, unknown>, `Set to ${o.label.toLowerCase()}.`)}>
                <span className="option-label">{o.label}{o.recommended && <em>closest</em>}</span>
                <span className="option-detail">{o.detail}</span>
              </button>
            ))}
          </div>
        </fieldset>
      )}
      {d.kind === 'size' && <Options job={job} act={act} options={d.options} legend="Print it at" />}

      {d.kind === 'release' && (
        <div className="prepared">
          {d.changes.length > 0 && <h3>RollCue prepared</h3>}
          {d.changes.length > 0 && <ul className="changes">{d.changes.map((c) => <li key={c}>{c}</li>)}</ul>}
          <h3>Unchanged</h3>
          <ul className="keeps">{d.keeps.map((c) => <li key={c}>{c}</li>)}</ul>
          {d.warnings.length > 0 && <ul className="warnings">{d.warnings.map((c) => <li key={c}>{c}</li>)}</ul>}
          {d.layout.fits && (
            <p className="layout mono">{d.layout.across} across × {d.layout.rows} rows{d.layout.rotated ? ', rotated' : ''} · {fmt(d.layout.lengthMm / 1000)} m of roll · {pct(d.layout.utilisation)} used</p>
          )}
        </div>
      )}
      {d.kind === 'release' && <Options job={job} act={act} options={d.options} legend="Adjust" />}

      {d.kind === 'return' && (
        <div className="prepared">
          <h3>Prepared return notice</h3>
          <blockquote className="notice-text">
            <strong>{d.notice.title}</strong>
            {d.notice.lines.map((l) => <span key={l}>{l}</span>)}
            <em>{d.notice.ask}</em>
          </blockquote>
          <p className="muted small">RollCue does not send email. Approving marks the job returned and keeps the notice PDF ready to send.</p>
        </div>
      )}
      {d.kind === 'return' && <Options job={job} act={act} options={d.options.filter((o) => o.id !== 'send-notice')} legend="Or instead" />}

      {failed && (
        <div className="failure" role="alert">
          <strong>{p!.error ?? 'Preparation failed.'}</strong>
          <span>Nothing was released. RollCue can prepare the file again from the current settings.</span>
          <button type="button" className="secondary" disabled={act.busy} onClick={act.retry}>Prepare again</button>
        </div>
      )}

      {!choose && p && !failed && (
        <div className="approve">
          <button type="button" className="primary" disabled={act.busy || p.status !== 'prepared'} onClick={act.approve}>
            {d.kind === 'return' ? 'Approve return' : 'Approve and release'}
          </button>
          <button type="button" className="quiet" disabled={act.busy} onClick={act.reject}>Reject job</button>
          <p className="binding mono" title={`binding ${p.binding_hash}`}>
            Approves file {short(p.artifact_sha256)} · revision {job.revision} · {p.policy_version}
          </p>
          <p className="muted small">{d.kind === 'return' ? 'Approving marks the job returned. Nothing is sent.' : 'Releasing adds the file to this demo’s production queue. Nothing is printed, cut or sent.'}</p>
        </div>
      )}
      {choose && <div className="approve"><button type="button" className="quiet" disabled={act.busy} onClick={act.reject}>Reject job</button></div>}
      <Evidence job={job} />
    </section>
  );
}

const STATUS_MARK: Record<PCheck['status'], string> = { pass: '✓', warn: '!', fail: '✕', unknown: '?' };

function Evidence({ job }: { job: JobView }) {
  const pred = job.prediction, plan = job.plan, ins = job.inspection;
  return (
    <details className="evidence">
      <summary>Why RollCue thinks this</summary>
      {pred && plan && (
        <div className="ev-block">
          <h4>Job type: the model alone</h4>
          <ul className="probs">
            {INTENTS.map((c) => (
              <li key={c}><span>{INTENT_LABEL[c]}</span><meter min={0} max={1} value={(pred.modelProbs ?? pred.probs)[c]} /><span className="mono">{prob((pred.modelProbs ?? pred.probs)[c])}</span></li>
            ))}
          </ul>
          {pred.memory.length > 0 && (
            <p className="memory-note">With your corrections in this session: {lower(pred.top)}, {prob(pred.pTop)}. Closest corrected file: <span className="mono">{pred.memory[0].filename}</span>, {pct(pred.memory[0].similarity)} similar.</p>
          )}
          {plan.intentSource === 'operator' && plan.intent && (
            <p className="memory-note">Operator correction applied: {lower(plan.intent)}. The figures above are the model’s own reading, not a confirmation.</p>
          )}
          {pred.forTop.length > 0 && <p><b>For {lower(pred.top)}:</b> {pred.forTop.map((e) => e.label).join(' · ')}</p>}
          {pred.againstTop.length > 0 && <p><b>Against:</b> {pred.againstTop.map((e) => e.label).join(' · ')}</p>}
          <p className="muted small mono">model {pred.modelVersion} · memory {pred.memoryVersion} · filename share of evidence {pct(plan.evidence.filenameShare)}</p>
        </div>
      )}
      {plan && (
        <div className="ev-block">
          <h4>Checks ({plan.checks.length})</h4>
          <ul className="checks">{plan.checks.map((c) => <li key={c.id} className={c.status}><span className="mark" aria-label={c.status}>{STATUS_MARK[c.status]}</span><span><b>{c.label}</b> {c.detail}</span></li>)}</ul>
        </div>
      )}
      {job.proposal?.verification && (
        <div className="ev-block">
          <h4>Output verified</h4>
          <ul className="checks">{job.proposal.verification.checks.map((c) => <li key={c.id} className={c.pass ? 'pass' : 'fail'}><span className="mark">{c.pass ? '✓' : '✕'}</span><span><b>{c.label}</b> {c.detail}</span></li>)}</ul>
        </div>
      )}
      {ins && (
        <div className="ev-block">
          <h4>File</h4>
          <p className="mono small">{ins.kind.toUpperCase()} · {ins.pages} page{ins.pages === 1 ? '' : 's'} · size from {ins.sizeSource} · spots {ins.spots.length ? ins.spots.join(', ') : 'none'} · {ins.mask.components} shape{ins.mask.components === 1 ? '' : 's'}{ins.densityPpi ? ` · ${Math.round(ins.densityPpi)} ppi` : ''}</p>
        </div>
      )}
      <div className="ev-block">
        <h4>Audit trail <span className={`chip ${job.chainOk ? 'confident' : 'thin'}`}>{job.chainOk ? 'hash chain intact' : 'chain broken'}</span></h4>
        <ol className="events">{job.events.map((e) => <li key={e.seq}><span className="mono">{e.hash}</span> {e.type}</li>)}</ol>
      </div>
    </details>
  );
}

function Receipt({ job, act }: { job: JobView; act: Act }) {
  const p = job.proposal!, t = (p.ticket ?? {}) as Record<string, any>;
  const returned = job.status === 'returned';
  return (
    <section className="card receipt" aria-live="polite">
      <Meta job={job} />
      <p className="stamp">{returned ? 'Returned' : 'Released'}</p>
      <h2 className="headline">{returned ? 'Return notice approved' : 'In the production queue'}</h2>
      <dl className="ticket mono">
        {t.intentLabel && <><dt>job</dt><dd>{t.intentLabel}{t.quantity ? ` × ${Number(t.quantity).toLocaleString('en-US')}` : ''}</dd></>}
        <dt>file</dt><dd>{short(p.artifact_sha256)}…</dd>
        <dt>approved</dt><dd>{new Date(p.approved_at!).toLocaleTimeString()}</dd>
        <dt>checks</dt><dd>{(t.verification ?? []).filter((c: any) => c.pass).length}/{(t.verification ?? []).length} re-verified</dd>
        <dt>binding</dt><dd>{short(p.binding_hash)}…</dd>
      </dl>
      <p className="muted small">{t.note}</p>
      <div className="approve">
        {act.next ? <button type="button" className="primary" onClick={act.next}>Next job</button> : <p className="muted">Queue clear.</p>}
        <a className="secondary button" href={p.downloadUrl}>Download {returned ? 'notice' : 'production'} PDF</a>
      </div>
      <Evidence job={job} />
    </section>
  );
}

function Closed({ job, act }: { job: JobView; act: Act }) {
  return (
    <section className="card">
      <Meta job={job} />
      <h2 className="headline">Rejected</h2>
      <p className="found">Nothing was prepared for production. The original file is unchanged.</p>
      <div className="approve">{act.next && <button type="button" className="primary" onClick={act.next}>Next job</button>}</div>
      <Evidence job={job} />
    </section>
  );
}

function Failed({ job, act }: { job: JobView; act: Act }) {
  return (
    <section className="card">
      <Meta job={job} />
      <h2 className="headline">This file could not be read</h2>
      <p className="found">{job.error}</p>
      <p className="why">RollCue stopped before preparing anything. Ask the customer for a PDF, PNG or JPEG export.</p>
      <div className="approve">{act.next && <button type="button" className="primary" onClick={act.next}>Next job</button>}</div>
    </section>
  );
}
