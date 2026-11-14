// A representative conventional preflight tool, built for the side-by-side comparison. It is not a copy of any product.
// It runs the same jobs on the same backend with the same approval binding; the operator drives every step by hand and
// nothing here feeds RollCue's correction memory (decisions are sent with manual: true).
import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { INTENTS, INTENT_LABEL, MEDIA_LABEL, type Intent } from '../../src/features.ts';
import { api, ApiError, interactionCounter, isWorking, type JobSummary, type JobView } from './api.ts';
import './fonts.css';
import './legacy.css';

const counter = interactionCounter();
const TABS = ['Jobs', 'Job ticket', 'Preflight', 'Cut & offsets', 'Output'] as const;
type Tab = (typeof TABS)[number];

function Legacy() {
  const [tab, setTab] = useState<Tab>('Jobs');
  const [jobs, setJobs] = useState<JobSummary[]>([]);
  const [job, setJob] = useState<JobView | null>(null);
  const [msg, setMsg] = useState<string>('');
  const [ran, setRan] = useState(false);
  const [generated, setGenerated] = useState(false);
  const [shownPreview, setShownPreview] = useState<string | null>(null); // proposal whose output preview has loaded (Codex R4-5)
  // A conventional tool will not output until the operator has done each step (Codex R1-3: no shortcut to RollCue's file).
  const [saved, setSaved] = useState(false);
  const [cutSet, setCutSet] = useState(false);
  const [product, setProduct] = useState<string>('');
  const [cutMethod, setCutMethod] = useState('');
  const [offset, setOffset] = useState('');

  const load = async (id: string) => {
    let v = await api.job(id);
    while (isWorking(v)) { await new Promise((r) => setTimeout(r, 600)); v = await api.job(id); }
    setJob(v); return v;
  };
  useEffect(() => {
    api.session().then(async (s) => {
      setJobs(s.jobs);
      const want = new URLSearchParams(location.search).get('job');
      if (want && s.jobs.some((j) => j.id === want)) await open(want);
    }).catch(() => setMsg('Server not reachable.'));
  }, []);

  const go = (t: Tab) => { if (t !== tab) counter.screen(); setTab(t); };
  async function open(id: string) {
    setRan(false); setGenerated(false); setSaved(false); setCutSet(false); setProduct(''); setCutMethod(''); setOffset(''); setMsg('Loading job…');
    await load(id); setMsg(''); counter.reset(); go('Job ticket');
  }
  const guard = async (fn: () => Promise<void>) => {
    try { await fn(); } catch (e) { setMsg(e instanceof ApiError ? `Error ${e.status}: ${e.message}` : 'Error.'); }
  };

  const saveTicket = () => guard(async () => {
    if (!job) return;
    if (!product) { setMsg('Select a product type.'); return; }
    setMsg('Saving…');
    await api.decide(job, { intent: product as Intent }, true);
    await load(job.id); setSaved(true); setRan(false); setCutSet(false); setGenerated(false); setMsg('Ticket saved.');
  });
  const applyCut = () => guard(async () => {
    if (!job) return;
    const params: Record<string, unknown> = {};
    if (cutMethod === 'rect') params.rectCut = true;
    if (cutMethod === 'contour' && offset) params.offsetMm = Number(offset);
    if (!cutMethod) { setMsg('Select a cut method.'); return; }
    if (!Object.keys(params).length) {
      // keep / none change nothing on the server, so they are only accepted when the prepared output already matches.
      const built = job.plan?.decision.kind === 'release' ? job.plan.decision.build.cut : cutMethod;
      if (built !== cutMethod) { setMsg(`Not available for this job: the output uses cut "${built}".`); return; }
      setCutSet(true); setGenerated(false); setMsg('Cut settings applied.'); return;
    }
    setMsg('Applying…');
    await api.decide(job, params, true);
    await load(job.id); setCutSet(true); setGenerated(false); setMsg('Cut settings applied.');
  });
  const send = () => guard(async () => {
    if (!job?.proposal) return;
    setMsg('Sending…');
    const v = await api.approve(job);
    setJob(v);
    if (v.status === 'released' || v.status === 'returned') { void api.metric('legacy', job.id, { ...counter.snapshot(), sample: job.sample, outcome: v.status }); setMsg(`Job ${v.status}.`); }
    else setMsg('Output failed verification.');
    setJobs(await api.jobs());
  });

  const plan = job?.plan, ins = job?.inspection, p = job?.proposal;
  const missing = [!saved && 'save the job ticket', !ran && 'run preflight', !cutSet && 'apply cut settings'].filter(Boolean);
  return (
    <div className="lg">
      <header className="lg-bar">
        <span className="lg-title">Preflight workstation <small>representative legacy workflow</small></span>
        <a href="/">← Back to RollCue</a>
      </header>
      <div className="lg-banner">Comparison mode: a conventional multi-tab preflight on the same jobs and backend. The operator decides and enters everything by hand.</div>
      <nav className="lg-tabs" role="tablist">
        {TABS.map((t) => <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'on' : ''} disabled={t !== 'Jobs' && !job} onClick={() => go(t)}>{t}</button>)}
      </nav>
      <div className="lg-status" role="status">{msg || (job ? `Job ${job.id} · ${job.filename} · rev ${job.revision} · ${job.status}` : 'No job open.')}</div>

      <main className="lg-body">
        {tab === 'Jobs' && (
          <table className="lg-table">
            <thead><tr><th>ID</th><th>File</th><th>Status</th><th>Received</th><th /></tr></thead>
            <tbody>{jobs.map((j) => (
              <tr key={j.id}><td className="m">{j.id}</td><td>{j.filename}</td><td>{j.status}</td><td>{new Date(j.createdAt).toLocaleTimeString()}</td>
                <td><button onClick={() => open(j.id)}>Open</button></td></tr>
            ))}</tbody>
          </table>
        )}

        {tab === 'Job ticket' && job && (
          <div className="lg-form">
            <fieldset><legend>Order</legend>
              <div className="row"><span>File</span><b>{job.filename}</b></div>
              <div className="row"><span>Quantity</span><b>{job.intake.qty ?? '—'}</b></div>
              <div className="row"><span>Media</span><b>{job.intake.media ? MEDIA_LABEL[job.intake.media] : '—'}</b></div>
              <div className="row"><span>Requested size</span><b>{job.intake.reqW ? `${job.intake.reqW} × ${job.intake.reqH} mm` : '—'}</b></div>
              <div className="row"><span>Notes</span><b dir="auto">{job.intake.notes || '—'}</b></div>
            </fieldset>
            <fieldset><legend>Production</legend>
              <label className="row"><span>Product type *</span>
                <select value={product} onChange={(e) => setProduct(e.target.value)}>
                  <option value="">— select —</option>
                  {INTENTS.map((i) => <option key={i} value={i}>{INTENT_LABEL[i]}</option>)}
                </select>
              </label>
            </fieldset>
            <div className="lg-actions"><button onClick={saveTicket}>Save ticket</button></div>
          </div>
        )}

        {tab === 'Preflight' && job && (
          <div>
            <div className="lg-actions"><button onClick={() => setRan(true)} disabled={!plan}>Run preflight</button></div>
            {ran && plan && ins && (
              <>
                <table className="lg-table">
                  <thead><tr><th>Check</th><th>Result</th><th>Detail</th></tr></thead>
                  <tbody>{plan.checks.map((c) => <tr key={c.id} className={c.status}><td>{c.label}</td><td>{c.status.toUpperCase()}</td><td>{c.detail}</td></tr>)}</tbody>
                </table>
                <table className="lg-table kv">
                  <tbody>
                    <tr><td>Format</td><td>{ins.kind.toUpperCase()}, {ins.pages} page(s)</td></tr>
                    <tr><td>Document size</td><td>{ins.widthMm ? `${ins.widthMm} × ${ins.heightMm} mm (${ins.sizeSource})` : 'unknown'}</td></tr>
                    <tr><td>Boxes</td><td className="m">{ins.boxes ? Object.entries(ins.boxes).map(([k, b]) => b ? `${k} ${b.w}×${b.h}` : `${k} —`).join(' · ') : '—'}</td></tr>
                    <tr><td>Bleed</td><td>{ins.bleedMm ?? '—'} mm</td></tr>
                    <tr><td>Spot colours</td><td>{ins.spots.join(', ') || 'none'}</td></tr>
                    <tr><td>Effective PPI</td><td>{ins.densityPpi ? Math.round(ins.densityPpi) : '—'}</td></tr>
                    <tr><td>Transparency</td><td>{Math.round(ins.mask.transparentFrac * 100)}%, {ins.mask.components} object(s)</td></tr>
                    <tr><td>Warnings</td><td>{ins.warnings.join('; ') || 'none'}</td></tr>
                  </tbody>
                </table>
              </>
            )}
          </div>
        )}

        {tab === 'Cut & offsets' && job && (
          <div className="lg-form">
            <fieldset><legend>Cut path</legend>
              <div className="row"><span>Detected</span><b>{ins?.cut ? `${ins.cut.name}${ins.cut.exactName ? '' : ' (non-standard name)'}` : 'none'}</b></div>
              {[['keep', 'Use existing cut path'], ['contour', 'Generate contour from transparency'], ['rect', 'Rectangle at trim'], ['none', 'No cut']].map(([v, l]) => (
                <label key={v} className="radio"><input type="radio" name="cut" value={v} checked={cutMethod === v} onChange={() => setCutMethod(v)} /> {l}</label>
              ))}
              <label className="row"><span>Contour offset (mm)</span><input type="number" min={0} max={6} step={0.5} value={offset} onChange={(e) => setOffset(e.target.value)} /></label>
            </fieldset>
            <div className="lg-actions"><button onClick={applyCut}>Apply</button></div>
          </div>
        )}

        {tab === 'Output' && job && (
          <div>
            <div className="lg-actions"><button onClick={() => setGenerated(true)} disabled={!p || missing.length > 0}>Generate output</button></div>
            {missing.length > 0 && <p className="lg-missing">Before output: {missing.join(', ')}.</p>}
            {generated && p && (
              <div className="lg-output">
                {p.kind === 'production' ? <img key={p.id} src={p.previewUrl} alt="Output preview" onLoad={() => setShownPreview(p.id)} /> : <p>Policy result: return to customer. A return notice was generated.</p>}
                <table className="lg-table kv"><tbody>
                  <tr><td>Output</td><td>{p.kind}</td></tr>
                  <tr><td>Status</td><td>{p.status}</td></tr>
                  <tr><td>SHA-256</td><td className="m">{p.artifact_sha256}</td></tr>
                  {p.verification?.checks.map((c) => <tr key={c.id}><td>{c.label}</td><td>{c.pass ? 'OK' : 'FAILED'} — {c.detail}</td></tr>)}
                </tbody></table>
                <div className="lg-actions">
                  <a href={p.downloadUrl}>Download PDF</a>
                  <button onClick={send} disabled={p.status !== 'prepared' || (p.kind === 'production' && shownPreview !== p.id)}>Approve &amp; send to production</button>
                </div>
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<StrictMode><Legacy /></StrictMode>);
