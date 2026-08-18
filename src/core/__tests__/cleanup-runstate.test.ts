import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { cleanupSpecs, findCleanupCandidates } from '../cleanup.js';
import { getLoopStatus, requestLoopStop, getRunFile, RUN_FILES } from '../run-state.js';
import { setTaskStatus } from '../verify-core.js';

let root: string;
const specs = (p: string) => join(p, '.spec-workflow', 'specs');

async function mkSpec(name: string, archived = false) {
  const dir = archived
    ? join(root, '.spec-workflow', 'archive', 'specs', name)
    : join(specs(root), name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(join(dir, 'tasks.md'), `- [-] 1. First task\n\n- [ ] 2. Second task\n`);
  return dir;
}

beforeEach(async () => {
  root = join(tmpdir(), `swmcp-v3-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
  await fs.mkdir(root, { recursive: true });
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

describe('core/cleanup', () => {
  it('dry run lists candidates older than cutoff without deleting', async () => {
    await mkSpec('old');
    await mkSpec('new');
    // birthtime is "now" for both, so use a `now` far in the future to make both candidates,
    // and daysOld huge to make none.
    const future = new Date(Date.now() + 400 * 24 * 3600 * 1000);
    const none = await findCleanupCandidates(root, { daysOld: 10_000, now: future });
    expect(none.candidates).toHaveLength(0);
    const both = await cleanupSpecs(root, { daysOld: 1, now: future, dryRun: true });
    expect(both.candidates.map(c => c.name).sort()).toEqual(['new', 'old']);
    expect(both.deleted).toHaveLength(0);
    await fs.access(join(specs(root), 'old')); // still there
  });

  it('deletes only archived specs when archived=true', async () => {
    await mkSpec('active');
    await mkSpec('arch', true);
    const future = new Date(Date.now() + 400 * 24 * 3600 * 1000);
    const r = await cleanupSpecs(root, { daysOld: 1, now: future, archived: true });
    expect(r.deleted).toEqual(['arch']);
    await fs.access(join(specs(root), 'active'));
    await expect(fs.access(join(root, '.spec-workflow', 'archive', 'specs', 'arch'))).rejects.toBeTruthy();
  });

  it('rejects negative daysOld', async () => {
    await expect(findCleanupCandidates(root, { daysOld: -1 })).rejects.toThrow(/daysOld/);
  });
});

describe('core/run-state', () => {
  it('reports not running when no pid, stale when pid dead, running when alive', async () => {
    await mkSpec('s');
    expect((await getLoopStatus(root, 's')).running).toBe(false);
    const pidFile = getRunFile(root, 's', RUN_FILES.pid);
    await fs.mkdir(join(pidFile, '..'), { recursive: true });
    await fs.writeFile(pidFile, '999999999');
    const stale = await getLoopStatus(root, 's');
    expect(stale.running).toBe(false);
    expect(stale.stale).toBe(true);
    await fs.writeFile(pidFile, String(process.pid));
    const live = await getLoopStatus(root, 's');
    expect(live.running).toBe(true);
    expect(live.pid).toBe(process.pid);
  });

  it('requestLoopStop writes a JSON stop file with nonce', async () => {
    await mkSpec('s');
    const req = await requestLoopStop(root, 's', 'tg:123');
    const raw = JSON.parse(await fs.readFile(getRunFile(root, 's', RUN_FILES.stop), 'utf-8'));
    expect(raw.by).toBe('tg:123');
    expect(raw.nonce).toBe(req.nonce);
    expect(req.nonce).toMatch(/^[0-9a-f]{32}$/);
    expect((await getLoopStatus(root, 's')).stopRequested).toBe(true);
  });
});

describe('verify-core.setTaskStatus', () => {
  it('changes status, journals manual transition, and resets fixAttempts on pending', async () => {
    const dir = await mkSpec('s');
    const vr = join(dir, 'verify-results');
    await fs.mkdir(vr, { recursive: true });
    await fs.writeFile(join(vr, 'task-1.json'), JSON.stringify({ taskId: '1', specName: 's', fixAttempts: 3, lastSignal: 'red', lastTestResults: [], lastFixNote: '', lastTimestamp: '' }));
    const r = await setTaskStatus({ projectPath: root, specName: 's', taskId: '1', status: 'pending', by: 'tg:1' });
    expect(r.ok).toBe(true);
    expect(r.previous).toBe('in-progress');
    expect(await fs.readFile(join(dir, 'tasks.md'), 'utf-8')).toContain('[ ] 1. First task');
    const j = JSON.parse(await fs.readFile(join(vr, 'task-1.json'), 'utf-8'));
    expect(j.fixAttempts).toBe(0);
    expect(j.manual.by).toBe('tg:1');
    expect(j.manual.to).toBe('pending');
  });

  it('requires a reason to block', async () => {
    await mkSpec('s');
    const r = await setTaskStatus({ projectPath: root, specName: 's', taskId: '2', status: 'blocked', by: 'cli' });
    expect(r.ok).toBe(false);
    const ok = await setTaskStatus({ projectPath: root, specName: 's', taskId: '2', status: 'blocked', reason: 'waiting on API key', by: 'cli' });
    expect(ok.ok).toBe(true);
    expect(await fs.readFile(join(specs(root), 's', 'tasks.md'), 'utf-8')).toMatch(/\[~\] 2\. Second task/);
  });

  it('refuses while the loop is running unless force', async () => {
    await mkSpec('s');
    const pidFile = getRunFile(root, 's', RUN_FILES.pid);
    await fs.mkdir(join(pidFile, '..'), { recursive: true });
    await fs.writeFile(pidFile, String(process.pid));
    const r = await setTaskStatus({ projectPath: root, specName: 's', taskId: '2', status: 'in-progress', by: 'tg:1' });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/Loop is running/);
    const f = await setTaskStatus({ projectPath: root, specName: 's', taskId: '2', status: 'in-progress', by: 'runner', force: true });
    expect(f.ok).toBe(true);
  });
});
