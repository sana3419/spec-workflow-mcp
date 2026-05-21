# /review — Code Review

Engine: Gemini (via ai_cli_run MCP)

## Trigger
- User says "review code", "check for issues", "审查代码"

## Execution

**Must dispatch via ai_cli_run. Never review code yourself.**

1. Get changed file list (names only, do NOT read content):
   ```bash
   git diff --name-only HEAD~1
   ```

2. Dispatch Gemini:
   ```
   ai_cli_run(
     model="gemini-2.5-pro",
     prompt="Review all changed files in this project. Read the files yourself.
     Check: security vulnerabilities, logic errors, performance issues, API contract violations.
     Classify each issue: BLOCK (must fix), WARN (should fix), NOTE (suggestion).
     Write your complete review report to .spec-workflow/reports/gemini-review-<YYYYMMDD-HHMMSS>.md
     Format: ## BLOCK / ## WARN / ## NOTE sections, each item: [file:line] description → fix suggestion.
     Project path: <path>"
   )
   ```

3. Wait: `ai_cli_wait(pid=<PID>)`

4. Read report from `.spec-workflow/reports/gemini-review-*.md`

5. Summary: BLOCK > 0 → fail, WARN/NOTE only → pass

Fallback: if ai_cli_run fails, execute review yourself and inform user.
After review, call verify-task with green/red signal.
