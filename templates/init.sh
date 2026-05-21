#!/bin/bash
# spec-workflow-mcp 项目初始化脚本
# 用法: bash init.sh [项目路径] [选项]
#       bash init.sh                          → 初始化当前目录
#       bash init.sh /path/to/project         → 初始化指定目录
#       bash init.sh /path --with-graph       → 加 code-review-graph（省 token）
#       bash init.sh /path --with-nexus       → 加 GitNexus（依赖分析）
#       bash init.sh /path --with-understand  → 加 Understand-Anything（可视化）
#       bash init.sh /path --with-all         → 全部安装
#       bash init.sh /path --force            → 强制覆盖 CLAUDE.md/skills/agents

set -e

# 解析参数
WITH_GRAPH=""; WITH_NEXUS=""; WITH_UNDERSTAND=""; WITH_ALL=""; FORCE=""
POSITIONAL=""
for arg in "$@"; do
  case $arg in
    --with-graph)      WITH_GRAPH=1 ;;
    --with-nexus)      WITH_NEXUS=1 ;;
    --with-understand) WITH_UNDERSTAND=1 ;;
    --with-all)        WITH_ALL=1 ;;
    --force)           FORCE=1 ;;
    -*)                echo "未知选项: $arg"; exit 1 ;;
    *)                 POSITIONAL="$arg" ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="${POSITIONAL:-.}"
PROJECT_DIR="$(cd "$PROJECT_DIR" 2>/dev/null && pwd || echo "$PROJECT_DIR")"

echo "================================================"
echo "  spec-workflow-mcp 项目初始化"
echo "================================================"
echo "  项目目录: $PROJECT_DIR"
echo ""

# 1. 创建项目目录（如果不存在）
if [ ! -d "$PROJECT_DIR" ]; then
  echo "[1/12] 创建项目目录..."
  mkdir -p "$PROJECT_DIR"
else
  echo "[1/12] 项目目录已存在"
fi

# 2. 创建 .spec-workflow 目录结构
echo "[2/12] 创建 .spec-workflow 目录..."
mkdir -p "$PROJECT_DIR/.spec-workflow/steering"
mkdir -p "$PROJECT_DIR/.spec-workflow/specs"
mkdir -p "$PROJECT_DIR/.spec-workflow/approvals"

# 3. 写入 config.toml
CONFIG_FILE="$PROJECT_DIR/.spec-workflow/config.toml"
if [ ! -f "$CONFIG_FILE" ]; then
  echo "[3/12] 写入引擎配置 config.toml..."
  cat > "$CONFIG_FILE" << 'TOML'
[engine]
default = "deepseek"
deepseekModel = "auto"
maxFixAttempts = 5
TOML
else
  echo "[3/12] config.toml 已存在，跳过"
fi

# 4. 复制 CLAUDE.md
CLAUDE_MD="$PROJECT_DIR/CLAUDE.md"
TEMPLATE="$SCRIPT_DIR/PROJECT-CLAUDE-MD-TEMPLATE.md"
if [ ! -f "$CLAUDE_MD" ] || [ "$FORCE" = "1" ]; then
  if [ -f "$TEMPLATE" ]; then
    echo "[4/12] 复制 CLAUDE.md 模板..."
    cp "$TEMPLATE" "$CLAUDE_MD"
  else
    echo "[4/12] 警告: 模板文件不存在: $TEMPLATE"
  fi
else
  echo "[4/12] CLAUDE.md 已存在，跳过（使用 --force 覆盖）"
fi

# 5. 复制 skills
SKILLS_DIR="$SCRIPT_DIR/skills"
TARGET_SKILLS="$PROJECT_DIR/.claude/skills"
if [ -d "$SKILLS_DIR" ]; then
  echo "[5/12] 复制 skills + agents..."
  mkdir -p "$TARGET_SKILLS"
  cp -r "$SKILLS_DIR"/* "$TARGET_SKILLS/"
  # 复制 agents
  AGENTS_DIR="$SCRIPT_DIR/agents"
  if [ -d "$AGENTS_DIR" ]; then
    mkdir -p "$PROJECT_DIR/.claude/agents"
    cp -r "$AGENTS_DIR"/* "$PROJECT_DIR/.claude/agents/"
  fi
else
  echo "[5/12] 警告: skills 目录不存在: $SKILLS_DIR"
fi

# 6. 部署 statusline
STATUSLINE_SRC="$SCRIPT_DIR/statusline.sh"
STATUSLINE_DST="$HOME/.claude/statusline.sh"
GLOBAL_SETTINGS="$HOME/.claude/settings.json"
if [ -f "$STATUSLINE_SRC" ]; then
  if [ ! -f "$STATUSLINE_DST" ]; then
    echo "[6/12] 部署 statusline.sh..."
    mkdir -p "$HOME/.claude"
    cp "$STATUSLINE_SRC" "$STATUSLINE_DST"
    chmod +x "$STATUSLINE_DST"
  else
    echo "[6/12] statusline.sh 已存在，跳过"
  fi
  # 检查全局 settings.json 是否配置了 statusLine
  if [ -f "$GLOBAL_SETTINGS" ]; then
    if ! grep -q "statusLine" "$GLOBAL_SETTINGS" 2>/dev/null; then
      echo "  配置 statusLine 到全局 settings.json..."
      TMP=$(mktemp)
      jq --arg cmd "bash $STATUSLINE_DST" '. + {"statusLine":{"type":"command","command":$cmd}}' "$GLOBAL_SETTINGS" > "$TMP" && mv "$TMP" "$GLOBAL_SETTINGS"
    fi
  else
    echo "  创建全局 settings.json..."
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
  echo "[6/12] 警告: statusline.sh 模板不存在"
fi

# 7. 创建项目级 .claude/settings.json（如果不存在）
SETTINGS_FILE="$PROJECT_DIR/.claude/settings.json"
if [ ! -f "$SETTINGS_FILE" ]; then
  echo "[7/12] 创建项目 settings.json..."
  mkdir -p "$PROJECT_DIR/.claude"
  cat > "$SETTINGS_FILE" << 'JSON'
{
  "permissions": {
    "allow": [
      "Bash(*)",
      "Read",
      "Write",
      "Edit",
      "Glob",
      "Grep",
      "WebFetch",
      "WebSearch",
      "Agent",
      "NotebookEdit"
    ]
  }
}
JSON
else
  echo "[7/12] 项目 settings.json 已存在，跳过"
fi

# 辅助函数：统一写入 .mcp.json（不用 claude mcp add，避免分散到 .claude.json）
add_mcp_server() {
  local name=$1 cmd=$2; shift 2; local args_json="$*"
  MCP_JSON="$PROJECT_DIR/.mcp.json"
  if [ ! -f "$MCP_JSON" ]; then
    echo '{"mcpServers":{}}' > "$MCP_JSON"
  fi
  if grep -q "\"$name\"" "$MCP_JSON" 2>/dev/null; then
    echo "  $name 已配置，跳过"
  else
    TMP=$(mktemp)
    jq --arg n "$name" --arg c "$cmd" --argjson a "$args_json" \
      '.mcpServers[$n] = {"type":"stdio","command":$c,"args":$a,"env":{}}' \
      "$MCP_JSON" > "$TMP" && mv "$TMP" "$MCP_JSON" && echo "  $name 已配置" || echo "  $name 配置失败"
  fi
}

# 8. 配置引擎 MCP
echo "[8/12] 配置引擎调度 MCP → .mcp.json..."
add_mcp_server "ai-cli" "npx" '["-y","ai-cli-mcp@latest"]'
if command -v deepseek &>/dev/null; then
  add_mcp_server "deepseek" "deepseek" '["serve","--mcp"]'
fi

# 9. 配置 spec-workflow-mcp
echo "[9/12] 配置 spec-workflow-mcp..."
SWM_DIST="$SCRIPT_DIR/../dist/index.js"
SWM_DIST_ABS=""
if [ -f "$SWM_DIST" ]; then
  SWM_DIST_ABS="$(cd "$(dirname "$SWM_DIST")" && pwd)/index.js"
fi

# 9a. Claude Code（写入 .mcp.json）
if [ -n "$SWM_DIST_ABS" ]; then
  add_mcp_server "spec-workflow" "node" "[\"$SWM_DIST_ABS\",\"$PROJECT_DIR\"]"
else
  echo "  跳过（需先 npm run build）"
fi

# 9b. Gemini CLI
GEMINI_SETTINGS="$HOME/.gemini/settings.json"
if [ -n "$SWM_DIST_ABS" ]; then
  echo "  配置 Gemini CLI MCP..."
  mkdir -p "$HOME/.gemini"
  if [ -f "$GEMINI_SETTINGS" ]; then
    if ! grep -q "spec-workflow" "$GEMINI_SETTINGS" 2>/dev/null; then
      TMP=$(mktemp)
      jq --arg dist "$SWM_DIST_ABS" --arg proj "$PROJECT_DIR" \
        '.mcpServers = (.mcpServers // {}) + {"spec-workflow":{"command":"node","args":[$dist,$proj]}}' \
        "$GEMINI_SETTINGS" > "$TMP" 2>/dev/null && mv "$TMP" "$GEMINI_SETTINGS" && echo "  Gemini: 已配置" || echo "  Gemini: 配置失败"
    else
      echo "  Gemini: 已配置，跳过"
    fi
  else
    python3 -c "import json; print(json.dumps({'mcpServers':{'spec-workflow':{'command':'node','args':['$SWM_DIST_ABS','$PROJECT_DIR']}}},indent=2))" > "$GEMINI_SETTINGS"
    echo "  Gemini: 已配置"
  fi
fi

# 9c. DeepSeek TUI
DS_MCP="$HOME/.deepseek/mcp.json"
if [ -n "$SWM_DIST_ABS" ]; then
  echo "  配置 DeepSeek TUI MCP..."
  mkdir -p "$HOME/.deepseek"
  if [ -f "$DS_MCP" ]; then
    if ! grep -q "spec-workflow" "$DS_MCP" 2>/dev/null; then
      TMP=$(mktemp)
      jq --arg dist "$SWM_DIST_ABS" --arg proj "$PROJECT_DIR" \
        '.mcpServers = (.mcpServers // {}) + {"spec-workflow":{"command":"node","args":[$dist,$proj]}}' \
        "$DS_MCP" > "$TMP" 2>/dev/null && mv "$TMP" "$DS_MCP" && echo "  DeepSeek: 已配置" || echo "  DeepSeek: 配置失败"
    else
      echo "  DeepSeek: 已配置，跳过"
    fi
  else
    python3 -c "import json; print(json.dumps({'mcpServers':{'spec-workflow':{'command':'node','args':['$SWM_DIST_ABS','$PROJECT_DIR']}}},indent=2))" > "$DS_MCP"
    echo "  DeepSeek: 已配置"
  fi
fi

# 10. 配置代码智能 MCP（可选，也写入 .mcp.json）
MCP_INSTALLED=""
if [ "$WITH_GRAPH" = "1" ] || [ "$WITH_ALL" = "1" ]; then
  echo "[10/12] 配置 code-review-graph（省 token 神器）..."
  if ! command -v code-review-graph &>/dev/null; then
    echo "  安装 code-review-graph（Python）..."
    pip install code-review-graph 2>/dev/null | tail -1
  fi
  add_mcp_server "code-review-graph" "code-review-graph" '["serve"]'
  echo "  构建知识图谱..."
  (cd "$PROJECT_DIR" && code-review-graph build 2>/dev/null | tail -1)
  MCP_INSTALLED="1"
fi

if [ "$WITH_NEXUS" = "1" ] || [ "$WITH_ALL" = "1" ]; then
  echo "[10/12] 配置 GitNexus（代码依赖分析）..."
  if ! command -v gitnexus &>/dev/null; then
    echo "  安装 gitnexus..."
    npm i -g gitnexus 2>/dev/null | tail -1
  fi
  add_mcp_server "gitnexus" "gitnexus" '["mcp"]'
  MCP_INSTALLED="1"
fi

if [ "$WITH_UNDERSTAND" = "1" ]; then
  echo "[10/12] Understand-Anything 需要通过 Claude plugin 安装："
  echo "  在 Claude Code 中运行: /plugin install understand-anything"
  MCP_INSTALLED="1"
fi

if [ -z "$MCP_INSTALLED" ]; then
  echo "[10/12] 跳过代码智能 MCP（可选: --with-graph / --with-nexus / --with-understand / --with-all）"
fi

# 11. 清理旧 codex plugin（如果存在）
echo "[11/12] 清理旧配置..."
if [ -f "$HOME/.claude/settings.json" ]; then
  if grep -q "enabledPlugins\|extraKnownMarketplaces\|codex@openai-codex" "$HOME/.claude/settings.json" 2>/dev/null; then
    TMP=$(mktemp)
    jq 'del(.enabledPlugins, .extraKnownMarketplaces)' "$HOME/.claude/settings.json" > "$TMP" 2>/dev/null && mv "$TMP" "$HOME/.claude/settings.json" && echo "  已清理旧 codex plugin 配置" || echo "  清理失败"
  else
    echo "  无需清理"
  fi
fi

# 12. 检查依赖工具
echo "[12/12] 检查工具链..."
MISSING=""
if ! command -v claude &>/dev/null; then
  MISSING="$MISSING  - claude (Claude Code CLI)\n"
fi
if ! command -v deepseek &>/dev/null; then
  MISSING="$MISSING  - deepseek (DeepSeek TUI: npm i -g deepseek-tui)\n"
fi
if ! command -v codex &>/dev/null; then
  MISSING="$MISSING  - codex (OpenAI Codex CLI, 用于图像生成)\n"
fi
if ! command -v gemini &>/dev/null; then
  MISSING="$MISSING  - gemini (Gemini CLI: npm i -g @google/gemini-cli)\n"
fi
if ! command -v jq &>/dev/null; then
  MISSING="$MISSING  - jq (JSON 处理: apt install jq)\n"
fi

if [ -n "$MISSING" ]; then
  echo "  警告: 以下工具未安装（不影响初始化，但运行时需要）:"
  echo -e "$MISSING"
else
  echo "  claude / deepseek / gemini / codex 均已安装"
fi

echo ""
echo "================================================"
echo "  初始化完成!"
echo "================================================"
echo ""
echo "  生成的文件:"
echo "    $PROJECT_DIR/CLAUDE.md"
echo "    $PROJECT_DIR/.spec-workflow/config.toml"
echo "    $PROJECT_DIR/.claude/skills/{review,qa,design-review,tdd}/"
echo "    $PROJECT_DIR/.claude/settings.json"
echo ""
echo "  下一步:"
echo "    1. cd $PROJECT_DIR"
echo "    2. 打开 claude code"
echo "    3. 告诉 Claude 你的需求，它会自动走 spec-workflow 流程"
echo ""
