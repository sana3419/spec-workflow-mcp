# /review — Code Review

Engine: Claude (routed subagents + MCP verification)

## Trigger
- User says "review code", "check for issues", "审查代码", "全面审查"

## Execution

### Phase 0: Route (deterministic — no guessing which reviewers to run)

Call `mcp__spec-workflow__review-route` first. It reads the reviewer agents' own frontmatter
(`.claude/agents/*.md`: tier / tags / triggers), the project profile and the diff, and returns the
agents to launch **with a reason each**. Defaults: Tier 0 always (`security-reviewer`,
`logic-reviewer`, `performance-reviewer`, `api-reviewer`, `test-adequacy-judge`, `spec-drift-detector`);
Tier 1 lenses (concurrency, error-handling, data-migration, backward-compat, dependency-license,
config-secrets, observability, i18n, accessibility, ux-copy, cost, architecture) when a changed path or an
added diff line matches their triggers; Tier 2 (spec docs), Tier 3 (language/stack), Tier 4 (infra), Tier 5 (LLM apps) likewise; cap 10.

Map what the user said onto the tool arguments:
- "review" / "全面审查"                → `{}` (working-tree diff) or `{ base: "HEAD~1" }` for the last commit
- "review security only" / a list       → `{ agents: ["security-reviewer"] }`
- "also check i18n" / "skip perf"        → `{ add: [...] }` / `{ skip: [...] }`
- "everything" / "full review"           → `{ full: true }`
- a task with `_Review: security, concurrency` → `{ tags: ["security","concurrency"] }`
- "what would you run?" (dry run)        → call the tool and STOP — print the selection + reasons only

Show the user the selected list + reasons in one line each before launching (they can adjust).

### Phase 1: Subagent Review (parallel)

Launch **exactly** the routed agents in parallel via the Agent tool (one call per name, `subagent_type`
= the agent name). Give each: the changed file list, the base ref, the spec name if any, and the
instruction to write its report to `.spec-workflow/reports/agent-<name>-<YYYYMMDD-HHMMSS>.md`.
Reviewers are read-only lenses (Read/Grep/Glob/Bash) — never let one edit files.

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

1. Read all subagent reports from `.spec-workflow/reports/agent-*.md` (only this run's timestamps)
2. Merge with MCP verification findings
3. Deduplicate and classify: BLOCK / WARN / NOTE
4. Output consolidated review report

Summary: any BLOCK → fail, WARN/NOTE only → pass.

For targeted review the router already narrowed the set; skip the MCP phase when only 1–2 agents ran.
If `test-adequacy-judge` ends with `VERDICT: fail`, treat that as a BLOCK on the tests, not the code.

After review, call verify-task with green/red signal if applicable.
