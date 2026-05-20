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
Call when resuming work on a spec or checking overall completion status. Shows which phases are complete and task implementation progress. After viewing status, read tasks.md directly to see all tasks and their status markers ([ ] pending, [-] in-progress, [x] completed).`,
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
          'Use spec-list for available specs',
          'Create spec with create-spec-doc'
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
        nextSteps.push('Read template: .spec-workflow/templates/requirements-template-v*.md');
        nextSteps.push('Create: .spec-workflow/specs/{name}/requirements.md');
        nextSteps.push('Request approval');
        break;
      case 'design':
        nextSteps.push('Read template: .spec-workflow/templates/design-template-v*.md');
        nextSteps.push('Create: .spec-workflow/specs/{name}/design.md');
        nextSteps.push('Request approval');
        break;
      case 'tasks':
        nextSteps.push('Read template: .spec-workflow/templates/tasks-template-v*.md');
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
        workflowRoot: PathUtils.getWorkflowRoot(projectPath),
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

    const defaultEngine = context.engineConfig?.default || 'deepseek';
    const engine = next.engine || defaultEngine;
    const deepseekModel = context.engineConfig?.deepseekModel || 'auto';

    return {
      nextTask: {
        id: next.id,
        name: next.description,
        engine,
        dispatchHint: generateDispatchHint(engine, deepseekModel, specName, next.id)
      }
    };
  } catch {
    return {};
  }
}

function generateDispatchHint(engine: string, deepseekModel: string, specName: string, taskId: string): string {
  switch (engine) {
    case 'deepseek':
      return `deepseek ${deepseekModel !== 'auto' ? '--model ' + deepseekModel + ' ' : ''}-p "Implement task ${taskId} for spec ${specName}"`;
    case 'gemini':
      return `gemini -p "Review/implement task ${taskId} for spec ${specName}"`;
    case 'claude':
      return `Implement task ${taskId} directly (Claude is the current engine)`;
    default:
      return `Implement task ${taskId} for spec ${specName} using ${engine}`;
  }
}