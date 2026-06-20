import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { ToolContext, ToolResponse, VerifyResult } from '../types.js';
import { PathUtils } from '../core/path-utils.js';
import { parseTasksFromMarkdown, getTaskById, updateTaskStatus } from '../core/task-parser.js';
import { promises as fs } from 'fs';
import { join } from 'path';

export const verifyTaskTool: Tool = {
  name: 'verify-task',
  description: `Record verification results for a completed task using traffic-light signals.

After implementing a task, run tests yourself (via Bash), then call this tool to record the result.
- green: All tests pass → task auto-marked completed [x] in tasks.md
- red: Tests fail → fixAttempts incremented; blocked after max retries

Call BEFORE log-implementation. Sequence: implement → test → verify-task(green) → log-implementation.

This tool does NOT execute tests. You must run tests yourself and report the result here.`,
  inputSchema: {
    type: 'object',
    properties: {
      projectPath: {
        type: 'string',
        description: 'Absolute path to the project root (optional, defaults to context projectPath)'
      },
      specName: {
        type: 'string',
        description: 'Name of the specification'
      },
      taskId: {
        type: 'string',
        description: 'Task ID (e.g., "1.1")'
      },
      signal: {
        type: 'string',
        enum: ['green', 'red'],
        description: 'Verification signal: green=pass, red=fail'
      },
      testResults: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Test name' },
            passed: { type: 'boolean', description: 'Whether the test passed' },
            error: { type: 'string', description: 'Error message if failed' }
          },
          required: ['name', 'passed']
        },
        description: 'Test results (required when signal=red)'
      },
      fixNote: {
        type: 'string',
        description: 'Note about the fix attempt or failure reason'
      },
      engine: {
        type: 'string',
        description: 'Engine used for this task (codex, claude)'
      },
      usage: {
        type: 'object',
        properties: {
          inputTokens: { type: 'number', description: 'Input tokens consumed' },
          outputTokens: { type: 'number', description: 'Output tokens consumed' },
          costUsd: { type: 'number', description: 'Estimated cost in USD' },
          durationMs: { type: 'number', description: 'Execution duration in milliseconds' }
        },
        description: 'Engine usage stats for this task (optional, for receipt tracking)'
      }
    },
    required: ['specName', 'taskId', 'signal']
  },
  annotations: {
    title: 'Verify Task',
    destructiveHint: true,
  }
};

export async function verifyTaskHandler(
  args: any,
  context: ToolContext
): Promise<ToolResponse> {
  const { specName, taskId, signal, testResults = [], fixNote, engine, usage } = args;
  const projectPath = args.projectPath || context.projectPath;

  if (!projectPath) {
    return { success: false, message: 'Project path is required but not provided' };
  }

  // Validate taskId format to prevent path traversal
  if (!/^\d+(\.\d+)*$/.test(taskId)) {
    return { success: false, message: `Invalid taskId format: '${taskId}'. Must be digits and dots (e.g., '1', '1.1', '2.3.1')` };
  }

  if (signal === 'red' && (!testResults || testResults.length === 0)) {
    return {
      success: false,
      message: 'testResults is required when signal is red',
      nextSteps: ['Provide test failure descriptions in testResults array']
    };
  }

  try {
    const translatedPath = PathUtils.translatePath(projectPath);
    const specPath = PathUtils.getSpecPath(translatedPath, specName);
    const tasksFile = join(specPath, 'tasks.md');

    let tasksContent: string;
    try {
      tasksContent = await fs.readFile(tasksFile, 'utf-8');
    } catch {
      return { success: false, message: `Tasks file not found for spec '${specName}'` };
    }

    const parseResult = parseTasksFromMarkdown(tasksContent);
    const task = getTaskById(parseResult.tasks, taskId);
    if (!task) {
      return { success: false, message: `Task '${taskId}' not found in spec '${specName}'` };
    }

    // Read or create verify-results
    const verifyDir = join(specPath, 'verify-results');
    await fs.mkdir(verifyDir, { recursive: true });
    const sanitizedId = taskId.replace(/\./g, '-');
    const verifyFile = join(verifyDir, `task-${sanitizedId}.json`);

    let verifyData: VerifyResult;
    try {
      const existing = await fs.readFile(verifyFile, 'utf-8');
      verifyData = JSON.parse(existing);
    } catch (err: any) {
      if (err?.code === 'ENOENT') {
        // File doesn't exist yet — normal for first verification
        verifyData = {
          taskId, specName, fixAttempts: 0,
          lastSignal: null, lastTestResults: [], lastFixNote: '', lastTimestamp: ''
        };
      } else {
        // File exists but is corrupted — warn but continue with fresh data
        verifyData = {
          taskId, specName, fixAttempts: 0,
          lastSignal: null, lastTestResults: [], lastFixNote: '', lastTimestamp: ''
        };
        // Note: fixAttempts reset on corruption - this is a known limitation
      }
    }

    // Reset fixAttempts if task was dragged back to pending (recovery scenario)
    if (task.status === 'pending') {
      verifyData.fixAttempts = 0;
    }

    const maxFixAttempts = context.engineConfig?.maxFixAttempts ?? 5;

    if (signal === 'green') {
      // Green: mark task completed
      const updated = updateTaskStatus(tasksContent, taskId, 'completed');
      await fs.writeFile(tasksFile, updated, 'utf-8');

      verifyData.lastSignal = 'green';
      verifyData.lastTestResults = testResults;
      verifyData.lastFixNote = fixNote || '';
      verifyData.lastTimestamp = new Date().toISOString();
      await fs.writeFile(verifyFile, JSON.stringify(verifyData, null, 2), 'utf-8');

      // Append to usage-log for receipt tracking
      await appendUsageLog(projectPath, {
        specName,
        taskId,
        taskName: task.description,
        engine: engine || task.engine || context.engineConfig?.default || 'codex',
        signal: 'green',
        timestamp: verifyData.lastTimestamp,
        usage: usage || null
      });

      return {
        success: true,
        message: `Task '${taskId}' verified GREEN - marked completed`,
        data: { signal: 'green', taskId, fixAttempts: verifyData.fixAttempts },
        nextSteps: [
          `Call log-implementation to record artifacts for task ${taskId}`,
          'Continue with next pending task via spec-status'
        ]
      };
    } else {
      // Red: increment fix attempts
      verifyData.fixAttempts += 1;
      verifyData.lastSignal = 'red';
      verifyData.lastTestResults = testResults;
      verifyData.lastFixNote = fixNote || '';
      verifyData.lastTimestamp = new Date().toISOString();

      if (verifyData.fixAttempts >= maxFixAttempts) {
        // Exceeded max attempts: block the task
        const reason = `Verification failed ${verifyData.fixAttempts} times, manual intervention required`;
        const updated = updateTaskStatus(tasksContent, taskId, 'blocked', reason);
        await fs.writeFile(tasksFile, updated, 'utf-8');
        await fs.writeFile(verifyFile, JSON.stringify(verifyData, null, 2), 'utf-8');

        await appendUsageLog(projectPath, {
          specName, taskId, taskName: task.description,
          engine: engine || task.engine || context.engineConfig?.default || 'codex',
          signal: 'blocked', timestamp: verifyData.lastTimestamp,
          usage: usage || null
        });

        return {
          success: true,
          message: `Task '${taskId}' BLOCKED after ${verifyData.fixAttempts} failed attempts`,
          data: { signal: 'red', blocked: true, fixAttempts: verifyData.fixAttempts },
          nextSteps: [
            'Task blocked - requires manual intervention',
            'Drag task back to pending in dashboard to reset and retry'
          ]
        };
      }

      await fs.writeFile(verifyFile, JSON.stringify(verifyData, null, 2), 'utf-8');

      return {
        success: true,
        message: `Task '${taskId}' verified RED - attempt ${verifyData.fixAttempts}/${maxFixAttempts}`,
        data: {
          signal: 'red',
          blocked: false,
          fixAttempts: verifyData.fixAttempts,
          maxFixAttempts,
          testResults
        },
        nextSteps: [
          `Fix the failures (attempt ${verifyData.fixAttempts}/${maxFixAttempts})`,
          `For Codex tasks: reuse the spec session via mcp__codex__codex-reply(threadId from .spec-workflow/specs/${specName}/.codex-thread) and pass the failing test output, so the fix keeps the original implementation context`,
          'Re-run tests and call verify-task again'
        ]
      };
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return { success: false, message: `Verification failed: ${errorMessage}` };
  }
}

interface UsageEntry {
  specName: string;
  taskId: string;
  taskName: string;
  engine: string;
  signal: string;
  timestamp: string;
  usage: { inputTokens?: number; outputTokens?: number; costUsd?: number; durationMs?: number } | null;
}

async function appendUsageLog(projectPath: string, entry: UsageEntry): Promise<void> {
  try {
    const logFile = join(PathUtils.getWorkflowRoot(projectPath), 'usage-log.json');
    let log: { entries: UsageEntry[] } = { entries: [] };
    try {
      const existing = await fs.readFile(logFile, 'utf-8');
      log = JSON.parse(existing);
    } catch { /* file doesn't exist yet */ }
    log.entries.push(entry);
    await fs.writeFile(logFile, JSON.stringify(log, null, 2), 'utf-8');
  } catch { /* non-critical, don't fail verify-task */ }
}
