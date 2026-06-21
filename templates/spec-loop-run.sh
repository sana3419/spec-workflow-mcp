#!/bin/bash
# Background Phase 4 loop runner — harness-owned verification (L0 + L1).
#
# Drives a spec's pending tasks to completion in a SEPARATE, headless Claude process, so your
# interactive `claude` session stays FREE. The IMPLEMENTING agent writes code + tests but does
# NOT judge itself: the loop SCRIPT runs each task's scoped tests and records the verdict from the
# exit code (verifiedBy: "harness-exec"). The script is the SOLE writer of task state.
#
# Run from the PROJECT ROOT:
#   bash .spec-workflow/spec-loop-run.sh <spec-name>                              # foreground
#   nohup bash .spec-workflow/spec-loop-run.sh <spec-name> >/dev/null 2>&1 &      # background
#
# Watch:  tail -f .spec-workflow/loop-run.log     Stop:  touch .spec-workflow/.loop-stop
# Guardrails: .spec-workflow/config.toml [loop] (maxIterations, noProgressStop, testCommand).

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

# Absolute package command (pick/verify subcommands), sed-injected by init.sh at install time.
SWMCP="${SWMCP:-@@SWMCP_CMD@@}"

if [ ! -d "$SW" ]; then echo "Run this from the project root (no $SW here)."; exit 1; fi
if [ ! -f "$TASKS" ]; then echo "No tasks.md for spec '$SPEC' ($TASKS)."; exit 1; fi
command -v claude >/dev/null 2>&1 || { echo "claude CLI not found in PATH."; exit 1; }

# Read a key from a [section]; numeric/bool values (spaces stripped).
read_key() {
  awk -v sec="[$1]" -v k="$2" '
    /^\[/ { insec = ($0 == sec) }
    insec && $0 ~ "^[ \t]*" k "[ \t]*=" {
      sub(/^[^=]*=[ \t]*/, ""); sub(/#.*/, ""); gsub(/[ \t"]/, ""); print; exit
    }' "$CONFIG" 2>/dev/null
}
# Read a STRING key from a [section] — preserves internal spaces (e.g. "npm test -- {tests}").
read_str() {
  awk -v sec="[$1]" -v k="$2" '
    /^\[/ { insec = ($0 == sec) }
    insec && $0 ~ "^[ \t]*" k "[ \t]*=" {
      sub(/^[^=]*=[ \t]*/, ""); sub(/[ \t]*#.*$/, ""); sub(/[ \t]+$/, "");
      gsub(/^"|"$/, ""); print; exit
    }' "$CONFIG" 2>/dev/null
}
# Pull a "key":"value" out of a JSON line (no jq dependency); empty for null/absent.
json_str() { printf '%s' "$1" | sed -n "s/.*\"$2\":\"\([^\"]*\)\".*/\1/p"; }

AUTO="$(read_key loop autoLoop)"
if [ "$AUTO" != "true" ]; then
  echo "Auto-loop is OFF. Set [loop].autoLoop = true in $CONFIG (or ask Claude to) and re-run."
  exit 0
fi
MAX="$(read_key loop maxIterations)";        case "$MAX" in ''|*[!0-9]*) MAX=50 ;; esac
NOPROG_MAX="$(read_key loop noProgressStop)"; case "$NOPROG_MAX" in ''|*[!0-9]*) NOPROG_MAX=3 ;; esac
MAXFIX="$(read_key engine maxFixAttempts)";  case "$MAXFIX" in ''|*[!0-9]*) MAXFIX=5 ;; esac
TEST_CMD="$(read_str loop testCommand)"

# Detect an un-injected placeholder. The pattern is '*@@*' (not the literal placeholder) so the
# init.sh sed-replace of the placeholder does not rewrite this guard.
case "$SWMCP" in
  *@@*)
    echo "Loop runner not finalized: SWMCP command was not injected (re-run init.sh after 'npm run build'),"
    echo "or export SWMCP='node /abs/path/to/dist/index.js' before running."
    exit 1 ;;
esac

remaining() { grep -cE '^[[:space:]]*- \[[ -]\]' "$TASKS" 2>/dev/null; }
IS_GIT=0; git -C "$PWD" rev-parse --git-dir >/dev/null 2>&1 && IS_GIT=1
# Non-git → the "modified pre-existing scoped test" check can't run (L1 is degraded). Stamp every
# verdict with --tamper-gate-off so verify-results carry a durable record, not just a log line.
TG=""; [ "$IS_GIT" = 0 ] && TG="--tamper-gate-off"

# Preflight: confirm a headless claude actually runs (and is logged in) before looping.
if ! claude -p "Reply with exactly: OK" >/dev/null 2>&1; then
  echo "Preflight FAILED: headless 'claude -p' did not run. Is the claude CLI logged in? (try: claude -p 'hi')"
  echo "$(date -u +%FT%TZ) [$SPEC] ABORT preflight failed" >> "$AUDIT" 2>/dev/null
  exit 1
fi

rm -f "$STOPF" >/dev/null 2>&1
echo $$ > "$PIDF"
if [ -z "$TEST_CMD" ]; then
  echo "$(date -u +%FT%TZ) [$SPEC] WARN SELF-CERTIFIED (no [loop].testCommand — verification NOT independent, DEPRECATED)" | tee -a "$AUDIT" >> "$LOG"
fi
echo "$(date -u +%FT%TZ) [$SPEC] loop-run START (max=$MAX noProgress=$NOPROG_MAX git=$IS_GIT harness=$([ -n "$TEST_CMD" ] && echo on || echo off) pid=$$)" >> "$AUDIT"
[ "$IS_GIT" = 0 ] && { echo "$(date -u +%FT%TZ) [$SPEC] WARN TAMPER-GATE OFF (not a git repo — pre-existing test tamper undetectable; verdicts flagged tamperGate:off)" >> "$AUDIT"; touch "$SW/.tamper-gate-off"; }

iter=0; lasthash=""; noprog=0
while true; do
  [ -f "$STOPF" ] && { echo "$(date -u +%FT%TZ) [$SPEC] STOP (stop flag)" >> "$AUDIT"; break; }

  R="$(remaining)"; [ -z "$R" ] && R=0
  [ "$R" -eq 0 ] && { echo "$(date -u +%FT%TZ) [$SPEC] DONE (all tasks [x]/[~])" >> "$AUDIT"; break; }
  [ "$iter" -ge "$MAX" ] && { echo "$(date -u +%FT%TZ) [$SPEC] STOP maxIterations($MAX)" >> "$AUDIT"; break; }

  H="$(cat "$TASKS" "$SW/specs/$SPEC/verify-results/"*.json 2>/dev/null | cksum 2>/dev/null | awk '{print $1}')"
  if [ -n "$H" ] && [ "$H" = "$lasthash" ]; then noprog=$((noprog + 1)); else noprog=0; lasthash="$H"; fi
  [ "$noprog" -ge "$NOPROG_MAX" ] && { echo "$(date -u +%FT%TZ) [$SPEC] STOP noProgress($NOPROG_MAX)" >> "$AUDIT"; break; }

  iter=$((iter + 1))

  # 1) Pick the task (script owns selection + marks [-]).
  PICK="$($SWMCP pick "$SPEC" --project "$PWD" 2>>"$LOG")"
  TASKID="$(json_str "$PICK" taskId)"
  SCOPE="$(json_str "$PICK" tests)"
  [ -z "$TASKID" ] && { echo "$(date -u +%FT%TZ) [$SPEC] pick returned no task; stopping" >> "$AUDIT"; break; }

  echo "" >> "$LOG"; echo "===== iter $iter @ $(date -u +%FT%TZ) task=$TASKID scope='${SCOPE:-none}' (remaining=$R) =====" >> "$LOG"
  echo "$(date -u +%FT%TZ) [$SPEC] iter=$iter task=$TASKID remaining=$R" >> "$AUDIT"

  # 2) Tamper-gate baselines, captured AFTER pick (pick's own [-] write must not count as tampering).
  TASKS_BEFORE="$(cksum < "$TASKS" 2>/dev/null)"
  BASE=""; [ "$IS_GIT" = 1 ] && BASE="$(git -C "$PWD" status --porcelain 2>/dev/null)"

  # 3) Implement (agent does NOT verify and does NOT touch task markers).
  FIXNOTE=""; [ -f "$SW/.fixnote-$TASKID" ] && FIXNOTE="$(cat "$SW/.fixnote-$TASKID")"
  claude -p "Autonomous Phase 4 loop — ONE iteration — spec '$SPEC', task $TASKID, in this project. Call the spec-workflow-guide tool first if you have not this session. Implement EXACTLY task $TASKID (Claude implements by default; offload to Codex only if the task is tagged _Engine: codex) and WRITE its tests. The harness runs the tests and records the verdict — do NOT call verify-task, and do NOT edit task markers in tasks.md (no [x]/[-]/[~]). If you genuinely cannot complete it, output a single line starting 'BLOCKER:' with the reason and stop. Otherwise call log-implementation when done.${FIXNOTE:+ A previous attempt failed; fix these failures: $FIXNOTE}" \
    > "$SW/.iter-out" 2>&1
  cat "$SW/.iter-out" >> "$LOG"
  rm -f "$SW/.fixnote-$TASKID" >/dev/null 2>&1

  # 3b) Agent-reported blocker → record [~] (script writes state, not the agent).
  BLOCKER="$(grep -m1 '^BLOCKER:' "$SW/.iter-out" | sed 's/^BLOCKER:[[:space:]]*//')"
  if [ -n "$BLOCKER" ]; then
    $SWMCP verify "$SPEC" --task "$TASKID" --signal blocked --note "$BLOCKER" $TG --project "$PWD" >> "$LOG" 2>&1
    echo "$(date -u +%FT%TZ) [$SPEC] task=$TASKID BLOCKED (agent): $BLOCKER" >> "$AUDIT"
    continue
  fi

  # 4) L1 tamper gate: the agent must not modify tasks.md or pre-existing scoped test files.
  TAMPER=""
  # (b) tasks.md changed during the agent step (compared via content hash around the agent, so
  #     pick's own [-] write — which happened before TASKS_BEFORE — is not counted).
  if [ "$TASKS_BEFORE" != "$(cksum < "$TASKS" 2>/dev/null)" ]; then
    TAMPER="agent modified tasks.md"
  fi
  # (a) a PRE-EXISTING (modified, not added) file in the task's _Tests scope (git only).
  if [ -z "$TAMPER" ] && [ "$IS_GIT" = 1 ] && [ -n "$SCOPE" ]; then
    NOW="$(git -C "$PWD" status --porcelain 2>/dev/null)"
    for f in $SCOPE; do
      BN="$(basename "$f")"
      if printf '%s\n' "$NOW" | grep -qE "^ ?M.*${BN}$" && ! printf '%s\n' "$BASE" | grep -qE "${BN}$"; then
        TAMPER="modified pre-existing scoped test ($BN)"; break
      fi
    done
  fi
  if [ -n "$TAMPER" ]; then
    $SWMCP verify "$SPEC" --task "$TASKID" --signal blocked --note "tamper gate: $TAMPER — needs review" --project "$PWD" >> "$LOG" 2>&1
    echo "$(date -u +%FT%TZ) [$SPEC] task=$TASKID TAMPER: $TAMPER" >> "$AUDIT"
    continue
  fi

  # 5) L0 verdict — the HARNESS runs the scoped tests; exit code is the verdict.
  if [ -z "$TEST_CMD" ]; then
    # Deprecated fallback: no testCommand → let the agent's own (already-run) verify-task stand.
    echo "$(date -u +%FT%TZ) [$SPEC] task=$TASKID SELF-CERTIFIED (no testCommand)" >> "$AUDIT"
    continue
  fi
  if [ -z "$SCOPE" ]; then
    # No scoped tests → cannot independently verify; mark complete as verifiedBy:none (visible).
    $SWMCP verify "$SPEC" --task "$TASKID" --signal green $TG --project "$PWD" >> "$LOG" 2>&1
    echo "$(date -u +%FT%TZ) [$SPEC] task=$TASKID UNVERIFIED (no _Tests scope)" >> "$AUDIT"
    continue
  fi

  CMD="${TEST_CMD//\{tests\}/$SCOPE}"
  bash -c "$CMD" > "$SW/.testout" 2>&1; EC=$?
  TAIL="$(tail -c 600 "$SW/.testout" | tr '\n' ' ')"
  if [ "$EC" -eq 0 ]; then
    $SWMCP verify "$SPEC" --task "$TASKID" --signal green --exit-code 0 --scope "$SCOPE" $TG --project "$PWD" >> "$LOG" 2>&1
    echo "$(date -u +%FT%TZ) [$SPEC] task=$TASKID GREEN (harness exit 0)" >> "$AUDIT"

    # 6) L1 regression: run all COMPLETED scopes once (shared fixtures intact). Flag, don't block.
    DONE_SCOPES="$($SWMCP scopes "$SPEC" --status completed --project "$PWD" 2>/dev/null)"
    if [ -n "$DONE_SCOPES" ]; then
      bash -c "${TEST_CMD//\{tests\}/$DONE_SCOPES}" > "$SW/.regout" 2>&1
      if [ $? -ne 0 ]; then
        echo "$(date -u +%FT%TZ) [$SPEC] WARN REGRESSION after task=$TASKID (a previously-green scope now fails)" | tee -a "$AUDIT" >> "$LOG"
        touch "$SW/.regression"
      fi
    fi
  else
    VERDICT="$($SWMCP verify "$SPEC" --task "$TASKID" --signal red --exit-code "$EC" --scope "$SCOPE" --note "$TAIL" --max-fix "$MAXFIX" $TG --project "$PWD" 2>>"$LOG")"
    echo "$(date -u +%FT%TZ) [$SPEC] task=$TASKID RED (harness exit $EC)" >> "$AUDIT"
    # Stash the failing output so the next attempt at this task gets the context.
    printf '%s' "$TAIL" > "$SW/.fixnote-$TASKID"
  fi
done

rm -f "$PIDF" "$STOPF" "$SW/.iter-out" "$SW/.testout" "$SW/.regout" >/dev/null 2>&1
echo "$(date -u +%FT%TZ) [$SPEC] loop-run END (iterations=$iter)" >> "$AUDIT" 2>/dev/null
