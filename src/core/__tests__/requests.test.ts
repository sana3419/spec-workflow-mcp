import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const home = join(tmpdir(), `swmcp-req-home-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
vi.mock('os', async (orig) => {
  const real = await orig<typeof import('os')>();
  return { ...real, homedir: () => home };
});

const q = await import('../requests.js');

beforeEach(async () => { await fs.mkdir(home, { recursive: true }); });
afterEach(async () => { await fs.rm(home, { recursive: true, force: true }); });

describe('core/requests (Telegram → live session mailbox)', () => {
  it('lives outside any project, 0700 dir / 0600 files', async () => {
    const r = await q.createRequest({ kind: 'new-spec', project: '/p', spec: 'auth', idea: 'login', by: 'tg:1' });
    expect(q.REQUESTS_DIR.startsWith(home)).toBe(true);
    expect((await fs.stat(q.REQUESTS_DIR)).mode & 0o777).toBe(0o700);
    expect((await fs.stat(join(q.REQUESTS_DIR, `${r.id}.json`))).mode & 0o777).toBe(0o600);
    expect(r.status).toBe('pending');
  });

  it('claim → done carries a result and stops showing as pending', async () => {
    const r = await q.createRequest({ kind: 'dispatch-task', project: '/p', spec: 'auth', taskId: '3', by: 'tg:1' });
    await q.updateRequest(r.id, { status: 'claimed', claimedAt: new Date().toISOString() });
    expect((await q.listRequests('pending'))).toHaveLength(0);
    await q.updateRequest(r.id, { status: 'done', finishedAt: new Date().toISOString(), result: 'task 3 green' });
    const done = await q.readRequest(r.id);
    expect(done).toMatchObject({ status: 'done', result: 'task 3 green' });
  });

  it('heartbeat tells the daemon whether a session is listening', async () => {
    expect(await q.watcherAlive()).toBe(false);
    await q.touchHeartbeat();
    expect(await q.watcherAlive()).toBe(true);
    expect(await q.watcherAlive(Date.now() + q.HEARTBEAT_TTL_MS + 1000)).toBe(false);
  });

  it('prunes finished requests only, and only when old', async () => {
    const old = await q.createRequest({ kind: 'new-spec', project: '/p', spec: 'a', by: 'tg:1' });
    const fresh = await q.createRequest({ kind: 'new-spec', project: '/p', spec: 'b', by: 'tg:1' });
    const pending = await q.createRequest({ kind: 'new-spec', project: '/p', spec: 'c', by: 'tg:1' });
    await q.updateRequest(old.id, { status: 'done', finishedAt: new Date(Date.now() - 30 * 86400_000).toISOString() });
    await q.updateRequest(fresh.id, { status: 'done', finishedAt: new Date().toISOString() });
    expect(await q.pruneRequests(7)).toBe(1);
    const left = (await q.listRequests()).map(r => r.id).sort();
    expect(left).toEqual([fresh.id, pending.id].sort());
  });

  it('rejects a forged id that would escape the queue directory', async () => {
    await expect(q.readRequest('../../etc/passwd')).resolves.toBeNull();
    await expect(q.updateRequest('../x', { status: 'done' })).rejects.toThrow(/invalid request id/);
  });
});
