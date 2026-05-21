# Spec Workflow MCP — 多引擎协同开发框架

基于 [Pimzino/spec-workflow-mcp](https://github.com/Pimzino/spec-workflow-mcp) 改造的多引擎协同开发框架。Claude Code 作为主控大脑，调度 DeepSeek / Gemini / Codex / Claude 四个引擎，配合红绿灯验证和学术报告生成。

## 启发来源

| 来源 | 贡献 |
|------|------|
| [Pimzino/spec-workflow-mcp](https://github.com/Pimzino/spec-workflow-mcp) | 核心框架：Requirements → Design → Tasks → Implementation 流程、Dashboard、审批系统 |
| [auto-claude](../auto-claude/) | 红绿灯验证机制（green/red 信号）、feature_list.json 进度追踪 |
| [garrytan/gstack](https://github.com/garrytan/gstack) | 角色技能：/review、/qa、/design-review |
| [obra/superpowers](https://github.com/obra/superpowers) | TDD 红绿重构纪律、子代理 worktree 隔离模式 |
| [code-review-graph](https://github.com/tirth8205/code-review-graph) / [GitNexus](https://github.com/abhigyanpatwari/GitNexus) / [Understand-Anything](https://github.com/Lum1104/Understand-Anything) | 可选代码智能 MCP（知识图谱、依赖分析、可视化） |

## 快速开始

### 1. 克隆并构建

```bash
git clone https://github.com/sana3419/spec-workflow-mcp.git
cd spec-workflow-mcp
npm install && npm run build
```

### 2. 初始化新项目

```bash
bash templates/init.sh /path/to/your-project
```

init.sh 会自动完成 10 个步骤：

| 步骤 | 内容 |
|------|------|
| 1 | 创建项目目录 |
| 2 | 创建 `.spec-workflow/` 目录结构 |
| 3 | 写入 `config.toml` 引擎配置 |
| 4 | 复制 `CLAUDE.md` 工作流模板 |
| 5 | 复制 skills（review/qa/design-review/tdd） |
| 6 | 部署 statusline.sh 到 `~/.claude/`（全局状态栏） |
| 7 | 创建项目级 `.claude/settings.json` |
| 8 | 配置代码智能 MCP（可选，见下方） |
| 9 | 配置 spec-workflow-mcp 为 MCP server |
| 10 | 检查工具链 |

可选参数（步骤 8）：
```bash
bash templates/init.sh /path --with-graph       # code-review-graph（省 token）
bash templates/init.sh /path --with-nexus       # GitNexus（依赖分析）
bash templates/init.sh /path --with-understand  # Understand-Anything（可视化）
bash templates/init.sh /path --with-all         # 全部安装
```

初始化后的项目结构：
```
your-project/
├── CLAUDE.md                          # Claude Code 自动读取的工作流指南
├── .claude/
│   ├── settings.json                  # 权限配置
│   ├── agents/                        # 审查子代理（独立上下文）
│   │   ├── security-reviewer.md
│   │   ├── logic-reviewer.md
│   │   ├── performance-reviewer.md
│   │   └── api-reviewer.md
│   └── skills/
│       ├── review/SKILL.md            # /review — 自动调用 gemini CLI
│       ├── qa/SKILL.md                # /qa — 自动调用 deepseek CLI
│       ├── design-review/SKILL.md     # /design-review — Claude 多模态审查
│       └── tdd/SKILL.md               # /tdd — 自动调用 deepseek CLI
└── .spec-workflow/
    ├── config.toml                    # 引擎配置
    ├── specs/                         # 规格文档（运行后生成）
    ├── approvals/                     # 审批数据
    ├── steering/                      # 项目指导（可选）
    ├── usage-log.json                 # 多引擎消费记录（自动生成）
    └── session-usage.json             # Claude 会话消费记录（statusline 自动写入）
```

### 3. 开始使用

```bash
cd /path/to/your-project
claude
```

进入 Claude Code 后的推荐步骤：

```
1. 告诉 Claude 你的需求（例如"帮我做一个用户认证系统"）
2. Claude 自动调用 spec-workflow-guide 获取流程 → 开始规划
3. 在 Dashboard (localhost:5000) 上审批每个阶段文档
4. Claude 按任务逐个执行，你可以观察 Kanban 看板进度
5. 全部完成后可选生成研究报告
```

### MCP 工具使用指令

在 Claude Code 对话中，MCP 工具会被自动调用。你也可以手动触发：

```
"查看 user-auth 的进度"          → Claude 调用 spec-status
"审批通过"                       → Claude 调用 approvals action:request
"这个任务测试通过了"              → Claude 调用 verify-task signal:green
"测试失败了，报错 xxx"            → Claude 调用 verify-task signal:red
"用 /review 审查代码"             → 自动调用 gemini CLI 审查
"用 /tdd 模式开发这个功能"        → 自动调用 deepseek CLI TDD 开发
"用 /qa 跑一遍测试"              → 自动调用 deepseek CLI QA 测试
"帮我看看 UI"                    → Claude 直接执行视觉审查（多模态）
```

Dashboard 操作：
```
启动 Dashboard:  node <spec-workflow-mcp>/dist/index.js --dashboard
访问地址:        http://localhost:5000
审批文档:        在 Approvals 页面点击 approve/reject/request changes
修改需求:        在 Specs 页面直接编辑 Markdown
查看进度:        在 Tasks 页面查看 Kanban 看板
恢复 blocked:   在看板中将 blocked 任务拖回 pending 列
```

## 工作流程

```
阶段1  Claude 规划
       ├── 调用 spec-workflow-guide 获取流程指南
       ├── requirements.md → dashboard 审批（可打回修改）
       ├── design.md       → dashboard 审批
       └── tasks.md        → 每个任务标注 _Engine → dashboard 审批

阶段2  逐任务执行（循环）
       ├── spec-status → 获取下一个 pending 任务 + 引擎建议 + 调度命令
       ├── 编辑 tasks.md：[ ] → [-] 标记开始
       ├── 根据 _Engine 调度对应引擎执行编码
       ├── 跑测试 → verify-task green/red
       │   ├── green → 自动标 [x]，调 log-implementation 记录
       │   └── red → 修复后重试，超限自动标 [~] blocked
       └── 继续下一个任务

阶段3  完成 / 报告（可选）
       ├── Claude 写 Markdown 报告 + SVG 图表
       ├── Codex 将 SVG 转精美图像（自主发挥风格）
       └── gen-report.py → 学术论文格式 docx
```

## 四大引擎

| 引擎 | 用途 | 调用方式 |
|------|------|---------|
| `deepseek`（默认） | 编码、重构、修 bug | `deepseek -p "..."` (DeepSeek TUI) |
| `gemini` | 审查、大仓浏览（免费） | `gemini -p "..."` |
| `codex` | SVG 转精美图像（报告阶段） | `codex -p "..."` |
| `claude` | 规划、任务拆解、交叉验证 | 直接执行（主控引擎） |

引擎配置（`.spec-workflow/config.toml`）：
```toml
[engine]
default = "deepseek"        # 默认引擎
deepseekModel = "auto"      # DeepSeek TUI 模型（auto 自动路由）
maxFixAttempts = 5           # 红灯最大修复次数
```

tasks.md 中标注引擎：
```markdown
- [ ] 1. 实现数据库模型
  - _Engine: deepseek_
  - _Prompt: Role: Backend Dev | Task: ...

- [ ] 2. 审查现有 API
  - _Engine: gemini_
  - _Prompt: Role: Reviewer | Task: ...
```

## MCP 工具（6 个）

| 工具 | 功能 |
|------|------|
| `spec-workflow-guide` | 获取完整工作流指南（每次新会话先调用） |
| `steering-guide` | 项目指导文档创建 |
| `spec-status` | 查看进度 + 下一任务引擎建议 + 调度命令 |
| `approvals` | 审批流程（request/status/delete） |
| `verify-task` | 红绿灯验证（green→自动完成，red→修复/blocked） |
| `log-implementation` | 记录实现日志和 artifacts（知识库） |

## 审查子代理（4 个，并行独立上下文）

初始化时自动安装到 `.claude/agents/`，在独立上下文中运行审查，不污染主对话：

| 子代理 | 审查方向 | 可用 MCP |
|--------|---------|---------|
| `security-reviewer` | 注入漏洞、认证缺陷、硬编码密钥、CVE | code-review-graph, gitnexus |
| `logic-reviewer` | 边界条件、竞态、资源泄漏、错误处理 | code-review-graph, gitnexus |
| `performance-reviewer` | N+1 查询、内存泄漏、阻塞操作、包体积 | code-review-graph, gitnexus |
| `api-reviewer` | 命名规范、HTTP 语义、版本兼容、数据验证 | code-review-graph, gitnexus |

使用方式：
```
"用子代理审查安全性"              → 启动 security-reviewer
"全面审查一下"                   → 并行启动 4 个子代理
"用子代理检查性能问题"            → 启动 performance-reviewer
```

子代理会自动利用 code-review-graph / gitnexus 的知识图谱（如果已安装），只读取相关代码，大幅节省 token。

## 技能（4 个，来自 GStack + Superpowers）

初始化时自动安装到 `.claude/skills/`：

| 技能 | 推荐引擎 | 用途 | 来源 |
|------|---------|------|------|
| `/review` | gemini | 自动调用 gemini CLI 审查代码（安全、逻辑、性能、API 契约） | GStack |
| `/qa` | deepseek | 自动调用 deepseek CLI 执行 QA 测试 + 逐个修复 + 原子提交 | GStack |
| `/design-review` | claude | Claude 直接执行视觉/交互审查（多模态分析截图） | GStack |
| `/tdd` | deepseek | 自动调用 deepseek CLI TDD 开发 + 子代理 worktree 隔离 | Superpowers |

## Statusline（状态栏）

init.sh 自动部署到 `~/.claude/statusline.sh`，显示两行实时信息：

```
Opus 4.6 (1M context)  |  my-project  |  main
上下文 ████░░░░░░ 42%  |  令牌 入385.0K 出128.0K  |  花费 $1.85  |  时长 30分45秒  |  代码 +320/-67  |  限额 23%
```

- 上下文进度条颜色：<50% 绿 → 50-80% 黄 → >80% 红
- 花费颜色：<$1 绿 → $1-5 黄 → >$5 红
- 时长为 API 实际调用时间（非墙钟时间）
- 自动将会话消费数据写入 `.spec-workflow/session-usage.json`

## 消费追踪

两层自动追踪，无需手动操作：

| 层级 | 文件 | 触发时机 | 记录内容 |
|------|------|---------|---------|
| 任务级 | `usage-log.json` | 每次 verify-task 调用 | 引擎、任务、token、花费 |
| 会话级 | `session-usage.json` | statusline 每次 tick | 模型、总 token、总花费、代码增删 |

## 报告生成

```bash
# Markdown → 学术论文 docx（宋体/Times New Roman，四号正文，1.5 倍行距）
python3 tools/gen-report.py docs/report/report.md -o docs/report/report.docx --images docs/report/images/
```

依赖：`pip install python-docx`

## 可选：代码智能 MCP

通过 init.sh 参数安装，作为独立 MCP server 运行：

| 工具 | 参数 | 用途 |
|------|------|------|
| [code-review-graph](https://github.com/tirth8205/code-review-graph) | `--with-graph` | Tree-sitter 知识图谱，review 时省 6.8-49x token |
| [GitNexus](https://github.com/abhigyanpatwari/GitNexus) | `--with-nexus` | 函数/依赖图谱，影响分析，重构辅助 |
| [Understand-Anything](https://github.com/Lum1104/Understand-Anything) | `--with-understand` | 多代理扫描 + React 可视化，理解新项目 |

## 依赖工具

| 工具 | 用途 | 安装 |
|------|------|------|
| Claude Code | 主控大脑 | `npm i -g @anthropic-ai/claude-code` |
| DeepSeek TUI | 默认编码引擎 | `npm i -g deepseek-tui`（ARM64 需 cargo 编译） |
| Gemini CLI | 审查引擎（免费） | `npm i -g @google/gemini-cli` |
| Codex CLI | 图像生成 | `npm i -g @openai/codex` |
| python-docx | 报告生成 | `pip install python-docx` |
| jq | JSON 处理（statusline 依赖） | `apt install jq` |

## Dashboard

启动：`node dist/index.js --dashboard`，访问 `http://localhost:5000`

功能：
- Kanban 看板：拖拽任务状态，显示引擎标签
- Spec 编辑器：在线修改需求/设计/任务
- 审批系统：approve / reject / request changes，支持 diff 对比
- 实现日志：查看每个任务的 artifacts 记录

## 致谢

- [Pimzino/spec-workflow-mcp](https://github.com/Pimzino/spec-workflow-mcp) — 核心框架
- [DeepSeek](https://github.com/deepseek-ai) — V4 模型 + TUI
- [Anthropic](https://anthropic.com) — Claude Code + MCP 协议
- [garrytan/gstack](https://github.com/garrytan/gstack) — 角色技能
- [obra/superpowers](https://github.com/obra/superpowers) — TDD 纪律 + worktree 模式
