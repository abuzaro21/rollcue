import { StrictMode, useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import { MEDIA, MEDIA_LABEL } from '../../src/features.ts';
import { api, ApiError, interactionCounter, isWorking, type JobSummary, type JobView, type Session } from './api.ts';
import { Card, type Act } from './card.tsx';
import { Mat } from './mat.tsx';
import './fonts.css';
import './styles.css';

const counter = interactionCounter();
const OPEN = new Set(['analysing', 'ready']);

function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [jobs, setJobs] = useState<JobSummary[]>([]);
  const [current, setCurrent] = useState<string | null>(null);
  const [job, setJob] = useState<JobView | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ text: string; tone: 'ok' | 'error' } | null>(null);
  const [adding, setAdding] = useState(false);
  const [memOpen, setMemOpen] = useState(false);
  const [kick, setKick] = useState(0); // restarts polling after an action leaves the job working
  const [conn, setConn] = useState<'connecting' | 'ok' | 'down'>('connecting');
  const curRef = useRef(current);
  curRef.current = current;
  // A response for a job the operator has already left must never be shown or acted on (Codex R1-2).
  const shown = job && job.id === current ? job : null;

  const refreshJobs = useCallback(async () => setJobs(await api.jobs()), []);
  const refreshSession = useCallback(async () => { const s = await api.session(); setSession(s); setJobs(s.jobs); return s; }, []);

  const connect = useCallback(() => {
    setConn('connecting');
    refreshSession().then((s) => { setConn('ok'); setCurrent((c) => c ?? s.jobs.find((j) => OPEN.has(j.status))?.id ?? s.jobs[0]?.id ?? null); }).catch(() => setConn('down'));
  }, [refreshSession]);
  useEffect(connect, [connect]);

  // Poll the open job while the server is still working on it; poll the queue while any job is.
  useEffect(() => {
    if (!current) { setJob(null); return; }
    let stop = false, t: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const v = await api.job(current);
        if (stop || v.id !== curRef.current) return;
        setJob(v);
        if (isWorking(v)) t = setTimeout(tick, 600);
      } catch { if (!stop) t = setTimeout(tick, 2000); }
    };
    void tick();
    return () => { stop = true; clearTimeout(t); };
  }, [current, kick]);
  const anyWorking = jobs.some((j) => j.status === 'analysing') || isWorking(shown);
  useEffect(() => {
    if (!anyWorking) return;
    const t = setInterval(() => void refreshJobs(), 1500);
    return () => clearInterval(t);
  }, [anyWorking, refreshJobs]);
  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(null), 5200); return () => clearTimeout(t); }, [toast]);

  const run = async (fn: () => Promise<JobView | void>, ok?: string) => {
    setBusy(true);
    try {
      const v = await fn();
      if (v && v.id === curRef.current) { setJob(v); if (isWorking(v)) setKick((k) => k + 1); }
      if (ok) setToast({ text: ok, tone: 'ok' });
      await refreshJobs();
    } catch (e) {
      setToast({ text: e instanceof ApiError ? e.message : 'Something went wrong. Nothing was released.', tone: 'error' });
      const id = curRef.current;
      if (e instanceof ApiError && e.status === 409 && id) { const v = await api.job(id); if (v.id === curRef.current) setJob(v); }
    } finally { setBusy(false); }
  };

  const nextOpen = jobs.find((j) => j.id !== current && OPEN.has(j.status));
  const job_ = shown;
  const act: Act | null = job_ && {
    busy,
    decide: (params, note) => run(async () => {
      const v = await api.decide(job_, params);
      if ('intent' in params) await refreshSession();
      return v;
    }, 'intent' in params && params.intent ? `${note} RollCue will read similar files this way for the rest of this session.` : note),
    approve: () => run(async () => {
      const v = await api.approve(job_);
      if (v.status === 'released' || v.status === 'returned') { void api.metric('decision', job_.id, { ...counter.snapshot(), sample: job_.sample, outcome: v.status }); counter.reset(); }
      else setToast({ text: 'Release failed verification. Nothing was released.', tone: 'error' });
      return v;
    }),
    retry: () => run(() => api.retry(job_)),
    reject: () => run(() => api.reject(job_), 'Job rejected. Nothing was prepared for production.'),
    next: nextOpen ? () => { counter.screen(); setCurrent(nextOpen.id); } : null,
  };

  const corrections = session?.corrections ?? [];
  const correctionText = corrections.length ? `Remembers ${corrections.length} correction${corrections.length === 1 ? '' : 's'}` : null;

  return (
    <div className="app">
      <header className="top">
        <a className="brand" href="/" aria-label="RollCue home"><span className="mark" aria-hidden />RollCue</a>
        <nav className="queue" aria-label="Jobs">
          {jobs.map((j) => (
            <button key={j.id} type="button" className={`qchip ${j.status}${j.id === current ? ' current' : ''}`} aria-current={j.id === current ? 'true' : undefined}
              onClick={() => { counter.screen(); setCurrent(j.id); }} title={`${j.filename} — ${j.status}`}>
              <span className="qdot" aria-hidden /><span className="qname">{j.filename}</span>
            </button>
          ))}
          <button type="button" className="qadd" onClick={() => setAdding(true)}>+ Upload</button>
          <button type="button" className="qadd sample" onClick={() => setAdding(true)}>Try a sample job</button>
        </nav>
        <div className="top-right">
          {correctionText && (
            <div className="mem">
              <button type="button" className="chip memory" aria-expanded={memOpen} onClick={() => setMemOpen(!memOpen)}>{correctionText}</button>
              {memOpen && (
                <div className="mem-pop" role="dialog" aria-label="Session corrections">
                  <p className="muted small">RollCue uses these to read similar files in this session only. The model itself does not change.</p>
                  <ul>{corrections.map((c) => <li key={c.jobId + c.at}><span className="mono">{c.filename}</span> {c.from ?? '—'} → <b>{c.to}</b></li>)}</ul>
                  <button type="button" className="quiet" onClick={() => run(async () => { await api.forget(); await refreshSession(); setMemOpen(false); if (curRef.current) return api.job(curRef.current); }, 'Corrections forgotten. Open jobs re-read.')}>Forget them</button>
                </div>
              )}
            </div>
          )}
          <a className="compare" href={`/legacy${current ? `?job=${current}` : ''}`}>Compare: the old way</a>
        </div>
      </header>

      <main className="work">
        {shown ? (
          <>
            <section className="stage" aria-label="Working object"><Mat job={shown} /></section>
            <aside className="side">{act && <Card job={shown} act={act} notice={<DemoContext text={session?.samples.find((s) => s.id === shown.sample)?.context} />} />}</aside>
          </>
        ) : conn !== 'ok' ? (
          <section className="arrival" role="status" aria-busy={conn === 'connecting'}>
            {conn === 'connecting' ? <p>Connecting to RollCue…</p> : <>
              <p>RollCue could not reach its server. Nothing was changed.</p>
              <button type="button" className="primary" onClick={connect}>Try again</button>
            </>}
          </section>
        ) : current ? (
          <section className="arrival" role="status" aria-busy="true"><p>Opening the job…</p></section>
        ) : (
          <Arrival session={session} onPick={() => setAdding(true)} onSample={(id) => run(async () => { const r = await api.sample(id); setCurrent(r.id); })} />
        )}
      </main>

      {adding && session && (
        <AddJob session={session} close={() => setAdding(false)}
          onSample={(id) => { setAdding(false); void run(async () => { const r = await api.sample(id); counter.screen(); setCurrent(r.id); }); }}
          onUpload={(file, intake) => { setAdding(false); void run(async () => { const r = await api.upload(file, intake); counter.screen(); setCurrent(r.id); }); }} />
      )}
      {session?.testHooks && location.hash === '#hooks' && shown?.proposal?.status === 'prepared' && (
        <button type="button" className="test-hook" onClick={() => run(async () => { await api.failNext(); }, 'Next release will fail (test hook).')}>Fail next release</button>
      )}
      <div className={`toast ${toast?.tone ?? ''}`} role="status" aria-live="polite">{toast?.text}</div>
    </div>
  );
}

/** What the operator knows from outside the file (a phone call, an email). Shown on demo samples only; RollCue never reads it. */
function DemoContext({ text }: { text?: string }) {
  return text ? <p className="demo-context" role="note"><b>Demo context, not seen by RollCue.</b> {text}</p> : null;
}

function Arrival({ session, onPick, onSample }: { session: Session | null; onPick: () => void; onSample: (id: string) => void }) {
  return (
    <section className="arrival">
      <h1>The next decision, not another dashboard.</h1>
      <p>RollCue reads a print job, works out what it is, prepares the production file, and asks you one question at a time.</p>
      <button type="button" className="primary" onClick={onPick}>Upload a print file</button>
      {session && <ul className="samples">{session.samples.map((s) => <li key={s.id}><button type="button" className="option" onClick={() => onSample(s.id)}><span className="option-label">{s.title}</span><span className="option-detail">{s.story}</span></button></li>)}</ul>}
    </section>
  );
}

function AddJob({ session, close, onSample, onUpload }: { session: Session; close: () => void; onSample: (id: string) => void; onUpload: (f: File, intake: Record<string, unknown>) => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [drag, setDrag] = useState(false);
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { ref.current?.showModal(); }, []);
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!file) return;
    const f = new FormData(e.currentTarget);
    const num = (k: string) => (f.get(k) ? Number(f.get(k)) : undefined);
    onUpload(file, { qty: num('qty'), reqW: num('w'), reqH: num('h'), media: f.get('media') || undefined, notes: String(f.get('notes') ?? '') });
  };
  return (
    <dialog ref={ref} className="sheet" onClose={close} aria-label="Add a job">
      <form method="dialog" className="sheet-close"><button type="submit" className="quiet" aria-label="Close">Close</button></form>
      <h2>Add a job</h2>
      <form onSubmit={submit} className="upload">
        <label className={`drop${drag ? ' over' : ''}${file ? ' has' : ''}`} onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)}
          onDrop={(e) => { e.preventDefault(); setDrag(false); setFile(e.dataTransfer.files[0] ?? null); }}>
          <input type="file" accept="application/pdf,image/png,image/jpeg" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          <span>{file ? file.name : 'Drop a PDF, PNG or JPEG here, or choose one'}</span>
          <small className="muted">Up to 10 MB. The file is read in an isolated worker and never changed.</small>
        </label>
        <p className="muted small">What the order says (optional, as it would come from the shop’s order form):</p>
        <div className="fields">
          <label>Quantity<input name="qty" type="number" min={1} max={1000000} inputMode="numeric" /></label>
          <label>Width mm<input name="w" type="number" min={5} max={5000} step="0.1" /></label>
          <label>Height mm<input name="h" type="number" min={5} max={5000} step="0.1" /></label>
          <label>Media<select name="media" defaultValue=""><option value="">Not given</option>{MEDIA.map((m) => <option key={m} value={m}>{MEDIA_LABEL[m]}</option>)}</select></label>
          <label className="wide">Customer notes<textarea name="notes" maxLength={600} rows={2} dir="auto" /></label>
        </div>
        <button type="submit" className="primary" disabled={!file}>Let RollCue read it</button>
      </form>
      <h3 id="samples">Try a sample job</h3>
      <ul className="samples">{session.samples.map((s) => <li key={s.id}><button type="button" className="option" onClick={() => onSample(s.id)}><span className="option-label">{s.title}</span><span className="option-detail">{s.story}</span></button></li>)}</ul>
    </dialog>
  );
}

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
