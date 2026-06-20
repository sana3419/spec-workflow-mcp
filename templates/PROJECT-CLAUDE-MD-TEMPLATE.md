# Project CLAUDE.md

Claude-led collaborative development framework. Claude plans, implements, reviews, and verifies; Codex is an auxiliary engine you offload specific coding tasks to (tasks tagged `_Engine: codex`).

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

Call `spec-workflow-guide` first to load the canonical 5-phase workflow (Requirements → Design → Tasks → Implementation → Research Report). Below are the engine extensions on top of that base flow.

**How to get approval** (applies to Phase 1–3): After creating each document, present it to the user (share the file path and a 1–2 sentence summary) and ask them to review and approve it in the chat. If the user approves, proceed to the next phase. If they request changes, update the document per their feedback and present it again. Proceed only after the user confirms.

### Implementation phase

**By default Claude implements each task itself** (write/edit code, run tests). Only tasks tagged
`_Engine: codex` are offloaded to Codex — use that for large, repetitive, or parallelizable work,
or to save Claude's context. The rest of this section describes the **Codex offload path**.

**Per-spec Codex session (efficiency + accuracy).** Each spec keeps ONE Codex session in
`.spec-workflow/specs/<spec>/.codex-thread` (plain text holding the threadId). Reuse it across the
spec's codex tasks so the worker keeps its context; only open a new session for a new/unrelated spec.

Decision before every Codex dispatch — read `.spec-workflow/specs/<spec>/.codex-thread`:
- **missing** (first task of this spec) → `mcp__codex__codex(prompt=..., sandbox=..., approval-policy=...)`, then write the returned threadId (from the tool result's `structuredContent.threadId`) to that file.
- **present** (later task in same spec, or a red→fix retry) → `mcp__codex__codex-reply(threadId=<file>, prompt=...)`.
- **reply fails** (stale thread) → fall back to `mcp__codex__codex(...)` and overwrite the file.

> Note: the Codex MCP interface is experimental — if `codex-reply` ever rejects `threadId`, re-check the current field name (it was `conversationId` in older Codex) and update `.codex-thread` handling.

`sandbox` / `approval-policy` / `model` come from `.spec-workflow/config.toml` `[engine.codex]`
(defaults: `workspace-write`, `never`). `spec-status` prints the exact dispatch hint with these filled in.

Per task — verify→fix closed loop:
1. `spec-status` → next pending task + dispatch hint (tells you the engine)
2. Edit `tasks.md`: `[ ]` → `[-]`
3. Implement:
   - **default (claude)** → write/edit the code yourself
   - **`_Engine: codex`** → dispatch via `codex` / `codex-reply` (per decision above); have Codex write a report to `.spec-workflow/reports/codex-<task>-<timestamp>.md`
4. Run tests → `verify-task`:
   - **green** → `log-implementation` → next task
   - **red** → if attempts < `maxFixAttempts`: fix (claude tasks: fix directly; codex tasks: `codex-reply(threadId, "tests failed: <log>, fix")`) and re-verify; else leave blocked
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
| Claude (default) | direct execution | Planning, implementation, review, verification, orchestration |
| Codex (auxiliary) | `mcp__codex__codex` / `codex-reply` | Offloaded coding for `_Engine: codex` tasks (large/repetitive/parallel) |

Default engine is set by `.spec-workflow/config.toml` `[engine] default` (= `claude`). Codex knobs (`sandbox` / `approvalPolicy` / `model`) live in `[engine.codex]`.

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

1. **Claude implements by default.** Write the code yourself unless a task is tagged `_Engine: codex` — only then offload it to Codex via `mcp__codex__codex` / `codex-reply`.
2. **For codex tasks, reuse the per-spec Codex session** — one `.codex-thread` per spec; `codex-reply` for follow-up codex tasks and red→fix retries, new `codex()` only for a new/unrelated spec. (Exception: `/tdd` parallel worktrees each start their own session.)
3. **When offloading to Codex, don't pre-read content** — tell Codex which files to read and to write its report to `.spec-workflow/reports/codex-<task>-<timestamp>.md`.
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
