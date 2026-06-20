#!/bin/bash
# spec-workflow-mcp project initialization script
# Usage: bash init.sh [project-path] [options]
#        bash init.sh                          → initialize current directory
#        bash init.sh /path/to/project         → initialize target directory
#        bash init.sh /path --with-graph       → add code-review-graph (save tokens)
#        bash init.sh /path --with-nexus       → add GitNexus (dependency analysis)
#        bash init.sh /path --with-all         → install all three
#        bash init.sh /path --force            → overwrite CLAUDE.md/skills/agents
#        bash init.sh /path --auto-loop        → enable Phase 4 auto-loop (Stop hook driver)

set -e

# Parse arguments
WITH_GRAPH=""; WITH_NEXUS=""; WITH_ALL=""; FORCE=""; AUTO_LOOP=""
POSITIONAL=""
for arg in "$@"; do
  case $arg in
    --with-graph)      WITH_GRAPH=1 ;;
    --with-nexus)      WITH_NEXUS=1 ;;
    --with-all)        WITH_ALL=1 ;;
    --force)           FORCE=1 ;;
    --auto-loop)       AUTO_LOOP=1 ;;
    -*)                echo "Unknown option: $arg"; exit 1 ;;
    *)                 POSITIONAL="$arg" ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="${POSITIONAL:-.}"
PROJECT_DIR="$(cd "$PROJECT_DIR" 2>/dev/null && pwd || echo "$PROJECT_DIR")"
SPEC_WORKFLOW_HOME="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "================================================"
echo "  spec-workflow-mcp project initialization"
echo "================================================"
echo "  Project:  $PROJECT_DIR"
echo "  Framework: $SPEC_WORKFLOW_HOME"
echo ""

# 1. Create project directory
if [ ! -d "$PROJECT_DIR" ]; then
  echo "[1/11] Creating project directory..."
  mkdir -p "$PROJECT_DIR"
else
  echo "[1/11] Project directory exists"
fi

# 2. Create .spec-workflow directory structure
echo "[2/11] Creating .spec-workflow structure..."
mkdir -p "$PROJECT_DIR/.spec-workflow/steering"
mkdir -p "$PROJECT_DIR/.spec-workflow/specs"
mkdir -p "$PROJECT_DIR/.spec-workflow/reports"

# 3. Write config.toml
CONFIG_FILE="$PROJECT_DIR/.spec-workflow/config.toml"
if [ ! -f "$CONFIG_FILE" ]; then
  echo "[3/11] Writing engine config (config.toml)..."
  cat > "$CONFIG_FILE" << 'TOML'
[engine]
default = "codex"
maxFixAttempts = 5

[engine.codex]
sandbox = "workspace-write"   # read-only | workspace-write | danger-full-access
approvalPolicy = "never"      # untrusted | on-failure | on-request | never
# model = "..."              # optional — leave commented out to use Codex's latest default (recommended)

[loop]
autoLoop = false              # true = Stop hook drives Phase 4 to completion (master switch)
maxIterations = 50            # hard cap on auto-loop iterations
noProgressStop = 3            # stop after N iterations with no tasks.md change
TOML
else
  echo "[3/11] config.toml exists, skipping"
fi

# 4. Copy CLAUDE.md
CLAUDE_MD="$PROJECT_DIR/CLAUDE.md"
TEMPLATE="$SCRIPT_DIR/PROJECT-CLAUDE-MD-TEMPLATE.md"
if [ ! -f "$CLAUDE_MD" ] || [ "$FORCE" = "1" ]; then
  if [ -f "$TEMPLATE" ]; then
    echo "[4/11] Copying CLAUDE.md template..."
    cp "$TEMPLATE" "$CLAUDE_MD"
  else
    echo "[4/11] WARNING: Template not found: $TEMPLATE"
  fi
else
  echo "[4/11] CLAUDE.md exists, skipping (use --force to overwrite)"
fi

# 4b. Copy AGENTS.md (Codex worker reads this natively)
AGENTS_MD="$PROJECT_DIR/AGENTS.md"
AGENTS_TEMPLATE="$SCRIPT_DIR/AGENTS.md"
if [ -f "$AGENTS_TEMPLATE" ]; then
  if [ ! -f "$AGENTS_MD" ] || [ "$FORCE" = "1" ]; then
    echo "       Copying AGENTS.md (Codex worker instructions)..."
    cp "$AGENTS_TEMPLATE" "$AGENTS_MD"
  else
    echo "       AGENTS.md exists, skipping (use --force to overwrite)"
  fi
fi

# 5. Copy skills + agents
SKILLS_DIR="$SCRIPT_DIR/skills"
TARGET_SKILLS="$PROJECT_DIR/.claude/skills"
if [ -d "$SKILLS_DIR" ]; then
  echo "[5/11] Copying skills + agents..."
  mkdir -p "$TARGET_SKILLS"
  cp -r "$SKILLS_DIR"/* "$TARGET_SKILLS/"
  AGENTS_DIR="$SCRIPT_DIR/agents"
  if [ -d "$AGENTS_DIR" ]; then
    mkdir -p "$PROJECT_DIR/.claude/agents"
    cp -r "$AGENTS_DIR"/* "$PROJECT_DIR/.claude/agents/"
  fi
else
  echo "[5/11] WARNING: Skills directory not found: $SKILLS_DIR"
fi

# 6. Deploy statusline
STATUSLINE_SRC="$SCRIPT_DIR/statusline.sh"
STATUSLINE_DST="$HOME/.claude/statusline.sh"
GLOBAL_SETTINGS="$HOME/.claude/settings.json"
if [ -f "$STATUSLINE_SRC" ]; then
  if [ ! -f "$STATUSLINE_DST" ]; then
    echo "[6/11] Deploying statusline.sh..."
    mkdir -p "$HOME/.claude"
    cp "$STATUSLINE_SRC" "$STATUSLINE_DST"
    chmod +x "$STATUSLINE_DST"
  else
    echo "[6/11] statusline.sh exists, skipping"
  fi
  # Configure statusLine in global settings.json
  if [ -f "$GLOBAL_SETTINGS" ]; then
    if ! jq -e '.statusLine' "$GLOBAL_SETTINGS" >/dev/null 2>&1; then
      echo "  Configuring statusLine in global settings.json..."
      TMP=$(mktemp)
      jq --arg cmd "bash $STATUSLINE_DST" '. + {"statusLine":{"type":"command","command":$cmd}}' "$GLOBAL_SETTINGS" > "$TMP" && mv "$TMP" "$GLOBAL_SETTINGS"
    fi
  else
    echo "  Creating global settings.json..."
    mkdir -p "$HOME/.claude"
    cat > "$GLOBAL_SETTINGS" << SLJSON
{
  "statusLine": {
    "type": "command",
    "command": "bash $STATUSLINE_DST"
  }
}
SLJSON
  fi
else
  echo "[6/11] WARNING: statusline.sh template not found"
fi

# 7. Create project .claude/settings.json
SETTINGS_FILE="$PROJECT_DIR/.claude/settings.json"
if [ ! -f "$SETTINGS_FILE" ]; then
  echo "[7/11] Creating project settings.json..."
  mkdir -p "$PROJECT_DIR/.claude"
  cat > "$SETTINGS_FILE" << 'JSON'
{
  "permissions": {
    "allow": [
      "Bash(*)",
      "Read(*)",
      "Write(*)",
      "Edit(*)",
      "Glob(*)",
      "Grep(*)",
      "WebFetch(*)",
      "WebSearch(*)",
      "Agent(*)",
      "NotebookEdit(*)",
      "Skill(*)",
      "mcp__spec-workflow__*",
      "mcp__codex__*",
      "mcp__code-review-graph__*",
      "mcp__gitnexus__*"
    ]
  }
}
JSON
else
  echo "[7/11] Project settings.json exists, skipping"
fi

# 7b. Auto-loop: install + register the Phase 4 Stop hook (only with --auto-loop)
if [ "$AUTO_LOOP" = "1" ]; then
  echo "       Enabling Phase 4 auto-loop (Stop hook)..."
  HOOK_SRC="$SCRIPT_DIR/hooks/spec-loop-stop.sh"
  HOOK_DIR="$PROJECT_DIR/.claude/hooks"
  HOOK_DST="$HOOK_DIR/spec-loop-stop.sh"
  if [ -f "$HOOK_SRC" ]; then
    mkdir -p "$HOOK_DIR"
    cp "$HOOK_SRC" "$HOOK_DST" && chmod +x "$HOOK_DST"
    # register Stop hook in project settings.json (idempotent)
    if ! jq -e '.hooks.Stop' "$SETTINGS_FILE" >/dev/null 2>&1; then
      TMP=$(mktemp)
      jq --arg cmd "bash $HOOK_DST" \
        '.hooks = (.hooks // {}) | .hooks.Stop = [{"hooks":[{"type":"command","command":$cmd}]}]' \
        "$SETTINGS_FILE" > "$TMP" && mv "$TMP" "$SETTINGS_FILE" && echo "       Stop hook registered" || echo "       Stop hook registration failed"
    else
      echo "       Stop hook already registered, skipping"
    fi
    # flip master switch on in config.toml
    if grep -q '^\[loop\]' "$CONFIG_FILE" 2>/dev/null; then
      sed -i 's/^autoLoop = false/autoLoop = true/' "$CONFIG_FILE"
    else
      printf '\n[loop]\nautoLoop = true\nmaxIterations = 50\nnoProgressStop = 3\n' >> "$CONFIG_FILE"
    fi
    echo "       config.toml [loop].autoLoop = true"
  else
    echo "       WARNING: hook template not found: $HOOK_SRC"
  fi
fi

# Helper: add MCP server to .mcp.json (idempotent via jq)
add_mcp_server() {
  local name=$1 cmd=$2; shift 2; local args_json="$*"
  MCP_JSON="$PROJECT_DIR/.mcp.json"
  if [ ! -f "$MCP_JSON" ]; then
    echo '{"mcpServers":{}}' > "$MCP_JSON"
  fi
  if jq -e --arg n "$name" '.mcpServers[$n]' "$MCP_JSON" >/dev/null 2>&1; then
    echo "  $name already configured, skipping"
  else
    TMP=$(mktemp)
    jq --arg n "$name" --arg c "$cmd" --argjson a "$args_json" \
      '.mcpServers[$n] = {"type":"stdio","command":$c,"args":$a,"env":{}}' \
      "$MCP_JSON" > "$TMP" && mv "$TMP" "$MCP_JSON" && echo "  $name configured" || echo "  $name configuration failed"
  fi
}

# 8. Configure Codex dispatch MCP (codex runs itself as an MCP server)
echo "[8/11] Configuring Codex dispatch MCP -> .mcp.json..."
MCP_JSON="$PROJECT_DIR/.mcp.json"
if [ ! -f "$MCP_JSON" ]; then
  echo '{"mcpServers":{}}' > "$MCP_JSON"
fi
if ! jq -e '.mcpServers["codex"]' "$MCP_JSON" >/dev/null 2>&1; then
  TMP=$(mktemp)
  jq '.mcpServers["codex"] = {"type":"stdio","command":"codex","args":["mcp-server"],"env":{}}' \
    "$MCP_JSON" > "$TMP" && mv "$TMP" "$MCP_JSON" && echo "  codex configured" || echo "  codex configuration failed"
else
  echo "  codex already configured, skipping"
fi

# 9. Configure spec-workflow-mcp for Claude Code (.mcp.json)
echo "[9/11] Configuring spec-workflow-mcp..."
SWM_DIST="$SCRIPT_DIR/../dist/index.js"
SWM_DIST_ABS=""
if [ -f "$SWM_DIST" ]; then
  SWM_DIST_ABS="$(cd "$(dirname "$SWM_DIST")" && pwd)/index.js"
fi

if [ -n "$SWM_DIST_ABS" ]; then
  add_mcp_server "spec-workflow" "node" "[\"$SWM_DIST_ABS\",\"$PROJECT_DIR\"]"
else
  echo "  Skipping (run npm run build first)"
fi

# 10. Optional code intelligence MCP
MCP_INSTALLED=""
if [ "$WITH_GRAPH" = "1" ] || [ "$WITH_ALL" = "1" ]; then
  echo "[10/11] Configuring code-review-graph..."
  if ! command -v code-review-graph &>/dev/null; then
    echo "  Installing code-review-graph (Python)..."
    pip install code-review-graph 2>/dev/null | tail -1
  fi
  add_mcp_server "code-review-graph" "code-review-graph" '["mcp"]'
  echo "  Building knowledge graph (required before the MCP tools return data)..."
  (cd "$PROJECT_DIR" && code-review-graph build 2>/dev/null | tail -1)
  MCP_INSTALLED="1"
fi

if [ "$WITH_NEXUS" = "1" ] || [ "$WITH_ALL" = "1" ]; then
  echo "[10/11] Configuring GitNexus..."
  if ! command -v gitnexus &>/dev/null; then
    echo "  Installing gitnexus..."
    npm i -g gitnexus 2>/dev/null | tail -1
  fi
  add_mcp_server "gitnexus" "gitnexus" '["mcp"]'
  echo "  Indexing repo (gitnexus mcp only serves indexed repos)..."
  (cd "$PROJECT_DIR" && gitnexus analyze 2>/dev/null | tail -1)
  MCP_INSTALLED="1"
fi

if [ -z "$MCP_INSTALLED" ]; then
  echo "[10/11] Skipping optional code intelligence MCP (use --with-graph / --with-nexus / --with-all)"
fi

# 11. Check dependencies (required vs optional)
echo "[11/11] Checking tool dependencies..."
REQUIRED_MISSING=""
if ! command -v claude &>/dev/null; then
  REQUIRED_MISSING="$REQUIRED_MISSING  - claude (Claude Code CLI: npm i -g @anthropic-ai/claude-code)\n"
fi
if ! command -v codex &>/dev/null; then
  REQUIRED_MISSING="$REQUIRED_MISSING  - codex (OpenAI Codex CLI: npm i -g @openai/codex; then run 'codex login')\n"
fi
if ! command -v jq &>/dev/null; then
  REQUIRED_MISSING="$REQUIRED_MISSING  - jq (JSON processor: apt install jq)\n"
fi

if [ -n "$REQUIRED_MISSING" ]; then
  echo ""
  echo "  ERROR: Required tools missing (must install before using):"
  echo -e "$REQUIRED_MISSING"
else
  echo "  All required tools installed"
fi

echo ""
echo "================================================"
echo "  Initialization complete!"
echo "================================================"
echo ""
echo "  Generated files:"
echo "    $PROJECT_DIR/CLAUDE.md"
echo "    $PROJECT_DIR/AGENTS.md"
echo "    $PROJECT_DIR/.spec-workflow/config.toml"
echo "    $PROJECT_DIR/.claude/skills/{review,qa,design-review,tdd}/"
echo "    $PROJECT_DIR/.claude/settings.json"
echo ""
if [ "$AUTO_LOOP" = "1" ]; then
  echo "    $PROJECT_DIR/.claude/hooks/spec-loop-stop.sh   (Phase 4 auto-loop ON)"
fi
echo ""
echo "  Next steps:"
echo "    1. Ensure Codex is ready: codex login   (first time only)"
echo "    2. cd $PROJECT_DIR"
echo "    3. claude"
echo "    4. Tell Claude what you want to build"
echo ""
if [ "$AUTO_LOOP" = "1" ]; then
  echo "  Auto-loop is ENABLED (config.toml [loop].autoLoop = true)."
  echo "  Pause it any time by setting autoLoop = false — no need to remove the hook."
else
  echo "  Phase 4 runs in prompt-driven mode (no Stop hook installed)."
  echo "  To enable the autonomous Stop-hook loop, re-run:  bash init.sh $PROJECT_DIR --auto-loop"
  echo "  (Editing [loop].autoLoop alone has no effect until the hook is registered.)"
fi
echo ""
echo "  Recommended: add to your shell profile:"
echo "    export SPEC_WORKFLOW_HOME=$SPEC_WORKFLOW_HOME"
echo ""
