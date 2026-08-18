import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { ToolContext, ToolResponse } from '../types.js';
import { routeReview } from '../core/review-router.js';

/** Package-shipped agents (fallback when the project has no .claude/agents). */
export function templateAgentsDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'templates', 'agents');
}

export const reviewRouteTool: Tool = {
  name: 'review-route',
  description: `Pick which reviewer subagents to run for a change — deterministically, with a reason per agent.

# Instructions
Call this BEFORE launching review subagents (the /review skill does). Routing reads the agents' own frontmatter (tier / tags / triggers) from .claude/agents/*.md, the project profile (languages, frameworks, migrations, LLM SDK, UI) and the diff: Tier 0 agents always run; Tier 1+ run when a changed path or an ADDED diff line matches their triggers. Then launch exactly the returned \`selected\` agents in parallel (Agent tool, one per name), passing them the changed files. Respect the user's overrides: \`agents\` (exact list), \`add\`/\`skip\`, \`full\` (no cap), \`tags\` from a task's _Review: field. Use \`dryRun\` semantics by simply not launching anything — the tool never runs agents itself.`,
  inputSchema: {
    type: 'object',
    properties: {
      projectPath: { type: 'string', description: 'Absolute project root (optional — server context)' },
      changedFiles: { type: 'array', items: { type: 'string' }, description: 'Repo-relative changed files. Omit to use git diff.' },
      diffText: { type: 'string', description: 'Unified diff (optional; used for content triggers). Omit to use git diff.' },
      base: { type: 'string', description: "git base for auto diff: 'HEAD' (working tree, default), 'HEAD~1', a branch, etc." },
      agents: { type: 'array', items: { type: 'string' }, description: 'Exact agent list — bypasses routing' },
      add: { type: 'array', items: { type: 'string' } },
      skip: { type: 'array', items: { type: 'string' } },
      tags: { type: 'array', items: { type: 'string' }, description: "Tags from the task's _Review: field, e.g. ['security','concurrency']" },
      full: { type: 'boolean', description: 'Select everything that triggers; ignore maxAgents' },
      maxAgents: { type: 'number', description: 'Cap (default 8 or review.config.json maxAgents)' },
    },
  },
  annotations: { title: 'Review Route', readOnlyHint: true },
};

export async function reviewRouteHandler(args: any, context: ToolContext): Promise<ToolResponse> {
  const projectPath = args.projectPath || context.projectPath;
  if (!projectPath) return { success: false, message: 'Project path is required' };
  try {
    const r = await routeReview({
      projectPath,
      changedFiles: args.changedFiles, diffText: args.diffText, base: args.base,
      agents: args.agents, add: args.add, skip: args.skip, tags: args.tags, full: !!args.full, maxAgents: args.maxAgents,
    }, templateAgentsDir());
    const list = r.selected.map(s => `${s.name} (T${s.tier}: ${s.reasons.join('; ')})`).join('\n- ');
    return {
      success: true,
      message: r.selected.length
        ? `Selected ${r.selected.length} reviewer(s) for ${r.changedFiles.length} changed file(s)${r.docsOnly ? ' [docs-only fast path]' : ''}:\n- ${list}`
        : 'No reviewers selected (no agents found or nothing changed).',
      data: r,
      nextSteps: r.selected.length
        ? ['Launch exactly these agents in parallel via the Agent tool, one per name, with the changed file list',
           'Each agent writes .spec-workflow/reports/agent-<name>-<ts>.md; consolidate BLOCK/WARN/PASSED afterwards',
           ...(r.skipped.length ? [`Skipped: ${r.skipped.map(s => `${s.name} (${s.why})`).join(', ')}`] : [])]
        : ['Run `bash init.sh <project>` to install the reviewer agents into .claude/agents/, or pass changedFiles'],
    };
  } catch (e) {
    return { success: false, message: `review-route failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}
