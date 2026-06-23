#!/bin/bash
# L3 verification harness for the pre-flight spec gate (Specification Self-Correction).
#
# Fake claude/codex shims drive the REAL spec-loop-run.sh. The fake codex acts as the cross-family
# spec auditor (verdict controlled by SPEC_VERDICT / SPEC_EMPTY, logged to .judgelog). Covers:
# gate pass -> proceed, gate fail -> abort before implementing, cross-family routing, no-output ->
# advisory pass, disabled.
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
# run_scenario <name> <specGate:true|false> <env...>
run_scenario(){
  local name="$1" sgate="$2" envs="$3"
  local T; T=$(mktemp -d); pushd "$T" >/dev/null
  git init -q; git config user.email t@t.t; git config user.name t
  mkdir -p src tests bin .spec-workflow/specs/s
  printf -- '- [ ] 1. t1\n  - _Tests: tests/task1.test.js_\n  - _Prompt: x_\n' > .spec-workflow/specs/s/tasks.md
  printf '# Requirements\n1.1 add(a,b) returns the sum.\n' > .spec-workflow/specs/s/requirements.md
  {
    echo '[engine]'; echo 'default = "claude"'; echo 'maxFixAttempts = 3'
    echo '[loop]'; echo 'autoLoop = true'; echo 'maxIterations = 2'; echo 'noProgressStop = 6'
    echo 'testCommand = "node --test {tests}"'
    echo "specGate = $sgate"
  } > .spec-workflow/config.toml
  cp "$TPL" .spec-workflow/spec-loop-run.sh
  sed -i "s|@@SWMCP_CMD@@|node \"$DIST\"|g" .spec-workflow/spec-loop-run.sh
  cat > bin/claude <<'SH'
#!/bin/bash
prompt="$*"
case "$prompt" in *"Reply with exactly: OK"*) echo OK; exit 0;; esac
case "$prompt" in *"spec auditor"*) echo "claude:specgate" >> .judgelog; echo "VERDICT: ${SPEC_VERDICT:-pass}"; exit 0;; esac
task="$(printf '%s' "$prompt" | grep -oE 'task [0-9]+' | head -1 | awk '{print $2}')"
mkdir -p src tests; echo "module.exports={add:(a,b)=>a+b}" > src/lib.js
printf 'const t=require("node:test"),a=require("node:assert");t("add",()=>{a.strictEqual(require("../src/lib").add(2,3),5)});\n' > "tests/task${task}.test.js"
exit 0
SH
  cat > bin/codex <<'SH'
#!/bin/bash
case "$*" in
  *"spec auditor"*)
    echo "codex:specgate" >> .judgelog
    [ "${SPEC_EMPTY:-}" = "1" ] && exit 0
    echo "VERDICT: ${SPEC_VERDICT:-pass}"; exit 0;;
esac
exit 0
SH
  chmod +x bin/claude bin/codex
  git add -A; git commit -qm init
  PATH="$T/bin:$PATH" env $envs timeout 120 bash .spec-workflow/spec-loop-run.sh s >/dev/null 2>&1
  popd >/dev/null
  SC_DIR="$T"
}
AUD(){ cat "$SC_DIR/.spec-workflow/loop-audit.log" 2>/dev/null; }
TKS(){ cat "$SC_DIR/.spec-workflow/specs/s/tasks.md" 2>/dev/null; }
JLOG(){ cat "$SC_DIR/.judgelog" 2>/dev/null; }
RES(){ cat "$SC_DIR/.spec-workflow/spec-gate-result.json" 2>/dev/null; }

run_scenario A true "SPEC_VERDICT=pass"
AUD | grep -q "SPEC-GATE pass (codex)" && JLOG | grep -q "codex:specgate" && TKS | grep -q '\[x\] 1' && RES | grep -q '"status": "pass"' \
  && ok "A spec gate pass (cross-family codex audits) -> loop proceeds, task done" || no "A"; rm -rf "$SC_DIR"

run_scenario B true "SPEC_VERDICT=fail"
AUD | grep -q "SPEC-GATE fail" && AUD | grep -q "ABORTED by spec gate" && TKS | grep -q '\[ \] 1' && ! AUD | grep -q "GREEN" \
  && [ -f "$SC_DIR/.spec-workflow/.spec-gate-failed" ] && RES | grep -q '"status": "fail"' \
  && ok "B spec gate fail -> loop ABORTS before implementing (task untouched, marker + result)" || no "B"; rm -rf "$SC_DIR"

run_scenario C true "SPEC_EMPTY=1"
AUD | grep -q "SPEC-GATE advisory-pass" && TKS | grep -q '\[x\] 1' \
  && ok "C auditor no-output -> advisory pass, loop proceeds (infra failure must not block all work)" || no "C"; rm -rf "$SC_DIR"

run_scenario D false ""
! AUD | grep -q "SPEC-GATE" && TKS | grep -q '\[x\] 1' \
  && ok "D specGate disabled -> no gate, loop proceeds" || no "D"; rm -rf "$SC_DIR"

echo ""
echo "L3 result: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
