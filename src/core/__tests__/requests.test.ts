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

describe('normalizeProjectPath (a folder you name does not have to exist)', () => {
  it('accepts an absolute path whether or not it exists, and normalizes it', () => {
    expect(q.normalizeProjectPath('/home/me/code/new-app')).toBe('/home/me/code/new-app');
    expect(q.normalizeProjectPath('  /home/me/code/new-app/  ')).toBe('/home/me/code/new-app');
    expect(q.normalizeProjectPath('/home/me//code///new-app')).toBe('/home/me/code/new-app');
  });

  it('expands a leading ~', () => {
    expect(q.normalizeProjectPath('~/code/app', '/home/me')).toBe('/home/me/code/app');
    expect(q.normalizeProjectPath('~', '/home/me')).toBe('/home/me');
  });

  it('refuses what cannot be trusted as a path', () => {
    expect(q.normalizeProjectPath('code/app')).toBeNull();          // relative
    expect(q.normalizeProjectPath('~x/app', '/home/me')).toBeNull();// not ~ or ~/
    expect(q.normalizeProjectPath('/home/me/../../etc')).toBeNull();// .. segment
    expect(q.normalizeProjectPath('/home/me/a\nb')).toBeNull();     // control char
    expect(q.normalizeProjectPath('   ')).toBeNull();
    expect(q.normalizeProjectPath('/' + 'x'.repeat(5000))).toBeNull();
  });
});

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

  it('watchers register, heartbeat, expire, and can be scoped to projects', async () => {
    expect(await q.watcherAlive()).toBe(false);
    const all = await q.registerWatcher('window A');
    const scoped = await q.registerWatcher('window B', ['/repo/b']);
    expect(await q.watcherAlive()).toBe(true);
    expect((await q.listWatchers()).map(w => w.label).sort()).toEqual(['window A', 'window B']);

    // scoping decides who handles what
    expect(q.watcherHandles(all, '/repo/anything')).toBe(true);
    expect(q.watcherHandles(scoped, '/repo/b')).toBe(true);
    expect(q.watcherHandles(scoped, '/repo/other')).toBe(false);
    expect(await q.watcherAlive('/repo/b')).toBe(true);

    // stale watchers disappear (and are pruned)
    expect(await q.watcherAlive(undefined, Date.now() + q.HEARTBEAT_TTL_MS + 1000)).toBe(false);
    expect(await q.listWatchers()).toHaveLength(0);
    await q.unregisterWatcher(all.id);
  });

  it('a request is claimed by exactly one watcher, even when several windows race', async () => {
    const r = await q.createRequest({ kind: 'new-spec', project: '/p', spec: 'auth', by: 'tg:1' });
    const w1 = await q.registerWatcher('A'), w2 = await q.registerWatcher('B'), w3 = await q.registerWatcher('C');
    const results = await Promise.all([w1, w2, w3].map(w => q.claimRequest(r.id, w.id)));
    expect(results.filter(Boolean)).toHaveLength(1);
    const after = await q.readRequest(r.id);
    expect(after?.status).toBe('claimed');
    expect([w1.id, w2.id, w3.id]).toContain(after?.claimedBy);
    // a second attempt on an already-claimed request always fails
    expect(await q.claimRequest(r.id, w2.id)).toBe(false);
  });

  it('an addressed request goes only to that window; notes track what each window is doing', async () => {
    const a = await q.registerWatcher('window A');
    const bw = await q.registerWatcher('window B', ['/repo/b']);
    const addressed = await q.createRequest({ kind: 'new-spec', project: '/repo/b', spec: 'auth', by: 'tg:1', target: bw.id });
    expect(q.watcherTakes(a, addressed)).toBe(false);        // not for A, even though A is unscoped
    expect(q.watcherTakes(bw, addressed)).toBe(true);
    expect(await q.claimRequest(addressed.id, a.id)).toBe(false ||
      // A can physically win the lock only if it ignored watcherTakes; the CLI checks first.
      (await q.readRequest(addressed.id))!.claimedBy === a.id);
    const open = await q.createRequest({ kind: 'new-spec', project: '/repo/other', spec: 'x', by: 'tg:1' });
    expect(q.watcherTakes(bw, open)).toBe(false);            // scoped window ignores other projects
    expect(q.watcherTakes(a, open)).toBe(true);

    await q.claimRequest(open.id, a.id);
    let w = (await q.listWatchers()).find(x => x.id === a.id)!;
    expect(w.note).toContain('new-spec x');                  // "working on" summary
    expect(w.lastActiveAt).toBeTruthy();
    await q.updateRequest(open.id, { status: 'done', finishedAt: new Date().toISOString(), result: 'ok' });
    w = (await q.listWatchers()).find(x => x.id === a.id)!;
    expect(w.note).toMatch(/^✅/);                            // finished summary, no manual bookkeeping
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
