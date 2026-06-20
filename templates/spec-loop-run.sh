#!/bin/bash
# Background Phase 4 loop runner.
#
# Drives a spec's pending tasks to completion in a SEPARATE, headless Claude process, so your
# interactive `claude` session stays FREE to chat and check progress.
#
# Run from the PROJECT ROOT:
#   bash .spec-workflow/spec-loop-run.sh <spec-name>                              # foreground (this terminal)
#   nohup bash .spec-workflow/spec-loop-run.sh <spec-name> >/dev/null 2>&1 &      # background
#
# Watch progress:   tail -f .spec-workflow/loop-run.log    (or use spec-status / the dashboard)
# Stop it:          touch .spec-workflow/.loop-stop        (or: kill "$(cat .spec-workflow/.loop-run.pid)")
#
# Guardrails come from .spec-workflow/config.toml [loop]: maxIterations, noProgressStop.

set +e

SPEC="$1"
if [ -z "$SPEC" ]; then echo "usage: spec-loop-run.sh <spec-name>"; exit 1; fi

SW=".spec-workflow"
TASKS="$SW/specs/$SPEC/tasks.md"
CONFIG="$SW/config.toml"
LOG="$SW/loop-run.log"
AUDIT="$SW/loop-audit.log"
PIDF="$SW/.loop-run.pid"
STOPF="$SW/.loop-stop"

if [ ! -d "$SW" ]; then echo "Run this from the project root (no $SW here)."; exit 1; fi
if [ ! -f "$TASKS" ]; then echo "No tasks.md for spec '$SPEC' ($TASKS)."; exit 1; fi
command -v claude >/dev/null 2>&1 || { echo "claude CLI not found in PATH."; exit 1; }

# read a key from the [loop] section of config.toml
read_loop_key() {
  awk -v k="$1" '
    /^\[/ { insec = ($0 == "[loop]") }
    insec && $0 ~ "^[ \t]*" k "[ \t]*=" {
      sub(/^[^=]*=[ \t]*/, ""); sub(/#.*/, ""); gsub(/[ \t"]/, ""); print; exit
    }' "$CONFIG" 2>/dev/null
}
AUTO="$(read_loop_key autoLoop)"
if [ "$AUTO" != "true" ]; then
  echo "Auto-loop is OFF. Set [loop].autoLoop = true in $CONFIG (or ask Claude to) and re-run."
  exit 0
fi
MAX="$(read_loop_key maxIterations)";   case "$MAX" in ''|*[!0-9]*) MAX=50 ;; esac
NOPROG_MAX="$(read_loop_key noProgressStop)"; case "$NOPROG_MAX" in ''|*[!0-9]*) NOPROG_MAX=3 ;; esac

remaining() { grep -cE '^[[:space:]]*- \[[ -]\]' "$TASKS" 2>/dev/null; }

# Preflight: confirm a headless claude actually runs (and is logged in) before looping, so we
# fail fast with guidance instead of silently burning iterations on noProgressStop.
if ! claude -p "Reply with exactly: OK" >/dev/null 2>&1; then
  echo "Preflight FAILED: headless 'claude -p' did not run. Is the claude CLI logged in? (try: claude -p 'hi')"
  echo "$(date -u +%FT%TZ) [$SPEC] ABORT preflight failed (headless claude not runnable)" >> "$AUDIT" 2>/dev/null
  exit 1
fi

rm -f "$STOPF" >/dev/null 2>&1
echo $$ > "$PIDF"
echo "$(date -u +%FT%TZ) [$SPEC] loop-run START (max=$MAX noProgress=$NOPROG_MAX pid=$$)" >> "$AUDIT" 2>/dev/null

iter=0; lasthash=""; noprog=0
while true; do
  if [ -f "$STOPF" ]; then echo "$(date -u +%FT%TZ) [$SPEC] STOP (stop flag)" >> "$AUDIT"; break; fi

  R="$(remaining)"; [ -z "$R" ] && R=0
  if [ "$R" -eq 0 ]; then echo "$(date -u +%FT%TZ) [$SPEC] DONE (all tasks [x]/[~])" >> "$AUDIT"; break; fi
  if [ "$iter" -ge "$MAX" ]; then echo "$(date -u +%FT%TZ) [$SPEC] STOP maxIterations($MAX)" >> "$AUDIT"; break; fi

  # progress = change to tasks.md OR verify-results (so active fix attempts count as progress)
  H="$(cat "$TASKS" "$SW/specs/$SPEC/verify-results/"*.json 2>/dev/null | cksum 2>/dev/null | awk '{print $1}')"
  if [ -n "$H" ] && [ "$H" = "$lasthash" ]; then noprog=$((noprog + 1)); else noprog=0; lasthash="$H"; fi
  if [ "$noprog" -ge "$NOPROG_MAX" ]; then echo "$(date -u +%FT%TZ) [$SPEC] STOP noProgress($NOPROG_MAX)" >> "$AUDIT"; break; fi

  iter=$((iter + 1))
  echo "$(date -u +%FT%TZ) [$SPEC] iter=$iter remaining=$R — invoking claude" >> "$AUDIT"
  echo "" >> "$LOG"; echo "===== iter $iter @ $(date -u +%FT%TZ) (remaining=$R) =====" >> "$LOG"

  claude -p "Autonomous Phase 4 loop — ONE iteration — for spec '$SPEC' in this project. Call the spec-workflow-guide tool first if you have not this session. Pick the next pending/in-progress task in $TASKS, implement it (Claude implements by default; offload to Codex only if the task is tagged _Engine: codex), run its tests, call verify-task (green/red), then log-implementation. Do EXACTLY ONE task this turn, then stop. If a task genuinely needs a human decision, mark it [~] blocked with a reason and stop. If no pending tasks remain, reply DONE and change nothing." \
    >> "$LOG" 2>&1
done

rm -f "$PIDF" "$STOPF" >/dev/null 2>&1
echo "$(date -u +%FT%TZ) [$SPEC] loop-run END (iterations=$iter)" >> "$AUDIT" 2>/dev/null
