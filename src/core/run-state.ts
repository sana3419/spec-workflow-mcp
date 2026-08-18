import { promises as fs } from 'fs';
import { join } from 'path';
import { randomBytes } from 'crypto';
import { PathUtils } from './path-utils.js';

/**
 * Per-spec loop run-state layout (v3). Everything the background loop runner needs at runtime
 * lives under `.spec-workflow/specs/<spec>/.run/` so concurrent specs never clobber each other:
 *
 *   .run/pid            PID of the running spec-loop-run.sh (absent/stale = not running)
 *   .run/stop           stop request  {"by":"<who>","at":"<iso>","nonce":"<hex>"}
 *   .run/gates/<id>.pending   harness-authored gate request (nonce + summary) — see gates.ts
 *   .run/testout, regout, iter-out, fixnote-*   scratch owned by the runner
 *
 * The bash runner (templates/spec-loop-run.sh) and this module MUST agree on these names.
 * Approvals are deliberately NOT stored here (the implementing agent can write into the project);
 * they live under ~/.spec-workflow/gates/ — see telegram/gates.ts.
 */

export const RUN_DIR = '.run';
export const RUN_FILES = {
  pid: 'pid',
  stop: 'stop',
  gatesDir: 'gates',
} as const;

export function getRunDir(projectPath: string, specName: string): string {
  return join(PathUtils.getSpecPath(PathUtils.translatePath(projectPath), specName), RUN_DIR);
}

export function getRunFile(projectPath: string, specName: string, name: string): string {
  return join(getRunDir(projectPath, specName), name);
}

export interface LoopStatus {
  running: boolean;
  pid?: number;
  /** pid file existed but process is gone */
  stale?: boolean;
  stopRequested?: boolean;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    // EPERM = exists but not ours; treat as alive
    return e && e.code === 'EPERM';
  }
}

export async function getLoopStatus(projectPath: string, specName: string): Promise<LoopStatus> {
  const pidFile = getRunFile(projectPath, specName, RUN_FILES.pid);
  const stopFile = getRunFile(projectPath, specName, RUN_FILES.stop);
  let stopRequested = false;
  try { await fs.access(stopFile); stopRequested = true; } catch { /* none */ }

  let raw: string;
  try {
    raw = (await fs.readFile(pidFile, 'utf-8')).trim();
  } catch {
    return { running: false, stopRequested };
  }
  const pid = parseInt(raw, 10);
  if (!Number.isFinite(pid) || pid <= 0) return { running: false, stale: true, stopRequested };
  const alive = processAlive(pid);
  return { running: alive, pid, stale: !alive, stopRequested };
}

export interface StopRequest {
  by: string;
  at: string;
  nonce: string;
}

/**
 * Ask a running loop to stop after its current iteration. Atomic (tmp + rename).
 * Returns the request that was written. Does nothing destructive if the loop is not running —
 * the runner clears a stale stop file at START, so a pre-written stop cannot silently kill the
 * next run.
 */
export async function requestLoopStop(projectPath: string, specName: string, by: string): Promise<StopRequest> {
  const dir = getRunDir(projectPath, specName);
  await fs.mkdir(dir, { recursive: true });
  const req: StopRequest = {
    by,
    at: new Date().toISOString(),
    nonce: Array.from(randomBytes(16)).map(b => b.toString(16).padStart(2, '0')).join(''),
  };
  const target = join(dir, RUN_FILES.stop);
  const tmp = `${target}.tmp-${process.pid}`;
  await fs.writeFile(tmp, JSON.stringify(req), { mode: 0o600 });
  await fs.rename(tmp, target);
  return req;
}
