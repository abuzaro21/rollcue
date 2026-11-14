// One worker thread, one task at a time, hard timeout. A timed-out or crashed worker is terminated and replaced, so a
// hostile file never blocks the request thread. The heap cap does not bound native canvas memory (Codex R3-13).
import { Worker } from 'node:worker_threads';
import type { Task } from './worker.ts';

export class TaskError extends Error {
  code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}

export class Pool {
  #worker: Worker | null = null;
  #queue: Array<() => Promise<void>> = [];
  #busy = false;
  #seq = 0;
  timeoutMs: number;
  constructor(timeoutMs = 25_000) { this.timeoutMs = timeoutMs; }
  /** Tasks running or waiting. */
  get backlog() { return this.#queue.length + (this.#busy ? 1 : 0); }

  #spawn() {
    this.#worker = new Worker(new URL('./worker.ts', import.meta.url), {
      resourceLimits: { maxOldGenerationSizeMb: 320, maxYoungGenerationSizeMb: 48 },
      execArgv: ['--disable-warning=ExperimentalWarning'],
    });
    this.#worker.unref();
    return this.#worker;
  }

  /** A task given as a function is built only when the worker is free, so a long queue holds job IDs, not files (Codex R6-2). */
  run<T>(task: Task | (() => Promise<Task>), transfer: ArrayBuffer[] = []): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const start = async () => {
        this.#busy = true;
        if (typeof task === 'function') {
          try { task = await task(); } catch (e) { this.#busy = false; void this.#queue.shift()?.(); reject(e); return; }
        }
        const w = this.#worker ?? this.#spawn();
        const id = ++this.#seq;
        const done = () => {
          clearTimeout(timer);
          w.off('message', onMsg); w.off('error', onErr); w.off('exit', onExit);
          this.#busy = false;
          void this.#queue.shift()?.();
        };
        const kill = () => { if (this.#worker === w) this.#worker = null; void w.terminate(); };
        const onMsg = (m: { id: number; ok: boolean; result: T; error: { code: string; message: string } }) => {
          if (m.id !== id) return;
          done();
          if (m.ok) resolve(m.result); else reject(new TaskError(m.error.code, m.error.message));
        };
        // Retire a failed worker before done() starts the next task, so that task gets a fresh worker (Codex R6-7).
        const onErr = (e: Error) => { kill(); done(); reject(new TaskError(/memory/i.test(String(e)) ? 'too-large' : 'internal', /memory/i.test(String(e)) ? 'The file needs more memory than this service allows.' : 'Processing failed.')); };
        const onExit = () => { if (this.#worker === w) this.#worker = null; done(); reject(new TaskError('internal', 'Processing stopped unexpectedly.')); };
        const timer = setTimeout(() => { kill(); done(); reject(new TaskError('timeout', `Processing took longer than ${this.timeoutMs / 1000} s and was stopped.`)); }, this.timeoutMs);
        w.on('message', onMsg); w.on('error', onErr); w.on('exit', onExit);
        w.postMessage({ id, task }, transfer);
      };
      if (this.#busy) this.#queue.push(start); else void start();
    });
  }

  async close() { await this.#worker?.terminate(); this.#worker = null; }
}
