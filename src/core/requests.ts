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
 *   ~/.spec-workflow/requests/<id>.json          one file per request, 0600, dir 0700
 *   ~/.spec-workflow/requests/.watchers/<wid>.json  one file per listening session (heartbeat = mtime)
 *
 * Outside any project on purpose: an implementing agent must not be able to forge a request that a
 * session would then execute with the user's authority.
 *
 * MANY SESSIONS, ONE OWNER PER REQUEST. Every `requests watch` registers itself, so several windows can
 * listen at once (one per project, or all of them). A request is handed to exactly one watcher: the
 * emitting watcher must first win an atomic claim (O_EXCL lock file), so two windows never do the same
 * work. A watcher may declare `--project` scopes, which is how you bind one window to one project.
 */

export type RequestKind = 'new-spec' | 'new-project' | 'dispatch-task';
export type RequestStatus = 'pending' | 'claimed' | 'done' | 'failed';

export interface Watcher {
  id: string;
  pid: number;
  label: string;
  /** absolute project paths this session handles; empty = any project */
  projects: string[];
  startedAt: string;
}

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
  /** watcher id that owns this request (set by the atomic claim) */
  claimedBy?: string;
  finishedAt?: string;
  result?: string;
}

export const REQUESTS_DIR = join(homedir(), '.spec-workflow', 'requests');
export const WATCHERS_DIR = join(REQUESTS_DIR, '.watchers');
/** A watcher is considered live if its file was touched within this window. */
export const HEARTBEAT_TTL_MS = 90_000;

async function ensureDir(): Promise<void> {
  await fs.mkdir(REQUESTS_DIR, { recursive: true, mode: 0o700 });
  await fs.mkdir(WATCHERS_DIR, { recursive: true, mode: 0o700 });
}

function watcherFile(id: string): string {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new Error(`invalid watcher id: ${id}`);
  return join(WATCHERS_DIR, `${id}.json`);
}

/** Register this session as a listener. Scope it with `projects` to bind it to specific repos. */
export async function registerWatcher(label: string, projects: string[] = []): Promise<Watcher> {
  await ensureDir();
  const w: Watcher = {
    id: `w-${process.pid}-${randomBytes(3).toString('hex')}`,
    pid: process.pid,
    label: label.slice(0, 80),
    projects: projects.filter(Boolean),
    startedAt: new Date().toISOString(),
  };
  await writeAtomic(watcherFile(w.id), w);
  return w;
}

export async function heartbeatWatcher(id: string): Promise<void> {
  try { const now = new Date(); await fs.utimes(watcherFile(id), now, now); }
  catch { /* file vanished (pruned / cleaned) — re-register on next tick */ }
}

export async function unregisterWatcher(id: string): Promise<void> {
  try { await fs.rm(watcherFile(id)); } catch { /* already gone */ }
}

/** Live watchers, newest heartbeat first; stale entries are removed as a side effect. */
export async function listWatchers(now = Date.now()): Promise<Array<Watcher & { lastSeen: string }>> {
  let names: string[];
  try { names = await fs.readdir(WATCHERS_DIR); } catch { return []; }
  const out: Array<Watcher & { lastSeen: string }> = [];
  for (const n of names) {
    if (!n.endsWith('.json')) continue;
    const f = join(WATCHERS_DIR, n);
    try {
      const st = await fs.stat(f);
      const w = JSON.parse(await fs.readFile(f, 'utf-8')) as Watcher;
      if (now - st.mtimeMs < HEARTBEAT_TTL_MS) out.push({ ...w, lastSeen: new Date(st.mtimeMs).toISOString() });
      else await fs.rm(f).catch(() => {});
    } catch { /* partial write */ }
  }
  return out.sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));
}

/** Does this watcher handle that project? (no scopes = handles everything) */
export function watcherHandles(w: Pick<Watcher, 'projects'>, project: string): boolean {
  return !w.projects.length || w.projects.includes(project);
}

/**
 * Atomically take ownership of a pending request. Returns false if another watcher got there first,
 * which is what keeps two open windows from doing the same work.
 */
export async function claimRequest(id: string, watcherId: string): Promise<boolean> {
  await ensureDir();
  const lock = `${file(id)}.lock`;
  try {
    const fh = await fs.open(lock, 'wx', 0o600);   // O_EXCL — first writer wins
    await fh.writeFile(watcherId);
    await fh.close();
  } catch { return false; }
  const cur = await readRequest(id);
  if (!cur || cur.status !== 'pending') { await fs.rm(lock).catch(() => {}); return false; }
  await updateRequest(id, { status: 'claimed', claimedAt: new Date().toISOString(), claimedBy: watcherId });
  return true;
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

/** Is any session listening (optionally: one that handles `project`)? */
export async function watcherAlive(project?: string, now = Date.now()): Promise<boolean> {
  const live = await listWatchers(now);
  return project ? live.some(w => watcherHandles(w, project)) : live.length > 0;
}

/** Delete finished requests older than `days` (the queue is a mailbox, not a log). */
export async function pruneRequests(days = 7, now = Date.now()): Promise<number> {
  const cutoff = now - days * 86400_000;
  let n = 0;
  for (const r of await listRequests()) {
    if (r.status !== 'done' && r.status !== 'failed') continue;
    const t = new Date(r.finishedAt || r.at).getTime();
    if (Number.isFinite(t) && t < cutoff) {
      try { await fs.rm(file(r.id)); await fs.rm(`${file(r.id)}.lock`).catch(() => {}); n++; } catch { /* gone */ }
    }
  }
  return n;
}
