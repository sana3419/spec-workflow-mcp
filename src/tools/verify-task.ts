import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { ToolContext, ToolResponse } from '../types.js';
import { recordVerification } from '../core/verify-core.js';

export const verifyTaskTool: Tool = {
  name: 'verify-task',
  description: `Record verification results for a completed task using traffic-light signals.

NOTE: In the background loop, verification is owned by the harness (the loop script runs the
task's scoped tests and records the verdict via exit code — verifiedBy: "harness-exec"). This
tool is the MANUAL fallback: a signal you pass here is self-reported (verifiedBy: "agent") and
is NOT independent verification. Prefer the harness path.

- green: All tests pass → task auto-marked completed [x] in tasks.md
- red: Tests fail → fixAttempts incremented; blocked after max retries

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

  try {
    const result = await recordVerification({
      projectPath,
      specName,
      taskId,
      signal,
      source: 'agent', // manual/self-reported — not independent
      maxFixAttempts: context.engineConfig?.maxFixAttempts ?? 5,
      testResults,
      fixNote,
      engine,
      usage,
    });

    if (!result.ok) {
      return { success: false, message: result.message };
    }

    if (result.outcome === 'green') {
      return {
        success: true,
        message: result.message,
        data: { signal: 'green', taskId, fixAttempts: result.fixAttempts },
        nextSteps: [
          `Call log-implementation to record artifacts for task ${taskId}`,
          'Continue with next pending task via spec-status'
        ]
      };
    }

    if (result.blocked) {
      return {
        success: true,
        message: result.message,
        data: { signal: 'red', blocked: true, fixAttempts: result.fixAttempts },
        nextSteps: [
          'Task blocked - requires manual intervention',
          'Drag task back to pending in dashboard to reset and retry'
        ]
      };
    }

    return {
      success: true,
      message: result.message,
      data: {
        signal: 'red',
        blocked: false,
        fixAttempts: result.fixAttempts,
        maxFixAttempts: result.maxFixAttempts,
        testResults
      },
      nextSteps: [
        `Fix the failures (attempt ${result.fixAttempts}/${result.maxFixAttempts}) — Claude fixes directly by default`,
        `For _Engine: codex tasks: reuse the spec session via mcp__codex__codex-reply(threadId from .spec-workflow/specs/${specName}/.codex-thread) with the failing test output, so the fix keeps the original implementation context`,
        'Re-run tests and call verify-task again'
      ]
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return { success: false, message: `Verification failed: ${errorMessage}` };
  }
}
