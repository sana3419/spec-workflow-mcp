#!/bin/bash
# L1 verification harness for the background loop (spec-loop-run.sh).
#
# Refactoring the tamper gate (L1) can't be validated by "the happy path stayed green". This driver
# installs a deterministic fake `claude` shim that PERFORMS each malicious/edge action, then runs the
# REAL spec-loop-run.sh so the actual gate code executes, and asserts on the audit log + tasks.md.
#
# Covers: (A) modify a pre-existing scoped test, (B) edit the _Tests: line, (C) cross-task
# regression, (D) agent BLOCKER, (E) pick's [-] write must NOT be flagged as tampering.
#
#   bash scripts/test-loop-l1.sh        # requires `npm run build` first (needs dist/) and node + git
set -u

REPO="$(cd "$(dirname "$0")/.." && pwd)"
TPL="$REPO/templates/spec-loop-run.sh"
DIST="$REPO/dist/index.js"
[ -f "$DIST" ] || { echo "dist/ missing — run 'npm run build' first"; exit 1; }
command -v node >/dev/null || { echo "node required"; exit 1; }
command -v git  >/dev/null || { echo "git required";  exit 1; }

PASS=0; FAIL=0
ok(){ echo "  PASS: $1"; PASS=$((PASS+1)); }
no(){ echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

SC_DIR=""
# run_scenario <name> <maxIter> <tasks.md body> <shim body using $task> [nogit]
run_scenario(){
  local name="$1" maxit="$2" tasks="$3" shim="$4" nogit="${5:-}"
  local T; T=$(mktemp -d); pushd "$T" >/dev/null
  [ "$nogit" = nogit ] || { git init -q; git config user.email t@t.t; git config user.name t; }
  mkdir -p src tests bin .spec-workflow/specs/s
  printf '%s\n' "$tasks" > .spec-workflow/specs/s/tasks.md
  cat > .spec-workflow/config.toml <<EOF
[engine]
default = "claude"
maxFixAttempts = 3
[loop]
autoLoop = true
maxIterations = $maxit
noProgressStop = 5
testCommand = "node --test {tests}"
EOF
  # A committed, passing, pre-existing scoped test (target for scenario A).
  cat > tests/task1.test.js <<'EOF'
const t=require('node:test'),a=require('node:assert');t('add',()=>{a.strictEqual(require('../src/lib').add(2,3),5)});
EOF
  cp "$TPL" .spec-workflow/spec-loop-run.sh
  sed -i "s|@@SWMCP_CMD@@|node \"$DIST\"|g" .spec-workflow/spec-loop-run.sh
  cat > bin/claude <<EOF
#!/bin/bash
prompt="\$*"
case "\$prompt" in *"Reply with exactly: OK"*) echo OK; exit 0;; esac
task="\$(printf '%s' "\$prompt" | grep -oE 'task [0-9]+' | head -1 | awk '{print \$2}')"
$shim
EOF
  chmod +x bin/claude
  [ "$nogit" = nogit ] || { git add -A; git commit -qm init; }
  PATH="$T/bin:$PATH" timeout 120 bash .spec-workflow/spec-loop-run.sh s >/dev/null 2>&1
  popd >/dev/null
  SC_DIR="$T"
}
AUD(){ cat "$SC_DIR/.spec-workflow/loop-audit.log"; }
TKS(){ cat "$SC_DIR/.spec-workflow/specs/s/tasks.md"; }

T1='- [ ] 1. t1
  - _Tests: tests/task1.test.js_
  - _Prompt: x_'
T12='- [ ] 1. t1
  - _Tests: tests/task1.test.js_
  - _Prompt: x_

- [ ] 2. t2
  - _Tests: tests/task2.test.js_
  - _Prompt: x_'

run_scenario A 1 "$T1" '
echo "module.exports={add:(a,b)=>a+b}" > src/lib.js
echo "// weaken the pre-existing test" >> tests/task1.test.js'
AUD | grep -q "TAMPER: modified pre-existing scoped test" && TKS | grep -q '\[~\] 1' \
  && ok "A modify pre-existing scoped test -> blocked" || no "A"; rm -rf "$SC_DIR"

run_scenario B 1 "$T1" '
echo "module.exports={add:(a,b)=>a+b}" > src/lib.js
sed -i "s#_Tests: tests/task1.test.js_#_Tests: tests/trivial.test.js_#" .spec-workflow/specs/s/tasks.md'
AUD | grep -q "TAMPER: agent modified tasks.md" && TKS | grep -q '\[~\] 1' \
  && ok "B edit _Tests: line -> blocked" || no "B"; rm -rf "$SC_DIR"

run_scenario C 2 "$T12" '
if [ "$task" = "1" ]; then
  echo "module.exports={add:(a,b)=>a+b}" > src/lib.js
else
  echo "module.exports={add:(a,b)=>a-b,mul:(a,b)=>a*b}" > src/lib.js
  echo "const t=require(\"node:test\"),a=require(\"node:assert\");t(\"mul\",()=>{a.strictEqual(require(\"../src/lib\").mul(2,3),6)});" > tests/task2.test.js
fi'
AUD | grep -q "REGRESSION after task=2" && TKS | grep -q '\[x\] 2' && [ -f "$SC_DIR/.spec-workflow/.regression" ] \
  && ok "C cross-task regression flagged, task2 keeps green" || no "C"; rm -rf "$SC_DIR"

run_scenario D 1 "$T1" 'echo "BLOCKER: external dependency missing"'
AUD | grep -q "BLOCKED (agent): external dependency missing" && TKS | grep -q '\[~\] 1' \
  && ok "D agent BLOCKER -> [~]" || no "D"; rm -rf "$SC_DIR"

run_scenario E 1 "$T1" 'echo "module.exports={add:(a,b)=>a+b}" > src/lib.js'
AUD | grep -q "task=1 GREEN" && ! AUD | grep -q "TAMPER" && TKS | grep -q '\[x\] 1' \
  && ok "E legit impl -> green, pick [-] write NOT flagged" || no "E"; rm -rf "$SC_DIR"

# F: NON-GIT — pre-existing test tamper is UNDETECTABLE (L1 degraded), but the verdict must carry a
# durable tamperGate:off flag + a .tamper-gate-off marker, so the downgrade is auditable after the fact.
run_scenario F 1 "$T1" '
echo "module.exports={add:(a,b)=>a+b}" > src/lib.js
echo "const t=require(\"node:test\");t(\"trivial\",()=>{});" > tests/task1.test.js' nogit
AUD | grep -q "TAMPER-GATE OFF" \
  && [ -f "$SC_DIR/.spec-workflow/.tamper-gate-off" ] \
  && grep -q '"tamperGate": "off"' "$SC_DIR/.spec-workflow/specs/s/verify-results/task-1.json" \
  && ok "F non-git: tamper undetectable BUT durably flagged (tamperGate:off + marker)" || no "F"; rm -rf "$SC_DIR"

echo ""
echo "L1 result: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
