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

## Approving requirements / design / tasks from your phone (orchestrator bot)

Phase 1–3 approvals stay *in conversation* — with the orchestrator, not `loop_bot`. When Claude Code
runs with the official Telegram channel plugin, the generated `CLAUDE.md` tells it to send each document
as a **`.md` attachment plus a ≤10-line summary** and to end with
`Reply "approve" to continue, or describe the changes you want.` Your next message decides. Only your own
message counts — text inside documents or agent output is never read as approval.

## How you drive it: buttons (primary)

Send any message (or `/menu`) to open the home screen; navigation edits the same message in place, so it
behaves like tabs rather than a chat log:

```
🏠 Home → [📋 Specs] [📁 Projects] [⏸ Gates] [⚙️ More] [➕ New spec] [📁 New / add project]
📋 Specs → pick one
   spec tabs: [📊 Overview] [☑️ Tasks] [📄 Docs] [📝 Logs]   (+ [▶️ Start loop] / [🛑 Stop loop])
☑️ Tasks → unfinished first → pick one
   task screen: [▶ start] [✅ done] [⛔ block] [↩ reset] [🚀 Run just this task] [📋 prompt]
⚙️ More → [🧭 Steering] [🧹 Cleanup] [❓ Commands]
```

## Handing work to the Claude session you already have open

`➕ New spec`, `📁 New project` and `🚀 Run just this task` do **not** spawn a fresh headless claude. They
file a request in `~/.spec-workflow/requests/` (0700 dir, 0600 files, outside every project so an
implementing agent cannot forge one). Your open Claude Code session watches that queue:

```bash
spec-workflow-mcp requests watch          # one JSON line per new request; also writes a heartbeat
```

Run that through the **Monitor** tool in Claude Code and each request arrives as an event in the session —
the work happens in the context you already have, not in a fresh process. Report back with:

```bash
spec-workflow-mcp requests claim <id>
spec-workflow-mcp requests done  <id> --result "spec auth created, 6 tasks"
spec-workflow-mcp requests done  <id> --fail --result "missing dependency"
```

The daemon pushes the outcome to Telegram.

**`📁 New project` takes any folder you name.** Reply with an absolute path (`/home/me/code/app`) or a
`~/…` one; **it does not have to exist** — `init.sh` creates it, parents included, and the queued
message says so. The daemon normalizes the path before filing the request (`~` expanded, `..` refused,
control characters refused) and rejects a path that already exists as a *file*.

### Several windows: registration, binding, exclusive claim

Every `requests watch` **registers itself** (`~/.spec-workflow/requests/.watchers/<id>.json`; the heartbeat is
the file mtime, stale entries expire after 90s), so:

* **Multiple windows are fine.** `spec-workflow-mcp requests watchers` lists who is listening.
* **One request goes to exactly one window.** A watcher must win an atomic claim (`O_EXCL` lock) before it
  emits the request; the losers skip it — two windows never do the same work.
* **Bind a window to projects** with `requests watch --project /abs/a,/abs/b` (plus `--label`). A scoped
  window only takes requests for those projects; an unscoped one takes anything. One window per repo is the
  intended setup.
* **Opening a new window does not rebind anything** — listeners add up. Closing it (Ctrl-C / session end)
  unregisters; a crash is covered by the 90s heartbeat expiry.
* Telegram shows `👂 listening: <labels>` when you tap, or warns you that nobody is.

**Address work to one window**: Home → `👂 Windows`. The list is sorted **most-recently-active first** and
each row shows the label, bound projects, when it was last active, and what it is doing or just did
(`⏳ new-spec auth` / `✅ task auth #3`). Tap a window to pin it: new work is addressed to it only (the
request carries `target`, other windows will not claim it); tap again to unpin. A window that stops
listening drops the pin automatically. A session can also publish its own summary with
`spec-workflow-mcp requests note "refactoring the parser"`.

Unattended fallback: `.spec-workflow/spec-new-run.sh <spec> <idea>` creates a spec with its own headless claude.

## Components (read-only here)

`⚙️ More → 🧩 Components` shows what the current project has: MCP servers from its `.mcp.json`, the
skills and reviewer agents under `.claude/`, and the recorded project state (initialised / pending /
ignored, from `~/.spec-workflow/projects.json`).

**Adding or removing components is a terminal job** — packages get installed and API keys get filled in:

```bash
bash templates/init.sh <project> --force     # opens the search-and-add picker
```

The picker takes several keywords per search and several picks per result list (`1 3 5`, `2-6`, `all`),
searching the curated catalog, the Claude Code marketplaces on this machine (skills/agents are copied in
as plain files) and npm. Anything with an unverifiable licence is refused. What you installed is
recorded in the project's `.spec-workflow/INSTALLED.md`.

## Commands (still available as a fallback)

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

* The **runner** writes `specs/<spec>/.run/gates/<id>.pending` (random nonce, kind, timestamp) and **signs it** with `GATE_SECRET`; the daemon shows buttons only for pendings whose signature verifies — a pending file forged or rewritten inside the project gets no card.
* The **daemon** posts a card whose text is composed only from daemon-owned strings keyed by gate kind plus numeric details (exit code, attempts, counts). Anything that came from the repo
  or an agent (judge reasons, log tails) is sent as a *separate* message under an “untrusted” banner in a
  code block, never next to the buttons.
* Your Approve/Reject is written **outside the project** to `~/.spec-workflow/gates/<projectHash>/<id>.json`,
  HMAC-SHA256-signed with `GATE_SECRET`. The runner recomputes the HMAC with `openssl` and ignores anything
  else — the implementing agent (which has write access inside the project) cannot approve its own gate.
* Decisions are idempotent (a redelivered tap cannot flip approve → reject) and cards refuse stale/foreign
  callback queries. Approve on an L3 failure never edits the spec (`spec-gate-result.json` gets
  `overriddenBy: "gate"`); approve on an L4 failure can never flip the result to pass.
* Ground-truth layers L0/L1 never wait on a human.
* The runner snapshots `config.toml` at START and stops with `CONFIG_CHANGED` if it changes mid-run (an agent cannot flip `testCommand`/`judge`/gate knobs under it).

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

## Trust boundary (read this once)

The gate secret lives in `~/.spec-workflow/telegram.env`, readable by the OS user that runs the daemon.
The loop runner runs headless `claude`/`codex` as **the same OS user**. `settings.json` denies the
implementing agent the `Read`/`Write` tools on that file and on the gates dir, and the runner never puts the
secret on a command line (it is passed by environment to `spec-workflow-mcp gate-hmac`), but a Bash
one-liner from a misbehaving agent is not a boundary the deny list can fully close. If you need a hard
boundary, run the daemon as a **separate OS user** (own `$HOME`, `telegram.env` 0600, gates dir 0700) and
give the runner only a verify capability. Everything else in this document is defence in depth against
*accidental* or *prompt-injected* misbehaviour, which is the realistic threat.

## Files

```
~/.spec-workflow/telegram.env            token, allowlist, GATE_SECRET (0600)
~/.spec-workflow/tg-state.json           update offset, board message ids, callback keys
~/.spec-workflow/gates/<hash>/<id>.json  signed decisions
~/.spec-workflow/audit/<hash>.jsonl      hash-chained command audit
<project>/.spec-workflow/loop-audit.log  runner event stream (tailed by the daemon)
<project>/.spec-workflow/specs/<spec>/.run/{pid,stop,gates/,…}   per-spec run state
```
