# /review — Code Review

Engine: Claude (subagents + MCP verification)

## Trigger
- User says "review code", "check for issues", "审查代码", "全面审查"

## Execution

### Phase 1: Subagent Review (parallel)

Launch all 4 review subagents in parallel via the subagent tool (Task):
- `security-reviewer` — injection, auth flaws, hardcoded secrets
- `logic-reviewer` — edge cases, race conditions, resource leaks
- `performance-reviewer` — N+1 queries, memory leaks, blocking ops
- `api-reviewer` — naming, HTTP semantics, versioning, validation

Each subagent writes report to `.spec-workflow/reports/agent-<type>-<YYYYMMDD-HHMMSS>.md`

### Phase 2: MCP Verification (main context)

After subagents complete, run MCP-based verification in main context. Use the REAL tool names below.

1. **code-review-graph** (if available): build/update the graph, then pull structured review context
   ```
   mcp__code-review-graph__build_or_update_graph_tool()                      # build/update graph first
   mcp__code-review-graph__get_review_context_tool(changed_files=<changed files>)
   mcp__code-review-graph__get_impact_radius_tool(changed_files=<changed files>)
   # targeted structural query (pattern + target both required):
   # mcp__code-review-graph__query_graph_tool(pattern="<regex>", target="function|class|file")
   ```

2. **gitnexus** (if available): dependency impact of changed symbols/files
   ```
   mcp__gitnexus__impact(target="<changed file or symbol>", direction="both")
   mcp__gitnexus__query(query="<natural-language dependency question>")
   ```

3. If MCP tools are unavailable (or the graph/index was never built), skip this phase (subagent results are sufficient).

### Phase 3: Consolidate

1. Read all subagent reports from `.spec-workflow/reports/agent-*.md`
2. Merge with MCP verification findings
3. Deduplicate and classify: BLOCK / WARN / NOTE
4. Output consolidated review report

Summary: any BLOCK → fail, WARN/NOTE only → pass.

For targeted review (e.g. "review security only"), launch only the relevant subagent + skip MCP phase.

After review, call verify-task with green/red signal if applicable.
