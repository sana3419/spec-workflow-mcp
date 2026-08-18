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
# Watch:  tail -f .spec-workflow/specs/<spec>/loop-run.log   (or Telegram: /status, /runlog)
# Stop:   spec-workflow-mcp stop <spec>   |  Telegram /stop <spec>
#         (writes .spec-workflow/specs/<spec>/.run/stop — JSON {by,at,nonce}, audited)
# Guardrails: .spec-workflow/config.toml [loop] (maxIterations, noProgressStop, testCommand, gates).
#
# Run-state layout (v3, per spec — concurrent specs never clobber each other):
#   specs/<spec>/.run/pid|stop|gates/<id>.pending|testout|regout|iter-out|fixnote-*|judgenote-*
#   specs/<spec>/loop-run.log, spec-gate-result.json, integration-result.json, .regression, ...
#   loop-audit.log stays PROJECT-wide (one event stream; every line is tagged [spec]).
# Remote gate DECISIONS live outside the project: ~/.spec-workflow/gates/<projectHash>/<id>.json
# (HMAC-signed with GATE_SECRET from ~/.spec-workflow/telegram.env) — see src/core/gates.ts.

set +e

SPEC="$1"
if [ -z "$SPEC" ]; then echo "usage: spec-loop-run.sh <spec-name>"; exit 1; fi
case "$SPEC" in *[!A-Za-z0-9._-]*|""|.|..|.*) echo "invalid spec name"; exit 1 ;; esac

SW=".spec-workflow"
SPECDIR="$SW/specs/$SPEC"
TASKS="$SPECDIR/tasks.md"
CONFIG="$SW/config.toml"
RUN="$SPECDIR/.run"
GATES="$RUN/gates"
LOG="$SPECDIR/loop-run.log"
AUDIT="$SW/loop-audit.log"
PIDF="$RUN/pid"
STOPF="$RUN/stop"
sha256_16() { { command -v sha256sum >/dev/null 2>&1 && sha256sum || shasum -a 256; } | cut -c1-16; }
PROJ_REAL="$(realpath "$PWD" 2>/dev/null || pwd -P)"
GATE_HOME="$HOME/.spec-workflow/gates/$(printf '%s' "$PROJ_REAL" | sha256_16)"
TG_ENV="$HOME/.spec-workflow/telegram.env"

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
json_str() { printf '%s' "$1" | tr -d '\n' | sed -n "s/.*\"$2\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" | head -1; }

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
    # Panel lenses: same-family reviewers that can only ADD a fail (the cross-family judge above is
    # the anchor and always runs first). Names come from the routed agent set for the task's scope
    # (tier-0 minus the judge itself), falling back to the classic security+logic pair.
    local lens lout lv lenses
    lenses="$($SWMCP route --files "${scope// /,}" --names --project "$PWD" 2>/dev/null | grep -E -- '-reviewer$' | head -4 | tr '\n' ' ')"
    [ -z "$lenses" ] && lenses="security-reviewer logic-reviewer"
    for lens in $lenses; do
      lout="$(timeout 300 claude -p --agent "$lens" "$rubric" </dev/null 2>/dev/null)"
      lv="$(parse_verdict "$lout")"
      [ "$lv" = "fail" ] && { verdict="fail"; reasons="$reasons [$lens] $(parse_reasons "$lout")"; }
    done
  fi
  $SWMCP judge-record "$SPEC" --task "$tid" --verdict "$verdict" --engine "$opp" --reasons "$reasons" --max "$JUDGE_MAX" --project "$PWD" >> "$LOG" 2>&1
  if [ "$verdict" = "fail" ]; then
    printf '%s' "$reasons" > "$RUN/judgenote-$tid"
    echo "$(date -u +%FT%TZ) [$SPEC] task=$tid JUDGE fail ($opp${mode:+/$mode}): $reasons" >> "$AUDIT"
  else
    echo "$(date -u +%FT%TZ) [$SPEC] task=$tid JUDGE pass ($opp${mode:+/$mode})" >> "$AUDIT"
  fi
}

# --- L4 integration terminal gate ---
jesc() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g' | tr '\n\t\r' '   ' | tr -d '\000-\010\013\014\016-\037'; }
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

  # Human gate on integration failure: approve = ONE more bounded fix round (never flips to pass).
  if { [ "$ec" -ne 0 ] || [ "$jverdict" = "fail" ]; } && [ "$GATE_ON_INTEGFAIL" = "true" ]; then
    if wait_gate integration-fail "Integration gate FAILED (exit $ec${jreasons:+, judge: $jreasons}). Approve for one more auto-fix round, reject to stop." "{\"exitCode\":$ec,\"attempts\":$attempt}"; then
      echo "$(date -u +%FT%TZ) [$SPEC] INTEGRATION extra fix round approved by gate" >> "$AUDIT"
      claude -p "The ASSEMBLED integration command for spec '$SPEC' still fails: $INTEG_CMD. Failure output (tail): $(tail -c 1200 "$log" | tr '\n' ' ').${jreasons:+ Cross-module reviewer said: $jreasons.} Fix the integration issue; do NOT weaken or delete any task's tests. Then stop." </dev/null >> "$LOG" 2>&1
      bash -c "$INTEG_CMD" >> "$log" 2>&1; ec=$?; attempt=$((attempt+1))
      [ "$ec" -eq 0 ] && jverdict="none"
    fi
  fi
  local status="pass"; { [ "$ec" -ne 0 ] || [ "$jverdict" = "fail" ]; } && status="fail"
  local blocked; blocked="$(grep -cE '^[[:space:]]*- \[~\]' "$TASKS" 2>/dev/null)"; case "$blocked" in ''|*[!0-9]*) blocked=0 ;; esac
  cat > "$SPECDIR/integration-result.json" <<JSON
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
    rm -f "$SPECDIR/.integration-failed" >/dev/null 2>&1
    echo "$(date -u +%FT%TZ) [$SPEC] INTEGRATION pass (exit 0$([ "$INTEG_JUDGE" = true ] && echo ", judge $jverdict"))" >> "$AUDIT"
  else
    touch "$SPECDIR/.integration-failed"
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
    cat > "$SPECDIR/spec-gate-result.json" <<JSON
{ "spec": "$SPEC", "status": "fail", "engine": "$opp", "reasons": "$(jesc "$reasons")", "timestamp": "$(date -u +%FT%TZ)" }
JSON
    touch "$SPECDIR/.spec-gate-failed"
    echo "$(date -u +%FT%TZ) [$SPEC] SPEC-GATE fail ($opp): $reasons" >> "$AUDIT"
    return 1
  fi
  rm -f "$SPECDIR/.spec-gate-failed" >/dev/null 2>&1
  if [ -n "$v" ]; then
    cat > "$SPECDIR/spec-gate-result.json" <<JSON
{ "spec": "$SPEC", "status": "pass", "engine": "$opp", "reasons": "", "timestamp": "$(date -u +%FT%TZ)" }
JSON
    echo "$(date -u +%FT%TZ) [$SPEC] SPEC-GATE pass ($opp)" >> "$AUDIT"
  else
    # No readable verdict — a soft pre-flight must not block all work on an infra/parse failure.
    echo "$(date -u +%FT%TZ) [$SPEC] SPEC-GATE advisory-pass ($opp produced no verdict)" >> "$AUDIT"
  fi
  return 0
}

# --- Remote approval gates (Telegram) ---
# The runner writes a PENDING request inside the project; a human decides via the Telegram daemon,
# which writes an HMAC-signed DECISION OUTSIDE the project (the implementing agent cannot forge it).
# Approve on a spec-gate fail = override-and-proceed (audited). Approve on an integration fail =
# one more bounded fix round. Timeout / reject / no secret = the conservative default (stop).
gate_secret() { [ -f "$TG_ENV" ] && sed -n 's/^GATE_SECRET=//p' "$TG_ENV" | head -1 | tr -d "\"'\r" | tr -d '[:space:]'; }
# The secret NEVER goes on a command line (it would show in ps / /proc/*/cmdline to the implementing agent):
# it is passed to the package's helper via the environment; the helper computes HMAC-SHA256 in-process.
gate_hmac()   { GATE_SECRET="$6" $SWMCP gate-hmac "$1" "$2" "$3" "$4" "$5" 2>/dev/null; }
gate_sign()   { GATE_SECRET="$5" $SWMCP gate-sign "$1" "$2" "$3" "$4" 2>/dev/null; }
# wait_gate <kind> <summary> [detail-json-object]  → 0 approve, 1 reject/timeout/unavailable
wait_gate() {
  local kind="$1" summary="$2" detail="${3:-{\}}"
  local secret; secret="$(gate_secret)"
  if [ -z "$secret" ] || ! command -v openssl >/dev/null 2>&1; then
    echo "$(date -u +%FT%TZ) [$SPEC] GATE unavailable kind=$kind (no GATE_SECRET / openssl) — treating as reject" >> "$AUDIT"; return 1
  fi
  local selftest; selftest="$(gate_hmac x y approve z w "$secret")"
  case "$selftest" in ????????????????????????????????????????????????????????????????) ;; *) echo "$(date -u +%FT%TZ) [$SPEC] GATE unavailable kind=$kind (hmac helper failed) — treating as reject" >> "$AUDIT"; return 1 ;; esac
  local id nonce now
  nonce="$(openssl rand -hex 16)"; now="$(date -u +%FT%TZ)"
  id="$SPEC-$kind-$$-$(date -u +%Y%m%dT%H%M%SZ)"
  mkdir -p "$GATES" "$GATE_HOME" 2>/dev/null
  PEND_ACTIVE="$GATES/$id.pending"; local pend="$PEND_ACTIVE"
  local sig; sig="$(gate_sign "$id" "$nonce" "$kind" "$now" "$secret")"
  cat > "$pend.tmp" <<JSON
{ "id": "$id", "spec": "$SPEC", "kind": "$kind", "nonce": "$nonce", "summary": "$(jesc "$summary")", "createdAt": "$now", "detail": $detail, "sig": "$sig" }
JSON
  mv -f "$pend.tmp" "$pend"
  [ -f "$pend" ] || { echo "$(date -u +%FT%TZ) [$SPEC] GATE unavailable kind=$kind (cannot write pending) — treating as reject" >> "$AUDIT"; return 1; }
  echo "$(date -u +%FT%TZ) [$SPEC] GATE pending id=$id kind=$kind timeout=${GATE_TIMEOUT}m" >> "$AUDIT"
  local deadline=$(( $(date +%s) + GATE_TIMEOUT*60 )) dec dfile d_id d_nonce d_dec d_by d_at d_hmac
  while [ "$(date +%s)" -lt "$deadline" ]; do
    [ -f "$STOPF" ] && { echo "$(date -u +%FT%TZ) [$SPEC] GATE id=$id aborted (stop requested)" >> "$AUDIT"; rm -f "$pend"; return 1; }
    dfile="$GATE_HOME/$id.json"
    if [ -f "$dfile" ]; then
      dec="$(cat "$dfile" 2>/dev/null)"
      d_id="$(json_str "$dec" id)"; d_nonce="$(json_str "$dec" nonce)"; d_dec="$(json_str "$dec" decision)"
      d_by="$(json_str "$dec" by)";  d_at="$(json_str "$dec" at)";       d_hmac="$(json_str "$dec" hmac)"
      local expect_hmac; expect_hmac="$(gate_hmac "$id" "$nonce" "$d_dec" "$d_by" "$d_at" "$secret")"
      if [ "$d_id" = "$id" ] && [ "$d_nonce" = "$nonce" ] && [ -n "$d_hmac" ] && [ -n "$expect_hmac" ] && [ "$expect_hmac" = "$d_hmac" ]; then
        rm -f "$pend"
        echo "$(date -u +%FT%TZ) [$SPEC] GATE $d_dec id=$id by=$d_by at=$d_at" >> "$AUDIT"
        [ "$d_dec" = "approve" ] && return 0 || return 1
      fi
      echo "$(date -u +%FT%TZ) [$SPEC] GATE id=$id INVALID decision file (bad hmac/nonce) — ignored" >> "$AUDIT"
      mv -f "$dfile" "$dfile.invalid" 2>/dev/null
    fi
    sleep 5
  done
  rm -f "$pend"; PEND_ACTIVE=""
  echo "$(date -u +%FT%TZ) [$SPEC] GATE timeout id=$id after ${GATE_TIMEOUT}m — treating as reject" >> "$AUDIT"; return 1
}

# Failure classification for a red verdict (harness-authored, from the test output + exit code).
classify_failure() {  # <exit-code> <output-file>
  local ec="$1" f="$2"
  if [ "$ec" -eq 124 ] || [ "$ec" -eq 137 ]; then echo timeout; return; fi
  if grep -qiE "Cannot find module|command not found|ENOENT|ECONNREFUSED|EACCES|No such file or directory|not installed" "$f" 2>/dev/null; then echo env; return; fi
  if grep -qiE "error TS[0-9]+|SyntaxError|Build failed|compilation failed|cannot compile|tsc.*error" "$f" 2>/dev/null; then echo build-fail; return; fi
  echo test-fail
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
GATE_ON_SPECFAIL="$(read_key loop gateOnSpecGateFail)"
GATE_ON_INTEGFAIL="$(read_key loop gateOnIntegrationFail)"
GATE_EVERY="$(read_key loop gateEveryTasks)"; case "$GATE_EVERY" in ''|*[!0-9]*) GATE_EVERY=0 ;; esac
GATE_TIMEOUT="$(read_key loop gateTimeoutMin)"; case "$GATE_TIMEOUT" in ''|*[!0-9]*) GATE_TIMEOUT=60 ;; esac
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

mkdir -p "$RUN" "$GATES" 2>/dev/null
# Atomic pid lock (noclobber): two simultaneous starts cannot both win. A stale pid (dead process, or a
# reused pid that is not a runner) is reclaimed.
OLDPID="$(cat "$PIDF" 2>/dev/null)"
if [ -n "$OLDPID" ] && kill -0 "$OLDPID" 2>/dev/null; then
  if [ ! -r "/proc/$OLDPID/cmdline" ] || tr '\0' ' ' < "/proc/$OLDPID/cmdline" 2>/dev/null | grep -q "spec-loop-run.sh"; then
    echo "A loop is already running for '$SPEC' (pid $OLDPID). Stop it first."; exit 1
  fi
fi
rm -f "$PIDF"
if ! ( set -o noclobber; echo $$ > "$PIDF" ) 2>/dev/null; then
  echo "A loop is already running for '$SPEC' (pid $(cat "$PIDF" 2>/dev/null)). Stop it first."; exit 1
fi
rm -f "$STOPF" "$GATES"/*.pending >/dev/null 2>&1   # a stale stop/gate must never act on THIS run
PEND_ACTIVE=""
on_signal() {
  echo "$(date -u +%FT%TZ) [$SPEC] loop-run END reason=SIGNAL (interrupted)" >> "$AUDIT" 2>/dev/null
  rm -f "$PIDF" "$PEND_ACTIVE" "$RUN/iter-out" "$RUN/testout" "$RUN/regout" >/dev/null 2>&1
  exit 130
}
trap on_signal INT TERM
if [ -z "$TEST_CMD" ]; then
  echo "$(date -u +%FT%TZ) [$SPEC] WARN SELF-CERTIFIED (no [loop].testCommand — verification NOT independent, DEPRECATED)" | tee -a "$AUDIT" >> "$LOG"
fi
echo "$(date -u +%FT%TZ) [$SPEC] loop-run START (max=$MAX noProgress=$NOPROG_MAX git=$IS_GIT harness=$([ -n "$TEST_CMD" ] && echo on || echo off) pid=$$)" >> "$AUDIT"
[ "$IS_GIT" = 0 ] && { echo "$(date -u +%FT%TZ) [$SPEC] WARN TAMPER-GATE OFF (not a git repo — pre-existing test tamper undetectable; verdicts flagged tamperGate:off)" >> "$AUDIT"; touch "$SPECDIR/.tamper-gate-off"; }

# L3 pre-flight spec gate — refuse to autonomously implement a spec too hackable/underspecified to verify.
if [ "$SPEC_GATE" = "true" ] && ! run_spec_gate; then
  SG_REASON="$(json_str "$(cat "$SPECDIR/spec-gate-result.json" 2>/dev/null)" reasons)"
  if [ "$GATE_ON_SPECFAIL" = "true" ] && wait_gate spec-gate-fail "Spec gate FAILED — approve to override and implement anyway (audited), reject to stop." "{\"reasons\":\"$(jesc "$SG_REASON")\"}"; then
    # Override is recorded in the result file so it is never mistaken for a pass.
    sed 's/"status": "fail"/"status": "fail", "overriddenBy": "gate"/' "$SPECDIR/spec-gate-result.json" > "$SPECDIR/spec-gate-result.json.tmp" 2>/dev/null && mv -f "$SPECDIR/spec-gate-result.json.tmp" "$SPECDIR/spec-gate-result.json"
    echo "$(date -u +%FT%TZ) [$SPEC] SPEC-GATE overridden by human gate — proceeding" >> "$AUDIT"
  else
    echo "$(date -u +%FT%TZ) [$SPEC] loop-run ABORTED by spec gate — run /harden-spec or fix the spec, then re-run" >> "$AUDIT"
    rm -f "$PIDF" >/dev/null 2>&1
    exit 1
  fi
fi

CONFIG_SUM="$(cksum < "$CONFIG" 2>/dev/null)"
iter=0; lasthash=""; noprog=0; GREENS=0; EXIT_REASON=""
while true; do
  # The agent must not retune the harness under us (testCommand="true", judge=false, gate knobs...).
  if [ "$(cksum < "$CONFIG" 2>/dev/null)" != "$CONFIG_SUM" ]; then
    EXIT_REASON=CONFIG_CHANGED; echo "$(date -u +%FT%TZ) [$SPEC] STOP config.toml changed during the run — refusing to continue with a possibly weakened harness" >> "$AUDIT"; break
  fi
  [ -f "$STOPF" ] && { EXIT_REASON=STOP; echo "$(date -u +%FT%TZ) [$SPEC] STOP by=$(json_str "$(cat "$STOPF" 2>/dev/null)" by)" >> "$AUDIT"; break; }

  R="$(remaining)"; [ -z "$R" ] && R=0
  [ "$R" -eq 0 ] && { EXIT_REASON=DONE; echo "$(date -u +%FT%TZ) [$SPEC] DONE (all tasks [x]/[~])" >> "$AUDIT"; break; }
  [ "$iter" -ge "$MAX" ] && { EXIT_REASON=MAXITER; echo "$(date -u +%FT%TZ) [$SPEC] STOP maxIterations($MAX)" >> "$AUDIT"; break; }

  H="$(cat "$TASKS" "$SPECDIR/verify-results/"*.json 2>/dev/null | cksum 2>/dev/null | awk '{print $1}')"
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
  # _Tests: comes from tasks.md (repo-controlled) and is substituted into testCommand → whitelist its characters.
  case "$SCOPE" in *[!A-Za-z0-9._/@*:,\ {}=-]*)
    $SWMCP verify "$SPEC" --task "$TASKID" --signal blocked --note "unsafe _Tests selector (characters outside [A-Za-z0-9._/@*:,{}= -])" $TG --project "$PWD" >> "$LOG" 2>&1
    echo "$(date -u +%FT%TZ) [$SPEC] task=$TASKID BLOCKED (unsafe _Tests selector)" >> "$AUDIT"; continue ;;
  esac

  echo "" >> "$LOG"; echo "===== iter $iter @ $(date -u +%FT%TZ) task=$TASKID scope='${SCOPE:-none}' (remaining=$R) =====" >> "$LOG"
  echo "$(date -u +%FT%TZ) [$SPEC] iter=$iter task=$TASKID remaining=$R" >> "$AUDIT"

  # 2) Tamper-gate baselines, captured AFTER pick (pick's own [-] write must not count as tampering).
  TASKS_BEFORE="$(cksum < "$TASKS" 2>/dev/null)"
  BASE=""; [ "$IS_GIT" = 1 ] && BASE="$(git -C "$PWD" status --porcelain 2>/dev/null)"

  # 3) Implement (agent does NOT verify and does NOT touch task markers).
  FIXNOTE=""; [ -f "$RUN/fixnote-$TASKID" ] && FIXNOTE="$(cat "$RUN/fixnote-$TASKID")"
  JUDGENOTE=""; [ -f "$RUN/judgenote-$TASKID" ] && JUDGENOTE="$(cat "$RUN/judgenote-$TASKID")"
  claude -p "Autonomous Phase 4 loop — ONE iteration — spec '$SPEC', task $TASKID, in this project. Call the spec-workflow-guide tool first if you have not this session. Implement EXACTLY task $TASKID (Claude implements by default; offload to Codex only if the task is tagged _Engine: codex) and WRITE its tests. The harness runs the tests and records the verdict — do NOT call verify-task, and do NOT edit task markers in tasks.md (no [x]/[-]/[~]). If you genuinely cannot complete it, output a single line starting 'BLOCKER:' with the reason and stop. Otherwise call log-implementation when done.${FIXNOTE:+ A previous attempt failed; fix these failures: $FIXNOTE}${JUDGENOTE:+ A previous attempt had its TESTS judged inadequate: $JUDGENOTE — strengthen the tests to assert real behavior and cover the requirements; do not just make them pass again.}" \
    > "$RUN/iter-out" 2>&1
  cat "$RUN/iter-out" >> "$LOG"
  rm -f "$RUN/fixnote-$TASKID" "$RUN/judgenote-$TASKID" >/dev/null 2>&1

  # 3b) Agent-reported blocker → record [~] (script writes state, not the agent).
  BLOCKER="$(grep -m1 '^BLOCKER:' "$RUN/iter-out" | sed 's/^BLOCKER:[[:space:]]*//')"
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
  bash -c "$CMD" > "$RUN/testout" 2>&1; EC=$?
  TAIL="$(tail -c 600 "$RUN/testout" | tr '\n' ' ')"
  if [ "$EC" -eq 0 ]; then
    $SWMCP verify "$SPEC" --task "$TASKID" --signal green --exit-code 0 --scope "$SCOPE" $TG --project "$PWD" >> "$LOG" 2>&1
    echo "$(date -u +%FT%TZ) [$SPEC] task=$TASKID GREEN (harness exit 0)" >> "$AUDIT"

    # 6) L1 regression: run all COMPLETED scopes once (shared fixtures intact). Flag, don't block.
    DONE_SCOPES="$($SWMCP scopes "$SPEC" --status completed --project "$PWD" 2>/dev/null)"
    if [ -n "$DONE_SCOPES" ]; then
      bash -c "${TEST_CMD//\{tests\}/$DONE_SCOPES}" > "$RUN/regout" 2>&1
      if [ $? -ne 0 ]; then
        echo "$(date -u +%FT%TZ) [$SPEC] WARN REGRESSION after task=$TASKID (a previously-green scope now fails)" | tee -a "$AUDIT" >> "$LOG"
        touch "$SPECDIR/.regression"
      fi
    fi

    # 7) L2 cross-family adequacy judge (opt-in). Runs only on a harness-exec green; can only reopen it.
    [ "$JUDGE" = "true" ] && run_judge "$TASKID" "$SCOPE" "$ENGINE" "$VERIFYMODE"

    # 8) Optional human checkpoint every N green tasks (never inside L0/L1 — ground truth doesn't wait).
    GREENS=$((GREENS + 1))
    if [ "$GATE_EVERY" -gt 0 ] && [ $((GREENS % GATE_EVERY)) -eq 0 ]; then
      REM="$(remaining)"; [ -z "$REM" ] && REM=0
      if ! wait_gate every-n-tasks "$GREENS tasks green so far ($REM remaining). Approve to continue, reject to stop." "{\"greens\":$GREENS,\"remaining\":$REM}"; then
        EXIT_REASON=STOP; echo "$(date -u +%FT%TZ) [$SPEC] STOP by=gate (every-n-tasks rejected/timeout)" >> "$AUDIT"; break
      fi
    fi
  else
    FCLASS="$(classify_failure "$EC" "$RUN/testout")"
    VERDICT="$($SWMCP verify "$SPEC" --task "$TASKID" --signal red --exit-code "$EC" --scope "$SCOPE" --note "$TAIL" --failure-class "$FCLASS" --max-fix "$MAXFIX" $TG --project "$PWD" 2>>"$LOG")"
    echo "$(date -u +%FT%TZ) [$SPEC] task=$TASKID RED (harness exit $EC, class=$FCLASS)" >> "$AUDIT"
    # Stash the failing output so the next attempt at this task gets the context.
    printf '%s' "$TAIL" > "$RUN/fixnote-$TASKID"
  fi
done

# L4 integration terminal gate — only when the spec genuinely reached DONE and a command is configured.
[ "$EXIT_REASON" = "DONE" ] && [ -n "$INTEG_CMD" ] && run_integration

rm -f "$PIDF" "$STOPF" "$RUN/iter-out" "$RUN/testout" "$RUN/regout" "$GATES"/*.pending >/dev/null 2>&1
echo "$(date -u +%FT%TZ) [$SPEC] loop-run END reason=${EXIT_REASON:-UNKNOWN} iterations=$iter" >> "$AUDIT" 2>/dev/null
