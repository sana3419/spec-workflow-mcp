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

# --- L2 cross-family adequacy judge helpers ---
parse_verdict() { printf '%s\n' "$1" | grep -ioE 'VERDICT:[[:space:]]*(pass|fail)' | tail -1 | grep -ioE 'pass|fail' | tr '[:upper:]' '[:lower:]'; }
parse_reasons() { printf '%s\n' "$1" | grep -iE 'REASONS:' | tail -1 | sed 's/.*[Rr][Ee][Aa][Ss][Oo][Nn][Ss]:[[:space:]]*//'; }
judge_rubric() {
  cat <<RUBRIC
You are an INDEPENDENT adversarial verifier from a DIFFERENT model family than the implementer, reviewing task $1 of spec "$SPEC" in this repository (READ-ONLY). The harness ALREADY confirmed its scoped tests PASS — do NOT re-run or re-judge pass/fail.
Read .spec-workflow/specs/$SPEC/requirements.md and .spec-workflow/specs/$SPEC/tasks.md (find task $1 and its _Requirements), the scoped test(s) [$2], and the implementation those tests cover.
Decide ONLY whether the tests are ADEQUATE:
1) they call the real implementation and assert meaningful behavior (NOT assert of a constant, tautologies, or everything mocked away);
2) they cover the requirements above;
3) task-type adversarial holes (for auth/security: default-deny, IDOR, secrets-not-logged, input validation).
End with EXACTLY one line "VERDICT: pass" or "VERDICT: fail"; if fail, add one line "REASONS: <one line>".
RUBRIC
}
# L2: judge a harness-green task. Cross-family (opposite of implementer engine); panel adds reviewer lenses.
run_judge() {
  local tid="$1" scope="$2" eng="$3" mode="$4"
  local opp; [ "$eng" = "codex" ] && opp="claude" || opp="codex"
  if [ "$opp" = "codex" ] && ! command -v codex >/dev/null 2>&1; then
    $SWMCP judge-record "$SPEC" --task "$tid" --verdict skipped --engine codex --reasons "codex CLI unavailable" --max "$JUDGE_MAX" --project "$PWD" >> "$LOG" 2>&1
    echo "$(date -u +%FT%TZ) [$SPEC] task=$tid JUDGE skipped (codex unavailable)" >> "$AUDIT"; return
  fi
  local rubric out v verdict="pass" reasons=""
  rubric="$(judge_rubric "$tid" "$scope")"
  if [ "$opp" = "codex" ]; then out="$(timeout 300 codex exec -s read-only --skip-git-repo-check -C "$PWD" "$rubric" </dev/null 2>/dev/null)"; else out="$(timeout 300 claude -p "$rubric" </dev/null 2>/dev/null)"; fi
  v="$(parse_verdict "$out")"
  if [ -z "$v" ]; then
    if [ -z "$(printf '%s' "$out" | tr -d '[:space:]')" ]; then
      # The judge produced NOTHING (timeout / engine error / unavailable). We cannot judge, so we
      # SKIP — green is kept (the judge can only downgrade; an infra failure must not block good work).
      $SWMCP judge-record "$SPEC" --task "$tid" --verdict skipped --engine "$opp" --reasons "judge produced no output" --max "$JUDGE_MAX" --project "$PWD" >> "$LOG" 2>&1
      echo "$(date -u +%FT%TZ) [$SPEC] task=$tid JUDGE skipped (no output from $opp)" >> "$AUDIT"; return
    fi
    # The judge SAID something but we could not parse a VERDICT. Do NOT silently release: a verdict we
    # cannot read is treated as FAIL (conservative — an unreadable objection must not become a pass).
    verdict="fail"; reasons="[$opp] unparseable judge output (no VERDICT line)"
  elif [ "$v" = "fail" ]; then
    verdict="fail"; reasons="[$opp] $(parse_reasons "$out")"
  fi
  if [ "$mode" = "panel" ]; then
    local lens lout lv
    for lens in security-reviewer logic-reviewer; do
      lout="$(timeout 300 claude -p --agent "$lens" "$rubric" 2>/dev/null)"
      lv="$(parse_verdict "$lout")"
      [ "$lv" = "fail" ] && { verdict="fail"; reasons="$reasons [$lens] $(parse_reasons "$lout")"; }
    done
  fi
  $SWMCP judge-record "$SPEC" --task "$tid" --verdict "$verdict" --engine "$opp" --reasons "$reasons" --max "$JUDGE_MAX" --project "$PWD" >> "$LOG" 2>&1
  if [ "$verdict" = "fail" ]; then
    printf '%s' "$reasons" > "$SW/.judgenote-$tid"
    echo "$(date -u +%FT%TZ) [$SPEC] task=$tid JUDGE fail ($opp${mode:+/$mode}): $reasons" >> "$AUDIT"
  else
    echo "$(date -u +%FT%TZ) [$SPEC] task=$tid JUDGE pass ($opp${mode:+/$mode})" >> "$AUDIT"
  fi
}

# --- L4 integration terminal gate ---
jesc() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g' | tr '\n\t' '  '; }
integration_rubric() {
  cat <<RUBRIC
You are an INDEPENDENT cross-module reviewer (READ-ONLY) for spec "$SPEC" in this repository. Every task passed its own scoped tests AND the assembled build/boot command succeeded. Your job: find CROSS-MODULE contract holes a green build cannot catch — API to frontend field/shape mismatches, middleware/assembly ordering, env/secret/bootstrap requirements, integration points that compile but will not interoperate.
Read .spec-workflow/specs/$SPEC/requirements.md, the Implementation Logs under .spec-workflow/specs/$SPEC/, and the build/boot output below:
---
$1
---
End with EXACTLY one line "VERDICT: pass" or "VERDICT: fail"; if fail, add one line "REASONS: <one line>".
RUBRIC
}
# Run the assembled build+boot once. Bounded auto-fix on failure; optional cross-module judge on green.
run_integration() {
  local attempt=0 ec=1 ts log
  ts="$(date -u +%Y%m%dT%H%M%SZ)"; mkdir -p "$SW/reports"; log="$SW/reports/integration-$ts.log"
  while :; do
    bash -c "$INTEG_CMD" > "$log" 2>&1; ec=$?
    [ "$ec" -eq 0 ] && break
    [ "$attempt" -ge "$INTEG_FIX" ] && break
    attempt=$((attempt+1))
    echo "$(date -u +%FT%TZ) [$SPEC] INTEGRATION fail (exit $ec) — auto-fix $attempt/$INTEG_FIX" >> "$AUDIT"
    claude -p "All tasks in spec '$SPEC' pass their own scoped tests, but the ASSEMBLED integration command failed: $INTEG_CMD. Failure output (tail): $(tail -c 1200 "$log" | tr '\n' ' '). Fix the cross-cutting integration issue (assembly, wiring, config, types, bootstrap) so the command passes. Do NOT weaken or delete any task's tests. Then stop." </dev/null >> "$LOG" 2>&1
  done

  local jverdict="none" jreasons=""
  if [ "$ec" -eq 0 ] && [ "$INTEG_JUDGE" = "true" ]; then
    local opp; [ "$ENGINE_DEFAULT" = "codex" ] && opp="claude" || opp="codex"
    [ "$opp" = "codex" ] && ! command -v codex >/dev/null 2>&1 && opp="claude"
    local rub jout jv
    rub="$(integration_rubric "$(tail -c 2000 "$log")")"
    if [ "$opp" = "codex" ]; then jout="$(timeout 300 codex exec -s read-only --skip-git-repo-check -C "$PWD" "$rub" </dev/null 2>/dev/null)"; else jout="$(timeout 300 claude -p "$rub" </dev/null 2>/dev/null)"; fi
    jv="$(parse_verdict "$jout")"
    if [ "$jv" = "fail" ]; then
      jverdict="fail"; jreasons="[$opp] $(parse_reasons "$jout")"
      if [ "$attempt" -lt "$INTEG_FIX" ]; then
        attempt=$((attempt+1))
        echo "$(date -u +%FT%TZ) [$SPEC] INTEGRATION judge fail ($opp) — auto-fix $attempt/$INTEG_FIX: $jreasons" >> "$AUDIT"
        claude -p "Spec '$SPEC' builds and boots, but a cross-module reviewer found an integration contract hole: $jreasons. Fix it so the modules interoperate; do NOT weaken any task's tests. Then stop." </dev/null >> "$LOG" 2>&1
        bash -c "$INTEG_CMD" >> "$log" 2>&1; ec=$?
      fi
    elif [ -n "$jv" ]; then
      jverdict="pass"
    else
      # Build/boot is green ground truth; an unreadable/empty advisory judge does NOT override it.
      jverdict="inconclusive"
    fi
  fi

  local status="pass"; { [ "$ec" -ne 0 ] || [ "$jverdict" = "fail" ]; } && status="fail"
  local blocked; blocked="$(grep -cE '^[[:space:]]*- \[~\]' "$TASKS" 2>/dev/null)"; case "$blocked" in ''|*[!0-9]*) blocked=0 ;; esac
  cat > "$SW/integration-result.json" <<JSON
{
  "spec": "$SPEC",
  "status": "$status",
  "exitCode": $ec,
  "command": "$(jesc "$INTEG_CMD")",
  "attempts": $attempt,
  "incompleteBlocked": $blocked,
  "judgeVerdict": "$jverdict",
  "judgeReasons": "$(jesc "$jreasons")",
  "log": "$log",
  "timestamp": "$(date -u +%FT%TZ)"
}
JSON
  if [ "$status" = "pass" ]; then
    rm -f "$SW/.integration-failed" >/dev/null 2>&1
    echo "$(date -u +%FT%TZ) [$SPEC] INTEGRATION pass (exit 0$([ "$INTEG_JUDGE" = true ] && echo ", judge $jverdict"))" >> "$AUDIT"
  else
    touch "$SW/.integration-failed"
    echo "$(date -u +%FT%TZ) [$SPEC] INTEGRATION fail (exit $ec, attempts $attempt$([ "$jverdict" = fail ] && echo ", judge fail: $jreasons"))" >> "$AUDIT"
  fi
}

# --- L3 spec gate (Specification Self-Correction, pre-flight) ---
spec_gate_rubric() {
  cat <<RUBRIC
You are an INDEPENDENT spec auditor (READ-ONLY) from a different model family, auditing spec "$SPEC" BEFORE any implementation. Read .spec-workflow/specs/$SPEC/requirements.md, design.md (if present), and tasks.md (including each task's _Tests selector and _Requirements).
Find SPEC-LEVEL hackability / underspecification that would let an implementation be "green" while missing intent. If the spec itself is wrong, the tests will faithfully verify the wrong thing — this is the LAST line of defense. Hunt for:
1) requirements that do NOT pin observable, measurable behavior (vague "should work / be secure / be fast");
2) _Tests selectors whose acceptance a trivial or tautological test could satisfy;
3) missing adversarial / edge / security requirements for the domain;
4) contradictions or gaps between requirements, design, and tasks.
Be strict, but only FAIL on holes that genuinely let wrong-but-green outcomes through.
End with EXACTLY "VERDICT: pass" or "VERDICT: fail"; if fail, add one line "REASONS: <one line>".
RUBRIC
}
# Pre-flight: a cross-family auditor checks the spec is sound enough to autonomously implement.
# Returns 0 to proceed, 1 to abort. Propose-only — never edits the spec.
run_spec_gate() {
  local opp; [ "$ENGINE_DEFAULT" = "codex" ] && opp="claude" || opp="codex"
  if [ "$opp" = "codex" ] && ! command -v codex >/dev/null 2>&1; then
    echo "$(date -u +%FT%TZ) [$SPEC] SPEC-GATE skipped (codex unavailable)" >> "$AUDIT"; return 0
  fi
  local rub out v reasons
  rub="$(spec_gate_rubric)"
  if [ "$opp" = "codex" ]; then out="$(timeout 300 codex exec -s read-only --skip-git-repo-check -C "$PWD" "$rub" </dev/null 2>/dev/null)"; else out="$(timeout 300 claude -p "$rub" </dev/null 2>/dev/null)"; fi
  v="$(parse_verdict "$out")"
  if [ "$v" = "fail" ]; then
    reasons="$(parse_reasons "$out")"
    cat > "$SW/spec-gate-result.json" <<JSON
{ "spec": "$SPEC", "status": "fail", "engine": "$opp", "reasons": "$(jesc "$reasons")", "timestamp": "$(date -u +%FT%TZ)" }
JSON
    touch "$SW/.spec-gate-failed"
    echo "$(date -u +%FT%TZ) [$SPEC] SPEC-GATE fail ($opp): $reasons" >> "$AUDIT"
    return 1
  fi
  rm -f "$SW/.spec-gate-failed" >/dev/null 2>&1
  if [ -n "$v" ]; then
    cat > "$SW/spec-gate-result.json" <<JSON
{ "spec": "$SPEC", "status": "pass", "engine": "$opp", "reasons": "", "timestamp": "$(date -u +%FT%TZ)" }
JSON
    echo "$(date -u +%FT%TZ) [$SPEC] SPEC-GATE pass ($opp)" >> "$AUDIT"
  else
    # No readable verdict — a soft pre-flight must not block all work on an infra/parse failure.
    echo "$(date -u +%FT%TZ) [$SPEC] SPEC-GATE advisory-pass ($opp produced no verdict)" >> "$AUDIT"
  fi
  return 0
}

AUTO="$(read_key loop autoLoop)"
if [ "$AUTO" != "true" ]; then
  echo "Auto-loop is OFF. Set [loop].autoLoop = true in $CONFIG (or ask Claude to) and re-run."
  exit 0
fi
MAX="$(read_key loop maxIterations)";        case "$MAX" in ''|*[!0-9]*) MAX=50 ;; esac
NOPROG_MAX="$(read_key loop noProgressStop)"; case "$NOPROG_MAX" in ''|*[!0-9]*) NOPROG_MAX=3 ;; esac
MAXFIX="$(read_key engine maxFixAttempts)";  case "$MAXFIX" in ''|*[!0-9]*) MAXFIX=5 ;; esac
TEST_CMD="$(read_str loop testCommand)"
JUDGE="$(read_key loop judge)"
JUDGE_MAX="$(read_key loop judgeMaxAttempts)"; case "$JUDGE_MAX" in ''|*[!0-9]*) JUDGE_MAX=2 ;; esac
INTEG_CMD="$(read_str loop integrationCommand)"
INTEG_FIX="$(read_key loop integrationFixAttempts)"; case "$INTEG_FIX" in ''|*[!0-9]*) INTEG_FIX=1 ;; esac
INTEG_JUDGE="$(read_key loop integrationJudge)"
SPEC_GATE="$(read_key loop specGate)"
ENGINE_DEFAULT="$(read_key engine default)"; [ -z "$ENGINE_DEFAULT" ] && ENGINE_DEFAULT="claude"

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

# L3 pre-flight spec gate — refuse to autonomously implement a spec too hackable/underspecified to verify.
if [ "$SPEC_GATE" = "true" ] && ! run_spec_gate; then
  echo "$(date -u +%FT%TZ) [$SPEC] loop-run ABORTED by spec gate — run /harden-spec or fix the spec, then re-run" >> "$AUDIT"
  rm -f "$PIDF" >/dev/null 2>&1
  exit 1
fi

iter=0; lasthash=""; noprog=0; EXIT_REASON=""
while true; do
  [ -f "$STOPF" ] && { EXIT_REASON=STOP; echo "$(date -u +%FT%TZ) [$SPEC] STOP (stop flag)" >> "$AUDIT"; break; }

  R="$(remaining)"; [ -z "$R" ] && R=0
  [ "$R" -eq 0 ] && { EXIT_REASON=DONE; echo "$(date -u +%FT%TZ) [$SPEC] DONE (all tasks [x]/[~])" >> "$AUDIT"; break; }
  [ "$iter" -ge "$MAX" ] && { EXIT_REASON=MAXITER; echo "$(date -u +%FT%TZ) [$SPEC] STOP maxIterations($MAX)" >> "$AUDIT"; break; }

  H="$(cat "$TASKS" "$SW/specs/$SPEC/verify-results/"*.json 2>/dev/null | cksum 2>/dev/null | awk '{print $1}')"
  if [ -n "$H" ] && [ "$H" = "$lasthash" ]; then noprog=$((noprog + 1)); else noprog=0; lasthash="$H"; fi
  [ "$noprog" -ge "$NOPROG_MAX" ] && { EXIT_REASON=NOPROGRESS; echo "$(date -u +%FT%TZ) [$SPEC] STOP noProgress($NOPROG_MAX)" >> "$AUDIT"; break; }

  iter=$((iter + 1))

  # 1) Pick the task (script owns selection + marks [-]).
  PICK="$($SWMCP pick "$SPEC" --project "$PWD" 2>>"$LOG")"
  TASKID="$(json_str "$PICK" taskId)"
  SCOPE="$(json_str "$PICK" tests)"
  ENGINE="$(json_str "$PICK" engine)"; [ -z "$ENGINE" ] && ENGINE="claude"
  VERIFYMODE="$(json_str "$PICK" verify)"
  [ -z "$TASKID" ] && { EXIT_REASON=NOTASK; echo "$(date -u +%FT%TZ) [$SPEC] pick returned no task; stopping" >> "$AUDIT"; break; }

  echo "" >> "$LOG"; echo "===== iter $iter @ $(date -u +%FT%TZ) task=$TASKID scope='${SCOPE:-none}' (remaining=$R) =====" >> "$LOG"
  echo "$(date -u +%FT%TZ) [$SPEC] iter=$iter task=$TASKID remaining=$R" >> "$AUDIT"

  # 2) Tamper-gate baselines, captured AFTER pick (pick's own [-] write must not count as tampering).
  TASKS_BEFORE="$(cksum < "$TASKS" 2>/dev/null)"
  BASE=""; [ "$IS_GIT" = 1 ] && BASE="$(git -C "$PWD" status --porcelain 2>/dev/null)"

  # 3) Implement (agent does NOT verify and does NOT touch task markers).
  FIXNOTE=""; [ -f "$SW/.fixnote-$TASKID" ] && FIXNOTE="$(cat "$SW/.fixnote-$TASKID")"
  JUDGENOTE=""; [ -f "$SW/.judgenote-$TASKID" ] && JUDGENOTE="$(cat "$SW/.judgenote-$TASKID")"
  claude -p "Autonomous Phase 4 loop — ONE iteration — spec '$SPEC', task $TASKID, in this project. Call the spec-workflow-guide tool first if you have not this session. Implement EXACTLY task $TASKID (Claude implements by default; offload to Codex only if the task is tagged _Engine: codex) and WRITE its tests. The harness runs the tests and records the verdict — do NOT call verify-task, and do NOT edit task markers in tasks.md (no [x]/[-]/[~]). If you genuinely cannot complete it, output a single line starting 'BLOCKER:' with the reason and stop. Otherwise call log-implementation when done.${FIXNOTE:+ A previous attempt failed; fix these failures: $FIXNOTE}${JUDGENOTE:+ A previous attempt had its TESTS judged inadequate: $JUDGENOTE — strengthen the tests to assert real behavior and cover the requirements; do not just make them pass again.}" \
    > "$SW/.iter-out" 2>&1
  cat "$SW/.iter-out" >> "$LOG"
  rm -f "$SW/.fixnote-$TASKID" "$SW/.judgenote-$TASKID" >/dev/null 2>&1

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

    # 7) L2 cross-family adequacy judge (opt-in). Runs only on a harness-exec green; can only reopen it.
    [ "$JUDGE" = "true" ] && run_judge "$TASKID" "$SCOPE" "$ENGINE" "$VERIFYMODE"
  else
    VERDICT="$($SWMCP verify "$SPEC" --task "$TASKID" --signal red --exit-code "$EC" --scope "$SCOPE" --note "$TAIL" --max-fix "$MAXFIX" $TG --project "$PWD" 2>>"$LOG")"
    echo "$(date -u +%FT%TZ) [$SPEC] task=$TASKID RED (harness exit $EC)" >> "$AUDIT"
    # Stash the failing output so the next attempt at this task gets the context.
    printf '%s' "$TAIL" > "$SW/.fixnote-$TASKID"
  fi
done

# L4 integration terminal gate — only when the spec genuinely reached DONE and a command is configured.
[ "$EXIT_REASON" = "DONE" ] && [ -n "$INTEG_CMD" ] && run_integration

rm -f "$PIDF" "$STOPF" "$SW/.iter-out" "$SW/.testout" "$SW/.regout" >/dev/null 2>&1
echo "$(date -u +%FT%TZ) [$SPEC] loop-run END (iterations=$iter)" >> "$AUDIT" 2>/dev/null
