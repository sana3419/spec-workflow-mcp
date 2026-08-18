---
name: init
description: Bootstrap the current project for spec-workflow (writes .spec-workflow/config.toml, the background loop runner, CLAUDE.md/AGENTS.md, .mcp.json codex entry and a restrictive .claude/settings.json). Use when the user says "init spec workflow", "set up spec-workflow here", or a project has no .spec-workflow/ yet.
user-invocable: true
allowed-tools:
  - Bash(bash *init.sh*)
  - Bash(ls *)
  - Bash(cat *)
  - Read
---

# /spec-workflow:init — bootstrap this project

Arguments: `$ARGUMENTS` (optional flags forwarded to init.sh: `--with-graph`, `--with-nexus`, `--with-all`, `--auto-loop`, `--force`).

1. Determine the project root (the current working directory unless the user named one).
2. Run:
   ```bash
   bash "${CLAUDE_PLUGIN_ROOT}/templates/init.sh" "<project-root>" $ARGUMENTS
   ```
   If `dist/index.js` is missing under `${CLAUDE_PLUGIN_ROOT}`, tell the user to run `npm ci && npm run build`
   in the plugin checkout first — the loop runner and the MCP server need it.
3. Summarise what was written (config.toml, spec-loop-run.sh, CLAUDE.md, AGENTS.md, .claude/settings.json,
   skills + agents copied into `.claude/`) and remind them to restart Claude Code so the `spec-workflow` MCP
   server (and codex, if configured) is picked up.
4. Offer `/spec-workflow:telegram` to set up the loop_bot daemon.

Never edit the generated files yourself in this skill; init.sh is idempotent (`--force` to overwrite).
