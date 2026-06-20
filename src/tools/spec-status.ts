import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { ToolContext, ToolResponse } from '../types.js';
import { PathUtils } from '../core/path-utils.js';
import { SpecParser } from '../core/parser.js';
import { parseTasksFromMarkdown, findNextPendingTask } from '../core/task-parser.js';
import { promises as fs } from 'fs';
import { join } from 'path';

export const specStatusTool: Tool = {
  name: 'spec-status',
  description: `Display comprehensive specification progress overview.

# Instructions
Call when resuming work on a spec or checking overall completion status. Shows which phases are complete and task implementation progress. After viewing status, read tasks.md directly to see all tasks and their status markers ([ ] pending, [-] in-progress, [x] completed, [~] blocked).`,
  inputSchema: {
    type: 'object',
    properties: {
      projectPath: {
        type: 'string',
        description: 'Absolute path to the project root (optional - uses server context path if not provided)'
      },
      specName: {
        type: 'string',
        description: 'Name of the specification'
      }
    },
    required: ['specName']
  },
  annotations: {
    title: 'Spec Status',
    readOnlyHint: true,
  }
};

export async function specStatusHandler(args: any, context: ToolContext): Promise<ToolResponse> {
  const { specName } = args;
  
  // Use context projectPath as default, allow override via args
  const projectPath = args.projectPath || context.projectPath;
  
  if (!projectPath) {
    return {
      success: false,
      message: 'Project path is required but not provided in context or arguments'
    };
  }

  try {
    // Translate path at tool entry point (components expect pre-translated paths)
    const translatedPath = PathUtils.translatePath(projectPath);
    const parser = new SpecParser(translatedPath);
    const spec = await parser.getSpec(specName);
    
    if (!spec) {
      return {
        success: false,
        message: `Specification '${specName}' not found`,
        nextSteps: [
          'Check spec name',
          'List directory .spec-workflow/specs/ for available specs',
          'Create the spec by writing requirements.md/design.md/tasks.md directly (see spec-workflow-guide)'
        ]
      };
    }

    // Determine current phase and overall status
    let currentPhase = 'not-started';
    let overallStatus = 'not-started';
    
    if (!spec.phases.requirements.exists) {
      currentPhase = 'requirements';
      overallStatus = 'requirements-needed';
    } else if (!spec.phases.design.exists) {
      currentPhase = 'design';
      overallStatus = 'design-needed';
    } else if (!spec.phases.tasks.exists) {
      currentPhase = 'tasks';
      overallStatus = 'tasks-needed';
    } else if (spec.taskProgress && spec.taskProgress.pending > 0) {
      currentPhase = 'implementation';
      overallStatus = 'implementing';
    } else if (spec.taskProgress && spec.taskProgress.total > 0 && spec.taskProgress.completed === spec.taskProgress.total) {
      currentPhase = 'completed';
      overallStatus = 'completed';
    } else {
      currentPhase = 'implementation';
      overallStatus = 'ready-for-implementation';
    }

    // Phase details
    const phaseDetails = [
      {
        name: 'Requirements',
        status: spec.phases.requirements.exists ? (spec.phases.requirements.approved ? 'approved' : 'created') : 'missing',
        lastModified: spec.phases.requirements.lastModified
      },
      {
        name: 'Design',
        status: spec.phases.design.exists ? (spec.phases.design.approved ? 'approved' : 'created') : 'missing',
        lastModified: spec.phases.design.lastModified
      },
      {
        name: 'Tasks',
        status: spec.phases.tasks.exists ? (spec.phases.tasks.approved ? 'approved' : 'created') : 'missing',
        lastModified: spec.phases.tasks.lastModified
      },
      {
        name: 'Implementation',
        status: spec.phases.implementation.exists ? 'in-progress' : 'not-started',
        progress: spec.taskProgress
      }
    ];

    // Next steps based on current phase
    const nextSteps = [];
    switch (currentPhase) {
      case 'requirements':
        nextSteps.push('Read template: .spec-workflow/templates/requirements-template.md');
        nextSteps.push('Create: .spec-workflow/specs/{name}/requirements.md');
        nextSteps.push('Request approval');
        break;
      case 'design':
        nextSteps.push('Read template: .spec-workflow/templates/design-template.md');
        nextSteps.push('Create: .spec-workflow/specs/{name}/design.md');
        nextSteps.push('Request approval');
        break;
      case 'tasks':
        nextSteps.push('Read template: .spec-workflow/templates/tasks-template.md');
        nextSteps.push('Create: .spec-workflow/specs/{name}/tasks.md');
        nextSteps.push('Request approval');
        break;
      case 'implementation':
        if (spec.taskProgress && spec.taskProgress.pending > 0) {
          nextSteps.push(`Read tasks: .spec-workflow/specs/${specName}/tasks.md`);
          nextSteps.push('Edit tasks.md: Change [ ] to [-] for task you start');
          nextSteps.push('Implement the task code (check _Engine field for dispatch target)');
          nextSteps.push('Run tests, then call verify-task with green/red signal');
          nextSteps.push('After green: call log-implementation to record artifacts');
        } else {
          nextSteps.push(`Read tasks: .spec-workflow/specs/${specName}/tasks.md`);
          nextSteps.push('Begin implementation by marking first task [-]');
        }
        break;
      case 'completed':
        nextSteps.push('All tasks completed (marked [x])');
        nextSteps.push('Run tests');
        break;
    }

    return {
      success: true,
      message: `Specification '${specName}' status: ${overallStatus}`,
      data: {
        name: specName,
        description: spec.description,
        currentPhase,
        overallStatus,
        createdAt: spec.createdAt,
        lastModified: spec.lastModified,
        phases: phaseDetails,
        taskProgress: spec.taskProgress || {
          total: 0,
          completed: 0,
          pending: 0
        },
        ...(await getNextTaskInfo(translatedPath, specName, context))
      },
      nextSteps,
      projectContext: {
        projectPath,
        workflowRoot: PathUtils.getWorkflowRoot(translatedPath),
        currentPhase,
        dashboardUrl: context.dashboardUrl
      }
    };

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      message: `Failed to get specification status: ${errorMessage}`,
      nextSteps: [
        'Check if the specification exists',
        'Verify the project path',
        'List directory .spec-workflow/specs/ to see available specifications'
      ]
    };
  }
}

async function getNextTaskInfo(
  projectPath: string,
  specName: string,
  context: ToolContext
): Promise<{ nextTask?: { id: string; name: string; engine: string; dispatchHint: string } }> {
  try {
    const tasksFile = join(PathUtils.getSpecPath(projectPath, specName), 'tasks.md');
    const content = await fs.readFile(tasksFile, 'utf-8');
    const parsed = parseTasksFromMarkdown(content);
    const next = findNextPendingTask(parsed.tasks);
    if (!next) return {};

    const defaultEngine = context.engineConfig?.default || 'claude';
    const engine = next.engine || defaultEngine;

    return {
      nextTask: {
        id: next.id,
        name: next.description,
        engine,
        dispatchHint: buildDispatchHint(engine, context, specName, next.id)
      }
    };
  } catch {
    return {};
  }
}

function buildDispatchHint(engine: string, context: ToolContext, specName: string, taskId: string): string {
  if (engine !== 'codex') {
    // Default path: Claude implements the task itself.
    return `Implement task ${taskId} yourself (Claude is the default engine — write/edit the code directly).`;
  }
  // _Engine: codex → offload to Codex via its MCP server, reusing the per-spec session thread.
  const cx = context.engineConfig?.codex;
  const sandbox = cx?.sandbox || 'workspace-write';
  const approval = cx?.approvalPolicy || 'never';
  const model = cx?.model ? `, model="${cx.model}"` : '';
  return [
    `Dispatch task ${taskId} of spec ${specName} to Codex (do NOT write the code yourself):`,
    `1. Read .spec-workflow/specs/${specName}/.codex-thread.`,
    `   - If missing: call mcp__codex__codex(prompt=..., sandbox="${sandbox}", approval-policy="${approval}"${model}), then save the returned threadId to that file.`,
    `   - If present: call mcp__codex__codex-reply(threadId=<file>, prompt=...) to reuse the spec session.`,
    `2. Tell Codex WHICH files to read/edit and to write a report to .spec-workflow/reports/codex-${taskId}-<timestamp>.md ending with a structured summary block.`,
    `3. Run tests, then verify-task (green→log-implementation; red→codex-reply with the failure log, up to maxFixAttempts).`,
  ].join('\n');
}