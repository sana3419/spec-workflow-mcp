import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { ToolContext, ToolResponse } from '../types.js';

export const specWorkflowGuideTool: Tool = {
  name: 'spec-workflow-guide',
  description: `Load essential spec workflow instructions to guide feature development from idea to implementation.

# Instructions
Call this tool FIRST when users request spec creation, feature development, or mention specifications. This provides the complete workflow sequence (Requirements → Design → Tasks → Implementation) that must be followed. Always load before any other spec tools to ensure proper workflow understanding. Its important that you follow this workflow exactly to avoid errors.`,
  inputSchema: {
    type: 'object',
    properties: {},
    additionalProperties: false
  },
  annotations: {
    title: 'Spec Workflow Guide',
    readOnlyHint: true,
  }
};

export async function specWorkflowGuideHandler(args: any, context: ToolContext): Promise<ToolResponse> {
  // Dashboard URL is populated from registry in server.ts
  const dashboardMessage = context.dashboardUrl ?
    `Monitor progress on dashboard: ${context.dashboardUrl}` :
    'Please start the dashboard with: spec-workflow-mcp --dashboard';

  return {
    success: true,
    message: 'Complete spec workflow guide loaded - follow this workflow exactly',
    data: {
      guide: getSpecWorkflowGuide(),
      dashboardUrl: context.dashboardUrl,
      dashboardAvailable: !!context.dashboardUrl
    },
    nextSteps: [
      'Follow sequence: Requirements → Design → Tasks → Implementation',
      'Read templates from .spec-workflow/templates/ with the Read tool first',
      'Present each document to the user and get their approval in chat',
      'Use MCP tools only',
      dashboardMessage
    ]
  };
}

function getSpecWorkflowGuide(): string {
  const currentYear = new Date().getFullYear();
  return `# Spec Development Workflow

## Overview

You guide users through spec-driven development using MCP tools. Transform rough ideas into detailed specifications through Requirements → Design → Tasks → Implementation phases. Use web search when available for current best practices (current year: ${currentYear}). Its important that you follow this workflow exactly to avoid errors.
Feature names use kebab-case (e.g., user-authentication). Create ONE spec at a time.

## Workflow Diagram
\`\`\`mermaid
flowchart TD
    Start([Start: User requests feature]) --> CheckSteering{Steering docs exist?}
    CheckSteering -->|Yes| P1_Load[Read steering docs:<br/>.spec-workflow/steering/*.md]
    CheckSteering -->|No| P1_Template

    %% Phase 1: Requirements
    P1_Load --> P1_Template[Check user-templates first,<br/>then read template:<br/>requirements-template.md]
    P1_Template --> P1_Research[Web search if available]
    P1_Research --> P1_Create[Create file:<br/>.spec-workflow/specs/{name}/<br/>requirements.md]
    P1_Create --> P1_Approve[Ask user to review &<br/>approve in chat]
    P1_Approve --> P1_Check{Approved?}
    P1_Check -->|changes| P1_Update[Update document using user comments as guidance]
    P1_Update --> P1_Create

    %% Phase 2: Design
    P1_Check -->|approved| P2_Template[Check user-templates first,<br/>then read template:<br/>design-template.md]
    P2_Template --> P2_Analyze[Analyze codebase patterns]
    P2_Analyze --> P2_Create[Create file:<br/>.spec-workflow/specs/{name}/<br/>design.md]
    P2_Create --> P2_Approve[Ask user to review &<br/>approve in chat]
    P2_Approve --> P2_Check{Approved?}
    P2_Check -->|changes| P2_Update[Update document using user comments as guidance]
    P2_Update --> P2_Create

    %% Phase 3: Tasks
    P2_Check -->|approved| P3_Template[Check user-templates first,<br/>then read template:<br/>tasks-template.md]
    P3_Template --> P3_Break[Convert design to tasks]
    P3_Break --> P3_Create[Create file:<br/>.spec-workflow/specs/{name}/<br/>tasks.md]
    P3_Create --> P3_Approve[Ask user to review &<br/>approve in chat]
    P3_Approve --> P3_Check{Approved?}
    P3_Check -->|changes| P3_Update[Update document using user comments as guidance]
    P3_Update --> P3_Create

    %% Phase 4: Implementation — two paths (interactive = agent self-reports; background loop = harness verifies)
    P3_Check -->|approved| P4_Ready[Spec complete.<br/>Ready to implement?]
    P4_Ready -->|background loop| P4_Loop[spec-loop-run.sh:<br/>harness runs each task's _Tests,<br/>verdict from exit code, CLI marks [x]/[~].<br/>Agent does NOT call verify-task]
    P4_Ready -->|interactive| P4_Status[spec-status]
    P4_Status --> P4_Task[Edit tasks.md:<br/>Change [ ] to [-]<br/>for in-progress]
    P4_Task --> P4_Code[Dispatch to Codex<br/>via mcp__codex__codex<br/>or implement if _Engine: claude]
    P4_Code --> P4_Verify{verify-task<br/>green/red?<br/>interactive: self-reported}
    P4_Verify -->|green| P4_Log[log-implementation<br/>Record details]
    P4_Verify -->|red| P4_Fix[codex-reply with<br/>failure log, up to<br/>maxFixAttempts]
    P4_Fix --> P4_Code
    P4_Log --> P4_Complete[verify-task marked<br/>task [x] — interactive path]
    P4_Complete --> P4_More{More tasks?}
    P4_More -->|Yes| P4_Task
    P4_More -->|No| End([Implementation Complete])

    style Start fill:#e1f5e1
    style End fill:#e1f5e1
    style P1_Check fill:#ffe6e6
    style P2_Check fill:#ffe6e6
    style P3_Check fill:#ffe6e6
    style CheckSteering fill:#fff4e6
    style P4_More fill:#fff4e6
    style P4_Log fill:#e3f2fd
\`\`\`

## Spec Workflow

### Phase 1: Requirements
**Purpose**: Define what to build based on user needs.

**File Operations**:
- Read steering docs: \`.spec-workflow/steering/*.md\` (if they exist)
- Check for custom template: \`.spec-workflow/user-templates/requirements-template.md\`
- Read template: \`.spec-workflow/templates/requirements-template.md\` (if no custom template)
- Create document: \`.spec-workflow/specs/{spec-name}/requirements.md\`

**Process**:
1. Check if \`.spec-workflow/steering/\` exists (if yes, read product.md, tech.md, structure.md)
2. Check for custom template at \`.spec-workflow/user-templates/requirements-template.md\`
3. If no custom template, read from \`.spec-workflow/templates/requirements-template.md\`
4. Research market/user expectations (if web search available, current year: ${currentYear})
5. Generate requirements as user stories with EARS criteria
6. Create \`requirements.md\` at \`.spec-workflow/specs/{spec-name}/requirements.md\`
7. After creating requirements.md, present it to the user (share the file path and a 1–2 sentence summary) and ask them to review and approve it in the chat. If the user approves, proceed to the next phase. If they request changes, update the document per their feedback and present it again. Proceed only after the user confirms.

### Phase 2: Design
**Purpose**: Create technical design addressing all requirements.

**File Operations**:
- Check for custom template: \`.spec-workflow/user-templates/design-template.md\`
- Read template: \`.spec-workflow/templates/design-template.md\` (if no custom template)
- Create document: \`.spec-workflow/specs/{spec-name}/design.md\`

**Process**:
1. Check for custom template at \`.spec-workflow/user-templates/design-template.md\`
2. If no custom template, read from \`.spec-workflow/templates/design-template.md\`
3. Analyze codebase for patterns to reuse
4. Research technology choices (if web search available, current year: ${currentYear})
5. Generate design with all template sections
6. Create \`design.md\` at \`.spec-workflow/specs/{spec-name}/design.md\`
7. After creating design.md, present it to the user (share the file path and a 1–2 sentence summary) and ask them to review and approve it in the chat. If the user approves, proceed to the next phase. If they request changes, update the document per their feedback and present it again. Proceed only after the user confirms.

### Phase 3: Tasks
**Purpose**: Break design into atomic implementation tasks.

**File Operations**:
- Check for custom template: \`.spec-workflow/user-templates/tasks-template.md\`
- Read template: \`.spec-workflow/templates/tasks-template.md\` (if no custom template)
- Create document: \`.spec-workflow/specs/{spec-name}/tasks.md\`

**Process**:
1. Check for custom template at \`.spec-workflow/user-templates/tasks-template.md\`
2. If no custom template, read from \`.spec-workflow/templates/tasks-template.md\`
3. Convert design into atomic tasks (1-3 files each)
4. Include file paths and requirement references
5. **IMPORTANT**: Generate a _Prompt field for each task with:
   - Role: specialized developer role for the task
   - Task: clear description with context references
   - Restrictions: what not to do, constraints to follow
   - _Leverage: files/utilities to use
   - _Requirements: requirements that the task implements
   - _Tests: the test file/glob that proves this task (acceptance selector). The background loop runs exactly these tests and the exit code is the verdict — set it at spec time, keep it self-contained, do not let the implementer change it
   - _Verify: optional; set to "panel" on security-critical tasks so the loop's adequacy judge uses a multi-lens panel (cross-family judge + security/logic reviewers, any fail reopens) instead of a single cross-family judge
   - _Engine: who implements (claude or codex; omit to use default claude). Add _Engine: codex only to offload that task to Codex
   - Success: specific completion criteria
   - Instructions related to setting the task in progress in tasks.md, verifying with verify-task, logging the implementation with log-implementation tool after completion.
   - Start the prompt with "Implement the task for spec {spec-name}, first run spec-workflow-guide to get the workflow guide then implement the task:"
6. Create \`tasks.md\` at \`.spec-workflow/specs/{spec-name}/tasks.md\`
7. After creating tasks.md, present it to the user (share the file path and a 1–2 sentence summary) and ask them to review and approve it in the chat. If the user approves, proceed to the next phase. If they request changes, update the document per their feedback and present it again. Proceed only after the user confirms.
8. After the user confirms: "Spec complete. Ready to implement?"

### Phase 4: Implementation
**Purpose**: Execute tasks systematically.

**File Operations**:
- Read specs: \`.spec-workflow/specs/{spec-name}/*.md\` (if returning to work)
- Edit tasks.md to update status:
  - \`- [ ]\` = Pending task
  - \`- [-]\` = In-progress task
  - \`- [x]\` = Completed task
  - \`- [~]\` = Blocked task
- Optional blocked reason metadata: \`- _Blocked: reason why task is blocked_\` (add as sub-bullet under the blocked task)

**Tools**:
- spec-status: Check overall progress (includes next task engine suggestion)
- verify-task: Record test verification results (green/red signal) before logging
- Bash (grep/ripgrep): CRITICAL - Search existing code before implementing (step 3)
- Read: Examine implementation log files directly
- implement-task prompt: Guide for implementing tasks
- log-implementation: Record implementation details with artifacts after task completion
- Direct editing: Mark tasks as in-progress [-] in tasks.md (verify-task auto-marks [x])

**Process**:
1. Check current status with spec-status
2. Read \`tasks.md\` to see all tasks
3. For each task:
   - Edit tasks.md: Change \`[ ]\` to \`[-]\` for the task you're starting
   - **CRITICAL: BEFORE implementing, search existing implementation logs**:
     - Implementation logs are in: \`.spec-workflow/specs/{spec-name}/Implementation Logs/\`
     - **Option 1: Use grep for fast searches**:
       - \`grep -r "api\|endpoint" .spec-workflow/specs/{spec-name}/Implementation Logs/\` - Find API endpoints
       - \`grep -r "component" .spec-workflow/specs/{spec-name}/Implementation Logs/\` - Find UI components
       - \`grep -r "function" .spec-workflow/specs/{spec-name}/Implementation Logs/\` - Find utility functions
       - \`grep -r "integration" .spec-workflow/specs/{spec-name}/Implementation Logs/\` - Find integration patterns
     - **Option 2: Read markdown files directly** - Use Read tool to examine specific log files
     - Best practice: Search 2-3 different terms to discover comprehensively
     - This prevents: duplicate endpoints, reimplemented components, broken integrations
     - Reuse existing code that already solves part of the task
   - **Read the _Prompt field** for guidance on role, approach, and success criteria
   - Follow _Leverage fields to use existing code/utilities
   - Check _Engine field to determine who implements (claude [default] or codex)
   - Default (claude): implement it yourself — write/edit the code directly
   - For codex tasks (opt-in): offload to the Codex MCP server, reusing the per-spec session (see Codex Dispatch below)
   - Test your implementation
   - **MANDATORY: Call verify-task** with signal='green' (pass) or 'red' (fail):
     - verify-task auto-marks task [x] on green signal
     - On red: fix failures and re-verify (max attempts from config, default 5)
     - If blocked after max attempts: task needs manual intervention
   - **MANDATORY: Log implementation** using log-implementation tool:
     - A task without an implementation log is NOT complete — this is the most commonly skipped step
     - Provide taskId and clear summary of what was implemented (1-2 sentences)
     - Include files modified/created and code statistics (lines added/removed)
     - **REQUIRED: Include artifacts field with structured implementation data**:
       - apiEndpoints: All API routes created/modified (method, path, purpose, formats, location)
       - components: All UI components created (name, type, purpose, location, props)
       - functions: All utility functions created (name, signature, location)
       - classes: All classes created (name, methods, location)
       - integrations: Frontend-backend connections with data flow description
     - Example: "Created API GET /api/todos/:id endpoint and TodoDetail React component with WebSocket real-time updates"
     - This creates a searchable knowledge base for future AI agents to discover existing code
     - Prevents implementation details from being lost in chat history
4. Continue until every task is \`[x]\` completed or \`[~]\` blocked

(The verify-task step above is the **interactive/manual** path — your green/red signal is self-reported. In the **background runner**, the harness instead runs each task's \`_Tests\` and records the verdict from the exit code, and the loop's CLI marks \`[x]\`/\`[~]\`; the per-task agent does NOT call verify-task or edit task markers. See Phase 4 Loop below.)

### Codex Dispatch (optional helper)
Claude is the primary engine — it plans, implements, reviews, and verifies. Codex is an
**auxiliary** engine you offload specific coding tasks to. Tasks may carry an \`_Engine:\` field:
- \`claude\` (default): implement directly. If no \`_Engine:\` field, this is used.
- \`codex\` (opt-in): dispatch the coding to the Codex MCP server — good for large, repetitive, or parallelizable tasks, or to save Claude's context.

When a task is \`_Engine: codex\`, use **per-spec session reuse** (efficiency + accuracy):
- Each spec keeps ONE Codex session in \`.spec-workflow/specs/{spec-name}/.codex-thread\`.
- First task of a spec → \`mcp__codex__codex(prompt, sandbox, approval-policy[, model])\`; save the returned threadId to \`.codex-thread\`.
- Later tasks in the same spec, and any red→fix retry → \`mcp__codex__codex-reply(threadId, prompt)\` so the worker keeps its context.
- Only if codex-reply fails (stale thread) → start a new \`codex()\` and overwrite \`.codex-thread\`.
- Tell Codex which files to read/edit and to write a report to \`.spec-workflow/reports/codex-<taskId>-<timestamp>.md\` ending with a structured summary block.

Use spec-status to see the suggested engine and the exact dispatch hint for the next task.

### Phase 4 Loop
Work tasks one at a time: implement → test → verify-task → log-implementation, until every task is \`[x]\` or \`[~]\`.
("Implement" = Claude writes the code by default, or offloads to Codex for \`_Engine: codex\` tasks. Inner fix loop: on red, fix and re-verify up to maxFixAttempts — claude tasks fix directly; codex tasks use \`codex-reply\` with the failure log — then it is left \`[~]\` blocked.)

Two ways to run it:
- **Interactive (default)**: you drive it in this session — do a task, continue to the next.
- **Background runner (optional, hands-off)**: \`.spec-workflow/spec-loop-run.sh <spec>\` (requires \`[loop].autoLoop = true\` in config.toml). It launches a SEPARATE headless \`claude\` per task and drives the spec to completion, so the **interactive session stays free** to chat / check progress. Here the **harness owns verification**: the per-task agent only implements + writes the task's \`_Tests\`; the script runs those tests, records the verdict from the exit code, and marks \`[x]\`/\`[~]\` — the agent does NOT call verify-task or edit markers. If \`[loop].judge = true\`, each harness-green task then gets a **cross-family adequacy judge** (codex judges claude's work and vice versa; \`_Verify: panel\` adds the security/logic reviewers) that checks whether the tests are actually adequate — an inadequate verdict reopens the task to strengthen the tests (bounded by \`judgeMaxAttempts\`). Finally, if \`[loop].integrationCommand\` is set, once the whole spec is DONE the loop runs an **integration terminal gate** — the real build + boot smoke of the assembled system (the \`tsc\`/whole build that per-task verification skips), with a bounded auto-fix on failure and an optional cross-module judge (\`integrationJudge\`); the result is recorded in \`integration-result.json\`. Start it in the background:
  \`nohup bash .spec-workflow/spec-loop-run.sh <spec> >/dev/null 2>&1 &\`
  Watch \`.spec-workflow/loop-run.log\`; stop with \`touch .spec-workflow/.loop-stop\` (or kill the PID in \`.spec-workflow/.loop-run.pid\`). Guardrails: \`maxIterations\` + \`noProgressStop\` (config \`[loop]\`); audit in \`.spec-workflow/loop-audit.log\`.

**When the user asks to "run/start the loop"**: launch the background runner with \`nohup … &\` (set \`[loop].autoLoop = true\` first if needed), report the PID, and keep chatting — do NOT loop in this interactive session yourself. Each background iteration is autonomous: do NOT pause to ask the user; if a task genuinely needs a human decision, mark it \`[~]\` blocked with a reason and move on.

### Phase 5: Research Report (Optional)
**Purpose**: Generate an academic-style research report in docx format after all tasks are completed.

**Process**:
1. Claude writes the report in Markdown (\`docs/report/report.md\`) covering:
   - Architecture analysis and technical decisions
   - Key technologies and implementation details
   - Experimental validation and results
   - Conclusions and future work
2. Claude generates SVG technical diagrams (\`docs/report/svg/\`):
   - Architecture diagram, data flow diagram, component diagram
3. Convert SVGs to PNG (\`docs/report/images/\`) with rsvg-convert:
   - \`for f in docs/report/svg/*.svg; do rsvg-convert -w 1200 "$f" -o "docs/report/images/$(basename "$f" .svg).png"; done\`
4. Generate docx via: \`python3 <spec-workflow-mcp>/tools/gen-report.py docs/report/report.md -o docs/report/report.docx --images docs/report/images/\`

**Markdown format**: Use # for title, ## for sections (一、二、...), ### for subsections (（一）（二）...), #### for sub-subsections (1．2．...), ![caption](path) for images, | table | for tables, [N] for references.

**Tools**: Claude (report writing + SVG), rsvg-convert (SVG→PNG), gen-report.py (Markdown→docx)

## Workflow Rules

- Create documents directly at specified file paths
- Read templates from \`.spec-workflow/templates/\` directory
- Follow exact template structures
- Get explicit user approval between phases by presenting each document and asking the user to approve it in chat
- Complete phases in sequence (no skipping)
- One spec at a time
- Use kebab-case for spec names
- CRITICAL: Proceed to the next phase only after the user confirms approval in chat
- CRITICAL: Call verify-task with green signal BEFORE log-implementation
- If _Engine field exists, dispatch to the specified engine (codex via MCP server, or claude directly)
- CRITICAL: Every task marked [x] MUST have a corresponding implementation log — call log-implementation BEFORE changing [-] to [x]
- Steering docs are optional - only create when explicitly requested

## File Structure
\`\`\`
.spec-workflow/
├── templates/           # Auto-populated on server start
│   ├── requirements-template.md
│   ├── design-template.md
│   ├── tasks-template.md
│   ├── product-template.md
│   ├── tech-template.md
│   └── structure-template.md
├── specs/
│   └── {spec-name}/
│       ├── requirements.md
│       ├── design.md
│       ├── tasks.md
│       └── Implementation Logs/     # Created automatically
│           ├── task-1_timestamp_id.md
│           ├── task-2_timestamp_id.md
│           └── ...
└── steering/
    ├── product.md
    ├── tech.md
    └── structure.md
\`\`\``;
}