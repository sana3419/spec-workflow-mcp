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

  const messages: PromptMessage[] = [
    {
      role: 'user',
      content: {
        type: 'text',
        text: `Implement ${taskId ? `task ${taskId}` : 'the next pending task'} for the "${specName}" feature.

**Context:**
- Project: ${context.projectPath}
- Feature: ${specName}
${taskId ? `- Task ID: ${taskId}` : ''}
${context.dashboardUrl ? `- Dashboard: ${context.dashboardUrl}` : ''}

**Implementation Workflow:**

1. **Check Current Status:**
   - Use the spec-status tool with specName "${specName}" to see overall progress
   - Read .spec-workflow/specs/${specName}/tasks.md to see all tasks
   - Identify ${taskId ? `task ${taskId}` : 'the next pending task marked with [ ]'}

2. **Start the Task:**
   - Edit .spec-workflow/specs/${specName}/tasks.md directly
   - Change the task marker from [ ] to [-] for the task you're starting
   - Only one task should be in-progress at a time

3. **Read Task Guidance:**
   - Look for the _Prompt field in the task - it contains structured guidance:
     - Role: The specialized developer role to assume
     - Task: Clear description with context references
     - Restrictions: What not to do and constraints
     - Success: Specific completion criteria
   - Note the _Leverage fields for files/utilities to use
   - Check _Requirements fields for which requirements this implements
   - Check _Engine field for which engine should execute this task (codex [default] or claude)

4. **Discover Existing Implementations (CRITICAL):**
   - BEFORE writing any code, search implementation logs to understand existing artifacts
   - Implementation logs are stored as markdown files in: .spec-workflow/specs/${specName}/Implementation Logs/

   **Option 1: Use grep/ripgrep for fast searches**
   \`\`\`bash
   # Search for API endpoints
   grep -r "GET\|POST\|PUT\|DELETE" ".spec-workflow/specs/${specName}/Implementation Logs/"

   # Search for specific components
   grep -r "ComponentName" ".spec-workflow/specs/${specName}/Implementation Logs/"

   # Search for integration patterns
   grep -r "integration\|dataFlow" ".spec-workflow/specs/${specName}/Implementation Logs/"
   \`\`\`

   **Option 2: Read markdown files directly**
   - Use the Read tool to examine implementation log files
   - Search for relevant sections (## API Endpoints, ## Components, ## Functions, etc.)
   - Review artifacts from related tasks to understand established patterns

   **Discovery best practices:**
   - First: Search for "API" or "endpoint" to find existing API patterns
   - Second: Search for "component" or specific component names to see existing UI structures
   - Third: Search for "integration" or "dataFlow" to understand how frontend/backend connect
   - Why this matters:
     - ❌ Don't create duplicate API endpoints - check for similar paths
     - ❌ Don't reimplement components/functions - verify utilities already don't exist
     - ❌ Don't ignore established patterns - understand middleware/integration setup
     - ✅ Reuse existing code - leverage already-implemented functions and components
     - ✅ Follow patterns - maintain consistency with established architecture
   - If initial search doesn't find expected results, refine your grep patterns
   - Document any existing related implementations before proceeding
   - If you find existing code that does what the task asks, leverage it instead of recreating

5. **Implement the Task** — dispatch by \`_Engine\`:
   - **\`_Engine: codex\` (default)** — DO NOT write the code yourself. Dispatch to Codex via its MCP server, reusing the per-spec session:
     - Read \`.spec-workflow/specs/${specName}/.codex-thread\`: if missing → \`mcp__codex__codex(prompt, sandbox, approval-policy[, model])\` and save the returned \`structuredContent.threadId\` to that file; if present → \`mcp__codex__codex-reply(threadId, prompt)\`.
     - Tell Codex the _Prompt guidance, which files to read/_Leverage and edit, and to write a report to \`.spec-workflow/reports/codex-${taskId || '<taskId>'}-<timestamp>.md\` ending with a structured summary block.
     - (\`sandbox\`/\`approval-policy\`/\`model\` come from config \`[engine.codex]\`; \`spec-status\` prints the exact hint.)
   - **\`_Engine: claude\`** — implement directly: follow the _Prompt guidance, use _Leverage files, create/modify the specified files, write clean code following existing patterns.
   - Either way: test the implementation thoroughly before verifying.

6. **Verify Implementation (MANDATORY - before logging):**
   - Run all relevant tests for the task
   - Call verify-task with specName, taskId, and signal='green' if tests pass, 'red' if tests fail
   - If red: fix failures and re-verify (max attempts configured, default 5)
   - If blocked after max attempts: task needs manual intervention
   - verify-task auto-marks task [x] on green — no manual edit needed
   - Only proceed to logging after green signal

7. **Log Implementation (MANDATORY - must complete after verify-task green):**
   - ⚠️ **STOP: Do NOT mark the task [x] until this step succeeds.**
   - A task without an implementation log is NOT complete. Skipping this step is the #1 workflow violation.
   - Call log-implementation with ALL of the following:
     - specName: "${specName}"
     - taskId: ${taskId ? `"${taskId}"` : 'the task ID you just completed'}
     - summary: Clear description of what was implemented (1-2 sentences)
     - filesModified: List of files you edited
     - filesCreated: List of files you created
     - statistics: {linesAdded: number, linesRemoved: number}
     - artifacts: {apiEndpoints: [...], components: [...], functions: [...], classes: [...], integrations: [...]}
   - You MUST include artifacts (required field) to enable other agents to find your work:
     - **apiEndpoints**: List all API endpoints created/modified with method, path, purpose, request/response formats, and location
     - **components**: List all UI components created with name, type, purpose, props, and location
     - **functions**: List all utility functions with signature and location
     - **classes**: List all classes with methods and location
     - **integrations**: Document how frontend connects to backend with data flow description
   - Example artifacts for an API endpoint:
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
   - Why: Future AI agents will query logs before implementing, preventing duplicate code and ensuring architecture consistency
   - This creates a searchable knowledge base — without it, implementation knowledge is lost when the conversation ends

8. **Confirm Completion:**
   - verify-task(green) already marked the task [x] — no manual edit needed
   - Confirm log-implementation returned success
   - Verify all success criteria from the _Prompt are met

**Important Guidelines:**
- Always mark a task as in-progress before starting work
- Follow the _Prompt field guidance for role, approach, and success criteria
- Use existing patterns and utilities mentioned in _Leverage fields
- Test your implementation before marking the task complete
- **ALWAYS call log-implementation BEFORE marking a task [x]** — this is the most-skipped step and it is mandatory
- If a task has subtasks (e.g., 4.1, 4.2), complete them in order
- If you encounter blockers, document them and move to another task

**Tools to Use:**
- spec-status: Check overall progress + the exact Codex dispatch hint
- mcp__codex__codex / mcp__codex__codex-reply: Dispatch coding to Codex (default engine) — do not write code yourself
- Bash (grep/ripgrep): CRITICAL - Search existing implementations before coding (step 4)
- Read: Examine markdown implementation log files directly (step 4)
- verify-task: Record green/red, auto-marks [x] on green (step 6)
- log-implementation: MANDATORY - Record implementation details with artifacts BEFORE marking task complete (step 7)
- Edit: Update task marker [ ]→[-] only (verify-task auto-marks [x])
- Read/Write/Edit: Implement the actual code changes ONLY for _Engine: claude tasks
- Bash: Run tests and verify implementation

**View Implementation Logs:**
- All logged implementations appear in the "Logs" tab of the dashboard
- Filter by spec, task ID, or search by summary
- View detailed statistics including files changed and lines modified
- Or search directly using grep on markdown files in .spec-workflow/specs/{specName}/Implementation Logs/

Please proceed with implementing ${taskId ? `task ${taskId}` : 'the next task'} following this workflow.`
      }
    }
  ];

  return messages;
}

export const implementTaskPrompt: PromptDefinition = {
  prompt,
  handler
};