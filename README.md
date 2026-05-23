# Spec Workflow MCP — Multi-Engine Collaborative Development Framework

[中文文档](README.zh.md)

A multi-engine collaborative development framework built on [Pimzino/spec-workflow-mcp](https://github.com/Pimzino/spec-workflow-mcp). Claude Code serves as the orchestrator, dispatching tasks to DeepSeek / Gemini / Codex / Claude engines with traffic-light verification and academic report generation.

## Inspiration

| Source | Contribution |
|--------|-------------|
| [Pimzino/spec-workflow-mcp](https://github.com/Pimzino/spec-workflow-mcp) | Core framework: Requirements → Design → Tasks → Implementation, Dashboard, approval system |
| [auto-claude](../auto-claude/) | Traffic-light verification (green/red signal), progress tracking |
| [garrytan/gstack](https://github.com/garrytan/gstack) | Role-based skills: /review, /qa, /design-review |
| [obra/superpowers](https://github.com/obra/superpowers) | TDD red-green-refactor discipline, subagent worktree isolation |
| [code-review-graph](https://github.com/tirth8205/code-review-graph) / [GitNexus](https://github.com/abhigyanpatwari/GitNexus) / [Understand-Anything](https://github.com/Lum1104/Understand-Anything) | Optional code intelligence MCP (knowledge graph, dependency analysis, visualization) |

## Quick Start

### 1. Clone and Build

```bash
git clone https://github.com/sana3419/spec-workflow-mcp.git
cd spec-workflow-mcp
npm install && npm run build
```

### 2. Initialize a New Project

```bash
bash templates/init.sh /path/to/your-project
```

This runs 10 automated steps:

| Step | Action |
|------|--------|
| 1 | Create project directory |
| 2 | Create `.spec-workflow/` structure |
| 3 | Write `config.toml` engine config |
| 4 | Copy `CLAUDE.md` workflow template |
| 5 | Copy skills (review/qa/design-review/tdd) |
| 6 | Deploy statusline.sh to `~/.claude/` |
| 7 | Create project `.claude/settings.json` |
| 8 | Configure code intelligence MCP (optional) |
| 9 | Configure spec-workflow-mcp as MCP server |
| 10 | Check tool dependencies |

Optional flags (step 8):
```bash
bash templates/init.sh /path --with-graph       # code-review-graph (save tokens)
bash templates/init.sh /path --with-nexus       # GitNexus (dependency analysis)
bash templates/init.sh /path --with-understand  # Understand-Anything (visualization)
bash templates/init.sh /path --with-all         # Install all three
```

### 3. Start

```bash
cd /path/to/your-project && claude
```

Recommended steps after entering Claude Code:

```
1. Describe your requirements (e.g., "Build a user auth system")
2. Claude auto-calls spec-workflow-guide → starts planning
3. Approve each phase document on Dashboard (localhost:5000)
4. Claude executes tasks one by one — watch progress on Kanban board
5. Optionally generate a research report when all tasks complete
```

### MCP Tool Usage

MCP tools are called automatically during conversation. You can also trigger them manually:

```
"Show progress for user-auth"       → spec-status
"Approve the document"              → approvals action:request
"Tests passed"                      → verify-task signal:green
"Tests failed, error: xxx"          → verify-task signal:red
"Use /review to check the code"     → auto-calls gemini CLI for review
"Use /tdd to develop this feature"  → auto-calls deepseek CLI for TDD
"Run /qa on the project"            → auto-calls deepseek CLI for QA testing
"Check the UI"                      → Claude runs visual audit directly (multimodal)
```

Dashboard commands:
```
Start Dashboard:  node <spec-workflow-mcp>/dist/index.js --dashboard
URL:              http://localhost:5000
Approve docs:     Approvals page → approve/reject/request changes
Edit specs:       Specs page → edit Markdown directly
View progress:    Tasks page → Kanban board
Recover blocked:  Drag blocked tasks back to pending column
```

## Workflow

```
Phase 1  Claude plans
         ├── spec-workflow-guide → load workflow
         ├── requirements.md → dashboard approval
         ├── design.md       → dashboard approval
         └── tasks.md        → _Engine per task → dashboard approval

Phase 2  Execute tasks (loop)
         ├── spec-status → next task + engine hint + dispatch command
         ├── Edit tasks.md: [ ] → [-]
         ├── Dispatch to engine (deepseek/gemini/codex/claude)
         ├── Run tests → verify-task green/red
         │   ├── green → auto-mark [x], call log-implementation
         │   └── red → fix & retry, blocked after maxFixAttempts
         └── Continue next task

Phase 3  Complete / Report (optional)
         ├── Claude writes Markdown report + SVG diagrams
         ├── Codex converts SVGs to polished images
         └── gen-report.py → academic docx
```

## Four Engines

| Engine | Purpose | Invocation |
|--------|---------|------------|
| `deepseek` (default) | Coding, refactoring, bug fixes | `ai_cli_run(model="oc-deepseek/deepseek-v4-pro")` |
| `gemini` | Code review, codebase browsing (free) | `gemini -p "..."` |
| `codex` | SVG → polished images (report phase) | `codex -p "..."` |
| `claude` | Planning, task decomposition, verification | Direct (orchestrator) |

## MCP Tools (6)

| Tool | Purpose |
|------|---------|
| `spec-workflow-guide` | Full workflow guide (call first each session) |
| `steering-guide` | Project steering documents |
| `spec-status` | Progress + next task engine suggestion + dispatch command |
| `approvals` | Approval workflow (request/status/delete) |
| `verify-task` | Traffic-light verification (green→done, red→fix/blocked) |
| `log-implementation` | Record implementation logs and artifacts (knowledge base) |

## Review Subagents (4, parallel isolated context)

Auto-installed to `.claude/agents/` during project init. Run in isolated context — won't pollute main conversation:

| Agent | Focus | Available MCP |
|-------|-------|---------------|
| `security-reviewer` | Injection, auth flaws, hardcoded secrets, CVE | code-review-graph, gitnexus |
| `logic-reviewer` | Edge cases, race conditions, resource leaks | code-review-graph, gitnexus |
| `performance-reviewer` | N+1 queries, memory leaks, blocking ops | code-review-graph, gitnexus |
| `api-reviewer` | Naming, HTTP semantics, versioning, validation | code-review-graph, gitnexus |

Usage:
```
"Use a subagent to review security"     → launches security-reviewer
"Do a full review"                      → launches all 4 in parallel
"Check for performance issues"          → launches performance-reviewer
```

Subagents auto-leverage code-review-graph / gitnexus knowledge graphs (if installed) to read only relevant code, saving tokens.

## Skills (4, from GStack + Superpowers)

Auto-installed to `.claude/skills/` during project init:

| Skill | Engine | Purpose | Source |
|-------|--------|---------|--------|
| `/review` | gemini | Auto-calls gemini CLI for code review (security, logic, performance) | GStack |
| `/qa` | deepseek | Dispatches DeepSeek via ai-cli-mcp for systematic QA + atomic fixes | GStack |
| `/design-review` | claude | Claude runs visual/interaction audit directly (multimodal) | GStack |
| `/tdd` | deepseek | Dispatches DeepSeek via ai-cli-mcp for TDD + subagent worktree isolation | Superpowers |

## Statusline

Auto-deployed to `~/.claude/statusline.sh`, shows two lines:

```
Opus 4.6 (1M context)  |  my-project  |  main
上下文 ████░░░░░░ 42%  |  令牌 入385.0K 出128.0K  |  花费 $1.85  |  时长 30分45秒  |  代码 +320/-67  |  限额 23%
```

Auto-saves session usage to `.spec-workflow/session-usage.json` on every tick.

## Usage Tracking

Two-level automatic tracking:

| Level | File | Trigger | Records |
|-------|------|---------|---------|
| Per-task | `usage-log.json` | Each verify-task call | Engine, task, tokens, cost |
| Per-session | `session-usage.json` | Statusline tick | Model, total tokens, cost, lines changed |

## Engine Configuration

`.spec-workflow/config.toml`:

```toml
[engine]
default = "deepseek"        # Default engine
maxFixAttempts = 5           # Max red-light fix attempts
```

## Report Generation

```bash
python3 tools/gen-report.py report.md -o report.docx --images images/
```

Requires: `pip install python-docx`

## Dependencies

| Tool | Purpose | Install |
|------|---------|---------|
| Claude Code | Orchestrator | `npm i -g @anthropic-ai/claude-code` |
| Crush (or OpenCode) | DeepSeek coding engine | `brew install charmbracelet/tap/crush` or [install script](https://github.com/charmbracelet/crush) |
| Gemini CLI | Review engine (free) | `npm i -g @google/gemini-cli` |
| Codex CLI | Image generation | `npm i -g @openai/codex` |
| python-docx | Report generation | `pip install python-docx` |
| jq | JSON processing | `apt install jq` |

## Dashboard

Start: `node dist/index.js --dashboard` → `http://localhost:5000`

Features: Kanban board with engine labels, spec editor, approval system with diff view, implementation logs.

## Credits

- [Pimzino/spec-workflow-mcp](https://github.com/Pimzino/spec-workflow-mcp) — Core framework
- [DeepSeek](https://github.com/deepseek-ai) — V4 model
- [Crush](https://github.com/charmbracelet/crush) — Terminal coding agent (OpenCode successor)
- [Anthropic](https://anthropic.com) — Claude Code + MCP protocol
- [garrytan/gstack](https://github.com/garrytan/gstack) — Role-based skills
- [obra/superpowers](https://github.com/obra/superpowers) — TDD discipline + worktree pattern
