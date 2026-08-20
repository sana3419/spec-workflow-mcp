# Third-party notices

## What this repository contains

The reviewer agents in `agents/` and the skills in `skills/` were written for this project in its own
house format. While designing the reviewer checklists we consulted, for inspiration only, two
MIT-licensed collections — **VoltAgent/awesome-claude-code-subagents** (© 2025 VoltAgent) and
**wshobson/agents** (© 2024 Seth Hobson). No file here is a copy of theirs; this is courtesy
attribution, not an obligation.

This project itself builds on **[Pimzino/spec-workflow-mcp](https://github.com/Pimzino/spec-workflow-mcp)**
(GPL-3.0). Parts of `src/core/` (task parsing, project registry, path utilities) and all six document
templates under `src/markdown/templates/` originate there. This repository therefore stays GPL-3.0.

## What the installer adds — fetched, never vendored

`init.sh` opens a picker (`templates/catalog.json` + `templates/lib/search.sh`). Nothing third-party
ships inside this repository: each choice is **fetched from its own source at install time** and stays
under its own licence. Every install writes `.spec-workflow/INSTALLED.md` in the target project,
recording what was installed, from where and under which licence — that file is the attribution for a
given project.

An item is only offered when its licence can be read from the registry or the upstream LICENSE file.
Anything unverifiable is shown with ⚠ and refused (the Snyk CLI, for example, publishes NOASSERTION and
is deliberately absent from the catalog).

### Curated catalog (licences verified 2026-08-20)

| Component | Source | Licence |
|---|---|---|
| Context7 | upstash/context7 | MIT |
| Playwright MCP | microsoft/playwright-mcp | Apache-2.0 |
| Sequential Thinking, Memory, Fetch, Git | modelcontextprotocol/servers | Apache-2.0 / MIT (project is mid-transition) |
| Postgres | crystaldba/postgres-mcp | MIT |
| SQLite | 0xOmarA/mcp-server-sqlite | Apache-2.0 |
| Semgrep | semgrep/mcp | MIT |
| Octocode | bgauryy/octocode-mcp | MIT |
| Tavily | tavily-ai/tavily-mcp | MIT |
| Brave Search | brave/brave-search-mcp-server | MIT |
| Exa | exa-labs/exa-mcp-server | MIT (repo LICENSE; npm metadata omits it) |
| Firecrawl | firecrawl/firecrawl-mcp-server | MIT |
| Supabase | supabase-community/supabase-mcp | Apache-2.0 |
| Neon | neondatabase-labs/mcp-server-neon | MIT |
| DeepWiki | mcp.deepwiki.com (hosted) | service — provider terms; no code installed |
| systematic-debugging, verification-before-completion, using-git-worktrees, brainstorming, dispatching-parallel-agents | obra/superpowers | MIT |
| web-video-presentation, beautiful-article | ConardLi/garden-skills | MIT |

Skills and agents copied out of a Claude Code marketplace on your machine keep their upstream LICENSE
next to them in `.claude/licenses/<name>.LICENSE`.

MIT and Apache-2.0 are one-way compatible into GPL-3.0, so fetching them into a GPL-3.0 project is
fine; the fetched files remain under their own licence and are not relicensed by this project.
