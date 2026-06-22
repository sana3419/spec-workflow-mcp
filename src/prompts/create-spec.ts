import { Prompt, PromptMessage } from '@modelcontextprotocol/sdk/types.js';
import { PromptDefinition } from './types.js';
import { ToolContext } from '../types.js';

const prompt: Prompt = {
  name: 'create-spec',
  title: 'Create Specification Document',
  description: 'Guide for creating spec documents directly in the file system. Shows how to use templates and create requirements, design, or tasks documents at the correct paths.',
  arguments: [
    {
      name: 'specName',
      description: 'Feature name in kebab-case (e.g., user-authentication, data-export)',
      required: true
    },
    {
      name: 'documentType', 
      description: 'Type of document to create: requirements, design, or tasks',
      required: true
    },
    {
      name: 'description',
      description: 'Brief description of what this spec should accomplish',
      required: false
    }
  ]
};

async function handler(args: Record<string, any>, context: ToolContext): Promise<PromptMessage[]> {
  const { specName, documentType, description } = args;
  
  if (!specName || !documentType) {
    throw new Error('specName and documentType are required arguments');
  }

  const validDocTypes = ['requirements', 'design', 'tasks'];
  if (!validDocTypes.includes(documentType)) {
    throw new Error(`documentType must be one of: ${validDocTypes.join(', ')}`);
  }

  // Build context-aware messages
  const messages: PromptMessage[] = [
    {
      role: 'user',
      content: {
        type: 'text',
        text: `Create a ${documentType} document for the "${specName}" feature using the spec-workflow methodology.

**Context:**
- Project: ${context.projectPath}
- Feature: ${specName}
- Document type: ${documentType}
${description ? `- Description: ${description}` : ''}
${context.dashboardUrl ? `- Dashboard: ${context.dashboardUrl}` : ''}

**Instructions:**
1. First, read the template at: .spec-workflow/templates/${documentType}-template.md
2. Follow the template structure exactly - this ensures consistency across the project
3. Create comprehensive content that follows spec-driven development best practices
4. Include all required sections from the template
5. Use clear, actionable language
6. Create the document at: .spec-workflow/specs/${specName}/${documentType}.md
7. After creating the document, present it to the user (share the file path and a 1–2 sentence summary) and ask them to review and approve it in the chat. If the user approves, proceed to the next phase. If they request changes, update the document per their feedback and present it again. Proceed only after the user confirms.

**File Paths:**
- Template location: .spec-workflow/templates/${documentType}-template.md
- Document destination: .spec-workflow/specs/${specName}/${documentType}.md

**Workflow Guidelines:**
- Requirements documents define WHAT needs to be built
- Design documents define HOW it will be built  
- Tasks documents break down implementation into actionable steps
- Each document builds upon the previous one in sequence
- Templates are automatically updated on server start

${documentType === 'tasks' ? `
**Special Instructions for Tasks Document:**
- For each task, generate a _Prompt field with structured AI guidance
- Format: _Prompt: Role: [role] | Task: [description] | Restrictions: [constraints] | Success: [criteria]
- Make prompts specific to the project context and requirements
- Include _Leverage fields pointing to existing code to reuse
- Include _Requirements fields showing which requirements each task implements
- Include a _Tests field: the test file/glob that proves THIS task (e.g. _Tests: tests/task3-auth.test.js_). This is the task's ACCEPTANCE SELECTOR — the background loop runs exactly these tests and the exit code decides green/red. Define it here, at spec time, as part of the contract; the implementing agent writes the test's content but must not change this selector. Each task's _Tests scope must be **self-contained** (runnable alone, not dependent on other tasks' fixtures). Tasks with no _Tests cannot be independently verified by the loop.
- Optionally add _Verify: panel_ to security-critical tasks (auth, crypto, access control). With the loop's adequacy judge enabled, a panel task is judged by a cross-family judge PLUS the security and logic reviewers (any fail reopens the task) — stronger scrutiny that the tests actually cover adversarial cases. Default (no _Verify) = a single cross-family judge.
- Claude implements tasks by default. Add an _Engine: codex_ field only to offload a specific task to Codex (e.g. large/repetitive/parallel work). Omit it (or _Engine: claude_) for the default Claude-implements path.
- Tasks should be atomic (1-3 files each) and in logical order
- Write clear task descriptions — they drive the implementation summaries logged later
` : ''}

Please read the ${documentType} template and create the comprehensive document at the specified path.`
      }
    }
  ];

  return messages;
}

export const createSpecPrompt: PromptDefinition = {
  prompt,
  handler
};