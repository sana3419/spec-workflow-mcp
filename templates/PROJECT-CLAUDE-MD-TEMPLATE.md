# Project CLAUDE.md

Codex-powered collaborative development framework. Claude orchestrates, Codex executes coding.

## MCP Tools

| Server | Tool | Purpose |
|--------|------|---------|
| spec-workflow-mcp | `spec-workflow-guide` | Load workflow guide (call first each session) |
| | `steering-guide` | Create project steering docs |
| | `spec-status` | Progress + next-task dispatch hint |
| | `verify-task` | Traffic-light verification (green/red signal) |
| | `log-implementation` | Record implementation logs and artifacts |
| codex | `mcp__codex__codex` | Start a new Codex session; returns a `threadId` |
| | `mcp__codex__codex-reply` | Continue an existing Codex session by `threadId` |

## Workflow

Call `spec-workflow-guide` first to load the canonical 5-phase workflow (Requirements → Design → Tasks → Implementation → Research Report). Below are the multi-engine extensions on top of that base flow.

**How to get approval** (applies to Phase 1–3): After creating each document, present it to the user (share the file path and a 1–2 sentence summary) and ask them to review and approve it in the chat. If the user approves, proceed to the next phase. If they request changes, update the document per their feedback and present it again. Proceed only after the user confirms.

### Implementation phase: dispatch coding to Codex

**Per-spec session (efficiency + accuracy).** Each spec keeps ONE Codex session in
`.spec-workflow/specs/<spec>/.codex-thread` (plain text holding the threadId). Reuse it across the
spec's tasks so the worker keeps its context; only open a new session for a new/unrelated spec.

Decision before every dispatch — read `.spec-workflow/specs/<spec>/.codex-thread`:
- **missing** (first task of this spec) → `mcp__codex__codex(prompt=..., sandbox=..., approval-policy=...)`, then write the returned threadId (from the tool result's `structuredContent.threadId`) to that file.
- **present** (later task in same spec, or a red→fix retry) → `mcp__codex__codex-reply(threadId=<file>, prompt=...)`.
- **reply fails** (stale thread) → fall back to `mcp__codex__codex(...)` and overwrite the file.

> Note: the Codex MCP interface is experimental — if `codex-reply` ever rejects `threadId`, re-check the current field name (it was `conversationId` in older Codex) and update `.codex-thread` handling.

`sandbox` / `approval-policy` / `model` come from `.spec-workflow/config.toml` `[engine.codex]`
(defaults: `workspace-write`, `never`). `spec-status` prints the exact dispatch hint with these filled in.

Per task — autonomous loop with verify→fix closed loop:
1. `spec-status` → next pending task + dispatch hint
2. Edit `tasks.md`: `[ ]` → `[-]`
3. Dispatch via `codex` / `codex-reply` (per decision above) — tell Codex WHAT to do, WHICH files to read/edit, and to write a report to `.spec-workflow/reports/codex-<task>-<timestamp>.md` ending with a structured summary block. **Never write the implementation code yourself.**
4. Read the report → run tests → `verify-task`:
   - **green** → `log-implementation` (record the threadId) → next task
   - **red** → if attempts < `maxFixAttempts`: `codex-reply(threadId, "tests failed: <log>, fix")` and re-verify; else leave blocked
5. Next task — no approval needed between tasks

**Loop mode** (the canonical algorithm lives in `spec-workflow-guide` — call it first; this is the operational summary):
- **autoLoop = false** (default): you drive the loop until all tasks are `[x]`/`[~]`.
- **autoLoop = true**: a Stop hook keeps you in Phase 4. At the start of implementation, read `[loop].autoLoop` from `.spec-workflow/config.toml`; if `true`, `echo "<spec-name>" > .spec-workflow/.autoloop-active` (bare slug). When all tasks are `[x]`/`[~]`, `rm -f .spec-workflow/.autoloop-active` to release the loop. (Hook safety: `maxIterations` + `noProgressStop`, audit in `.spec-workflow/loop-audit.log`. Requires the hook installed via `init.sh --auto-loop`.)

### Research Report phase (optional)
1. Claude writes Markdown report → `docs/report/report.md`
2. Claude generates SVG diagrams → `docs/report/svg/`
3. Convert: `for f in docs/report/svg/*.svg; do rsvg-convert -w 1200 "$f" -o "docs/report/images/$(basename "$f" .svg).png"; done`
4. Generate docx: `python3 $SPEC_WORKFLOW_HOME/tools/gen-report.py docs/report/report.md -o docs/report/report.docx --images docs/report/images/`

## Engines

| Engine | How | Purpose |
|--------|-----|---------|
| Codex (default) | `mcp__codex__codex` / `codex-reply` | Coding, refactoring, bug fixes |
| Claude | (direct execution) | Planning, verification, orchestration |

Codex knobs (`sandbox` / `approvalPolicy` / `model`) live in `.spec-workflow/config.toml` `[engine.codex]`.

## Skills (auto-installed to .claude/skills/)

| Skill | Engine | Purpose |
|-------|--------|---------|
| `/review` | Claude | Launches 4 review subagents in parallel (security, logic, performance, API) |
| `/qa` | Codex | Systematic QA testing + atomic fixes |
| `/design-review` | Claude | Visual/interaction audit (multimodal) |
| `/tdd` | Codex | TDD red-green-refactor + worktree isolation |

## Subagents (auto-installed to .claude/agents/)

| Agent | Focus |
|-------|-------|
| `security-reviewer` | Injection, auth flaws, hardcoded secrets, CVE |
| `logic-reviewer` | Edge cases, race conditions, resource leaks |
| `performance-reviewer` | N+1 queries, memory leaks, blocking ops |
| `api-reviewer` | Naming, HTTP semantics, versioning, validation |

## Rules

1. **IMPORTANT: Dispatch coding via `mcp__codex__codex` / `codex-reply`** — never write implementation code yourself. Exception: `_Engine: claude` or non-coding tasks.
2. **Reuse the per-spec Codex session** — one `.codex-thread` per spec; `codex-reply` for follow-up tasks and red→fix retries, new `codex()` only for a new/unrelated spec. (Exception: `/tdd` parallel worktrees each start their own session.)
3. **Never pre-read content before dispatching** — tell Codex which files to read and to write its report to `.spec-workflow/reports/codex-<task>-<timestamp>.md`.
4. All prompts to Codex MUST be in English.
5. Call `spec-workflow-guide` first each new session.
6. `verify-task` + `log-implementation` are mandatory for every task; the red→fix loop is bounded by `maxFixAttempts`.
7. Approval is in-conversation: present each Phase 1–3 document to the user and proceed only after they confirm approval in chat.

## File Structure

```
.spec-workflow/
├── config.toml              # Engine config
├── steering/                # Project steering (optional)
├── specs/{spec-name}/
│   ├── requirements.md / design.md / tasks.md
│   ├── .codex-thread        # Per-spec Codex session threadId (for reuse)
│   ├── Implementation Logs/
│   └── verify-results/
├── reports/                 # Codex output: codex-<task>-<YYYYMMDD-HHMMSS>.md
├── usage-log.json
└── session-usage.json
docs/report/                 # Research report (optional)
├── report.md / svg/ / images/
```
