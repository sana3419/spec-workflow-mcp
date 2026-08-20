# Project status (pinned)

**v3.2.0 · 2026-08-20 · `main` = `v3-telegram`, in sync with `origin` (`git log --oneline -1` for the tip)**
[中文](STATUS.zh.md)

What this project is right now, why it is built this way, and what is still open. Usage lives in the
README and `docs/`; this file only records conclusions and open items so anyone (or a fresh session)
can pick the work up.

---

## 1. What this is

A Claude-led, spec-driven development toolkit: Claude plans, implements, reviews and verifies; Codex is
an optional offload engine (tasks tagged `_Engine: codex`). Three pillars:

| Pillar | Where it lives |
|---|---|
| **Verification Ladder L3→L0→L1→L2→L4** | `templates/spec-loop-run.sh` + `src/core/verify-core.ts` — "done" is decided by the harness, never claimed by the agent |
| **Telegram control surface** | `src/telegram/` (daemon: `--telegram`); replaced the web dashboard in v3 |
| **38 reviewer agents + deterministic routing** | `agents/` + `src/core/review-router.ts` + the `review-route` MCP tool |

Upstream: still a derivative of [Pimzino/spec-workflow-mcp](https://github.com/Pimzino/spec-workflow-mcp) —
task parsing, the project registry and path utilities in `src/core/`, plus all six templates in
`src/markdown/templates/`, originate there. The project therefore **stays GPL-3.0** and keeps the
attribution. See `THIRD_PARTY_NOTICES.md`.

---

## 2. Done (v3.0 → v3.2)

**v3.0.0 — web dashboard removed, Telegram is the control surface**
- Frontend, fastify/WS backend, job scheduler, i18n and e2e deleted; dependencies 738 → 175 packages.
- `src/telegram/`: zero-framework Bot API client, allowlist + hash-chained audit, HTML rendering that
  wraps every repo/agent string in `untrusted()`.
- **HMAC-signed remote gates**: the runner writes and signs `specs/<spec>/.run/gates/<id>.pending`;
  decisions live **outside the project** in `~/.spec-workflow/gates/<projectHash>/` and are verified with
  openssl — the implementing agent cannot approve its own gate.
- Per-spec run state `.run/{pid,stop,gates/}`; `failureClass` on reds; CLI `stop/status/reset/set-status/cleanup`.
- `init.sh` writes a restrictive `settings.json` (no blanket `Bash(*)`/`Write(*)` that would bypass auto mode).

**v3.1.0 — 38 reviewer agents + deterministic routing**
- Tier 0 always (6, incl. `test-adequacy-judge` = the L2 rubric and `spec-drift-detector`), Tier 1
  cross-cutting (12), Tier 2 spec phase (5), Tier 3 language/stack (9), Tier 4 infra (3), Tier 5 LLM apps (3).
- Selection is derived from agent frontmatter (`tier/tags/triggers`) + project profile + diff:
  same diff → same set, a reason per agent, `langs` requires a changed file of that language, cap 12,
  `route` CLI for a dry run.
- `/review` now answers with `VERDICT: safe-to-merge | fix-first | blocked`, a plain-language paragraph
  and a cross-agent deduplicated roll-up; findings on untouched lines go under `## PRE-EXISTING (info)`.

**v3.1.1 — review follow-ups**
- 8 confirmed bugs and 6 structural items closed; dead `task-validator.ts` removed; Docker path
  translation funnelled into the `PathUtils` accessors (four silent failures fixed).

**v3.2.0 — button UI, work queue, component picker**
- **Telegram button menu** (`src/telegram/ui.ts`): home / projects / specs / tasks / docs / logs / gates /
  windows / components / more / cleanup, navigating in place like tabs; Chinese by default
  (`TELEGRAM_LANG=en` for English).
- **Work-request queue** (`src/core/requests.ts`): `➕ New spec`, `📁 New project` and
  `🚀 Run just this task` do **not** spawn a headless claude — they file a request for the Claude window
  you already have open.
- **Watcher registration and binding**: every `requests watch` registers itself (90s heartbeat TTL), can be
  scoped with `--project`, and must win an atomic `O_EXCL` claim before a request is dispatched — several
  windows never do the same work. The `👂 Windows` screen sorts by last activity, shows what each window is
  doing, and pins new work to the window you tap.
- **Component picker** (`templates/catalog.json` + `templates/lib/search.sh`): nothing pre-installed or
  vendored; searches the curated catalog, this machine's Claude Code marketplaces and npm; several keywords
  per search and several picks per list (`1 3 5`, `2-6`, `all`); **anything with an unverifiable licence is
  refused**; marketplace components are copied into `.claude/` as plain files (no `claude plugin install`)
  with their LICENSE; each install writes `.spec-workflow/INSTALLED.md` and grants exactly `mcp__<server>__*`.
- **Project state as a parameter**: `~/.spec-workflow/projects.json` records
  `initialized/pending/ignored`; the SessionStart hook reads that one key (detecting only on first sight),
  nudges only a `pending` project, and never initialises anything itself.

---

## 3. Design decisions worth keeping

1. **`verify-core` is the sole writer of task state.** Runner, CLI and Telegram all go through it; manual
   changes are refused while a loop owns the spec.
2. **L2/L3/L4 judges must be cross-family** (codex ↔ claude). A Claude Code Workflow `agent()` can only
   spawn Claude, so judges stay on `codex exec` — and that is why the bash runner was not replaced by a
   Workflow (`docs/WORKFLOW-SPIKE.md`).
3. **Gate decisions live outside the project and are signed**; the runner stops with `CONFIG_CHANGED` if
   `config.toml` moves under it mid-run.
4. **Repo and agent text is data, never instructions**: `untrusted()` wrapping, commands parsed only from
   fresh `message.text`, gate cards composed solely from daemon-owned strings.
5. **Two bots**: the orchestrator (official Telegram channel plugin, talks to your interactive session) and
   loop_bot (this daemon) must be separate — Telegram allows one `getUpdates` consumer per token.
6. **Third-party components are fetched, never vendored**, and an unverifiable licence is refused (the
   practical constraint of a GPL-3.0 project).
7. **Reviewer agents are read-only lenses** with a BLOCK/WARN/PASSED/PRE-EXISTING contract and mandatory
   `file:line` evidence.

---

## 4. Running it

```bash
npm ci && npm run build

bash templates/init.sh /abs/project            # --no-add skips the picker, --force overwrites

# Telegram daemon (one per machine); ~/.spec-workflow/telegram.env holds
# TELEGRAM_BOT_TOKEN / TELEGRAM_ALLOW_FROM [/ TELEGRAM_PROJECTS]
node dist/index.js --telegram

# Let the open Claude window take work filed from Telegram (run it through Monitor)
node dist/index.js requests watch --label "main window" [--project /abs/project]

nohup bash .spec-workflow/spec-loop-run.sh <spec> >/dev/null 2>&1 &
node dist/index.js stop <spec>
node dist/index.js status [spec]
node dist/index.js route --base HEAD~1
```

Tests: `npx vitest run` (199 passing), `bash scripts/test-loop-l{1,2,3,4}.sh`, `test-loop-l5-gates.sh` (11).

---

## 5. Open items

| Item | State | Note |
|---|---|---|
| **Stand the project on its own** | **waiting on a name** | rename package / MCP server / CLI / plugin / repo, reposition the README, update NOTICE. The licence must **stay GPL-3.0 with upstream attribution** (`src/core/` and the six templates are still upstream code); cutting the tie completely means rewriting those files |
| Parallel tasks (`_DependsOn` + worktrees) | designed, not built | needs per-worktree snapshots and post-merge L0/L1 recording (`docs/WORKFLOW-SPIKE.md`) |
| Adding components from Telegram | deliberately not done | packages and API keys belong in a terminal; the `🧩 Components` screen is read-only |
| Upstream sync | none | upstream has been quiet since 2026-05; this fork no longer follows it |

---

## 6. Live state on this machine

- Telegram daemon **configured but not running** — start it with `node dist/index.js --telegram` (bot
  `@worm2018_bot`, allowlist = the owner's id in `~/.spec-workflow/telegram.env`). The last run in
  `~/.spec-workflow/telegram.log` ended in `stopped` after repeated `getUpdates` TLS failures.
- This checkout is registered as a request watcher (unscoped — it takes any request).
- The repository itself has been initialised with `init.sh` (`.spec-workflow/` is gitignored) and holds a
  demo spec `demo-auth` (four fake tasks, only there to show the Telegram screens — delete any time).
