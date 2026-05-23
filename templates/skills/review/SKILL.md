# /review — Code Review

Engine: Claude (via built-in review subagents)

## Trigger
- User says "review code", "check for issues", "审查代码"

## Execution

**Use Claude's built-in review subagents (in .claude/agents/) for parallel isolated review.**

1. Launch all 4 review subagents in parallel via Agent tool:
   - `security-reviewer` — injection, auth flaws, hardcoded secrets
   - `logic-reviewer` — edge cases, race conditions, resource leaks
   - `performance-reviewer` — N+1 queries, memory leaks, blocking ops
   - `api-reviewer` — naming, HTTP semantics, versioning, validation

2. Each subagent runs in isolated context, reads relevant code, writes findings

3. Collect results from all subagents

4. Summary: any BLOCK-level issue → fail, WARN/NOTE only → pass

For targeted review (e.g. "review security only"), launch only the relevant subagent.

After review, call verify-task with green/red signal if applicable.
