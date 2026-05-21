# /qa — Systematic QA Testing

Engine: DeepSeek (via mcp__deepseek__* MCP tools)

## Trigger
- User says "test", "QA", "run tests", "跑测试"

## Execution

**Must dispatch via mcp__deepseek__* tools. Never test code yourself.**

1. Collect test targets (file list only, do NOT read content):
   - Completed tasks from tasks.md
   - File names from Implementation Logs/

2. Dispatch DeepSeek via MCP tools to:
   - Find and run existing tests (npm test / pytest / go test)
   - Test API endpoints from Implementation Logs
   - Fix bugs found, re-run tests, commit atomically: `git commit -m "fix: <desc>"`
   - Write QA report to `.spec-workflow/reports/deepseek-qa-<YYYYMMDD-HHMMSS>.md`

3. Read report from `.spec-workflow/reports/deepseek-qa-*.md`

4. For each related task, call verify-task to update status

Fallback: if DeepSeek MCP unavailable, execute QA yourself and inform user.
