# Telegram control (`loop_bot`)

Since v3.0 the web dashboard is gone. Everything it did — progress board, task cards, logs, archive,
cleanup — plus things it could not do (start/stop the background loop, approve human gates from
your phone) goes through a Telegram bot. [中文](TELEGRAM.zh.md)

Two bots, two roles:

| Bot | Runs where | What it is for |
|---|---|---|
| **orchestrator bot** — the official Claude Code Telegram *channel* plugin (`claude --channels plugin:telegram@claude-plugins-official`) | inside your interactive Claude Code session | talk to Claude in natural language: create specs, approve requirements/design/tasks, ask it to run `/review`, "run the loop", edit documents |
| **loop_bot** — `spec-workflow-mcp --telegram` (this project) | one daemon per machine, no Claude session needed | watch every project's loop, board + pushes, gate Approve/Reject cards, `/status /tasks /logs /start /stop …` |

They must be **different bots** (different tokens): Telegram allows exactly one `getUpdates` poller per
token and the channel plugin already polls its own. If you only want pushes from `loop_bot` and no
commands, you may reuse the token with `TELEGRAM_SEND_ONLY=true`.

## Setup (5 minutes)

1. `@BotFather` → `/newbot` → copy the token. Get your numeric user id from `@userinfobot`.
2. Create the env file (0600) — the daemon refuses to start without an allowlist:
   ```bash
   mkdir -p ~/.spec-workflow && chmod 700 ~/.spec-workflow
   cat > ~/.spec-workflow/telegram.env <<'EOF'
   TELEGRAM_BOT_TOKEN=123456789:AAH...
   TELEGRAM_ALLOW_FROM=111111111          # comma-separated numeric user ids that may command
   # TELEGRAM_NOTIFY=111111111            # who receives pushes (default: ALLOW_FROM)
   # TELEGRAM_PROJECTS=/abs/proj-a,/abs/proj-b   # extra roots besides the MCP registry
   # TELEGRAM_SEND_ONLY=true              # pushes only, never poll (shared-token mode)
   EOF
   chmod 600 ~/.spec-workflow/telegram.env
   ```
   `GATE_SECRET` is generated into the same file on first start.
3. Start the daemon (systemd, tmux, or `nohup`):
   ```bash
   nohup node /path/to/spec-workflow-mcp/dist/index.js --telegram >> ~/.spec-workflow/telegram.log 2>&1 &
   ```
4. DM the bot `/help`. Projects appear automatically once an MCP server for them has run at least
   once (they register in `~/.spec-workflow-mcp/`); or list them in `TELEGRAM_PROJECTS`.

`--telegram-once` performs a single watcher tick (push new events, post gate cards) and exits — usable
from cron if you don't want a long-running process (commands then don't work).

## Commands

```
/status [proj[/spec]]        overview · project · spec + loop state
/projects   /use <proj>      list / set the current project for this chat
/specs [archived] [q]        spec list (progress bars, search)
/spec <spec>                 summary + buttons: 📄 requirements · 📐 design · ☑️ tasks (sent as .md files)
/tasks <spec>                board text grouped by status
/task <spec> <id> [start|done|block <reason>|reset]     task card with buttons
/steering                    steering docs (buttons send the files)
/logs <spec> [N] | task <id> implementation logs
/logstats <spec>             lines added/removed, files, artifacts
/find <type> <term>          search artifacts (apiEndpoints|components|functions|classes|integrations)
/prompt <spec> <id>          the implement prompt for a task
/gates                       pending human gates
/runlog <spec> [N]           tail of loop-audit.log for that spec
/start <spec>   /stop <spec> background loop (needs [loop].autoLoop = true in the project)
/archive|/unarchive <spec>   with confirmation button
/cleanup <days> [archived]   dry-run list, then a "Delete N" button — irreversible
/about  /help
```
`proj/spec` works everywhere (`/tasks myapp/auth`); with a single known project you can omit it.

## What gets pushed

* **Board** — one message per loop run, edited in place (silent): phases, `✅ 🔄 ⛔ ⬜` counts, loop pid,
  last event.
* **New messages** — loop started, task blocked / tamper gate / regression, judge fail, spec-gate fail,
  integration result, loop ended (with reason and final status).
* **Gate cards** — see below.

Task greens only update the board; nothing pings you per task.

## Human gates (approve from your phone)

Enable in the project's `.spec-workflow/config.toml`:

```toml
[loop]
gateOnSpecGateFail = true      # L3 failed → Approve = override-and-proceed (audited), Reject = stop
gateOnIntegrationFail = true   # L4 failed → Approve = ONE more bounded fix round, Reject = stop
gateEveryTasks = 5             # pause after every N green tasks for a checkpoint
gateTimeoutMin = 60            # no decision in time = reject
```

How it stays trustworthy:

* The **runner** writes `specs/<spec>/.run/gates/<id>.pending` (a random nonce + harness-authored summary).
* The **daemon** posts a card whose text contains only harness fields. Anything that came from the repo
  or an agent (judge reasons, log tails) is sent as a *separate* message under an “untrusted” banner in a
  code block, never next to the buttons.
* Your Approve/Reject is written **outside the project** to `~/.spec-workflow/gates/<projectHash>/<id>.json`,
  HMAC-SHA256-signed with `GATE_SECRET`. The runner recomputes the HMAC with `openssl` and ignores anything
  else — the implementing agent (which has write access inside the project) cannot approve its own gate.
* Decisions are idempotent (a redelivered tap cannot flip approve → reject) and cards refuse stale/foreign
  callback queries. Approve on an L3 failure never edits the spec (`spec-gate-result.json` gets
  `overriddenBy: "gate"`); approve on an L4 failure can never flip the result to pass.
* Ground-truth layers L0/L1 never wait on a human.

## Security model

* Only numeric ids in `TELEGRAM_ALLOW_FROM` are answered; everyone else is dropped silently (no pairing
  mode, no group chats). Commands are read only from fresh `message.text` — never edited/forwarded messages
  or quoted replies.
* Every command and gate decision is appended to `~/.spec-workflow/audit/<projectHash>.jsonl` as a
  SHA-256 hash chain (`prev`/`hash` fields); truncation or edits are detectable.
* The daemon never runs `claude`/`codex` and never shells out with user input. `/start` only spawns the
  project's own `spec-loop-run.sh`; all state changes go through `verify-core` (task state),
  `run-state` (stop requests), `gates`, `archive-service`, `cleanup`.
* Manual task-state changes are refused while a loop is running for that spec (`/stop` first).
* The project `settings.json` written by `init.sh` denies the implementing agent access to
  `~/.spec-workflow/**`, `.run/**`, the audit log and `api.telegram.org`.

## Files

```
~/.spec-workflow/telegram.env            token, allowlist, GATE_SECRET (0600)
~/.spec-workflow/tg-state.json           update offset, board message ids, callback keys
~/.spec-workflow/gates/<hash>/<id>.json  signed decisions
~/.spec-workflow/audit/<hash>.jsonl      hash-chained command audit
<project>/.spec-workflow/loop-audit.log  runner event stream (tailed by the daemon)
<project>/.spec-workflow/specs/<spec>/.run/{pid,stop,gates/,…}   per-spec run state
```
