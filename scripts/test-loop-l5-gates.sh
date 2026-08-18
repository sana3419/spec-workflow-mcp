#!/bin/bash
# L5 harness: remote (Telegram) gates + stop protocol + per-spec run state, against the REAL runner.
#
# The "human" is simulated by a background approver that writes an HMAC-signed decision into a fake
# $HOME/.spec-workflow/gates/<hash>/ exactly like the daemon does (src/core/gates.ts). Scenarios:
#   A  spec gate FAIL + gateOnSpecGateFail → approve → loop proceeds, result overriddenBy:gate
#   B  same, but decision has a WRONG hmac → ignored → timeout → abort (no task touched)
#   C  gateEveryTasks=1 → pending appears under specs/s/.run/gates, reject → STOP by=gate
#   D  `spec-workflow-mcp stop s --by tg:1` mid-run → STOP by=tg:1, .run/pid removed
#   E  double start refused while .run/pid alive
#   F  agent edits config.toml mid-run (testCommand="true") → STOP config changed, task 2 untouched
#   G  pending gate carries a runner signature (sig) the daemon can verify
#
#   bash scripts/test-loop-l5-gates.sh     # requires `npm run build`, node, git, openssl
set -u
REPO="$(cd "$(dirname "$0")/.." && pwd)"
TPL="$REPO/templates/spec-loop-run.sh"
DIST="$REPO/dist/index.js"
[ -f "$DIST" ] || { echo "dist/ missing — run 'npm run build' first"; exit 1; }
command -v node >/dev/null && command -v git >/dev/null && command -v openssl >/dev/null || { echo "node + git + openssl required"; exit 1; }

PASS=0; FAIL=0
ok(){ echo "  PASS: $1"; PASS=$((PASS+1)); }
no(){ echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

SECRET="$(openssl rand -hex 32)"
SC_DIR=""; FAKE_HOME=""
# run_scenario <loop-toml-extra> <SPEC_VERDICT> <approver: approve|reject|badhmac|none> [stopper]
run_scenario(){
  local extra="$1" verdict="$2" approver="$3" stopper="${4:-}"
  local T; T=$(mktemp -d); FAKE_HOME=$(mktemp -d); pushd "$T" >/dev/null
  git init -q; git config user.email t@t.t; git config user.name t
  mkdir -p src tests bin .spec-workflow/specs/s "$FAKE_HOME/.spec-workflow"
  printf 'GATE_SECRET=%s\n' "$SECRET" > "$FAKE_HOME/.spec-workflow/telegram.env"
  printf -- '- [ ] 1. t1\n  - _Tests: tests/task1.test.js_\n  - _Prompt: x_\n- [ ] 2. t2\n  - _Tests: tests/task2.test.js_\n  - _Prompt: y_\n' > .spec-workflow/specs/s/tasks.md
  printf '# Requirements\n1.1 add(a,b) returns the sum.\n' > .spec-workflow/specs/s/requirements.md
  {
    echo '[engine]'; echo 'default = "claude"'; echo 'maxFixAttempts = 3'
    echo '[loop]'; echo 'autoLoop = true'; echo 'maxIterations = 4'; echo 'noProgressStop = 6'
    echo 'testCommand = "node --test {tests}"'
    echo 'gateTimeoutMin = 1'
    printf '%s\n' "$extra"
  } > .spec-workflow/config.toml
  cp "$TPL" .spec-workflow/spec-loop-run.sh
  sed -i "s|@@SWMCP_CMD@@|node \"$DIST\"|g" .spec-workflow/spec-loop-run.sh
  cat > bin/claude <<'SH'
#!/bin/bash
prompt="$*"
case "$prompt" in *"Reply with exactly: OK"*) echo OK; exit 0;; esac
case "$prompt" in *"spec auditor"*) echo "VERDICT: ${SPEC_VERDICT:-pass}"; exit 0;; esac
task="$(printf '%s' "$prompt" | grep -oE 'task [0-9]+' | head -1 | awk '{print $2}')"
sleep "${IMPL_SLEEP:-0}"
mkdir -p src tests; echo "module.exports={add:(a,b)=>a+b}" > src/lib.js
printf 'const t=require("node:test"),a=require("node:assert");t("add",()=>{a.strictEqual(require("../src/lib").add(2,3),5)});\n' > "tests/task${task}.test.js"
[ "${TAMPER_CONFIG:-}" = 1 ] && [ "$task" = 1 ] && printf '\ntestCommand = "true"\n' >> .spec-workflow/config.toml
exit 0
SH
  cat > bin/codex <<'SH'
#!/bin/bash
case "$*" in *"spec auditor"*) echo "VERDICT: ${SPEC_VERDICT:-pass}"; exit 0;; esac
exit 0
SH
  chmod +x bin/claude bin/codex
  git add -A; git commit -qm init

  # Background approver: waits for a pending gate and answers it like the daemon would.
  local HASH; HASH="$(printf '%s' "$(realpath "$T")" | sha256sum | cut -c1-16)"
  local GDIR="$FAKE_HOME/.spec-workflow/gates/$HASH"
  if [ "$approver" != none ]; then
    (
      for _ in $(seq 1 60); do
        pend="$(ls "$T"/.spec-workflow/specs/s/.run/gates/*.pending 2>/dev/null | head -1)"
        if [ -n "$pend" ]; then
          cp "$pend" "$T/.captured-pending.json" 2>/dev/null
          id="$(sed -n 's/.*"id": *"\([^"]*\)".*/\1/p' "$pend")"; nonce="$(sed -n 's/.*"nonce": *"\([^"]*\)".*/\1/p' "$pend")"
          dec=approve; [ "$approver" = reject ] && dec=reject
          at="2026-08-18T00:00:00Z"; by="tg:42"
          hmac="$(printf '%s' "$id:$nonce:$dec:$by:$at" | openssl dgst -sha256 -hmac "$SECRET" | awk '{print $NF}')"
          [ "$approver" = badhmac ] && hmac="deadbeef"
          mkdir -p "$GDIR"
          # pretty-printed like a JSON.stringify(x, null, 2) writer would — the runner must tolerate spaces/newlines
          printf '{\n  "id": "%s",\n  "nonce": "%s",\n  "decision": "%s",\n  "by": "%s",\n  "at": "%s",\n  "hmac": "%s"\n}\n' "$id" "$nonce" "$dec" "$by" "$at" "$hmac" > "$GDIR/$id.json.tmp"
          mv "$GDIR/$id.json.tmp" "$GDIR/$id.json"
          exit 0
        fi
        sleep 0.5
      done
    ) &
  fi
  if [ "$stopper" = stop ]; then
    ( sleep 4; node "$DIST" stop s --by tg:1 --project "$T" >/dev/null 2>&1 ) &
  fi
  local extra_env=""; [ "$stopper" = stop ] && extra_env="IMPL_SLEEP=3"
  [ "$stopper" = tamper ] && extra_env="TAMPER_CONFIG=1"
  HOME="$FAKE_HOME" PATH="$T/bin:$PATH" env SPEC_VERDICT="$verdict" $extra_env timeout 150 bash .spec-workflow/spec-loop-run.sh s >/dev/null 2>&1
  wait
  popd >/dev/null
  SC_DIR="$T"
}
AUD(){ cat "$SC_DIR/.spec-workflow/loop-audit.log" 2>/dev/null; }
TKS(){ cat "$SC_DIR/.spec-workflow/specs/s/tasks.md" 2>/dev/null; }
RES(){ cat "$SC_DIR/.spec-workflow/specs/s/spec-gate-result.json" 2>/dev/null; }

echo "== L5 gates / stop / run-state =="

run_scenario $'specGate = true\ngateOnSpecGateFail = true' fail approve
AUD | grep -q "GATE pending .*kind=spec-gate-fail" && AUD | grep -q "GATE approve .*by=tg:42" && AUD | grep -q "SPEC-GATE overridden" \
  && RES | grep -q '"overriddenBy": "gate"' && RES | grep -q '"status": "fail"' && TKS | grep -q '\[x\] 1' \
  && ok "A spec-gate fail + approve → overridden (audited, status stays fail), loop proceeds" \
  || { no "A"; AUD | tail -8; }
[ ! -f "$SC_DIR/.spec-workflow/specs/s/.run/pid" ] && [ -z "$(ls "$SC_DIR"/.spec-workflow/specs/s/.run/gates/ 2>/dev/null)" ] \
  && ok "A2 .run/pid removed and pending gate consumed at END" || no "A2 run-state cleanup"

run_scenario $'specGate = true\ngateOnSpecGateFail = true' fail badhmac
AUD | grep -q "GATE .*INVALID decision" && AUD | grep -q "GATE timeout" && AUD | grep -q "ABORTED by spec gate" && TKS | grep -q '\[ \] 1' \
  && ok "B forged decision (bad hmac) ignored → timeout → abort, no task touched" || { no "B"; AUD | tail -6; }

run_scenario 'gateEveryTasks = 1' pass reject
AUD | grep -q "GATE pending .*kind=every-n-tasks" && AUD | grep -q "GATE reject" && AUD | grep -q "STOP by=gate" \
  && TKS | grep -q '\[x\] 1' && TKS | grep -q '\[ \] 2' \
  && ok "C every-n-tasks gate rejected → STOP after task 1, task 2 untouched" || { no "C"; AUD | tail -6; }
# C2: the runner-authored pending carries a signature the PACKAGE verifier (what the daemon uses) accepts,
#     and rejects under a different secret — runner↔daemon parity on the real artefact.
if [ -f "$SC_DIR/.captured-pending.json" ]; then
  GATE_SECRET="$SECRET" node "$DIST" gate-verify-pending "$SC_DIR/.captured-pending.json" 2>/dev/null | grep -q '^valid$' \
    && ! GATE_SECRET="$(openssl rand -hex 32)" node "$DIST" gate-verify-pending "$SC_DIR/.captured-pending.json" 2>/dev/null | grep -q '^valid$' \
    && ok "C2 runner-signed pending verifies with the daemon's verifier (and not under another secret)" || no "C2 pending signature parity"
else no "C2 (no pending captured)"; fi
# C3: the secret must never appear on any process command line while the runner signs/verifies
! grep -q "openssl dgst.*-hmac" "$TPL" && ok "C3 secret is not passed to openssl argv (env-fed helper)" || no "C3 secret on argv"

run_scenario '' pass none stop
AUD | grep -q "STOP by=tg:1" && AUD | grep -q "loop-run END reason=STOP" && [ ! -f "$SC_DIR/.spec-workflow/specs/s/.run/pid" ] \
  && ok "D CLI stop mid-run → STOP by=tg:1, pid cleaned" || { no "D"; AUD | tail -6; }

# E: double start refused
T=$(mktemp -d); mkdir -p "$T/.spec-workflow/specs/s/.run"
# a live process whose cmdline looks like a runner (the guard checks /proc/<pid>/cmdline on Linux)
( exec -a "bash .spec-workflow/spec-loop-run.sh s" sleep 20 ) & HOLDER=$!; sleep 0.2
echo "$HOLDER" > "$T/.spec-workflow/specs/s/.run/pid"
printf -- '- [ ] 1. t\n' > "$T/.spec-workflow/specs/s/tasks.md"; printf '[loop]\nautoLoop = true\n' > "$T/.spec-workflow/config.toml"
cp "$TPL" "$T/.spec-workflow/spec-loop-run.sh"; sed -i "s|@@SWMCP_CMD@@|node \"$DIST\"|g" "$T/.spec-workflow/spec-loop-run.sh"
mkdir -p "$T/bin"; printf '#!/bin/bash\necho OK\n' > "$T/bin/claude"; chmod +x "$T/bin/claude"
( cd "$T" && PATH="$T/bin:$PATH" bash .spec-workflow/spec-loop-run.sh s 2>&1 | grep -q "already running" ) && ok "E second start refused while .run/pid alive" || no "E double start"
kill "$HOLDER" 2>/dev/null
# E2: a stale pid (dead process) is reclaimed instead of blocking forever
echo 999999999 > "$T/.spec-workflow/specs/s/.run/pid"
( cd "$T" && PATH="$T/bin:$PATH" timeout 20 bash .spec-workflow/spec-loop-run.sh s >/dev/null 2>&1; true )
! grep -q 999999999 "$T/.spec-workflow/specs/s/.run/pid" 2>/dev/null && ok "E2 stale pid reclaimed" || no "E2 stale pid"

run_scenario '' pass none tamper
AUD | grep -q "config.toml changed" && AUD | grep -q "loop-run END reason=CONFIG_CHANGED" && TKS | grep -q '\[ \] 2' \
  && ok "F config.toml edited mid-run → STOP CONFIG_CHANGED, task 2 untouched" || { no "F"; AUD | tail -6; }

# G: pending is signed by the runner (start a gate, read the pending before it is consumed)
run_scenario 'gateEveryTasks = 1' pass none
# with no approver the gate times out (1 min); the pending file is removed on timeout, so inspect the audit only
AUD | grep -q "GATE pending .*kind=every-n-tasks" && AUD | grep -q "GATE timeout" \
  && ok "G unattended gate times out → treated as reject (no silent approve)" || { no "G"; AUD | tail -6; }

echo ""; echo "L5 result: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
