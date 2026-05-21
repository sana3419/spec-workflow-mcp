#!/bin/bash
# Claude Code Statusline — 多引擎协同工作站

INPUT=$(cat)

MODEL=$(echo "$INPUT" | jq -r '.model.display_name // "Unknown"')
CWD=$(echo "$INPUT" | jq -r '.cwd // ""' | xargs basename 2>/dev/null || echo "~")
CTX_PCT=$(echo "$INPUT" | jq -r '.context_window.used_percentage // 0' | cut -d. -f1)
COST=$(echo "$INPUT" | jq -r '.cost.total_cost_usd // 0')
IN_TOKENS=$(echo "$INPUT" | jq -r '.context_window.total_input_tokens // 0')
OUT_TOKENS=$(echo "$INPUT" | jq -r '.context_window.total_output_tokens // 0')
LINES_ADD=$(echo "$INPUT" | jq -r '.cost.total_lines_added // 0')
LINES_DEL=$(echo "$INPUT" | jq -r '.cost.total_lines_removed // 0')
DURATION=$(echo "$INPUT" | jq -r '.cost.total_api_duration_ms // 0')
RATE_5H=$(echo "$INPUT" | jq -r '.rate_limits.five_hour.used_percentage // -1' | cut -d. -f1)
GIT_BRANCH=$(git -C "$(echo "$INPUT" | jq -r '.cwd // "."')" branch --show-current 2>/dev/null || echo "")

# 颜色
RST="\033[0m"; DIM="\033[2m"; BOLD="\033[1m"
GREEN="\033[32m"; YELLOW="\033[33m"; RED="\033[31m"
BLUE="\033[34m"; CYAN="\033[36m"; MAGENTA="\033[35m"

# 上下文进度条
BAR_LEN=10; FILLED=$((CTX_PCT * BAR_LEN / 100)); EMPTY=$((BAR_LEN - FILLED))
if [ "$CTX_PCT" -lt 50 ]; then BAR_COLOR="$GREEN"
elif [ "$CTX_PCT" -lt 80 ]; then BAR_COLOR="$YELLOW"
else BAR_COLOR="$RED"; fi
BAR="${BAR_COLOR}"
for ((i=0; i<FILLED; i++)); do BAR+="█"; done
for ((i=0; i<EMPTY; i++)); do BAR+="░"; done
BAR+="${RST}"

# Token 格式化
fmt() {
  local n=$1
  if [ "$n" -ge 1000000 ]; then echo "$(echo "scale=1; $n/1000000" | bc)M"
  elif [ "$n" -ge 1000 ]; then echo "$(echo "scale=1; $n/1000" | bc)K"
  else echo "$n"; fi
}
IN_FMT=$(fmt "$IN_TOKENS"); OUT_FMT=$(fmt "$OUT_TOKENS")

# 时长
DS=$((DURATION / 1000))
if [ "$DS" -ge 3600 ]; then DUR="$((DS/3600))时$((DS%3600/60))分"
elif [ "$DS" -ge 60 ]; then DUR="$((DS/60))分$((DS%60))秒"
else DUR="${DS}秒"; fi

# 花费颜色
CI=$(echo "$COST" | cut -d. -f1)
if [ "$CI" -lt 1 ]; then CC="$GREEN"
elif [ "$CI" -lt 5 ]; then CC="$YELLOW"
else CC="$RED"; fi

# 第一行：模型 | 项目 | 分支
L1="${BOLD}${CYAN}${MODEL}${RST}"
L1+="  ${DIM}|${RST}  ${BLUE}${CWD}${RST}"
[ -n "$GIT_BRANCH" ] && L1+="  ${DIM}|${RST}  ${MAGENTA}${GIT_BRANCH}${RST}"

# 第二行：上下文 | 令牌 | 花费 | 时长 | 代码 | 限额
L2="上下文 ${BAR} ${CTX_PCT}%"
L2+="  ${DIM}|${RST}  令牌 ${DIM}入${RST}${IN_FMT} ${DIM}出${RST}${OUT_FMT}"
L2+="  ${DIM}|${RST}  ${CC}花费 \$${COST}${RST}"
L2+="  ${DIM}|${RST}  时长 ${DUR}"
L2+="  ${DIM}|${RST}  代码 ${GREEN}+${LINES_ADD}${RST}/${RED}-${LINES_DEL}${RST}"

if [ "$RATE_5H" -ge 0 ]; then
  if [ "$RATE_5H" -lt 50 ]; then RC="$GREEN"
  elif [ "$RATE_5H" -lt 80 ]; then RC="$YELLOW"
  else RC="$RED"; fi
  L2+="  ${DIM}|${RST}  ${RC}限额 ${RATE_5H}%${RST}"
fi

printf "%b\n%b" "$L1" "$L2"

# ── 自动存储 session 消费数据 ──
# 每次 tick 覆盖写入，退出时即为最终数据；resume 同 session 自动覆盖
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty')
SPEC_DIR=$(echo "$INPUT" | jq -r '.cwd // "."')
USAGE_DIR="$SPEC_DIR/.spec-workflow"
if [ -n "$SESSION_ID" ] && [ -d "$USAGE_DIR" ]; then
  USAGE_FILE="$USAGE_DIR/session-usage.json"
  # 读取已有记录或初始化
  if [ -f "$USAGE_FILE" ]; then
    EXISTING=$(cat "$USAGE_FILE")
  else
    EXISTING='{"sessions":[]}'
  fi
  # 构建当前 session JSON，用 jq 合并/覆盖
  SESSION_JSON=$(echo "$INPUT" | jq '{
    sessionId: .session_id,
    model: .model.display_name,
    inputTokens: (.context_window.total_input_tokens // 0),
    outputTokens: (.context_window.total_output_tokens // 0),
    costUsd: (.cost.total_cost_usd // 0),
    durationMs: (.cost.total_duration_ms // 0),
    linesAdded: (.cost.total_lines_added // 0),
    linesRemoved: (.cost.total_lines_removed // 0),
    contextPct: (.context_window.used_percentage // 0),
    lastUpdate: now | strftime("%Y-%m-%dT%H:%M:%SZ")
  }')
  # 覆盖同 sessionId 或追加新的
  echo "$EXISTING" | jq --argjson s "$SESSION_JSON" '
    if (.sessions | map(.sessionId) | index($s.sessionId)) then
      .sessions |= map(if .sessionId == $s.sessionId then $s else . end)
    else
      .sessions += [$s]
    end
  ' > "$USAGE_FILE" 2>/dev/null
fi
