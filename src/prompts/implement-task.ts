import { Prompt, PromptMessage } from '@modelcontextprotocol/sdk/types.js';
import { PromptDefinition } from './types.js';
import { ToolContext } from '../types.js';

const prompt: Prompt = {
  name: 'implement-task',
  title: 'Implement Specification Task',
  description: 'Guide for implementing a specific task from the tasks.md document. Provides comprehensive instructions for task execution, including reading _Prompt fields, marking progress, completion criteria, and logging implementation details for the dashboard.',
  arguments: [
    {
      name: 'specName',
      description: 'Feature name in kebab-case for the task to implement',
      required: true
    },
    {
      name: 'taskId',
      description: 'Specific task ID to implement (e.g., "1", "2.1", "3")',
      required: false
    }
  ]
};

async function handler(args: Record<string, any>, context: ToolContext): Promise<PromptMessage[]> {
  const { specName, taskId } = args;

  if (!specName) {
    throw new Error('specName is a required argument');
  }

  const taskLabel = taskId ? `task ${taskId}` : 'the next pending task';
  const taskIdRef = taskId ? `"${taskId}"` : 'the task ID you just completed';

  const messages: PromptMessage[] = [
    {
      role: 'user',
      content: {
        type: 'text',
        text: `Implement ${taskLabel} for the "${specName}" feature.

**Context:**
- Project: ${context.projectPath}
- Feature: ${specName}
${taskId ? `- Task ID: ${taskId}` : ''}
${context.dashboardUrl ? `- Dashboard: ${context.dashboardUrl}` : ''}

**Implementation Workflow:**

1. **Check status & pick the task:**
   - Run spec-status with specName "${specName}", and read .spec-workflow/specs/${specName}/tasks.md.
   - Identify ${taskId ? `task ${taskId}` : 'the next task marked [ ]'}.

2. **Start the task:**
   - Edit .spec-workflow/specs/${specName}/tasks.md and change the task's marker from [ ] to [-].
   - Only one task may be in-progress at a time.

3. **Read task guidance from the task's fields:**
   - _Prompt — structured guidance: Role, Task (with context refs), Restrictions, Success criteria.
   - _Leverage — files/utilities to reuse. _Requirements — requirements this implements.
   - _Engine — who implements: claude (default) or codex.

4. **Discover existing implementations before writing code:**
   - Implementation logs live in .spec-workflow/specs/${specName}/Implementation Logs/ (markdown).
   - Search them first (e.g. \`grep -r "endpoint\\|component\\|integration" ".spec-workflow/specs/${specName}/Implementation Logs/"\`) or read the files directly.
   - If existing code already does what the task needs, reuse it — do not duplicate endpoints, components, or utilities.

5. **Implement by \`_Engine\` (default \`claude\`):**
   - **claude (default):** implement it yourself — follow the _Prompt guidance, use _Leverage files, write clean code matching existing patterns.
   - **codex (opt-in):** offload coding to Codex via its MCP server, reusing the per-spec session. Read .spec-workflow/specs/${specName}/.codex-thread: if missing → \`mcp__codex__codex(prompt, sandbox, approval-policy[, model])\` and save the returned \`structuredContent.threadId\` to that file; if present → \`mcp__codex__codex-reply(threadId, prompt)\`. Tell Codex the _Prompt guidance, which files to read/_Leverage and edit, and to write a report to .spec-workflow/reports/codex-${taskId || '<taskId>'}-<timestamp>.md ending with a structured summary block. (sandbox/approval-policy/model come from config [engine.codex]; spec-status prints the exact hint.)

6. **Verify (before logging):**
   - Run all relevant tests for the task.
   - Call verify-task with specName, taskId, and signal='green' if tests pass, 'red' if they fail.
   - If red: fix and re-verify (max attempts configured, default 5). If still blocked: the task needs manual intervention.
   - On green, verify-task marks the task [x] for you — do not edit the marker yourself. Proceed to logging only after green.

7. **Log the implementation (MANDATORY — before the task counts as done):**
   - A task without an implementation log is NOT complete; this is the most-skipped step. Do it after verify-task green.
   - Call log-implementation with: specName "${specName}", taskId ${taskIdRef}, summary (1-2 sentences), filesModified, filesCreated, statistics {linesAdded, linesRemoved}, and artifacts (required).
   - artifacts must document, so other agents can find your work:
     - apiEndpoints: method, path, purpose, request/response formats, location
     - components: name, type, purpose, props, location
     - functions: signature, location
     - classes: methods, location
     - integrations: how frontend connects to backend, with data-flow description
   - Example:
     \`\`\`json
     "apiEndpoints": [{
       "method": "GET",
       "path": "/api/todos/:id",
       "purpose": "Fetch a specific todo by ID",
       "requestFormat": "URL param: id (string)",
       "responseFormat": "{ id: string, title: string, completed: boolean }",
       "location": "src/server.ts:245"
     }]
     \`\`\`
   - This builds a searchable knowledge base future agents query before implementing — without it the knowledge is lost when the conversation ends.

8. **Confirm completion:**
   - Confirm log-implementation returned success, and that all _Prompt success criteria are met. (verify-task already marked the task [x].)

**Guidelines:**
- Follow the _Prompt guidance and reuse _Leverage utilities.
- If a task has subtasks (e.g. 4.1, 4.2), complete them in order.
- If you hit a blocker, document it and move to another task.`
      }
    }
  ];

  return messages;
}

export const implementTaskPrompt: PromptDefinition = {
  prompt,
  handler
};
