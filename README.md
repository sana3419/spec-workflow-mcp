# Spec Workflow MCP — Multi-Engine Collaborative Development Framework

[中文文档](README.zh.md)

A multi-engine collaborative development framework built on [Pimzino/spec-workflow-mcp](https://github.com/Pimzino/spec-workflow-mcp). Claude Code serves as the orchestrator, dispatching tasks to DeepSeek / Gemini / Codex / Claude engines with traffic-light verification and academic report generation.

## Inspiration

This project merges ideas from three sources:

1. **[Pimzino/spec-workflow-mcp](https://github.com/Pimzino/spec-workflow-mcp)** — The core spec-driven development framework providing Requirements → Design → Tasks → Implementation workflow, real-time Dashboard, and approval system. This project is built on top of it.

2. **[auto-claude](../auto-claude/)** — An autonomous coding agent project that contributed the traffic-light verification concept (unit test → regression → green/red signal) and progress tracking via feature_list.json. The `verify-task` tool is directly inspired by this.

3. **Multi-engine collaboration** — The 2026 AI coding tool ecosystem inspired the "right engine for the right job" dispatch strategy: DeepSeek TUI for coding (LiveCodeBench 93.5, low cost), Gemini CLI for review (generous free tier), Claude for planning and verification (strong reasoning).

## Changes from Original

| Feature | Description |
|---------|-------------|
| Multi-engine dispatch | `_Engine:` field in tasks, `spec-status` returns dispatch hints |
| Traffic-light verification | New `verify-task` tool: green→complete, red→fix/blocked |
| Engine config | `[engine]` section in config.toml |
| Academic report generation | `gen-report.py`: Markdown + images → docx (Chinese academic format) |
| Project initialization | `init.sh`: one-command setup for new projects |
| Streamlined i18n | Chinese + English only |

## Quick Start

### 1. Install

```bash
cd spec-workflow-mcp && npm install
```

### 2. Configure Claude Code MCP

Add to `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "spec-workflow": {
      "command": "node",
      "args": ["<path-to>/spec-workflow-mcp/dist/index.js", "<your-project>"]
    }
  }
}
```

### 3. Initialize a New Project

```bash
bash <path-to>/spec-workflow-mcp/templates/init.sh /path/to/your-project
```

### 4. Start

```bash
cd /path/to/your-project && claude
```

## Workflow

```
Phase 1  Claude plans
         ├── requirements.md → dashboard approval
         ├── design.md       → dashboard approval
         └── tasks.md        → _Engine per task → dashboard approval

Phase 2  Execute tasks
         ├── spec-status → next task + engine hint
         ├── Dispatch to engine (deepseek/gemini/claude)
         ├── Run tests → verify-task green/red
         └── log-implementation

Phase 3  Complete / Report (optional)
         ├── Claude writes Markdown report + SVG diagrams
         ├── Codex converts SVGs to polished images
         └── gen-report.py → academic docx
```

## MCP Tools

| Tool | Purpose |
|------|---------|
| `spec-workflow-guide` | Full workflow guide |
| `steering-guide` | Project steering documents |
| `spec-status` | Progress + next task engine suggestion |
| `approvals` | Approval workflow (request/status/delete) |
| `verify-task` | Traffic-light verification (green→done, red→fix/blocked) |
| `log-implementation` | Record implementation logs and artifacts |

## Credits

- [Pimzino/spec-workflow-mcp](https://github.com/Pimzino/spec-workflow-mcp) — Core framework
- [DeepSeek](https://github.com/deepseek-ai) — V4 model + TUI
- [Anthropic](https://anthropic.com) — Claude Code + MCP protocol
