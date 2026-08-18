export const meta = {
  name: 'spec-workflow-review',
  description: 'Routed reviewer fan-out with adversarial verification of BLOCK findings',
  whenToUse: 'Use for /review --full on large diffs: runs every routed reviewer agent in parallel, then has 3 independent skeptics try to refute each BLOCK before it is reported.',
  phases: [
    { title: 'Route', detail: 'deterministic reviewer selection (review-route)' },
    { title: 'Review', detail: 'one subagent per routed lens' },
    { title: 'Verify', detail: '3 refuters per BLOCK finding' },
  ],
}
// args: { projectPath: string, base?: string, agents?: string[], full?: boolean }
const FINDINGS = {
  type: 'object',
  properties: {
    agent: { type: 'string' },
    findings: { type: 'array', items: { type: 'object', properties: {
      severity: { type: 'string', enum: ['BLOCK', 'WARN'] },
      file: { type: 'string' }, line: { type: 'number' },
      summary: { type: 'string' }, fix: { type: 'string' },
    }, required: ['severity', 'file', 'summary'] } },
    passed: { type: 'array', items: { type: 'string' } },
  },
  required: ['agent', 'findings'],
}
const VERDICT = { type: 'object', properties: { refuted: { type: 'boolean' }, why: { type: 'string' } }, required: ['refuted', 'why'] }

phase('Route')
const routed = await agent(
  `Call the MCP tool review-route with ${JSON.stringify({ projectPath: args.projectPath, base: args.base ?? 'HEAD', agents: args.agents, full: !!args.full })}. ` +
  `Return ONLY the JSON: {"selected":[{"name":..., "reasons":[...]}], "changedFiles":[...]}.`,
  { label: 'route', schema: { type: 'object', properties: { selected: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, reasons: { type: 'array', items: { type: 'string' } } }, required: ['name'] } }, changedFiles: { type: 'array', items: { type: 'string' } } }, required: ['selected', 'changedFiles'] } },
)
log(`routed ${routed.selected.length} reviewer(s) for ${routed.changedFiles.length} file(s)`)

const results = await pipeline(
  routed.selected,
  (sel) => agent(
    `You are running the reviewer agent "${sel.name}" (read its definition in .claude/agents/${sel.name}.md and follow it exactly, read-only). ` +
    `Project: ${args.projectPath}. Changed files: ${routed.changedFiles.join(', ')}. Base: ${args.base ?? 'HEAD'}. ` +
    `Write your normal report to .spec-workflow/reports/, then return the findings as structured output.`,
    { label: `review:${sel.name}`, phase: 'Review', schema: FINDINGS, agentType: sel.name },
  ),
  async (report, sel) => {
    if (!report) return null
    const blocks = report.findings.filter(f => f.severity === 'BLOCK')
    const verified = await parallel(blocks.map(f => () =>
      parallel(['correctness', 'exploitability', 'reproduce-from-code'].map(lens => () =>
        agent(`Lens: ${lens}. A reviewer (${sel.name}) claims a BLOCK: ${f.summary} at ${f.file}:${f.line ?? '?'} in project ${args.projectPath}. ` +
              `Try hard to REFUTE it by reading the actual code (read-only). If you cannot show it is wrong, refuted=false. Default to refuted=true if the claim is vague or unsupported.`,
              { label: `verify:${sel.name}:${f.file}`, phase: 'Verify', schema: VERDICT })))
        .then(votes => ({ ...f, agent: sel.name, refutations: votes.filter(Boolean).filter(v => v.refuted).length, votes: votes.filter(Boolean) }))
    ))
    return { agent: sel.name, blocks: verified, warns: report.findings.filter(f => f.severity === 'WARN'), passed: report.passed ?? [] }
  },
)

const all = results.filter(Boolean)
const confirmed = all.flatMap(r => r.blocks.filter(b => b.refutations < 2))
const dropped = all.flatMap(r => r.blocks.filter(b => b.refutations >= 2))
log(`BLOCK confirmed: ${confirmed.length}, refuted: ${dropped.length}, WARN: ${all.reduce((n, r) => n + r.warns.length, 0)}`)
return { confirmedBlocks: confirmed, refutedBlocks: dropped, warns: all.flatMap(r => r.warns.map(w => ({ ...w, agent: r.agent }))), agentsRun: all.map(r => r.agent) }
