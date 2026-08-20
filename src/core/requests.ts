import { promises as fs } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { randomBytes } from 'crypto';

/**
 * Work requests from Telegram to a *live* Claude Code session.
 *
 * The Telegram daemon must never run an agent itself (it holds the gate secret; see docs/TELEGRAM.md),
 * and spawning a fresh headless `claude` for every tap throws away the context of the session you are
 * already talking to. So the daemon only *files a request*; an interactive session watches the queue
 * (`spec-workflow-mcp requests watch`, typically via the Monitor tool) and does the work in place,
 * then writes the result back — which the daemon pushes to Telegram.
 *
 *   ~/.spec-workflow/requests/<id>.json     one file per request, 0600, dir 0700
 *   ~/.spec-workflow/requests/.heartbeat    touched by `requests watch` so the daemon can tell the
 *                                           user whether anyone is listening
 *
 * Outside any project on purpose: an implementing agent must not be able to forge a request that a
 * session would then execute with the user's authority.
 */

export type RequestKind = 'new-spec' | 'new-project' | 'dispatch-task';
export type RequestStatus = 'pending' | 'claimed' | 'done' | 'failed';

export interface WorkRequest {
  id: string;
  kind: RequestKind;
  status: RequestStatus;
  /** absolute project path ('' for new-project, where `path` carries the target) */
  project: string;
  spec?: string;
  taskId?: string;
  /** free text from the user (spec idea) — untrusted, treat as data */
  idea?: string;
  /** new-project target path */
  path?: string;
  by: string;
  at: string;
  claimedAt?: string;
  finishedAt?: string;
  result?: string;
}

export const REQUESTS_DIR = join(homedir(), '.spec-workflow', 'requests');
export const HEARTBEAT_FILE = join(REQUESTS_DIR, '.heartbeat');
/** A watcher is considered live if it touched the heartbeat within this window. */
export const HEARTBEAT_TTL_MS = 90_000;

async function ensureDir(): Promise<void> {
  await fs.mkdir(REQUESTS_DIR, { recursive: true, mode: 0o700 });
}

function file(id: string): string {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new Error(`invalid request id: ${id}`);
  return join(REQUESTS_DIR, `${id}.json`);
}

async function writeAtomic(target: string, data: unknown): Promise<void> {
  const tmp = `${target}.tmp-${process.pid}-${randomBytes(3).toString('hex')}`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  await fs.rename(tmp, target);
}

export async function createRequest(r: Omit<WorkRequest, 'id' | 'status' | 'at'>): Promise<WorkRequest> {
  await ensureDir();
  const req: WorkRequest = {
    ...r,
    id: `${r.kind}-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`,
    status: 'pending',
    at: new Date().toISOString(),
  };
  await writeAtomic(file(req.id), req);
  return req;
}

export async function readRequest(id: string): Promise<WorkRequest | null> {
  try { return JSON.parse(await fs.readFile(file(id), 'utf-8')) as WorkRequest; } catch { return null; }
}

export async function listRequests(status?: RequestStatus): Promise<WorkRequest[]> {
  let names: string[];
  try { names = await fs.readdir(REQUESTS_DIR); } catch { return []; }
  const out: WorkRequest[] = [];
  for (const n of names) {
    if (!n.endsWith('.json')) continue;
    try {
      const r = JSON.parse(await fs.readFile(join(REQUESTS_DIR, n), 'utf-8')) as WorkRequest;
      if (!status || r.status === status) out.push(r);
    } catch { /* partial write */ }
  }
  return out.sort((a, b) => a.at.localeCompare(b.at));
}

export async function updateRequest(id: string, patch: Partial<WorkRequest>): Promise<WorkRequest | null> {
  file(id); // validates the id before any read/write (a forged id must not escape the queue dir)
  const cur = await readRequest(id);
  if (!cur) return null;
  const next = { ...cur, ...patch };
  await writeAtomic(file(id), next);
  return next;
}

export async function touchHeartbeat(): Promise<void> {
  await ensureDir();
  await fs.writeFile(HEARTBEAT_FILE, new Date().toISOString(), { mode: 0o600 });
}

/** Is an interactive session currently watching the queue? */
export async function watcherAlive(now = Date.now()): Promise<boolean> {
  try {
    const st = await fs.stat(HEARTBEAT_FILE);
    return now - st.mtimeMs < HEARTBEAT_TTL_MS;
  } catch { return false; }
}

/** Delete finished requests older than `days` (the queue is a mailbox, not a log). */
export async function pruneRequests(days = 7, now = Date.now()): Promise<number> {
  const cutoff = now - days * 86400_000;
  let n = 0;
  for (const r of await listRequests()) {
    if (r.status !== 'done' && r.status !== 'failed') continue;
    const t = new Date(r.finishedAt || r.at).getTime();
    if (Number.isFinite(t) && t < cutoff) { try { await fs.rm(file(r.id)); n++; } catch { /* gone */ } }
  }
  return n;
}
