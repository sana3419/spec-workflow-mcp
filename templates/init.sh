#!/bin/bash
# spec-workflow-mcp 项目初始化脚本
# 用法: bash init.sh [项目路径]
#       bash init.sh              → 初始化当前目录
#       bash init.sh /path/to/project → 初始化指定目录

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="${1:-.}"
PROJECT_DIR="$(cd "$PROJECT_DIR" 2>/dev/null && pwd || echo "$PROJECT_DIR")"

echo "================================================"
echo "  spec-workflow-mcp 项目初始化"
echo "================================================"
echo "  项目目录: $PROJECT_DIR"
echo ""

# 1. 创建项目目录（如果不存在）
if [ ! -d "$PROJECT_DIR" ]; then
  echo "[1/5] 创建项目目录..."
  mkdir -p "$PROJECT_DIR"
else
  echo "[1/5] 项目目录已存在"
fi

# 2. 创建 .spec-workflow 目录结构
echo "[2/5] 创建 .spec-workflow 目录..."
mkdir -p "$PROJECT_DIR/.spec-workflow/steering"
mkdir -p "$PROJECT_DIR/.spec-workflow/specs"
mkdir -p "$PROJECT_DIR/.spec-workflow/approvals"

# 3. 写入 config.toml
CONFIG_FILE="$PROJECT_DIR/.spec-workflow/config.toml"
if [ ! -f "$CONFIG_FILE" ]; then
  echo "[3/5] 写入引擎配置 config.toml..."
  cat > "$CONFIG_FILE" << 'TOML'
[engine]
default = "deepseek"
deepseekModel = "auto"
maxFixAttempts = 5
TOML
else
  echo "[3/5] config.toml 已存在，跳过"
fi

# 4. 复制 CLAUDE.md
CLAUDE_MD="$PROJECT_DIR/CLAUDE.md"
TEMPLATE="$SCRIPT_DIR/PROJECT-CLAUDE-MD-TEMPLATE.md"
if [ ! -f "$CLAUDE_MD" ]; then
  if [ -f "$TEMPLATE" ]; then
    echo "[4/5] 复制 CLAUDE.md 模板..."
    cp "$TEMPLATE" "$CLAUDE_MD"
  else
    echo "[4/5] 警告: 模板文件不存在: $TEMPLATE"
    echo "       请手动复制 CLAUDE.md"
  fi
else
  echo "[4/5] CLAUDE.md 已存在，跳过"
fi

# 5. 检查依赖工具
echo "[5/5] 检查工具链..."
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
  MISSING="$MISSING  - gemini (Google Gemini CLI)\n"
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
echo ""
echo "  下一步:"
echo "    1. cd $PROJECT_DIR"
echo "    2. 打开 claude code"
echo "    3. 告诉 Claude 你的需求，它会自动走 spec-workflow 流程"
echo ""
