import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { projectLastActivity, sortProjectsByActivity } from '../project-activity.js';

let base: string;
const mkProject = async (name: string) => {
  const p = join(base, name);
  await fs.mkdir(join(p, '.spec-workflow', 'specs'), { recursive: true });
  return p;
};
const touch = async (p: string, when: Date) => { await fs.utimes(p, when, when); };

beforeEach(async () => { base = join(tmpdir(), `swmcp-act-${Date.now()}-${Math.floor(Math.random() * 1e6)}`); await fs.mkdir(base, { recursive: true }); });
afterEach(async () => { await fs.rm(base, { recursive: true, force: true }); });

describe('core/project-activity', () => {
  it('orders projects by their newest activity, not alphabetically', async () => {
    const a = await mkProject('aaa-old');
    const z = await mkProject('zzz-new');
    const old = new Date(Date.now() - 30 * 86400_000);
    for (const p of [join(a, '.spec-workflow'), join(a, '.spec-workflow', 'specs')]) await touch(p, old);
    expect(await sortProjectsByActivity([a, z])).toEqual([z, a]);   // newest first
    expect([a, z].sort()).toEqual([a, z]);                          // alphabetical would be the reverse
  });

  it('a spec written just now lifts its project to the top', async () => {
    const a = await mkProject('a'), b = await mkProject('b');
    const old = new Date(Date.now() - 86400_000);
    for (const p of [a, b]) for (const d of ['.spec-workflow', '.spec-workflow/specs']) await touch(join(p, d), old);
    await fs.mkdir(join(a, '.spec-workflow', 'specs', 'fresh'), { recursive: true });
    const order = await sortProjectsByActivity([b, a]);
    expect(order[0]).toBe(a);
    expect(await projectLastActivity(a)).toBeGreaterThan(await projectLastActivity(b));
  });

  it('a loop run counts as activity, and unreadable projects sort last without throwing', async () => {
    const a = await mkProject('a'), b = await mkProject('b');
    const old = new Date(Date.now() - 86400_000);
    for (const p of [a, b]) for (const d of ['.spec-workflow', '.spec-workflow/specs']) await touch(join(p, d), old);
    await fs.writeFile(join(b, '.spec-workflow', 'loop-audit.log'), 'x\n');
    expect((await sortProjectsByActivity([a, b]))[0]).toBe(b);
    const gone = join(base, 'does-not-exist');
    expect(await projectLastActivity(gone)).toBe(0);
    expect((await sortProjectsByActivity([gone, b]))).toEqual([b, gone]);
  });
});
