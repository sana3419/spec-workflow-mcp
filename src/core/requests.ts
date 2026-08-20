import { promises as fs } from 'fs';
import { join, resolve } from 'path';
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
  /** what this session is doing / last did — shown in the Telegram window list */
  note?: string;
  /** last time it claimed or finished a request (not the heartbeat) */
  lastActiveAt?: string;
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
  /** address this request to ONE window; unaddressed requests go to any watcher whose scope matches */
  target?: string;
  finishedAt?: string;
  result?: string;
}

/**
 * Normalize a project path typed by a human (Telegram, CLI) into an absolute one.
 *
 * The target does NOT have to exist — `init.sh` creates it. What we insist on is that the path is
 * unambiguous *before* it is filed as a request: leading `~` expanded, absolute, no `..` segment, no
 * control characters, bounded length. Returns null when the input cannot be trusted as a path.
 */
export function normalizeProjectPath(input: string, home: string = homedir()): string | null {
  const raw = input.trim();
  if (!raw || raw.length > 4096) return null;
  if (/[\u0000-\u001f\u007f]/.test(raw)) return null;

  let p = raw;
  if (p === '~') p = home;
  else if (p.startsWith('~/')) p = join(home, p.slice(2));

  if (!p.startsWith('/')) return null;
  if (p.split('/').includes('..')) return null;

  const abs = resolve(p);
  return abs.length > 4096 ? null : abs;
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

/** Is this request for that watcher? Addressed requests are exclusive; the rest follow the scope. */
export function watcherTakes(w: Pick<Watcher, 'id' | 'projects'>, r: Pick<WorkRequest, 'project' | 'target'>): boolean {
  return r.target ? r.target === w.id : watcherHandles(w, r.project);
}

/** Publish what this session is doing (shown in the Telegram window list). */
export async function setWatcherNote(id: string, note: string): Promise<void> {
  try {
    const w = JSON.parse(await fs.readFile(watcherFile(id), 'utf-8')) as Watcher;
    await writeAtomic(watcherFile(id), { ...w, note: note.slice(0, 160), lastActiveAt: new Date().toISOString() });
  } catch { /* watcher gone */ }
}

/** One-line description of a request, for watcher notes and the Telegram list. */
export function describeRequest(r: Pick<WorkRequest, 'kind' | 'spec' | 'taskId' | 'path'>): string {
  if (r.kind === 'new-spec') return `new-spec ${r.spec ?? ''}`.trim();
  if (r.kind === 'new-project') return `new-project ${r.path ?? ''}`.trim();
  return `task ${r.spec ?? ''} #${r.taskId ?? ''}`.trim();
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
  await setWatcherNote(watcherId, `⏳ ${describeRequest(cur)}`);
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
  // Finishing a request updates the owning window's summary, so the Telegram list stays truthful
  // without the session having to remember to publish anything.
  if (next.claimedBy && (next.status === 'done' || next.status === 'failed')) {
    await setWatcherNote(next.claimedBy, `${next.status === 'done' ? '✅' : '❌'} ${describeRequest(next)}`);
  }
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
