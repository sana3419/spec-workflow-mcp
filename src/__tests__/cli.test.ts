import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { runPickCli, runScopesCli, runVerifyCli } from '../cli.js';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('cli subcommands (pick / scopes / verify)', () => {
  let testDir: string;
  let specDir: string;
  let tasksFile: string;
  let out: string[];
  let logSpy: any;

  beforeEach(async () => {
    testDir = join(tmpdir(), `cli-test-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
    specDir = join(testDir, '.spec-workflow', 'specs', 'test-spec');
    tasksFile = join(specDir, 'tasks.md');
    await fs.mkdir(specDir, { recursive: true });
    await fs.writeFile(tasksFile, [
      '- [x] 1. Done task',
      '  - _Tests: tests/task1.test.js_',
      '',
      '- [ ] 2. Pending task',
      '  - _Tests: tests/task2.test.js_',
      '',
      '- [ ] 3. No-scope task',
      '',
    ].join('\n'));
    out = [];
    logSpy = vi.spyOn(console, 'log').mockImplementation((m?: any) => { out.push(String(m)); });
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it('pick selects the next pending task, marks it [-], and prints its scope', async () => {
    const code = await runPickCli(['test-spec', '--project', testDir]);
    expect(code).toBe(0);
    const json = JSON.parse(out[0]);
    expect(json.taskId).toBe('2');
    expect(json.tests).toBe('tests/task2.test.js');
    expect(await fs.readFile(tasksFile, 'utf-8')).toContain('[-] 2. Pending task');
  });

  it('pick prefers an already in-progress task (resume) over pending', async () => {
    await fs.writeFile(tasksFile, '- [-] 2. Resuming\n  - _Tests: t2_\n\n- [ ] 3. Later\n');
    await runPickCli(['test-spec', '--project', testDir]);
    expect(JSON.parse(out[0]).taskId).toBe('2');
  });

  it('scopes prints the space-joined _Tests of completed tasks only', async () => {
    const code = await runScopesCli(['test-spec', '--status', 'completed', '--project', testDir]);
    expect(code).toBe(0);
    expect(out[0]).toBe('tests/task1.test.js');
  });

  it('verify green with a scope records harness-exec', async () => {
    await runVerifyCli(['test-spec', '--task', '2', '--signal', 'green', '--exit-code', '0', '--scope', 'tests/task2.test.js', '--project', testDir]);
    const data = JSON.parse(await fs.readFile(join(specDir, 'verify-results', 'task-2.json'), 'utf-8'));
    expect(data.verifiedBy).toBe('harness-exec');
    expect(await fs.readFile(tasksFile, 'utf-8')).toContain('[x] 2. Pending task');
  });

  it('verify green with NO scope records verifiedBy:none (not independently verified)', async () => {
    await runVerifyCli(['test-spec', '--task', '3', '--signal', 'green', '--project', testDir]);
    const data = JSON.parse(await fs.readFile(join(specDir, 'verify-results', 'task-3.json'), 'utf-8'));
    expect(data.verifiedBy).toBe('none');
  });
});
