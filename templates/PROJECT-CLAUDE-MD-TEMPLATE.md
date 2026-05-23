# Project CLAUDE.md

## MCP Tools

### spec-workflow-mcp (Workflow Management)
- `spec-workflow-guide` — Load workflow guide (call first each session)
- `steering-guide` — Create project steering docs
- `spec-status` — Progress + next task engine suggestion
- `approvals` — Approval workflow (request/status/delete)
- `log-implementation` — Record implementation logs and artifacts
- `verify-task` — Traffic-light verification (green/red signal)

### ai-cli-mcp (Multi-Engine Dispatch)
- `ai_cli_run` — Launch engine (DeepSeek/Gemini/Codex) in background, returns PID
- `ai_cli_wait` — Wait for engine completion, return result
- `ai_cli_peek` — Check engine progress
- `ai_cli_get_result` — Get engine result
- `ai_cli_doctor` — Check engine CLI availability

## Multi-Engine Dispatch

### IMPORTANT: Must dispatch via MCP tools, never execute yourself

When a task has `_Engine:` field or user requests a specific engine, **you MUST use MCP tools** to dispatch. Never execute the task yourself. Never call CLI via Bash.

| Engine | Dispatch Method | Purpose |
|--------|----------------|---------|
| DeepSeek (default) | `ai_cli_run(model="oc-deepseek/deepseek-v4-pro")` | Coding, refactoring, bug fixes |
| Gemini | `ai_cli_run(model="gemini-2.5-pro")` | Large-scale code/doc reading, codebase research, file analysis (free tier, large context) |
| Codex | `ai_cli_run(model="gpt-5.4")` | Image generation, SVG to polished images |
| Claude | Execute directly (no dispatch needed) | Planning, task decomposition, verification |

### IMPORTANT: Use Gemini for large-scale reading

When you need to read large codebases, documentation, or many files for research, **dispatch to Gemini** instead of reading files yourself or using Agent subagents. Gemini has a large free context window — use it to save Claude tokens. Tell Gemini what to read and where to write its summary report.

### IMPORTANT: Never pre-read content before dispatching

Do NOT use Read tool, cat, grep, git diff, or any method to load file content into your context before passing to an engine. Instead, instruct the engine to read files itself and **write a structured report to a designated path**.

Dispatch pattern:
```
1. Tell the engine WHAT to do, WHICH files to read, and WHERE to write its report
2. Engine reads files, executes task, writes report to .spec-workflow/reports/<engine>-<task>-<timestamp>.md
3. You read the report file to get results
```

Example — dispatching Gemini for code review:
```
ai_cli_run(
  model="gemini-2.5-pro",
  prompt="Review all changed files in this project for security vulnerabilities, logic errors, and performance issues. Read the files yourself. Write your complete review report to .spec-workflow/reports/gemini-review-20260521.md with sections: ## BLOCK, ## WARN, ## NOTE. Project path: /path/to/project"
)
```

Example — dispatching DeepSeek for coding:
```
ai_cli_run(
  model="oc-deepseek/deepseek-v4-pro",
  prompt="Implement the user login endpoint with JWT authentication. Read src/auth/ for existing patterns. Write implementation and update tests. Project path: /path/to/project"
)
```

## Workflow

### Phase 1: Planning (Claude executes directly, approval required)
1. Call `spec-workflow-guide` to load workflow
2. Write `requirements.md` → submit for approval → wait for approval (see below)
   - Once approved → proceed to step 3. If rejected → revise and resubmit.
3. Write `design.md` (based on approved requirements) → submit for approval → wait
   - Once approved → proceed to step 4. If rejected → revise and resubmit.
4. Write `tasks.md` (mark `_Engine:` per task, based on approved design) → submit for approval → wait
   - Once approved → proceed to Phase 2. If rejected → revise and resubmit.

**How to wait for approval**: After submitting (you get back an `approvalId`), launch a background poller that watches the approval JSON file directly:
```
Bash(run_in_background=true):
APPROVAL_DIR=".spec-workflow/approvals"
APPROVAL_ID="<approvalId>"
while true; do
  FILE=$(find "$APPROVAL_DIR" -name "${APPROVAL_ID}.json" 2>/dev/null | head -1)
  if [ -n "$FILE" ]; then
    STATUS=$(jq -r '.status' "$FILE" 2>/dev/null)
    if [ "$STATUS" != "pending" ]; then echo "APPROVAL_RESULT:$STATUS"; exit 0; fi
  fi
  sleep 15
done
```
You will be notified when the background task completes with `APPROVAL_RESULT:approved` or `APPROVAL_RESULT:rejected`. Then continue or revise accordingly. Do NOT auto-cancel.

### Phase 2: Implementation (task loop, NO approval needed)
1. Call `spec-status` → get next pending task + engine suggestion
2. Edit `tasks.md`: `[ ]` → `[-]` to mark started
3. Dispatch coding to DeepSeek via `ai_cli_run(model="oc-deepseek/deepseek-v4-pro")`
4. Read engine's report from `.spec-workflow/reports/` or get result via `ai_cli_wait`
5. Run tests to verify
6. Call `verify-task`:
   - `signal: "green"` → auto-marks `[x]`, then call `log-implementation`
   - `signal: "red"` → record failure, fix and retry (auto-blocked after maxFixAttempts)
7. Call `log-implementation` to record artifacts
8. Continue to next task — no approval needed between tasks

### Phase 3: Research Report (optional)
After all tasks complete:
1. Claude writes Markdown report (`docs/report/report.md`)
2. Claude generates SVG diagrams → `docs/report/svg/`
3. Dispatch Codex: `ai_cli_run(model="gpt-5.4", prompt="Convert SVG files in docs/report/svg/ to polished PNG images. Save to docs/report/images/. Use creative visual style.")`
4. Run `python3 <spec-workflow-mcp>/tools/gen-report.py docs/report/report.md -o docs/report/report.docx --images docs/report/images/`

Markdown report format:
```
# Title                         → Paper title (centered, bold)
Author: xxx  Advisor: xxx       → Author line
Abstract: xxx                   → Abstract
Keywords: xxx                   → Keywords
## 1. Introduction              → Level 1 heading
### 1.1 xxx                     → Level 2 heading
#### 1.1.1 xxx                  → Level 3 heading
Body text                       → Normal paragraph
![Caption](path)                → Image + caption
| Header | ...                  → Table
[1] Reference...                → Reference
```

## Skills (4, from GStack + Superpowers)

Built-in skills in `.claude/skills/`, dispatch to engines via MCP:

| Skill | Engine | Dispatch | Purpose |
|-------|--------|----------|---------|
| `/review` | Gemini | `ai_cli_run(model="gemini-2.5-pro")` | Code review: security, logic, performance |
| `/qa` | DeepSeek | `ai_cli_run(model="oc-deepseek/deepseek-v4-pro")` | Systematic QA testing + atomic fixes |
| `/design-review` | Claude | Execute directly | Visual/interaction audit (multimodal) |
| `/tdd` | DeepSeek | `ai_cli_run(model="oc-deepseek/deepseek-v4-pro")` | TDD red-green-refactor + worktree isolation |

## Review Subagents (4, parallel isolated context)

In `.claude/agents/`, run in isolated context:

| Agent | Focus |
|-------|-------|
| `security-reviewer` | Injection, auth flaws, hardcoded secrets, CVE |
| `logic-reviewer` | Edge cases, race conditions, resource leaks |
| `performance-reviewer` | N+1 queries, memory leaks, blocking ops |
| `api-reviewer` | Naming, HTTP semantics, versioning, validation |

Usage: "Run security review with subagent" or "Full review" (launches all 4 in parallel).

### Fault Handling
- Blocked tasks: drag back to pending on dashboard to retry
- Task auto-blocked after `maxFixAttempts` failures

## Rules

1. **IMPORTANT: Dispatch coding tasks via MCP** — All coding/implementation tasks MUST be dispatched via `ai_cli_run(model="oc-deepseek/deepseek-v4-pro")` by default. Never write implementation code yourself. Exception: `_Engine: claude` explicitly set, OR the task is planning/verification/documentation (non-coding) → execute directly.
2. **IMPORTANT: Never pre-read content** — Do not load file content into your context before dispatching. Tell the engine to read files and write a report to `.spec-workflow/reports/<engine>-<task>-<timestamp>.md`. Read the report afterward.
3. **IMPORTANT: All prompts to external engines MUST be in English** — When dispatching tasks via `ai_cli_run`, the prompt parameter MUST be written in English, even if the user speaks Chinese. External engines perform better with English prompts. User-facing output can remain in the user's language.
4. **Call `spec-workflow-guide` first** each new session
5. **Read before write** — understand existing code before modifying
6. **verify-task is mandatory** — every task must pass verification
7. **log-implementation is mandatory** — record after verify-task green
8. **No scope creep** — only implement what the task describes
9. **Approval only in Phase 1** — only planning documents (requirements/design/tasks) need approval. Implementation (Phase 2) does NOT need approval — just code, verify, and continue.
10. **Non-blocking approval** — after submitting an approval, do NOT wait idle. Continue writing the next document immediately. Poll status every 30s in background. If rejected, revise and resubmit. If all Phase 1 docs approved, proceed to Phase 2. After 10 minutes pending, ask the user.

## Engine Report Convention

All engine outputs should be written to `.spec-workflow/reports/` with naming:
```
.spec-workflow/reports/
├── gemini-review-20260521-143022.md      # Gemini code review
├── deepseek-impl-task1-20260521-150000.md # DeepSeek implementation log
├── codex-images-20260521-160000.md        # Codex image generation log
└── ...
```

Format: `<engine>-<type>-<identifier>-<YYYYMMDD-HHMMSS>.md`

## File Structure

```
.spec-workflow/
├── config.toml              # Engine config
├── steering/                # Project steering (optional)
├── specs/{spec-name}/
│   ├── requirements.md
│   ├── design.md
│   ├── tasks.md             # With _Engine fields
│   ├── Implementation Logs/
│   └── verify-results/
├── reports/                 # Engine output reports (auto-generated)
├── usage-log.json           # Multi-engine usage tracking (auto)
├── session-usage.json       # Session usage tracking (statusline auto)
└── approvals/
docs/report/                 # Research report (optional)
├── report.md
├── svg/
└── images/
```
