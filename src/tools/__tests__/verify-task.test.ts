import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { verifyTaskHandler } from '../verify-task.js';
import { ToolContext } from '../../types.js';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('verify-task', () => {
  let testDir: string;
  let specDir: string;
  let tasksFile: string;
  let context: ToolContext;

  beforeEach(async () => {
    testDir = join(tmpdir(), `verify-task-test-${Date.now()}`);
    specDir = join(testDir, '.spec-workflow', 'specs', 'test-spec');
    tasksFile = join(specDir, 'tasks.md');

    await fs.mkdir(specDir, { recursive: true });
    await fs.writeFile(tasksFile, `- [-] 1. First task
  - File: src/test.ts

- [ ] 2. Second task
  - File: src/other.ts
`);

    context = {
      projectPath: testDir,
      engineConfig: { default: 'deepseek', deepseekModel: 'auto', maxFixAttempts: 3 }
    };
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it('should mark task completed on green signal', async () => {
    const result = await verifyTaskHandler({
      specName: 'test-spec',
      taskId: '1',
      signal: 'green'
    }, context);

    expect(result.success).toBe(true);
    expect(result.data.signal).toBe('green');

    const updated = await fs.readFile(tasksFile, 'utf-8');
    expect(updated).toContain('[x] 1. First task');
  });

  it('should create verify-results JSON on green', async () => {
    await verifyTaskHandler({
      specName: 'test-spec',
      taskId: '1',
      signal: 'green'
    }, context);

    const verifyFile = join(specDir, 'verify-results', 'task-1.json');
    const data = JSON.parse(await fs.readFile(verifyFile, 'utf-8'));
    expect(data.lastSignal).toBe('green');
    expect(data.taskId).toBe('1');
  });

  it('should return error when red signal has no testResults', async () => {
    const result = await verifyTaskHandler({
      specName: 'test-spec',
      taskId: '1',
      signal: 'red'
    }, context);

    expect(result.success).toBe(false);
    expect(result.message).toContain('testResults is required');
  });

  it('should increment fixAttempts on red signal', async () => {
    const result = await verifyTaskHandler({
      specName: 'test-spec',
      taskId: '1',
      signal: 'red',
      testResults: [{ name: 'test1', passed: false, error: 'failed' }],
      fixNote: 'Missing validation'
    }, context);

    expect(result.success).toBe(true);
    expect(result.data.signal).toBe('red');
    expect(result.data.fixAttempts).toBe(1);
    expect(result.data.blocked).toBe(false);
  });

  it('should block task after max fix attempts', async () => {
    for (let i = 0; i < 3; i++) {
      await verifyTaskHandler({
        specName: 'test-spec',
        taskId: '1',
        signal: 'red',
        testResults: [{ name: 'test1', passed: false, error: 'failed' }]
      }, context);
    }

    const updated = await fs.readFile(tasksFile, 'utf-8');
    expect(updated).toContain('[~] 1. First task');
    expect(updated).toContain('_Blocked:');
  });

  it('should reset fixAttempts when task is pending (recovery)', async () => {
    // First: create verify data with some attempts
    const verifyDir = join(specDir, 'verify-results');
    await fs.mkdir(verifyDir, { recursive: true });
    await fs.writeFile(join(verifyDir, 'task-2.json'), JSON.stringify({
      taskId: '2',
      specName: 'test-spec',
      fixAttempts: 4,
      lastSignal: 'red',
      lastTestResults: [],
      lastFixNote: '',
      lastTimestamp: ''
    }));

    // Task 2 is pending, so fixAttempts should reset
    const result = await verifyTaskHandler({
      specName: 'test-spec',
      taskId: '2',
      signal: 'red',
      testResults: [{ name: 'test1', passed: false }]
    }, context);

    // fixAttempts should be 1 (reset from 4 to 0, then +1)
    expect(result.data.fixAttempts).toBe(1);
  });

  it('should return error for non-existent task', async () => {
    const result = await verifyTaskHandler({
      specName: 'test-spec',
      taskId: '99',
      signal: 'green'
    }, context);

    expect(result.success).toBe(false);
    expect(result.message).toContain("Task '99' not found");
  });

  it('should return error for non-existent spec', async () => {
    const result = await verifyTaskHandler({
      specName: 'nonexistent',
      taskId: '1',
      signal: 'green'
    }, context);

    expect(result.success).toBe(false);
    expect(result.message).toContain('Tasks file not found');
  });

  it('should suggest log-implementation as next step on green', async () => {
    const result = await verifyTaskHandler({
      specName: 'test-spec',
      taskId: '1',
      signal: 'green'
    }, context);

    expect(result.nextSteps).toBeDefined();
    expect(result.nextSteps!.some(s => s.includes('log-implementation'))).toBe(true);
  });
});
