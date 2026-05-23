# Spec Workflow MCP — 多引擎协同开发框架

基于 [Pimzino/spec-workflow-mcp](https://github.com/Pimzino/spec-workflow-mcp) 改造的多引擎协同开发框架。Claude Code 作为主控大脑，调度 DeepSeek / Gemini / Codex / Claude 四个引擎，配合红绿灯验证和学术报告生成。

## 前置要求

| 依赖 | 检查命令 | 安装方式 |
|------|---------|---------|
| Node.js ≥ 18 | `node -v` | [nodejs.org](https://nodejs.org) |
| Claude Code | `claude -v` | `npm i -g @anthropic-ai/claude-code` |
| jq | `jq --version` | `apt install jq` / `brew install jq` |

需要的 API Key：

| Key | 用途 | 获取 |
|-----|------|------|
| `ANTHROPIC_API_KEY` | Claude Code（主控） | [console.anthropic.com](https://console.anthropic.com) |
| `DEEPSEEK_API_KEY` | DeepSeek V4（编码引擎） | [platform.deepseek.com](https://platform.deepseek.com) |

可选 API Key：

| Key | 用途 | 获取 |
|-----|------|------|
| Google 账号 | Gemini CLI（免费审查引擎） | `gemini` → 浏览器登录 |
| `OPENAI_API_KEY` | Codex CLI（图像生成） | [platform.openai.com](https://platform.openai.com) |

## 安装配置

### 第 1 步：克隆并构建 spec-workflow-mcp

```bash
git clone https://github.com/sana3419/spec-workflow-mcp.git
cd spec-workflow-mcp
npm install && npm run build
```

### 第 2 步：安装引擎 CLI

**Crush**（DeepSeek 编码引擎 — OpenCode 继任者）：

```bash
# npm（全平台）
npm install -g @charmland/crush

# macOS (Homebrew)
brew install charmbracelet/tap/crush

# 验证
crush --version
```

**Gemini CLI**（免费代码审查引擎，可选）：

```bash
npm install -g @google/gemini-cli
gemini    # 首次运行：跟随浏览器登录
```

**Codex CLI**（图像生成，可选）：

```bash
npm install -g @openai/codex
```

### 第 3 步：配置 DeepSeek API

```bash
mkdir -p ~/.config/crush
cat > ~/.config/crush/crush.json << 'EOF'
{
  "$schema": "https://charm.land/crush.json",
  "providers": {
    "deepseek": {
      "type": "openai-compat",
      "base_url": "https://api.deepseek.com/v1",
      "api_key": "sk-你的DEEPSEEK_API_KEY",
      "models": [
        {
          "id": "deepseek-v4-pro",
          "name": "DeepSeek V4 Pro",
          "cost_per_1m_in": 2.0,
          "cost_per_1m_out": 8.0,
          "context_window": 1048576,
          "default_max_tokens": 65536
        },
        {
          "id": "deepseek-v4-flash",
          "name": "DeepSeek V4 Flash",
          "cost_per_1m_in": 0.2,
          "cost_per_1m_out": 0.6,
          "context_window": 1048576,
          "default_max_tokens": 65536
        }
      ]
    }
  },
  "mcpServers": {}
}
EOF
```

把 `sk-你的DEEPSEEK_API_KEY` 替换为你的实际 key。

验证：

```bash
crush run "回复OK"     # 应该输出：OK
crush models           # 应该显示：deepseek/deepseek-v4-pro, deepseek/deepseek-v4-flash
```

### 第 4 步：初始化项目

```bash
bash /path/to/spec-workflow-mcp/templates/init.sh /path/to/your-project
```

init.sh 会自动完成 12 个步骤：

| 步骤 | 内容 |
|------|------|
| 1 | 创建项目目录 |
| 2 | 创建 `.spec-workflow/` 目录结构 |
| 3 | 写入 `config.toml` 引擎配置 |
| 4 | 复制 `CLAUDE.md` 工作流模板 |
| 5 | 复制 skills（review/qa/design-review/tdd）+ 审查子代理 |
| 6 | 部署 statusline.sh 到 `~/.claude/`（全局状态栏） |
| 7 | 创建项目级 `.claude/settings.json` |
| 8 | 配置 ai-cli-mcp（多引擎调度）→ `.mcp.json` |
| 9 | 配置 spec-workflow-mcp + Gemini CLI + Crush MCP |
| 10-12 | 可选代码智能 MCP、清理、依赖检查 |

可选参数：

```bash
bash templates/init.sh /path --with-graph       # code-review-graph（省 token）
bash templates/init.sh /path --with-nexus       # GitNexus（依赖分析）
bash templates/init.sh /path --with-understand  # Understand-Anything（可视化）
bash templates/init.sh /path --with-all         # 全部安装
bash templates/init.sh /path --force            # 强制覆盖 CLAUDE.md/skills/agents
```

### 第 5 步：开始使用

```bash
cd /path/to/your-project
claude
```

首次启动：Claude Code 会提示审批 `.mcp.json` 中的 MCP server — 选择 **Allow**。

## 工作原理

```
阶段1  Claude 规划
       ├── 调用 spec-workflow-guide 获取流程指南
       ├── requirements.md → dashboard 审批（可打回修改）
       ├── design.md       → dashboard 审批
       └── tasks.md        → 每个任务标注 _Engine → dashboard 审批

阶段2  逐任务执行（循环）
       ├── spec-status → 获取下一个 pending 任务 + 引擎建议
       ├── 编辑 tasks.md：[ ] → [-] 标记开始
       ├── 通过 ai_cli_run MCP 工具调度对应引擎
       ├── 跑测试 → verify-task green/red
       │   ├── green → 自动标 [x]，调 log-implementation 记录
       │   └── red → 修复后重试，超限自动标 [~] blocked
       └── 继续下一个任务

阶段3  完成 / 报告（可选）
       ├── Claude 写 Markdown 报告 + SVG 图表
       ├── Codex 将 SVG 转精美图像
       └── gen-report.py → 学术论文格式 docx
```

## 引擎调度

所有引擎通过 **ai-cli-mcp**（单一 MCP server）统一调度。Claude 不会直接通过 Bash 调用 CLI。

| 引擎 | 模型字符串 | 用途 |
|------|-----------|------|
| DeepSeek V4 Pro | `oc-deepseek/deepseek-v4-pro` | 编码、重构、修 bug（默认） |
| DeepSeek V4 Flash | `oc-deepseek/deepseek-v4-flash` | 快速/低成本编码任务 |
| Gemini 2.5 Pro | `gemini-2.5-pro` | 大规模代码/文档阅读、代码库研究（免费大上下文） |
| Gemini 2.5 Flash | `gemini-2.5-flash` | 快速文件阅读（免费） |
| Codex GPT-5.4 | `gpt-5.4` | 图像生成、SVG 转换 |
| Claude | （直接执行） | 规划、验证、编排 |

底层原理：ai-cli-mcp 通过 **Crush** CLI（OpenCode 继任者）调用 DeepSeek API。`.mcp.json` 中的 `OPENCODE_CLI_NAME=crush` 环境变量使其生效。

## MCP 架构

```
Claude Code（主控）
├── spec-workflow-mcp     — 工作流管理（6 个工具）
├── ai-cli-mcp            — 引擎调度（run/wait/peek/get_result/doctor/models）
│   ├── Crush CLI         → DeepSeek V4（通过 OPENCODE_CLI_NAME=crush）
│   ├── Gemini CLI        → Gemini 2.5/3
│   └── Codex CLI         → GPT-5.x
├── code-review-graph     — 知识图谱（可选，--with-graph）
└── gitnexus              — 依赖分析（可选，--with-nexus）
```

## 使用方式

MCP 工具会被自动调用。也可以用自然语言触发：

```
"帮我做一个用户认证系统"              → Claude 开始 spec-workflow 规划
"查看 user-auth 的进度"              → spec-status
"这个任务测试通过了"                  → verify-task signal:green
"测试失败了，报错 xxx"                → verify-task signal:red
"用 /review 审查代码"                → 并行启动 4 个审查子代理
"用 /tdd 模式开发这个功能"            → 调度 DeepSeek 进行 TDD 开发
"用 /qa 跑一遍测试"                  → 调度 DeepSeek 进行 QA 测试
"帮我看看 UI"                        → Claude 直接执行视觉审查（多模态）
"全面审查一下"                       → 并行启动 4 个审查子代理
```

## Dashboard

```bash
node /path/to/spec-workflow-mcp/dist/index.js --dashboard
# → http://localhost:5000
```

| 功能 | 说明 |
|------|------|
| Kanban 看板 | 拖拽任务在 pending/in-progress/completed/blocked 之间 |
| Spec 编辑器 | 在线编辑 requirements/design/tasks Markdown |
| 审批系统 | approve / reject / request changes，支持 diff 对比 |
| 实现日志 | 查看每个任务的 artifacts 记录 |

## 审查子代理（4 个，并行独立上下文）

自动安装到 `.claude/agents/`，在独立上下文中运行，不污染主对话：

| 子代理 | 审查方向 |
|--------|---------|
| `security-reviewer` | 注入漏洞、认证缺陷、硬编码密钥、CVE |
| `logic-reviewer` | 边界条件、竞态、资源泄漏、错误处理 |
| `performance-reviewer` | N+1 查询、内存泄漏、阻塞操作、包体积 |
| `api-reviewer` | 命名规范、HTTP 语义、版本兼容、数据验证 |

## 技能（4 个，来自 GStack + Superpowers）

自动安装到 `.claude/skills/`：

| 技能 | 引擎 | 用途 |
|------|------|------|
| `/review` | Claude | 并行启动 4 个审查子代理（安全、逻辑、性能、API） |
| `/qa` | DeepSeek | 系统化 QA 测试 + 原子修复 |
| `/design-review` | Claude | 视觉/交互审查（多模态） |
| `/tdd` | DeepSeek | TDD 红绿重构 + worktree 隔离 |

## Statusline（状态栏）

自动部署到 `~/.claude/statusline.sh`：

```
Opus 4.6 (1M context)  |  my-project  |  main
上下文 ████░░░░░░ 42%  |  令牌 入385.0K 出128.0K  |  花费 $1.85  |  时长 30分45秒  |  代码 +320/-67  |  限额 23%
```

自动将会话消费数据写入 `.spec-workflow/session-usage.json`。

## 消费追踪

| 层级 | 文件 | 触发时机 | 记录内容 |
|------|------|---------|---------|
| 任务级 | `usage-log.json` | 每次 verify-task 调用 | 引擎、任务、token、花费 |
| 会话级 | `session-usage.json` | statusline 每次 tick | 模型、总 token、总花费、代码增删 |

## 项目结构（init 后）

```
your-project/
├── CLAUDE.md                          # 工作流指南（Claude Code 自动读取）
├── .mcp.json                          # MCP server 配置（ai-cli, spec-workflow 等）
├── .claude/
│   ├── settings.json                  # 权限配置
│   ├── agents/                        # 审查子代理
│   └── skills/                        # /review, /qa, /design-review, /tdd
└── .spec-workflow/
    ├── config.toml                    # 引擎配置
    ├── specs/                         # 规格文档（工作流中生成）
    ├── approvals/                     # 审批数据
    ├── steering/                      # 项目指导（可选）
    ├── reports/                       # 引擎输出报告（自动生成）
    ├── usage-log.json                 # 任务级消费追踪（自动）
    └── session-usage.json             # 会话级消费追踪（自动）
```

## 故障排查

| 问题 | 解决方案 |
|------|---------|
| MCP 工具不可用 | 重启 Claude Code 会话。首次使用需审批 MCP server |
| `ai-cli: Failed to reconnect` | 检查 `crush --version` 已安装。检查 `.mcp.json` 中 env 有 `"OPENCODE_CLI_NAME": "crush"` |
| DeepSeek 调度失败 | 运行 `crush run "test"` 验证 API 配置。检查 `~/.config/crush/crush.json` |
| Gemini 不工作 | 运行 `gemini` 进行浏览器登录 |
| Dashboard 启动失败 | 检查 5000 端口是否被占用：`lsof -i :5000` |
| `spec-status` 报错 | 确认 `.mcp.json` 中 args 的项目路径正确 |
| 重置 MCP 审批 | `claude mcp reset-project-choices` |

## Dashboard 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `SPEC_WORKFLOW_BIND_ADDRESS` | `127.0.0.1` | 网络绑定地址（`0.0.0.0` 允许外部访问） |
| `SPEC_WORKFLOW_ALLOW_EXTERNAL_ACCESS` | `false` | 绑定非 localhost 时必须设为 `true` |
| `SPEC_WORKFLOW_CORS_ORIGINS` | （无） | 额外 CORS 域名，逗号分隔（如 `http://my-domain.com,https://my-domain.com`） |

示例 — 通过反向代理暴露 Dashboard：

```bash
SPEC_WORKFLOW_ALLOW_EXTERNAL_ACCESS=true \
SPEC_WORKFLOW_BIND_ADDRESS=0.0.0.0 \
SPEC_WORKFLOW_CORS_ORIGINS=https://my-domain.com \
node dist/index.js /path/to/project --dashboard --port 5000
```

示例 — systemd 服务：

```ini
[Unit]
Description=Spec Workflow Dashboard
After=network.target

[Service]
Type=simple
Environment=SPEC_WORKFLOW_ALLOW_EXTERNAL_ACCESS=true
Environment=SPEC_WORKFLOW_BIND_ADDRESS=0.0.0.0
Environment=SPEC_WORKFLOW_CORS_ORIGINS=https://my-domain.com
ExecStart=/usr/bin/node /path/to/dist/index.js /path/to/project --dashboard --no-open --port 5000
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

## 引擎配置

`.spec-workflow/config.toml`：

```toml
[engine]
default = "deepseek"        # 默认引擎
maxFixAttempts = 5           # 红灯最大修复次数，超限自动 blocked
```

## 报告生成（可选）

```bash
pip install python-docx
python3 tools/gen-report.py docs/report/report.md -o docs/report/report.docx --images docs/report/images/
```

输出：学术论文格式（宋体/Times New Roman，A4，1.5 倍行距）。

## 可选：代码智能 MCP

通过 init.sh 参数安装：

| 工具 | 参数 | 用途 |
|------|------|------|
| [code-review-graph](https://github.com/tirth8205/code-review-graph) | `--with-graph` | Tree-sitter 知识图谱，review 时省 6.8-49x token |
| [GitNexus](https://github.com/abhigyanpatwari/GitNexus) | `--with-nexus` | 函数/依赖图谱，影响分析，重构辅助 |
| [Understand-Anything](https://github.com/Lum1104/Understand-Anything) | `--with-understand` | 多代理扫描 + React 可视化，理解新项目 |

## 致谢

- [Pimzino/spec-workflow-mcp](https://github.com/Pimzino/spec-workflow-mcp) — 核心框架
- [DeepSeek](https://github.com/deepseek-ai) — V4 模型
- [Crush](https://github.com/charmbracelet/crush) — 终端编码 Agent（OpenCode 继任者）
- [ai-cli-mcp](https://github.com/mkXultra/ai-cli-mcp) — 多引擎 MCP 调度
- [Anthropic](https://anthropic.com) — Claude Code + MCP 协议
- [garrytan/gstack](https://github.com/garrytan/gstack) — 角色技能
- [obra/superpowers](https://github.com/obra/superpowers) — TDD 纪律 + worktree 模式
