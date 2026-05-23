# /review — Code Review

Engine: Claude (subagents + MCP verification)

## Trigger
- User says "review code", "check for issues", "审查代码", "全面审查"

## Execution

### Phase 1: Subagent Review (parallel)

Launch all 4 review subagents in parallel via Agent tool:
- `security-reviewer` — injection, auth flaws, hardcoded secrets
- `logic-reviewer` — edge cases, race conditions, resource leaks
- `performance-reviewer` — N+1 queries, memory leaks, blocking ops
- `api-reviewer` — naming, HTTP semantics, versioning, validation

Each subagent writes report to `.spec-workflow/reports/agent-<type>-<YYYYMMDD-HHMMSS>.md`

### Phase 2: MCP Verification (main context)

After subagents complete, run MCP-based verification in main context:

1. **code-review-graph** (if available): Build/query knowledge graph for structural issues
   ```
   mcp__code-review-graph__build_graph()
   mcp__code-review-graph__query_graph(query="find unused exports, circular dependencies, dead code")
   ```

2. **gitnexus** (if available): Analyze dependency impact
   ```
   mcp__gitnexus__analyze_dependencies()
   mcp__gitnexus__find_impact(files=<changed files>)
   ```

3. If MCP tools are unavailable, skip this phase (subagent results are sufficient).

### Phase 3: Consolidate

1. Read all subagent reports from `.spec-workflow/reports/agent-*.md`
2. Merge with MCP verification findings
3. Deduplicate and classify: BLOCK / WARN / NOTE
4. Output consolidated review report

Summary: any BLOCK → fail, WARN/NOTE only → pass.

For targeted review (e.g. "review security only"), launch only the relevant subagent + skip MCP phase.

After review, call verify-task with green/red signal if applicable.
