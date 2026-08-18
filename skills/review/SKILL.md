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
added diff line matches their triggers; Tier 2 (spec docs), Tier 3 (language/stack), Tier 4 (infra), Tier 5 (LLM apps) likewise; cap 12.

Map what the user said onto the tool arguments:
- "review" / "全面审查"                → `{}` (working-tree diff) or `{ base: "HEAD~1" }` for the last commit
- "review security only" / a list       → `{ agents: ["security-reviewer"] }`
- "also check i18n" / "skip perf"        → `{ add: [...] }` / `{ skip: [...] }`
- "everything" / "full review"           → `{ full: true }`
- a task with `_Review: security, concurrency` → `{ tags: ["security","concurrency"] }`
- "what would you run?" (dry run)        → call the tool and STOP — print the selection + reasons only

Show the user the selected list + reasons in one line each **and the cost preview** ("N reviewers in parallel, ~N×30–80k tokens, a few minutes") before launching; they can say "skip X", "only X", "full". Silencing permanently: `.spec-workflow/review.config.json` `{ "never": ["i18n-reviewer"] }`.

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

### Phase 3: Consolidate — the ONLY thing most users read

1. Read all subagent reports from `.spec-workflow/reports/agent-*.md` (only this run's timestamps)
2. Merge with MCP verification findings
3. **Deduplicate across agents**: same `file:line` (±3 lines) or the same root cause reported by several lenses →
   ONE entry, keep the highest severity, list the lenses that agreed (`[security, config-secrets, shell]`).
   A finding under an agent's `## PRE-EXISTING (info)` heading (untouched lines) never becomes BLOCK/WARN.
4. Output the consolidated report in EXACTLY this shape — first lines first, details last:

```
VERDICT: safe-to-merge | fix-first | blocked
<one paragraph, plain language, no jargon: what this change does, what's wrong (if anything), what to do next>

Roll-up: N BLOCK · M WARN · K pre-existing (info) — from R reviewers (list)

## BLOCK
- [file:line] one line · why it matters · fix · agreed by [lenses]
## WARN
- ...
## PRE-EXISTING (info)
- ... (short; not caused by this change)
## What was checked and found clean
- one line per reviewer (their PASSED sections, condensed)
<details per agent collapsed / linked to report files>
```

`blocked` = any confirmed BLOCK; `fix-first` = WARN only that a maintainer would want before merge;
`safe-to-merge` = nothing above pre-existing/info. If `test-adequacy-judge` returned `VERDICT: fail`, the
overall verdict is at least `fix-first` and the paragraph must say the *tests* (not the code) are the gap.
Write the consolidated report to `.spec-workflow/reports/review-<YYYYMMDD-HHMMSS>.md` too.

For targeted review the router already narrowed the set; skip the MCP phase when only 1–2 agents ran.
If `test-adequacy-judge` ends with `VERDICT: fail`, treat that as a BLOCK on the tests, not the code.

After review, call verify-task with green/red signal if applicable.
