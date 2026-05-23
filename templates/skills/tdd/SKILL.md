# /tdd — Test-Driven Development

Engine: DeepSeek (via ai_cli_run)

Inspired by Superpowers framework TDD discipline.

## Trigger
- User says "use TDD", "write tests first", "用 TDD 写"

## Execution

**Must dispatch via ai_cli_run(model="oc-deepseek/deepseek-v4-pro"). Never write code yourself.**

### Single Task TDD

Dispatch DeepSeek via ai_cli_run to execute strict Red-Green-Refactor:
- RED: Write failing test first, run to confirm failure
- GREEN: Write minimum code to pass test
- REFACTOR: Clean up without changing behavior, confirm tests still pass
- Commit: `git add -A && git commit -m "feat: <desc>"`
- One test case at a time

### Parallel Tasks (Subagent Worktree Mode)

For parallelizable tasks, use Agent tool to launch subagents in git worktrees:

1. Create worktree:
   ```bash
   git worktree add .worktrees/task-1 -b feat/task-1
   ```

2. Launch subagent (via Agent tool) in worktree directory, instruct it to dispatch DeepSeek via ai_cli_run for TDD

3. After completion, merge:
   ```bash
   git merge feat/task-1
   git worktree remove .worktrees/task-1
   ```

## After TDD

All tests pass → call verify-task signal=green
Any test fails → call verify-task signal=red with failure details

Fallback: if ai-cli-mcp unavailable, execute TDD yourself and inform user.
