#!/bin/bash
# L2 verification harness for the cross-family adequacy judge.
#
# Like test-loop-l1.sh, this installs deterministic fake `claude` and `codex` shims and runs the
# REAL spec-loop-run.sh, so the actual judge stage executes. The shims:
#   - answer the preflight,
#   - "implement" a task (write src/lib.js + tests/task<N>.test.js that passes the harness),
#   - act as the JUDGE when given the adequacy rubric, emitting a VERDICT controlled by env vars
#     (JUDGE_VERDICT / SEC_VERDICT / LOGIC_VERDICT) and logging which engine/lens judged to .judgelog.
#
# Covers: cross-family routing (claude->codex, codex->claude), judge pass, fail->reopen->cap,
# panel any-fail, no-verdict->skip (green kept), and judge disabled.
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
# run_scenario <name> <maxIter> <judgeMax> <judge:true|false> <tasks.md> <env assignments>
run_scenario(){
  local name="$1" maxit="$2" jmax="$3" judge="$4" tasks="$5" envs="$6"
  local T; T=$(mktemp -d); pushd "$T" >/dev/null
  git init -q; git config user.email t@t.t; git config user.name t
  mkdir -p src tests bin .spec-workflow/specs/s
  printf '%s\n' "$tasks" > .spec-workflow/specs/s/tasks.md
  : > .spec-workflow/specs/s/requirements.md
  cat > .spec-workflow/config.toml <<EOF
[engine]
default = "claude"
maxFixAttempts = 3
[loop]
autoLoop = true
maxIterations = $maxit
noProgressStop = 6
testCommand = "node --test {tests}"
judge = $judge
judgeMaxAttempts = $jmax
EOF
  cp "$TPL" .spec-workflow/spec-loop-run.sh
  sed -i "s|@@SWMCP_CMD@@|node \"$DIST\"|g" .spec-workflow/spec-loop-run.sh

  # fake claude: preflight / judge (rubric) / implement
  cat > bin/claude <<'SH'
#!/bin/bash
prompt="$*"
case "$prompt" in *"Reply with exactly: OK"*) echo OK; exit 0;; esac
case "$prompt" in
  *"adversarial verifier"*)
    case "$*" in
      *"--agent security-reviewer"*) echo "claude:security-reviewer" >> .judgelog; echo "VERDICT: ${SEC_VERDICT:-pass}"; exit 0;;
      *"--agent logic-reviewer"*)    echo "claude:logic-reviewer"    >> .judgelog; echo "VERDICT: ${LOGIC_VERDICT:-pass}"; exit 0;;
      *)                             echo "claude:primary"           >> .judgelog; echo "VERDICT: ${JUDGE_VERDICT:-pass}"; exit 0;;
    esac;;
esac
task="$(printf '%s' "$prompt" | grep -oE 'task [0-9]+' | head -1 | awk '{print $2}')"
mkdir -p src tests
echo "module.exports={add:(a,b)=>a+b}" > src/lib.js
printf 'const t=require("node:test"),a=require("node:assert");t("add",()=>{a.strictEqual(require("../src/lib").add(2,3),5)});\n' > "tests/task${task}.test.js"
exit 0
SH
  # fake codex: judge only (codex exec ... "<rubric>")
  cat > bin/codex <<'SH'
#!/bin/bash
case "$*" in
  *"adversarial verifier"*)
    echo "codex" >> .judgelog
    if [ "${JUDGE_EMPTY:-}" = "1" ]; then exit 0; fi                                  # truly no output
    if [ "${JUDGE_NOVERDICT:-}" = "1" ]; then echo "I cannot decide"; exit 0; fi      # output, no VERDICT line
    echo "VERDICT: ${JUDGE_VERDICT:-pass}"
    exit 0;;
esac
exit 0
SH
  chmod +x bin/claude bin/codex
  git add -A; git commit -qm init
  PATH="$T/bin:$PATH" env $envs timeout 180 bash .spec-workflow/spec-loop-run.sh s >/dev/null 2>&1
  popd >/dev/null
  SC_DIR="$T"
}
AUD(){ cat "$SC_DIR/.spec-workflow/loop-audit.log" 2>/dev/null; }
TKS(){ cat "$SC_DIR/.spec-workflow/specs/s/tasks.md" 2>/dev/null; }
JLOG(){ cat "$SC_DIR/.judgelog" 2>/dev/null; }
JJSON(){ cat "$SC_DIR/.spec-workflow/specs/s/verify-results/task-1.json" 2>/dev/null; }

T1='- [ ] 1. t1
  - _Tests: tests/task1.test.js_
  - _Prompt: x_'
T1_CODEX='- [ ] 1. t1
  - _Tests: tests/task1.test.js_
  - _Engine: codex_
  - _Prompt: x_'
T1_PANEL='- [ ] 1. t1
  - _Tests: tests/task1.test.js_
  - _Verify: panel_
  - _Prompt: x_'

run_scenario A 1 2 true "$T1" "JUDGE_VERDICT=pass"
JLOG | grep -q "codex" && ! JLOG | grep -q "claude:primary" && AUD | grep -q "JUDGE pass (codex)" && TKS | grep -q '\[x\] 1' && JJSON | grep -q '"engine": "codex"' \
  && ok "A claude task -> CODEX judges (cross-family), pass -> [x]" || no "A"; rm -rf "$SC_DIR"

run_scenario B 1 2 true "$T1_CODEX" "JUDGE_VERDICT=pass"
JLOG | grep -q "claude:primary" && ! JLOG | grep -q "^codex$" && AUD | grep -q "JUDGE pass (claude)" && JJSON | grep -q '"engine": "claude"' \
  && ok "B codex task -> CLAUDE judges (cross-family)" || no "B"; rm -rf "$SC_DIR"

run_scenario C 3 2 true "$T1" "JUDGE_VERDICT=fail"
AUD | grep -q "JUDGE fail" && TKS | grep -q '\[~\] 1' && [ "$(JJSON | grep -o '"attempts": [0-9]*' | grep -o '[0-9]*')" = "2" ] \
  && ok "C judge fail -> reopen -> block [~] at cap (attempts=2)" || no "C"; rm -rf "$SC_DIR"

run_scenario D 2 1 true "$T1_PANEL" "JUDGE_VERDICT=pass SEC_VERDICT=fail"
JLOG | grep -q "codex" && JLOG | grep -q "claude:security-reviewer" && JLOG | grep -q "claude:logic-reviewer" && AUD | grep -q "JUDGE fail" && TKS | grep -q '\[~\] 1' \
  && ok "D panel: any-fail (security) -> fail despite primary pass; all 3 lenses ran" || no "D"; rm -rf "$SC_DIR"

run_scenario E 1 2 true "$T1" "JUDGE_EMPTY=1"
AUD | grep -q "JUDGE skipped (no output" && TKS | grep -q '\[x\] 1' && JJSON | grep -q '"verdict": "skipped"' \
  && ok "E judge produced NO output -> skipped, green NOT lost" || no "E"; rm -rf "$SC_DIR"

# G: judge produced output but NO parseable VERDICT -> must NOT silently release; treated as fail.
run_scenario G 2 1 true "$T1" "JUDGE_NOVERDICT=1"
AUD | grep -q "JUDGE fail" && ! AUD | grep -q "JUDGE skipped" && TKS | grep -q '\[~\] 1' && JJSON | grep -q '"verdict": "fail"' \
  && ok "G judge output w/o VERDICT -> FAIL (not released), task reopened/blocked" || no "G"; rm -rf "$SC_DIR"

run_scenario F 1 2 false "$T1" ""
! AUD | grep -q "JUDGE" && TKS | grep -q '\[x\] 1' && ! JJSON | grep -q '"judge"' \
  && ok "F judge disabled -> no judge stage, green untouched" || no "F"; rm -rf "$SC_DIR"

echo ""
echo "L2 result: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
