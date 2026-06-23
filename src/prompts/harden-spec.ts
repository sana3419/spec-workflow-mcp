import { Prompt, PromptMessage } from '@modelcontextprotocol/sdk/types.js';
import { PromptDefinition } from './types.js';
import { ToolContext } from '../types.js';

const prompt: Prompt = {
  name: 'harden-spec',
  title: 'Harden Spec (Specification Self-Correction)',
  description: 'Adversarially self-critique a spec for hackable ambiguity / underspecification before implementation, and PROPOSE concrete hardening edits for human approval. This is the last line of defense: if the spec itself is wrong, the tests will faithfully verify the wrong thing.',
  arguments: [
    {
      name: 'specName',
      description: 'Feature name in kebab-case of the spec to harden',
      required: true
    }
  ]
};

async function handler(args: Record<string, any>, context: ToolContext): Promise<PromptMessage[]> {
  const { specName } = args;
  if (!specName) {
    throw new Error('specName is a required argument');
  }

  const messages: PromptMessage[] = [
    {
      role: 'user',
      content: {
        type: 'text',
        text: `Harden the spec "${specName}" using Specification Self-Correction (SSC) — BEFORE any implementation.

**Why:** Every downstream gate (harness tests, adequacy judge, integration) anchors on this spec. If the spec is ambiguous or underspecified, an implementation can satisfy it — and its \`_Tests\` — while completely missing intent, and every gate still goes green. You are the last line of defense for *intent*. There is no exit code for "the spec means what the human wanted", so be rigorous.

**Read first:**
- .spec-workflow/specs/${specName}/requirements.md
- .spec-workflow/specs/${specName}/design.md (if present)
- .spec-workflow/specs/${specName}/tasks.md — including every task's \`_Tests\` selector and \`_Requirements\`.

**Step 1 — Adversarial read (the SSC move).** Put yourself in the shoes of a lazy/adversarial implementer: *"If I implemented this spec to the letter but to my own advantage, where could I make the requirements and the \`_Tests\` pass while missing what the human actually wants?"* Concretely hunt for:
1. **Requirements that don't pin observable behavior** — vague "should work / be secure / be fast" criteria with no measurable, checkable definition.
2. **Hackable \`_Tests\` selectors** — acceptance criteria a trivial/tautological test (assert-a-constant, everything mocked) would satisfy; or scopes that don't actually pin the behavior the requirement describes.
3. **Missing adversarial / edge / security requirements** — for the domain (e.g. auth: default-deny, IDOR, secrets-not-logged; data: empty/null/huge inputs; concurrency) that an honest-but-narrow implementation would skip.
4. **Contradictions or gaps** between requirements ↔ design ↔ tasks — work implied by requirements with no task, or tasks not traceable to a requirement.

**Step 2 — Report the holes.** List each finding with: the location (file + which requirement/task), why it lets a wrong-but-green outcome through, and the concrete intent it fails to pin.

**Step 3 — Propose hardening (DO NOT APPLY).** For each hole, propose a concrete edit to requirements.md / tasks.md — tightened, measurable acceptance criteria; sharpened \`_Tests\` expectations; added adversarial/edge requirements; filled gaps. Present it as a clear before→after diff/patch.

**Important:** Do NOT edit any files. The spec is the human-owned contract — present your critique and proposed hardening for the human to review and approve. After they approve, they (or you, on their explicit go-ahead) apply the edits, then proceed to implementation.`
      }
    }
  ];

  return messages;
}

export const hardenSpecPrompt: PromptDefinition = {
  prompt,
  handler
};
