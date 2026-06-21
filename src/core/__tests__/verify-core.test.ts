import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { recordVerification } from '../verify-core.js';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('verify-core.recordVerification', () => {
  let testDir: string;
  let specDir: string;
  let tasksFile: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `verify-core-test-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
    specDir = join(testDir, '.spec-workflow', 'specs', 'test-spec');
    tasksFile = join(specDir, 'tasks.md');
    await fs.mkdir(specDir, { recursive: true });
    await fs.writeFile(tasksFile, `- [-] 1. First task\n  - File: src/a.ts\n\n- [ ] 2. Second task\n  - File: src/b.ts\n`);
  });
  afterEach(async () => { await fs.rm(testDir, { recursive: true, force: true }); });

  const verifyJson = async (id: string) =>
    JSON.parse(await fs.readFile(join(specDir, 'verify-results', `task-${id}.json`), 'utf-8'));

  it('green from harness records verifiedBy:harness-exec + exitCode + scope and marks [x]', async () => {
    const r = await recordVerification({
      projectPath: testDir, specName: 'test-spec', taskId: '1', signal: 'green',
      source: 'harness-exec', exitCode: 0, testScope: 'tests/task1.test.js',
    });
    expect(r.outcome).toBe('green');
    expect((await fs.readFile(tasksFile, 'utf-8'))).toContain('[x] 1. First task');
    const data = await verifyJson('1');
    expect(data.verifiedBy).toBe('harness-exec');
    expect(data.exitCode).toBe(0);
    expect(data.testScope).toBe('tests/task1.test.js');
  });

  it('agent source is recorded distinctly (self-reported)', async () => {
    await recordVerification({ projectPath: testDir, specName: 'test-spec', taskId: '1', signal: 'green', source: 'agent' });
    expect((await verifyJson('1')).verifiedBy).toBe('agent');
  });

  it('none source records a green that is NOT independently verified', async () => {
    await recordVerification({ projectPath: testDir, specName: 'test-spec', taskId: '1', signal: 'green', source: 'none' });
    expect((await verifyJson('1')).verifiedBy).toBe('none');
  });

  it('red increments fixAttempts and blocks at max', async () => {
    for (let i = 0; i < 3; i++) {
      await recordVerification({
        projectPath: testDir, specName: 'test-spec', taskId: '1', signal: 'red', source: 'harness-exec',
        maxFixAttempts: 3, testResults: [{ name: 't', passed: false, error: 'x' }],
      });
    }
    const updated = await fs.readFile(tasksFile, 'utf-8');
    expect(updated).toContain('[~] 1. First task');
    expect(updated).toContain('_Blocked:');
  });

  it('blocked signal marks [~] directly with the reason and does NOT consume a fix attempt', async () => {
    const r = await recordVerification({
      projectPath: testDir, specName: 'test-spec', taskId: '1', signal: 'blocked',
      source: 'harness-exec', fixNote: 'tamper gate: agent modified tasks.md',
    });
    expect(r.outcome).toBe('blocked');
    expect(r.fixAttempts).toBe(0);
    const updated = await fs.readFile(tasksFile, 'utf-8');
    expect(updated).toContain('[~] 1. First task');
    expect(updated).toContain('tamper gate');
  });

  it('rejects red without testResults', async () => {
    const r = await recordVerification({ projectPath: testDir, specName: 'test-spec', taskId: '1', signal: 'red', source: 'harness-exec' });
    expect(r.ok).toBe(false);
  });
});
