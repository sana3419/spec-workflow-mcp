# Spec Workflow MCP — 多引擎协同开发框架

基于 [Pimzino/spec-workflow-mcp](https://github.com/Pimzino/spec-workflow-mcp) 改造的多引擎协同开发框架。Claude Code 作为主控大脑，调度 DeepSeek / Gemini / Codex / Claude 四个引擎，配合红绿灯验证和学术报告生成。

## 启发来源

本项目的设计思路来自三个方向的融合：

1. **[Pimzino/spec-workflow-mcp](https://github.com/Pimzino/spec-workflow-mcp)** — Spec 驱动开发的核心框架，提供了 Requirements → Design → Tasks → Implementation 的结构化流程、Dashboard 实时监控和审批系统。本项目在此基础上进行改造。

2. **[auto-claude](../auto-claude/)** — 自主编码 Agent 项目，贡献了红绿灯验证机制（功能自测 → 集成回归 → green/red 信号）和 feature_list.json 进度追踪的思路。verify-task 工具的设计直接借鉴于此。

3. **多引擎协同理念** — 2026 年 AI 编码工具生态的演进启发了"让合适的引擎做合适的事"的调度策略：DeepSeek TUI 负责编码（LiveCodeBench 93.5，成本低），Gemini CLI 负责审查（免费额度大），Claude 负责规划和验证（推理能力强）。

## 在原版基础上的改造

| 改造项 | 说明 |
|--------|------|
| 多引擎调度 | 任务 `_Engine:` 字段指定引擎，`spec-status` 返回调度建议 |
| 红绿灯验证 | 新增 `verify-task` 工具，green 自动标完成，red 超限自动 blocked |
| 引擎配置 | `config.toml` 的 `[engine]` section，支持自定义默认引擎和模型 |
| 学术报告生成 | `gen-report.py` 将 Markdown + 图片转为学术论文格式 docx |
| 项目初始化 | `init.sh` 一键创建 `.spec-workflow/` + `CLAUDE.md` |
| 精简国际化 | 仅保留中文 + 英文 |

## 快速开始

### 1. 安装

```bash
cd spec-workflow-mcp && npm install
```

### 2. 配置 Claude Code MCP

在 `~/.claude/settings.json` 中添加：

```json
{
  "mcpServers": {
    "spec-workflow": {
      "command": "node",
      "args": ["<path-to>/spec-workflow-mcp/dist/index.js", "<your-project>"]
    }
  }
}
```

### 3. 初始化新项目

```bash
bash <path-to>/spec-workflow-mcp/templates/init.sh /path/to/your-project
```

生成：
```
your-project/
├── CLAUDE.md                    # Claude Code 自动读取
└── .spec-workflow/
    ├── config.toml              # 引擎配置
    ├── specs/
    ├── approvals/
    └── steering/
```

### 4. 开始使用

```bash
cd /path/to/your-project
claude
# 告诉 Claude 你的需求，它会自动走 spec-workflow 流程
```

## 工作流程

```
阶段1  Claude 规划
       ├── requirements.md → dashboard 审批
       ├── design.md       → dashboard 审批
       └── tasks.md        → 每个任务标注 _Engine → dashboard 审批

阶段2  逐任务执行
       ├── spec-status → 获取下一任务 + 引擎建议
       ├── 根据 _Engine 调度引擎（deepseek/gemini/claude）
       ├── 跑测试 → verify-task green/red
       └── log-implementation 记录 artifacts

阶段3  完成 / 报告（可选）
       ├── Claude 写 Markdown 报告 + SVG 图表
       ├── Codex 将 SVG 转精美图像
       └── gen-report.py → 学术论文格式 docx
```

## 引擎配置

`.spec-workflow/config.toml`：

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

## MCP 工具

| 工具 | 功能 |
|------|------|
| `spec-workflow-guide` | 获取完整工作流指南 |
| `steering-guide` | 项目指导文档 |
| `spec-status` | 查看进度 + 下一任务引擎建议 |
| `approvals` | 审批流程（request/status/delete） |
| `verify-task` | 红绿灯验证（green→完成，red→修复/blocked） |
| `log-implementation` | 记录实现日志和 artifacts |

## 报告生成

```bash
# Markdown → 学术论文 docx
python3 tools/gen-report.py report.md -o report.docx --images images/
```

格式：宋体/Times New Roman，四号正文，1.5 倍行距，A4 页面。

## 依赖工具

| 工具 | 用途 | 安装 |
|------|------|------|
| Claude Code | 主控大脑 | `npm i -g @anthropic-ai/claude-code` |
| DeepSeek TUI | 编码引擎 | `npm i -g deepseek-tui` |
| Gemini CLI | 审查引擎 | Google Cloud CLI |
| Codex CLI | 图像生成 | `npm i -g @openai/codex` |

## 致谢

- [Pimzino/spec-workflow-mcp](https://github.com/Pimzino/spec-workflow-mcp) — 核心框架
- [DeepSeek](https://github.com/deepseek-ai) — V4 模型 + TUI
- [Anthropic](https://anthropic.com) — Claude Code + MCP 协议
