# /qa — Systematic QA Testing

Engine: Codex (via `mcp__codex__codex` / `codex-reply`)

## Trigger
- User says "test", "QA", "run tests", "跑测试"

## Execution

**Must dispatch via `mcp__codex__codex` (or `codex-reply` to reuse the spec session). Never test code yourself.**

1. Collect test targets (file list only, do NOT read content):
   - Completed tasks from tasks.md
   - File names from Implementation Logs/

2. Decide session: read `.spec-workflow/specs/<spec>/.codex-thread` — reuse via `codex-reply(threadId, ...)`, else `codex(...)` and save the returned threadId. Dispatch Codex to:
   - Find and run existing tests (npm test / pytest / go test)
   - Test API endpoints from Implementation Logs
   - Fix bugs found, re-run tests, commit atomically: `git commit -m "fix: <desc>"`
   - Write QA report to `.spec-workflow/reports/codex-qa-<YYYYMMDD-HHMMSS>.md`, ending with a structured summary block

3. Read report from `.spec-workflow/reports/codex-qa-*.md`

4. For each related task, call verify-task to update status

Fallback: if the codex MCP server is unavailable, execute QA yourself and inform user.
