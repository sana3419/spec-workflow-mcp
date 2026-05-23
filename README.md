# Spec Workflow MCP — Multi-Engine Collaborative Development Framework

[中文文档](README.zh.md)

A multi-engine collaborative development framework built on [Pimzino/spec-workflow-mcp](https://github.com/Pimzino/spec-workflow-mcp). Claude Code serves as the orchestrator, dispatching tasks to DeepSeek / Gemini / Codex / Claude engines with traffic-light verification and academic report generation.

## Prerequisites

Before you begin, make sure you have:

| Requirement | Check | Install |
|-------------|-------|---------|
| Node.js ≥ 18 | `node -v` | [nodejs.org](https://nodejs.org) |
| Claude Code | `claude -v` | `npm i -g @anthropic-ai/claude-code` |
| jq | `jq --version` | `apt install jq` / `brew install jq` |

API keys you will need:

| Key | Purpose | Get it at |
|-----|---------|-----------|
| `ANTHROPIC_API_KEY` | Claude Code (orchestrator) | [console.anthropic.com](https://console.anthropic.com) |
| `DEEPSEEK_API_KEY` | DeepSeek V4 (coding engine) | [platform.deepseek.com](https://platform.deepseek.com) |

Optional API keys:

| Key | Purpose | Get it at |
|-----|---------|-----------|
| Google account | Gemini CLI (free review engine) | `gemini` → browser login |
| `OPENAI_API_KEY` | Codex CLI (image generation) | [platform.openai.com](https://platform.openai.com) |

## Installation

### Step 1: Clone and build spec-workflow-mcp

```bash
git clone https://github.com/sana3419/spec-workflow-mcp.git
cd spec-workflow-mcp
npm install && npm run build
```

### Step 2: Install engine CLIs

**Crush** (DeepSeek coding engine — successor to OpenCode):

```bash
# npm (all platforms)
npm install -g @charmland/crush

# macOS (Homebrew)
brew install charmbracelet/tap/crush

# Verify
crush --version
```

**Gemini CLI** (free code review engine, optional):

```bash
npm install -g @google/gemini-cli
gemini    # First run: follow browser login
```

**Codex CLI** (image generation, optional):

```bash
npm install -g @openai/codex
```

### Step 3: Configure DeepSeek API for Crush

```bash
mkdir -p ~/.config/crush
cat > ~/.config/crush/crush.json << 'EOF'
{
  "$schema": "https://charm.land/crush.json",
  "providers": {
    "deepseek": {
      "type": "openai-compat",
      "base_url": "https://api.deepseek.com/v1",
      "api_key": "sk-YOUR_DEEPSEEK_API_KEY",
      "models": [
        {
          "id": "deepseek-v4-pro",
          "name": "DeepSeek V4 Pro",
          "cost_per_1m_in": 2.0,
          "cost_per_1m_out": 8.0,
          "context_window": 1048576,
          "default_max_tokens": 65536
        },
        {
          "id": "deepseek-v4-flash",
          "name": "DeepSeek V4 Flash",
          "cost_per_1m_in": 0.2,
          "cost_per_1m_out": 0.6,
          "context_window": 1048576,
          "default_max_tokens": 65536
        }
      ]
    }
  },
  "mcpServers": {}
}
EOF
```

Replace `sk-YOUR_DEEPSEEK_API_KEY` with your actual key.

Verify:

```bash
crush run "Reply OK"    # Should print: OK
crush models            # Should show: deepseek/deepseek-v4-pro, deepseek/deepseek-v4-flash
```

### Step 4: Initialize your project

```bash
bash /path/to/spec-workflow-mcp/templates/init.sh /path/to/your-project
```

This runs 12 automated steps:

| Step | Action |
|------|--------|
| 1 | Create project directory |
| 2 | Create `.spec-workflow/` structure |
| 3 | Write `config.toml` engine config |
| 4 | Copy `CLAUDE.md` workflow template |
| 5 | Copy skills (review/qa/design-review/tdd) + review subagents |
| 6 | Deploy statusline.sh to `~/.claude/` (global status bar) |
| 7 | Create project `.claude/settings.json` |
| 8 | Configure ai-cli-mcp (multi-engine dispatch) → `.mcp.json` |
| 9 | Configure spec-workflow-mcp + Gemini CLI + Crush MCP |
| 10-12 | Optional code intelligence MCP, cleanup, dependency check |

Optional flags:

```bash
bash templates/init.sh /path --with-graph       # code-review-graph (save tokens)
bash templates/init.sh /path --with-nexus       # GitNexus (dependency analysis)
bash templates/init.sh /path --with-understand  # Understand-Anything (visualization)
bash templates/init.sh /path --with-all         # Install all three
bash templates/init.sh /path --force            # Overwrite CLAUDE.md/skills/agents
```

### Step 5: Start

```bash
cd /path/to/your-project
claude
```

First time: Claude Code will prompt you to approve the MCP servers in `.mcp.json` — select **Allow**.

## How It Works

```
Phase 1  Claude plans
         ├── spec-workflow-guide → load workflow
         ├── requirements.md → dashboard approval (can request changes)
         ├── design.md       → dashboard approval
         └── tasks.md        → _Engine per task → dashboard approval

Phase 2  Execute tasks (loop)
         ├── spec-status → next task + engine hint
         ├── Edit tasks.md: [ ] → [-] to mark started
         ├── Dispatch to engine via ai_cli_run MCP tool
         ├── Run tests → verify-task green/red
         │   ├── green → auto-mark [x], call log-implementation
         │   └── red → fix & retry, blocked after maxFixAttempts
         └── Continue next task

Phase 3  Complete / Report (optional)
         ├── Claude writes Markdown report + SVG diagrams
         ├── Codex converts SVGs to polished images
         └── gen-report.py → academic docx
```

## Engine Dispatch

All engines are dispatched through **ai-cli-mcp** (a single MCP server). Claude never calls CLIs directly via Bash.

| Engine | Model String | Purpose |
|--------|-------------|---------|
| DeepSeek V4 Pro | `oc-deepseek/deepseek-v4-pro` | Coding, refactoring, bug fixes (default) |
| DeepSeek V4 Flash | `oc-deepseek/deepseek-v4-flash` | Fast/cheap coding tasks |
| Gemini 2.5 Pro | `gemini-2.5-pro` | Large-scale code/doc reading, codebase research (free) |
| Gemini 2.5 Flash | `gemini-2.5-flash` | Fast review (free) |
| Codex GPT-5.4 | `gpt-5.4` | Image generation, SVG conversion |
| Claude | (direct execution) | Planning, verification, orchestration |

Under the hood: ai-cli-mcp dispatches DeepSeek tasks through **Crush** CLI (OpenCode successor), which calls the DeepSeek API. The `OPENCODE_CLI_NAME=crush` env var in `.mcp.json` makes this work.

## MCP Architecture

```
Claude Code (orchestrator)
├── spec-workflow-mcp     — workflow management (6 tools)
├── ai-cli-mcp            — engine dispatch (run/wait/peek/get_result/doctor/models)
│   ├── Crush CLI         → DeepSeek V4 (via OPENCODE_CLI_NAME=crush)
│   ├── Gemini CLI        → Gemini 2.5/3
│   └── Codex CLI         → GPT-5.x
├── code-review-graph     — knowledge graph (optional, --with-graph)
└── gitnexus              — dependency analysis (optional, --with-nexus)
```

## MCP Tools

### spec-workflow-mcp (6 tools)

| Tool | Purpose |
|------|---------|
| `spec-workflow-guide` | Full workflow guide (call first each session) |
| `steering-guide` | Project steering documents |
| `spec-status` | Progress + next task engine suggestion |
| `approvals` | Approval workflow (request/status/delete) |
| `verify-task` | Traffic-light verification (green→done, red→fix/blocked) |
| `log-implementation` | Record implementation logs and artifacts |

### ai-cli-mcp (engine dispatch)

| Tool | Purpose |
|------|---------|
| `run` | Launch engine task in background, returns process ID |
| `wait` | Wait for engine completion, return result |
| `peek` | Check engine progress without waiting |
| `get_result` | Get completed engine result |
| `doctor` | Check which engine CLIs are available |
| `models` | List all available model strings |

## Using Claude Code

MCP tools are called automatically. You can also trigger them with natural language:

```
"Build a user auth system"              → Claude starts spec-workflow planning
"Show progress for user-auth"           → spec-status
"Tests passed"                          → verify-task signal:green
"Tests failed, error: xxx"              → verify-task signal:red
"Use /review to check the code"         → launches 4 review subagents in parallel
"Use /tdd to develop this feature"      → dispatches DeepSeek for TDD
"Run /qa on the project"                → dispatches DeepSeek for QA testing
"Check the UI"                          → Claude runs visual audit (multimodal)
"Do a full review"                      → launches 4 review subagents in parallel
```

## Dashboard

```bash
node /path/to/spec-workflow-mcp/dist/index.js --dashboard
# → http://localhost:5000
```

| Feature | Description |
|---------|-------------|
| Kanban board | Drag tasks between pending/in-progress/completed/blocked |
| Spec editor | Edit requirements/design/tasks Markdown online |
| Approval system | Approve/reject/request changes with diff view |
| Implementation logs | View artifacts recorded per task |

## Review Subagents (4, parallel isolated context)

Auto-installed to `.claude/agents/`. Run in isolated context — won't pollute main conversation:

| Agent | Focus |
|-------|-------|
| `security-reviewer` | Injection, auth flaws, hardcoded secrets, CVE |
| `logic-reviewer` | Edge cases, race conditions, resource leaks |
| `performance-reviewer` | N+1 queries, memory leaks, blocking ops |
| `api-reviewer` | Naming, HTTP semantics, versioning, validation |

## Skills (4, from GStack + Superpowers)

Auto-installed to `.claude/skills/`:

| Skill | Engine | Purpose |
|-------|--------|---------|
| `/review` | Claude | Launches 4 review subagents in parallel (security, logic, performance, API) |
| `/qa` | DeepSeek | Systematic QA testing + atomic fixes |
| `/design-review` | Claude | Visual/interaction audit (multimodal) |
| `/tdd` | DeepSeek | TDD red-green-refactor + worktree isolation |

## Statusline

Auto-deployed to `~/.claude/statusline.sh`:

```
Opus 4.6 (1M context)  |  my-project  |  main
Context ████░░░░░░ 42%  |  Tokens in385K out128K  |  Cost $1.85  |  Duration 30m45s  |  Code +320/-67  |  Rate 23%
```

Auto-saves session usage to `.spec-workflow/session-usage.json`.

## Usage Tracking

| Level | File | Trigger | Records |
|-------|------|---------|---------|
| Per-task | `usage-log.json` | Each verify-task call | Engine, task, tokens, cost |
| Per-session | `session-usage.json` | Statusline tick | Model, total tokens, cost, lines changed |

## Project Structure (after init)

```
your-project/
├── CLAUDE.md                          # Workflow guide (auto-read by Claude Code)
├── .mcp.json                          # MCP server config (ai-cli, spec-workflow, etc.)
├── .claude/
│   ├── settings.json                  # Permission config
│   ├── agents/                        # Review subagents
│   └── skills/                        # /review, /qa, /design-review, /tdd
└── .spec-workflow/
    ├── config.toml                    # Engine config
    ├── specs/                         # Spec documents (created during workflow)
    ├── approvals/                     # Approval data
    ├── steering/                      # Project steering (optional)
    ├── reports/                       # Engine output reports (auto-generated)
    ├── usage-log.json                 # Per-task usage tracking (auto)
    └── session-usage.json             # Session usage tracking (auto)
```

## Troubleshooting

| Problem | Solution |
|---------|----------|
| MCP tools not available | Restart Claude Code session. First time: approve MCP servers when prompted |
| `ai-cli: Failed to reconnect` | Check `crush --version` is installed. Check `.mcp.json` has `"OPENCODE_CLI_NAME": "crush"` in env |
| DeepSeek dispatch fails | Run `crush run "test"` to verify API config. Check `~/.config/crush/crush.json` |
| Gemini not working | Run `gemini` once for browser login |
| Dashboard won't start | Check port 5000 is free: `lsof -i :5000` |
| `spec-status` returns error | Make sure project path in `.mcp.json` args matches your actual project path |
| Reset MCP approvals | `claude mcp reset-project-choices` |

## Dashboard Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `SPEC_WORKFLOW_BIND_ADDRESS` | `127.0.0.1` | Network bind address (`0.0.0.0` for external access) |
| `SPEC_WORKFLOW_ALLOW_EXTERNAL_ACCESS` | `false` | Must be `true` when binding to non-localhost |
| `SPEC_WORKFLOW_CORS_ORIGINS` | (none) | Extra CORS origins, comma-separated (e.g. `http://my-domain.com,https://my-domain.com`) |

Example — expose dashboard via reverse proxy:

```bash
SPEC_WORKFLOW_ALLOW_EXTERNAL_ACCESS=true \
SPEC_WORKFLOW_BIND_ADDRESS=0.0.0.0 \
SPEC_WORKFLOW_CORS_ORIGINS=https://my-domain.com \
node dist/index.js /path/to/project --dashboard --port 5000
```

Example — systemd service:

```ini
[Unit]
Description=Spec Workflow Dashboard
After=network.target

[Service]
Type=simple
Environment=SPEC_WORKFLOW_ALLOW_EXTERNAL_ACCESS=true
Environment=SPEC_WORKFLOW_BIND_ADDRESS=0.0.0.0
Environment=SPEC_WORKFLOW_CORS_ORIGINS=https://my-domain.com
ExecStart=/usr/bin/node /path/to/dist/index.js /path/to/project --dashboard --no-open --port 5000
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

## Engine Configuration

`.spec-workflow/config.toml`:

```toml
[engine]
default = "deepseek"        # Default engine
maxFixAttempts = 5           # Max red-light fix attempts before auto-block
```

## Report Generation (optional)

```bash
pip install python-docx
python3 tools/gen-report.py docs/report/report.md -o docs/report/report.docx --images docs/report/images/
```

Output: Academic paper format (Song/Times New Roman, A4, 1.5 line spacing).

## Credits

- [Pimzino/spec-workflow-mcp](https://github.com/Pimzino/spec-workflow-mcp) — Core framework
- [DeepSeek](https://github.com/deepseek-ai) — V4 model
- [Crush](https://github.com/charmbracelet/crush) — Terminal coding agent (OpenCode successor)
- [ai-cli-mcp](https://github.com/mkXultra/ai-cli-mcp) — Multi-engine MCP dispatch
- [Anthropic](https://anthropic.com) — Claude Code + MCP protocol
- [garrytan/gstack](https://github.com/garrytan/gstack) — Role-based skills
- [obra/superpowers](https://github.com/obra/superpowers) — TDD discipline + worktree pattern
