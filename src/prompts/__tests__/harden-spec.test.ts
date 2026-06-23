import { describe, it, expect } from 'vitest';
import { hardenSpecPrompt } from '../harden-spec.js';

describe('harden-spec prompt (L3 SSC)', () => {
  it('requires specName', async () => {
    await expect(hardenSpecPrompt.handler({}, {} as any)).rejects.toThrow('specName');
  });

  it('emits the SSC critique structure: adversarial read, the four hole classes, propose-not-apply', async () => {
    const msgs = await hardenSpecPrompt.handler({ specName: 'demo' }, {} as any);
    const text = (msgs[0].content as any).text as string;

    // anchors on the actual spec files incl. _Tests
    expect(text).toContain('.spec-workflow/specs/demo/requirements.md');
    expect(text).toContain('.spec-workflow/specs/demo/tasks.md');
    expect(text).toContain('_Tests');

    // the adversarial SSC move
    expect(text.toLowerCase()).toContain('adversarial');
    expect(text).toMatch(/to my own advantage|missing intent|wrong-but-green/i);

    // the four hole classes
    expect(text).toMatch(/observable.*behavior/i);     // vague requirements
    expect(text).toMatch(/trivial|tautological/i);     // hackable _Tests
    expect(text).toMatch(/adversarial|edge|security/i);// missing adversarial reqs
    expect(text).toMatch(/contradiction|gap/i);        // requirements<->tasks gaps

    // propose-only, human-owned contract
    expect(text).toMatch(/do not (edit|apply)/i);
    expect(text).toMatch(/approv/i);
  });

  it('is registered in the prompt list', async () => {
    const { registerPrompts } = await import('../index.js');
    expect(registerPrompts().map(p => p.name)).toContain('harden-spec');
  });
});
