#!/bin/bash
# spec-workflow Phase 4 auto-loop Stop hook.
#
# Registered as a Claude Code "Stop" hook only when loop.autoLoop is enabled.
# When Claude tries to end its turn during autonomous implementation, this hook
# checks whether the active spec still has pending/in-progress tasks and, if so,
# blocks the stop and re-injects the loop prompt — driving Phase 4 to completion.
#
# Master switch is config.toml [loop].autoLoop; the hook self-gates on it, so
# setting autoLoop=false pauses the loop without unregistering the hook.
#
# SAFETY: on ANY error or uncertainty the hook exits 0 (allow stop). It must
# never trap Claude in an un-exitable loop. Guards: maxIterations, noProgressStop,
# and the .autoloop-active marker (only active during Phase 4).

set +e

# --- read hook input (JSON on stdin) ---
INPUT="$(cat 2>/dev/null)"
allow() { exit 0; }   # allow the stop

CWD="$(printf '%s' "$INPUT" | jq -r '.cwd // empty' 2>/dev/null)"
[ -z "$CWD" ] && CWD="$PWD"

SW="$CWD/.spec-workflow"
CONFIG="$SW/config.toml"
MARKER="$SW/.autoloop-active"
ITER_FILE="$SW/.loop-iter"
HASH_FILE="$SW/.loop-lasthash"
NOPROG_FILE="$SW/.loop-noprog"
AUDIT="$SW/loop-audit.log"

# --- gate 1: must have a config ---
[ -f "$CONFIG" ] || allow

# read a key from the [loop] section of config.toml
read_loop_key() {
  awk -v k="$1" '
    /^\[/ { insec = ($0 == "[loop]") }
    insec && $0 ~ "^[ \t]*" k "[ \t]*=" {
      sub(/^[^=]*=[ \t]*/, ""); sub(/#.*/, ""); gsub(/[ \t"]/, ""); print; exit
    }' "$CONFIG" 2>/dev/null
}

AUTO_LOOP="$(read_loop_key autoLoop)"
# gate 2: master switch off → allow
[ "$AUTO_LOOP" = "true" ] || allow

# gate 3: only active during Phase 4 (Claude maintains this marker).
# No marker → not in an auto-loop: wipe any stale loop state (prevents cross-spec bleed) and allow.
if [ ! -f "$MARKER" ]; then
  rm -f "$ITER_FILE" "$HASH_FILE" "$NOPROG_FILE" >/dev/null 2>&1
  allow
fi

MAX_ITER="$(read_loop_key maxIterations)"; [ -z "$MAX_ITER" ] && MAX_ITER=50
NOPROG_STOP="$(read_loop_key noProgressStop)"; [ -z "$NOPROG_STOP" ] && NOPROG_STOP=3
case "$MAX_ITER" in *[!0-9]*) MAX_ITER=50 ;; esac
case "$NOPROG_STOP" in *[!0-9]*) NOPROG_STOP=3 ;; esac

# active spec = contents of the marker (Claude writes the spec name into it).
# Strip whitespace AND surrounding quotes so a marker like "my-spec" or 'my-spec' still resolves.
SPEC="$(head -n1 "$MARKER" 2>/dev/null | tr -d "[:space:]\"'")"
[ -z "$SPEC" ] && allow
TASKS="$SW/specs/$SPEC/tasks.md"
[ -f "$TASKS" ] || allow

# --- remaining work? pending [ ] or in-progress [-] tasks ---
REMAINING="$(grep -cE '^[[:space:]]*- \[[ -]\]' "$TASKS" 2>/dev/null)"
[ -z "$REMAINING" ] && REMAINING=0
if [ "$REMAINING" -eq 0 ]; then
  # all done/blocked → release the marker (self-heal if Claude forgot), clean state, allow stop
  rm -f "$MARKER" "$ITER_FILE" "$HASH_FILE" "$NOPROG_FILE" >/dev/null 2>&1
  allow
fi

# --- iteration cap (primary safety stop) ---
ITER="$(cat "$ITER_FILE" 2>/dev/null)"; case "$ITER" in ''|*[!0-9]*) ITER=0 ;; esac
if [ "$ITER" -ge "$MAX_ITER" ]; then
  printf '%s [%s] iter=%s STOP maxIterations(%s) reached\n' "$(date -u +%FT%TZ)" "$SPEC" "$ITER" "$MAX_ITER" >> "$AUDIT" 2>/dev/null
  rm -f "$MARKER" "$ITER_FILE" "$HASH_FILE" "$NOPROG_FILE" >/dev/null 2>&1
  allow
fi

# --- no-progress guard: stop if there is no progress for N iterations.
# Progress = any change to tasks.md OR to verify-results (so active fix attempts,
# which bump fixAttempts in verify-results, count as progress and don't trip this). ---
HASH="$(cat "$TASKS" "$SW/specs/$SPEC/verify-results/"*.json 2>/dev/null | cksum 2>/dev/null | awk '{print $1}')"
LAST_HASH="$(cat "$HASH_FILE" 2>/dev/null)"
NOPROG="$(cat "$NOPROG_FILE" 2>/dev/null)"; case "$NOPROG" in ''|*[!0-9]*) NOPROG=0 ;; esac
if [ -n "$HASH" ] && [ "$HASH" = "$LAST_HASH" ]; then
  NOPROG=$((NOPROG + 1))
else
  NOPROG=0
fi
if [ "$NOPROG" -ge "$NOPROG_STOP" ]; then
  printf '%s [%s] iter=%s STOP noProgress(%s) — no tasks.md/verify-results change\n' "$(date -u +%FT%TZ)" "$SPEC" "$ITER" "$NOPROG_STOP" >> "$AUDIT" 2>/dev/null
  rm -f "$MARKER" "$ITER_FILE" "$HASH_FILE" "$NOPROG_FILE" >/dev/null 2>&1
  allow
fi

# --- block the stop and continue the loop ---
ITER=$((ITER + 1))
printf '%s' "$ITER" > "$ITER_FILE" 2>/dev/null
printf '%s' "$HASH" > "$HASH_FILE" 2>/dev/null
printf '%s' "$NOPROG" > "$NOPROG_FILE" 2>/dev/null
printf '%s [%s] iter=%s BLOCK remaining=%s\n' "$(date -u +%FT%TZ)" "$SPEC" "$ITER" "$REMAINING" >> "$AUDIT" 2>/dev/null

REASON="Auto-loop (iteration ${ITER}/${MAX_ITER}): spec '${SPEC}' still has ${REMAINING} pending/in-progress task(s). Continue Phase 4 — call spec-status for the next task, implement it (Claude writes the code by default; only offload to Codex via codex-reply when the task is _Engine: codex), run tests, and verify-task. When every task is [x] or [~] blocked, remove .spec-workflow/.autoloop-active so the loop can end. Do NOT stop to ask the user; if one task truly needs a human decision, mark just that task [~] blocked with a reason and continue to the next."
jq -cn --arg r "$REASON" '{decision:"block", reason:$r}' 2>/dev/null \
  || printf '{"decision":"block","reason":"Auto-loop: %s pending task(s) remain in spec %s. Continue Phase 4 via spec-status."}\n' "$REMAINING" "$SPEC"
exit 0
