---
name: telegram
description: Configure and start the spec-workflow Telegram loop_bot daemon (token, allowlist, gates). Use when the user pastes a Telegram bot token, asks to "set up telegram", "start the loop bot", or asks how to approve gates from their phone.
user-invocable: true
allowed-tools:
  - Bash(mkdir *)
  - Bash(chmod *)
  - Bash(cat *)
  - Bash(ls *)
  - Bash(nohup node *)
  - Bash(node *dist/index.js --telegram*)
  - Bash(pgrep *)
  - Bash(tail *)
  - Read
  - Write
---

# /spec-workflow:telegram — loop_bot setup

Arguments: `$ARGUMENTS` (may contain a bot token like `123456789:AAH...` and/or numeric user ids).

Read `${CLAUDE_PLUGIN_ROOT}/docs/TELEGRAM.md` once for the full picture. Then:

1. **Two bots.** Explain in one line: this loop_bot is separate from the Claude Code Telegram *channel* plugin
   (different token — one poller per token). If the user only wants pushes, `TELEGRAM_SEND_ONLY=true` allows a
   shared token.
2. **Env file** `~/.spec-workflow/telegram.env` (create dir 0700, file 0600). Required:
   `TELEGRAM_BOT_TOKEN=<token>` and `TELEGRAM_ALLOW_FROM=<numeric ids>` (from @userinfobot). Optional:
   `TELEGRAM_NOTIFY`, `TELEGRAM_PROJECTS=/abs/a,/abs/b`, `TELEGRAM_SEND_ONLY`. Never echo the token back into
   chat; never write it anywhere else. If the user has not given the numeric id, ask for it — the daemon refuses
   to start with an empty allowlist.
3. **Start** (one per machine):
   ```bash
   nohup node "${CLAUDE_PLUGIN_ROOT}/dist/index.js" --telegram >> ~/.spec-workflow/telegram.log 2>&1 &
   ```
   then `tail -n 5 ~/.spec-workflow/telegram.log` and report "connected as @…" or the error.
4. Tell the user to DM the bot `/help`, and that projects appear once their MCP server has run once (or via
   `TELEGRAM_PROJECTS`). Mention the gate knobs (`gateOnSpecGateFail`, `gateOnIntegrationFail`,
   `gateEveryTasks`, `gateTimeoutMin` in `.spec-workflow/config.toml`) for phone approvals.
