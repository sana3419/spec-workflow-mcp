# Spec Workflow MCP — Claude 主导的协同开发框架

[English](README.md)

Claude 主导的协同开发框架。Claude Code 规划、实现、审查;OpenAI Codex 作为可选引擎,按需(任务标注 `_Engine: codex`)分担编码任务。基于 [Pimzino/spec-workflow-mcp](https://github.com/Pimzino/spec-workflow-mcp) 改造，配合红绿灯验证和学术报告生成。

> **说明**：`docs/` 目录下的文件描述的是上游 Pimzino 的行为。本 fork 的具体用法请参考 `init.sh` 生成的项目 `CLAUDE.md`。

## 前置要求

| 依赖 | 检查命令 | 安装方式 |
|------|---------|---------|
| Node.js ≥ 18 | `node -v` | [nodejs.org](https://nodejs.org) |
| Claude Code | `claude -v` | `npm i -g @anthropic-ai/claude-code` |
| OpenAI Codex | `codex --version` | `npm i -g @openai/codex`，首次运行 `codex login` |
| jq | `jq --version` | `apt install jq` / `brew install jq` |

认证：

| Key | 用途 | 获取 |
|-----|------|------|
| `ANTHROPIC_API_KEY` | Claude Code（主控） | [console.anthropic.com](https://console.anthropic.com) |
| Codex 登录 | OpenAI Codex（编码引擎）— `codex login`（ChatGPT 账号）或按 Codex 文档配置 OpenAI API key | [openai.com/codex](https://openai.com/codex) |

## 安装配置

### 第 1 步：克隆并构建 spec-workflow-mcp

```bash
git clone https://github.com/sana3419/spec-workflow-mcp.git
cd spec-workflow-mcp
npm install && npm run build
```

### 第 2 步：安装 Codex CLI

```bash
npm i -g @openai/codex
codex login    # 首次运行：用 ChatGPT 账号登录（或配置 OpenAI API key）
```

### 第 3 步：初始化项目

```bash
bash /path/to/spec-workflow-mcp/templates/init.sh /path/to/your-project
```

可选参数：

```bash
bash templates/init.sh /path --with-graph       # code-review-graph（省 token）
bash templates/init.sh /path --with-nexus       # GitNexus（依赖分析）
bash templates/init.sh /path --with-all         # 安装 graph + nexus
bash templates/init.sh /path --auto-loop        # 开启阶段4自动循环（Stop hook 驱动）
bash templates/init.sh /path --force            # 强制覆盖 CLAUDE.md/skills/agents
```

> 想要代码库可视化?[Understand-Anything](https://github.com/Lum1104/Understand-Anything) 是一个独立的 Claude Code 插件(**不由 `init.sh` 托管**)——需要的话在 Claude Code 内运行 `/plugin install understand-anything` 手动安装。

### 第 4 步：开始使用

```bash
cd /path/to/your-project
claude
```

首次启动：Claude Code 会提示审批 `.mcp.json` 中的 MCP server — 选择 **Allow**。

## 工作原理

```
阶段1-3  Claude 规划
       ├── 调用 spec-workflow-guide 获取流程指南
       ├── requirements.md → 对话内确认（可在对话里打回修改）
       ├── design.md       → 对话内确认
       └── tasks.md        → 每个任务标注 _Engine → 对话内确认

阶段4  逐任务执行（循环）
       ├── spec-status → 获取下一个 pending 任务 + 调度提示
       ├── 编辑 tasks.md：[ ] → [-] 标记开始
       ├── 默认由 Claude 自己实现该任务;仅当任务标注 _Engine: codex 时,才通过 codex MCP 工具分担给 Codex 编码
       ├── 跑测试 → verify-task green/red
       │   ├── green → 自动标 [x]，调 log-implementation 记录
       │   └── red → codex-reply 带失败日志重试，超限自动标 [~] blocked
       └── 继续下一个任务

阶段5  完成 / 报告（可选）
       ├── Claude 写 Markdown 报告 + SVG 图表
       ├── rsvg-convert 将 SVG 转图像
       └── gen-report.py → 学术论文格式 docx
```

**审批在对话内完成。** Claude 会把每份 `requirements.md` / `design.md` / `tasks.md` 在对话里呈给你，只有你在对话中同意后才进入下一阶段。没有 Dashboard 审批页，也没有 VS Code 审批流程。

## Codex 调度（可选）

默认情况下,每个任务都由 Claude 自己实现。当某个任务在 `tasks.md` 中标注 `_Engine: codex` 时——适用于大规模、重复性或可并行的编码,或为节省 Claude 的上下文——Claude 才通过 Codex **自带的 MCP server** 把该任务分担给 OpenAI Codex。Claude 不会直接通过 Bash 调用 CLI。`init.sh` 会把 codex server 写入项目 `.mcp.json`：

```json
"codex": { "type": "stdio", "command": "codex", "args": ["mcp-server"], "env": {} }
```

codex MCP server 暴露两个工具：

- `mcp__codex__codex(prompt, sandbox, approval-policy, model, cwd)` → 开启新 Codex 会话，返回 `threadId`
- `mcp__codex__codex-reply(threadId, prompt)` → 续接已有会话

**按 spec 复用会话。** 每个 spec 在 `.spec-workflow/specs/<spec>/.codex-thread` 中保存一个 threadId。该 spec 的第一个任务调用 `codex()` 并保存 threadId；同一 spec 的后续任务以及任何红→修复重试调用 `codex-reply()`。仅当遇到新的/不相关的 spec、或 `codex-reply` 失败（线程过期）时才开启新会话。这样 worker 能在一个 spec 的各任务及修复过程中保持上下文 —— 既高效又准确。

**Codex 参数** 来自 `.spec-workflow/config.toml` 的 `[engine.codex]`：

| 键 | 取值 | 默认 |
|----|------|------|
| `sandbox` | `read-only` \| `workspace-write` \| `danger-full-access` | `workspace-write` |
| `approvalPolicy` | `untrusted` \| `on-failure` \| `on-request` \| `never` | `never` |
| `model` | （可选）Codex 模型 | — |

另有 `[engine] default = "claude"` 和 `maxFixAttempts = 5`。完整文件：

```toml
[engine]
default = "claude"          # claude | codex（claude = Claude 直接实现;codex = 分担给 Codex）
maxFixAttempts = 5           # 红灯最大修复次数，超限自动 blocked

[engine.codex]
sandbox = "workspace-write"  # read-only | workspace-write | danger-full-access
approvalPolicy = "never"     # untrusted | on-failure | on-request | never
# model = "..."             # 可选 — 建议保持注释，让 Codex 用最新默认模型

[loop]
autoLoop = false             # true = Stop hook 驱动阶段4跑到完成（总开关）
maxIterations = 50           # 自动循环硬上限
noProgressStop = 3           # 连续 N 轮 tasks.md 无变化则停止
```

**自主的 验证→修复 闭环。** 调度 → worker 把报告写入 `.spec-workflow/reports/codex-<task>-<timestamp>.md` → Claude 跑测试 → `verify-task` green/red → 红灯时用 `codex-reply` 带失败日志重试（受 `maxFixAttempts` 限制）→ `log-implementation`。

## 自动循环（可选，需主动开启）

默认情况下阶段4是**提示驱动**的：Claude 在任务之间会停下，由你推动继续。开启后，Stop hook 会驱动阶段4自动跑到完成，无需逐次提示。

```bash
bash init.sh /path/to/your-project --auto-loop
```

这会在项目 `.claude/settings.json` 注册一个 `Stop` hook，并把 `config.toml` 的 `[loop].autoLoop` 置为 `true`。每轮结束后 hook 检查当前 spec，若仍有任务就提示 Claude 继续。

- **暂停：** 把 `config.toml` 的 `[loop].autoLoop` 改为 `false`。hook 保持注册并按此开关自门控，无需删除 hook。（**未先通过 `--auto-loop` 注册 hook 时，仅改 config 无效。**）
- **护栏：** `maxIterations`（默认 50）硬性封顶循环；`noProgressStop`（默认 3）在连续 N 轮 `tasks.md` 无变化后停止。仅当 `.spec-workflow/.autoloop-active` 标记存在（阶段4）时循环才生效。
- **审计日志：** 每轮迭代与停止原因都会追加到 `.spec-workflow/loop-audit.log`。
- **人工接管：** 若循环跑飞，删除 `.spec-workflow/.autoloop-active` 即可立即终止。

## MCP 架构

```
Claude Code（主控）
├── spec-workflow-mcp     — 工作流管理（5 个工具）
├── codex（MCP server）   — 编码调度
│   ├── codex(prompt, sandbox, approval-policy, model)  → 新会话（threadId）
│   └── codex-reply(threadId, prompt)                   → 复用会话
├── code-review-graph     — 知识图谱（可选，--with-graph）
└── gitnexus              — 依赖分析（可选，--with-nexus）
```

## MCP 工具

| Server | 工具 | 用途 |
|--------|------|------|
| spec-workflow-mcp | `spec-workflow-guide` | 完整工作流指南（每个会话先调用） |
| | `steering-guide` | 项目指导文档 |
| | `spec-status` | 进度 + 下一任务调度提示 |
| | `verify-task` | 红绿灯验证（green→完成，red→修复/blocked） |
| | `log-implementation` | 记录实现日志与产物 |
| codex | `mcp__codex__codex` | 开启新 Codex 会话（返回 threadId） |
| | `mcp__codex__codex-reply` | 按 threadId 续接已有 Codex 会话 |

## 使用方式

MCP 工具会被自动调用。也可以用自然语言触发：

```
"帮我做一个用户认证系统"              → Claude 开始 spec-workflow 规划
"查看 user-auth 的进度"              → spec-status
"这个任务测试通过了"                  → verify-task signal:green
"测试失败了，报错 xxx"                → verify-task signal:red
"用 /review 审查代码"                → 并行启动 4 个审查子代理
"用 /tdd 模式开发这个功能"            → 调度 Codex 进行 TDD 开发
"用 /qa 跑一遍测试"                  → 调度 Codex 进行 QA 测试
"帮我看看 UI"                        → Claude 直接执行视觉审查（多模态）
"全面审查一下"                       → 并行启动 4 个审查子代理
```

## Dashboard

```bash
node /path/to/spec-workflow-mcp/dist/index.js --dashboard
# → http://localhost:5000
```

仅用于监控：Kanban 看板、specs、tasks、实现日志、统计、设置。（审批在对话内完成，不在 Dashboard。）

| 功能 | 说明 |
|------|------|
| Kanban 看板 | 查看任务在 pending/in-progress/completed/blocked 之间的状态 |
| specs / tasks | 浏览 requirements/design/tasks 文档与任务进度 |
| 实现日志 | 查看每个任务的 artifacts 记录 |
| 统计 / 设置 | 用量统计与 Dashboard 设置 |

部署配置（绑定地址、CORS、systemd）见 [docs/DASHBOARD-DEPLOYMENT.md](docs/DASHBOARD-DEPLOYMENT.md)。

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
| `/qa` | Codex | 系统化 QA 测试 + 原子修复 |
| `/design-review` | Claude | 视觉/交互审查（多模态） |
| `/tdd` | Codex | TDD 红绿重构 + worktree 隔离 |

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
├── AGENTS.md                          # Codex worker 指令（Codex 原生读取）
├── .mcp.json                          # MCP server 配置（codex, spec-workflow 等）
├── .claude/
│   ├── settings.json                  # 权限配置
│   ├── agents/                        # 审查子代理
│   └── skills/                        # /review, /qa, /design-review, /tdd
└── .spec-workflow/
    ├── config.toml                    # 引擎 + 循环配置
    ├── steering/                      # 项目指导（可选）
    ├── specs/                         # 规格文档（工作流中生成）
    │   └── <spec>/                    # requirements/design/tasks.md
    │       ├── .codex-thread          # 按 spec 的 Codex 会话 id
    │       ├── Implementation Logs/   # log-implementation 产物
    │       └── verify-results/        # verify-task 结果
    ├── reports/                       # Codex 输出报告（codex-<task>-<timestamp>.md）
    ├── usage-log.json                 # 任务级消费追踪（自动）
    └── session-usage.json             # 会话级消费追踪（自动）
```

## 故障排查

| 问题 | 解决方案 |
|------|---------|
| MCP 工具不可用 | 重启 Claude Code 会话。首次使用需审批 MCP server |
| Codex 调度失败 | 运行 `codex login`。检查 `codex --version`。检查 `.mcp.json` 是否包含 codex server |
| Dashboard 启动失败 | 检查 5000 端口是否被占用：`lsof -i :5000` |
| `spec-status` 报错 | 确认 `.mcp.json` 中 args 的项目路径正确 |
| 重置 MCP server 授权 | `claude mcp reset-project-choices` |

## 报告生成（可选）

```bash
pip install python-docx
python3 tools/gen-report.py docs/report/report.md -o docs/report/report.docx --images docs/report/images/
```

输出：学术论文格式（宋体/Times New Roman，A4，1.5 倍行距）。

## 可选：代码智能 MCP

| 工具 | 安装方式 | 用途 |
|------|---------|------|
| [code-review-graph](https://github.com/tirth8205/code-review-graph) | `init.sh --with-graph` | Tree-sitter 知识图谱，review 时省 6.8-49x token |
| [GitNexus](https://github.com/abhigyanpatwari/GitNexus) | `init.sh --with-nexus` | 函数/依赖图谱，影响分析，重构辅助 |
| [Understand-Anything](https://github.com/Lum1104/Understand-Anything) | Claude Code 内 `/plugin install understand-anything`（独立插件，init.sh 不托管） | 多代理扫描 + React 可视化，理解新项目 |

## 致谢

- [Pimzino/spec-workflow-mcp](https://github.com/Pimzino/spec-workflow-mcp) — 核心框架
- [OpenAI Codex](https://openai.com/codex) — 编码引擎 + MCP server
- [Anthropic](https://anthropic.com) — Claude Code + MCP 协议
- [garrytan/gstack](https://github.com/garrytan/gstack) — 角色技能
- [obra/superpowers](https://github.com/obra/superpowers) — TDD 纪律 + worktree 模式
