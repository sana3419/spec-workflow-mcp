# Project CLAUDE.md

## MCP 工具

本项目通过 spec-workflow-mcp 进行规格驱动开发，有以下 MCP 工具可用：

- `spec-workflow-guide` — 获取完整工作流指南（每次新会话先调用）
- `steering-guide` — 项目指导文档创建
- `spec-status` — 查看进度和下一个任务（含引擎建议）
- `approvals` — 审批流程（request/status/delete）
- `log-implementation` — 记录实现日志和 artifacts
- `verify-task` — 红绿灯验证（green/red 信号）

## 多引擎调度

任务通过 `_Engine:` 字段指定执行引擎：

| 引擎 | 用途 | 调用方式 |
|------|------|---------|
| `deepseek`（默认） | 编码、重构、修 bug | `deepseek -p "..."` (DeepSeek TUI, 支持 --model auto) |
| `gemini` | 审查、大仓浏览 | `gemini -p "..."` |
| `claude` | 规划、复杂推理 | 直接执行 |

调用 `spec-status` 会返回下一个任务的引擎建议和调度命令。

## 工作流程

### 规划阶段（Claude 执行）
1. 调用 `spec-workflow-guide` 获取指南
2. 与用户讨论需求 → 写 `requirements.md` → 提交审批
3. 写 `design.md` → 提交审批
4. 写 `tasks.md`（每个任务标注 `_Engine:`）→ 提交审批
5. 用户在 dashboard 审批每个阶段（可打回修改）

### 实现阶段（按任务循环）
1. 调用 `spec-status` → 获取下一个 pending 任务 + 引擎建议
2. 编辑 `tasks.md`：`[ ]` → `[-]` 标记开始
3. 根据 `_Engine` 调度对应引擎执行编码
4. 通过 Bash 运行测试
5. 调用 `verify-task`：
   - `signal: "green"` → 自动标 `[x]`，然后调 `log-implementation`
   - `signal: "red"` → 记录失败，修复后重试（超限自动 blocked）
6. 调用 `log-implementation` 记录 artifacts
7. 继续下一个任务

### 完成后：研究报告（可选）
所有任务完成后，可生成学术风格的项目研究报告：
1. Claude 撰写 Markdown 报告（`docs/report/report.md`），包含架构分析、技术决策、实验验证、成果总结
2. Claude 生成 SVG 技术图表（架构图、流程图、数据流图）→ 保存到 `docs/report/svg/`
3. Codex 将 SVG 转换为精美插图 → 保存到 `docs/report/images/`（Codex 自主发挥视觉风格）
4. 执行 `python3 <spec-workflow-mcp>/tools/gen-report.py docs/report/report.md -o docs/report/report.docx --images docs/report/images/`
5. 输出标准学术论文格式的 docx（二号宋体标题、四号正文、Times New Roman 西文、1.5倍行距）

Markdown 报告格式约定：
```
# 大标题                    → 论文标题（居中二号加粗）
作者：xxx 指导老师：xxx      → 作者行
摘 要：xxx                  → 摘要
关键词：xxx                 → 关键词
## 一、引言                  → 一级标题（黑体加粗）
### （一）xxx               → 二级标题（宋体加粗）
#### 1．xxx                → 三级标题
正文段落                     → 四号宋体，首行缩进
![图注](path)               → 插入图片 + 图注
| 表头 | ...                → 表格
[1] 参考文献...             → 参考文献
```

### 故障处理
- blocked 任务：用户在 dashboard 拖回 pending 后重试
- 超过 `maxFixAttempts` 次修复失败会自动终止该任务

## 规则

1. **每次新会话先调 `spec-workflow-guide`** 获取最新流程
2. **先读后写** — 修改前先阅读理解现有代码
3. **verify-task 必须执行** — 每个任务完成后必须通过验证
4. **log-implementation 必须执行** — verify-task green 后必须记录
5. **不扩大范围** — 只实现任务描述中规定的内容
6. **审批必须通过** — 每个阶段文档必须用户审批后才能继续

## 文件结构

```
.spec-workflow/
├── config.toml              # 引擎配置
├── steering/                # 项目指导（可选）
├── specs/{spec-name}/
│   ├── requirements.md
│   ├── design.md
│   ├── tasks.md             # 含 _Engine 字段
│   ├── Implementation Logs/
│   └── verify-results/
└── approvals/
docs/report/                 # 完成后研究报告（可选）
├── report.md
├── svg/                     # Claude 生成的 SVG 图表
└── images/                  # Codex 生成的精美图像
```
