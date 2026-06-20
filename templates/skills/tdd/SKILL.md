# /tdd — Test-Driven Development

Engine: Codex (via `mcp__codex__codex` / `codex-reply`)

Inspired by Superpowers framework TDD discipline.

## Trigger
- User says "use TDD", "write tests first", "用 TDD 写"

## Execution

**Must dispatch via `mcp__codex__codex` (or `codex-reply` to reuse the spec session). Never write code yourself.**

### Single Task TDD

Decide session: read `.spec-workflow/specs/<spec>/.codex-thread` — reuse via `codex-reply(threadId, ...)`, else `codex(...)` and save the returned threadId. Dispatch Codex to execute strict Red-Green-Refactor:
- RED: Write failing test first, run to confirm failure
- GREEN: Write minimum code to pass test
- REFACTOR: Clean up without changing behavior, confirm tests still pass
- Commit: `git add -A && git commit -m "feat: <desc>"`
- One test case at a time

### Parallel Tasks (Subagent Worktree Mode)

For parallelizable tasks, use the subagent tool (Task) to launch subagents in git worktrees.
Note: parallel worktrees are independent, so each subagent starts its OWN Codex
session (`codex(...)`) rather than sharing the spec thread.

1. Create worktree:
   ```bash
   git worktree add .worktrees/task-1 -b feat/task-1
   ```

2. Launch a subagent (via the Task tool) in the worktree directory, instruct it to dispatch Codex via `mcp__codex__codex` for TDD

3. After completion, merge:
   ```bash
   git merge feat/task-1
   git worktree remove .worktrees/task-1
   ```

## After TDD

All tests pass → call verify-task signal=green
Any test fails → call verify-task signal=red with failure details

Fallback: if the codex MCP server is unavailable, execute TDD yourself and inform user.
