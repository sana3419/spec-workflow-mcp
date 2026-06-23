#!/bin/bash
# L4 verification harness for the integration terminal gate.
#
# Fake claude/codex shims + an env-controlled fake integration command (integ.sh) drive the REAL
# spec-loop-run.sh, so the actual L4 stage executes. integ.sh passes/fails per INTEG_MODE; the fake
# claude "auto-fix" optionally repairs it (INTEG_FIXABLE); the fake codex acts as the cross-module
# judge (INTEG_JUDGE_VERDICT). Covers: pass, fail->fix->pass, fail->exhausted->fail, judge-fail,
# not-DONE skip, disabled.
set -u

REPO="$(cd "$(dirname "$0")/.." && pwd)"
TPL="$REPO/templates/spec-loop-run.sh"
DIST="$REPO/dist/index.js"
[ -f "$DIST" ] || { echo "dist/ missing — run 'npm run build' first"; exit 1; }
command -v node >/dev/null && command -v git >/dev/null || { echo "node + git required"; exit 1; }

PASS=0; FAIL=0
ok(){ echo "  PASS: $1"; PASS=$((PASS+1)); }
no(){ echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

SC_DIR=""
# run_scenario <name> <maxIter> <ifix> <ijudge> <with_integ:true|false> <tasks.md> <env...>
run_scenario(){
  local name="$1" maxit="$2" ifix="$3" ijudge="$4" withint="$5" tasks="$6" envs="$7"
  local T; T=$(mktemp -d); pushd "$T" >/dev/null
  git init -q; git config user.email t@t.t; git config user.name t
  mkdir -p src tests bin .spec-workflow/specs/s
  printf '%s\n' "$tasks" > .spec-workflow/specs/s/tasks.md
  : > .spec-workflow/specs/s/requirements.md
  {
    echo '[engine]'; echo 'default = "claude"'; echo 'maxFixAttempts = 3'
    echo '[loop]'; echo 'autoLoop = true'; echo "maxIterations = $maxit"; echo 'noProgressStop = 6'
    echo 'testCommand = "node --test {tests}"'
    if [ "$withint" = true ]; then
      echo 'integrationCommand = "bash integ.sh"'
      echo "integrationFixAttempts = $ifix"
      echo "integrationJudge = $ijudge"
    fi
  } > .spec-workflow/config.toml
  # env-controlled fake integration command
  cat > integ.sh <<'SH'
#!/bin/bash
case "${INTEG_MODE:-pass}" in
  pass) exit 0;;
  needfix) [ -f .integ-ok ] && exit 0 || { echo "assembled build FAILED: missing .integ-ok"; exit 1; };;
esac
SH
  cp "$TPL" .spec-workflow/spec-loop-run.sh
  sed -i "s|@@SWMCP_CMD@@|node \"$DIST\"|g" .spec-workflow/spec-loop-run.sh
  cat > bin/claude <<'SH'
#!/bin/bash
prompt="$*"
case "$prompt" in *"Reply with exactly: OK"*) echo OK; exit 0;; esac
case "$prompt" in *"adversarial verifier"*) echo "claude:primary" >> .judgelog; echo "VERDICT: ${JUDGE_VERDICT:-pass}"; exit 0;; esac
case "$prompt" in *"integration command failed"*|*"cross-module reviewer found"*) [ "${INTEG_FIXABLE:-0}" = "1" ] && touch .integ-ok; exit 0;; esac
task="$(printf '%s' "$prompt" | grep -oE 'task [0-9]+' | head -1 | awk '{print $2}')"
mkdir -p src tests; echo "module.exports={add:(a,b)=>a+b}" > src/lib.js
printf 'const t=require("node:test"),a=require("node:assert");t("add",()=>{a.strictEqual(require("../src/lib").add(2,3),5)});\n' > "tests/task${task}.test.js"
exit 0
SH
  cat > bin/codex <<'SH'
#!/bin/bash
case "$*" in
  *"cross-module reviewer"*) echo "codex-integ" >> .judgelog; echo "VERDICT: ${INTEG_JUDGE_VERDICT:-pass}"; exit 0;;
  *"adversarial verifier"*)  echo "codex" >> .judgelog; echo "VERDICT: ${JUDGE_VERDICT:-pass}"; exit 0;;
esac
exit 0
SH
  chmod +x bin/claude bin/codex integ.sh
  git add -A; git commit -qm init
  PATH="$T/bin:$PATH" env $envs timeout 180 bash .spec-workflow/spec-loop-run.sh s >/dev/null 2>&1
  popd >/dev/null
  SC_DIR="$T"
}
AUD(){ cat "$SC_DIR/.spec-workflow/loop-audit.log" 2>/dev/null; }
RES(){ cat "$SC_DIR/.spec-workflow/integration-result.json" 2>/dev/null; }
TKS(){ cat "$SC_DIR/.spec-workflow/specs/s/tasks.md" 2>/dev/null; }

T1='- [ ] 1. t1
  - _Tests: tests/task1.test.js_
  - _Prompt: x_'
T2='- [ ] 1. t1
  - _Tests: tests/task1.test.js_
  - _Prompt: x_

- [ ] 2. t2
  - _Tests: tests/task2.test.js_
  - _Prompt: x_'

run_scenario A 1 1 false true "$T1" "INTEG_MODE=pass"
AUD | grep -q "INTEGRATION pass" && RES | grep -q '"status": "pass"' && RES | grep -q '"attempts": 0' \
  && ok "A integration command passes -> INTEGRATION pass, no fix" || no "A"; rm -rf "$SC_DIR"

run_scenario B 1 1 false true "$T1" "INTEG_MODE=needfix INTEG_FIXABLE=1"
AUD | grep -q "auto-fix 1/1" && AUD | grep -q "INTEGRATION pass" && RES | grep -q '"status": "pass"' && RES | grep -q '"attempts": 1' \
  && ok "B integration fails -> bounded auto-fix repairs -> pass (attempts=1)" || no "B"; rm -rf "$SC_DIR"

run_scenario C 1 1 false true "$T1" "INTEG_MODE=needfix INTEG_FIXABLE=0"
AUD | grep -q "INTEGRATION fail" && [ -f "$SC_DIR/.spec-workflow/.integration-failed" ] && RES | grep -q '"status": "fail"' \
  && ok "C integration fails + fix exhausted -> INTEGRATION fail + marker" || no "C"; rm -rf "$SC_DIR"

run_scenario D 1 1 true true "$T1" "INTEG_MODE=pass INTEG_JUDGE_VERDICT=fail"
AUD | grep -q "INTEGRATION judge fail" && RES | grep -q '"judgeVerdict": "fail"' && RES | grep -q '"status": "fail"' && cat "$SC_DIR/.judgelog" 2>/dev/null | grep -q "codex-integ" \
  && ok "D build green + cross-module judge FAIL -> status fail (cross-family codex judge ran)" || no "D"; rm -rf "$SC_DIR"

run_scenario E 1 1 false true "$T2" "INTEG_MODE=pass"
! AUD | grep -q "INTEGRATION" && [ ! -f "$SC_DIR/.spec-workflow/integration-result.json" ] && AUD | grep -q "maxIterations" \
  && ok "E not DONE (maxIterations, task remains) -> integration NOT run" || no "E"; rm -rf "$SC_DIR"

run_scenario F 1 1 false false "$T1" "INTEG_MODE=pass"
! AUD | grep -q "INTEGRATION" && [ ! -f "$SC_DIR/.spec-workflow/integration-result.json" ] \
  && ok "F no integrationCommand -> no integration stage" || no "F"; rm -rf "$SC_DIR"

echo ""
echo "L4 result: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
