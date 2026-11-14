// Test-only: Ghostscript is never run by the service.
import { execFile } from 'node:child_process';
import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * Optional third opinion: Ghostscript's tiffsep device writes one plate per colourant. A real spot colour produces a
 * "(CutContour)" plate. Used by the test suite and CI when `gs` is installed; never on uploaded originals.
 */
export async function ghostscriptPlates(bytes: Uint8Array, gsBin = process.env.RC_GS ?? 'gs'): Promise<string[] | null> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rc-gs-'));
  try {
    await writeFile(path.join(dir, 'in.pdf'), bytes);
    const ok = await new Promise<boolean>((resolve) => {
      execFile(gsBin, ['-q', '-dSAFER', '-dBATCH', '-dNOPAUSE', '-sDEVICE=tiffsep', '-r36', `-sOutputFile=${path.join(dir, 'p.tif')}`, path.join(dir, 'in.pdf')],
        { timeout: 30_000 }, (err) => resolve(!err));
    });
    if (!ok) return null;
    const names = await readdir(dir);
    const plates: string[] = [];
    for (const n of names) { const mt = /^p\((.+)\)\.tif$/.exec(n); if (mt && (await stat(path.join(dir, n))).size > 0) plates.push(mt[1]); }
    return plates.sort();
  } finally { await rm(dir, { recursive: true, force: true }); }
}
