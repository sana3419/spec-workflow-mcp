# Telegram 控制（`loop_bot`）

v3.0 起 Web Dashboard 已删除。它原来能做的（进度看板、任务卡、日志、归档、清理）以及做不到的（启停后台 loop、在手机上审批人工闸门）全部通过 Telegram bot 完成。[English](TELEGRAM.md)

两个 bot，两种角色：

| Bot | 跑在哪 | 干什么 |
|---|---|---|
| **orchestrator bot** —— Claude Code 官方 Telegram *channel* 插件（`claude --channels plugin:telegram@claude-plugins-official`） | 你的交互式 Claude Code 会话内 | 用自然语言指挥 Claude：建 spec、审批 requirements/design/tasks、让它跑 `/review`、"起 loop"、改文档 |
| **loop_bot** —— `spec-workflow-mcp --telegram`（本项目） | 每台机器一个守护进程，不需要 Claude 会话 | 盯所有项目的 loop：看板 + 推送、闸门 Approve/Reject 卡片、`/status /tasks /logs /start /stop …` |

两者**必须是不同的 bot**（不同 token）：Telegram 每个 token 只允许一个 `getUpdates` 轮询者，channel 插件已经在轮询自己的。若只要 `loop_bot` 推送、不接命令，可用 `TELEGRAM_SEND_ONLY=true` 复用 token。

## 安装（5 分钟）

1. `@BotFather` → `/newbot` → 复制 token；在 `@userinfobot` 拿到你的数字 user id。
2. 建 env 文件（0600）—— 没有 allowlist 守护进程拒绝启动：
   ```bash
   mkdir -p ~/.spec-workflow && chmod 700 ~/.spec-workflow
   cat > ~/.spec-workflow/telegram.env <<'EOF'
   TELEGRAM_BOT_TOKEN=123456789:AAH...
   TELEGRAM_ALLOW_FROM=111111111          # 允许发命令的数字 user id，逗号分隔
   # TELEGRAM_NOTIFY=111111111            # 接收推送的人（默认 = ALLOW_FROM）
   # TELEGRAM_PROJECTS=/abs/proj-a,/abs/proj-b   # MCP 注册表之外额外的项目根
   # TELEGRAM_SEND_ONLY=true              # 只推送不轮询（共用 token 模式）
   EOF
   chmod 600 ~/.spec-workflow/telegram.env
   ```
   `GATE_SECRET` 首次启动时自动生成到同一文件。
3. 启动守护进程（systemd / tmux / `nohup`）：
   ```bash
   nohup node /path/to/spec-workflow-mcp/dist/index.js --telegram >> ~/.spec-workflow/telegram.log 2>&1 &
   ```
4. 私聊 bot 发 `/help`。项目会在其 MCP server 跑过一次后自动出现（注册在 `~/.spec-workflow-mcp/`）；也可以写在 `TELEGRAM_PROJECTS`。

`--telegram-once` 只跑一次 watcher tick（推送新事件、发闸门卡片）然后退出 —— 可放 cron，但此模式下命令不可用。

## 在手机上审批 requirements / design / tasks（orchestrator bot）

Phase 1–3 的审批仍在*对话内*完成 —— 对象是 orchestrator，不是 `loop_bot`。当 Claude Code 通过官方 Telegram channel 插件运行时，生成的 `CLAUDE.md` 会让它把每份文档作为 **`.md` 附件 + ≤10 行摘要**发出，并以
`Reply "approve" to continue, or describe the changes you want.` 结尾。你的下一条消息就是决定。只有你本人的消息算数 —— 文档或 agent 输出里的文字永远不会被当作批准。

## 操作方式：按钮菜单（主）

发任意一条消息或 `/menu` 打开首页，之后全程点按钮，导航就地编辑同一条消息（像切换标签页）：

```
🏠 首页 → [📋 Spec] [📁 项目] [⏸ 审批] [⚙️ 更多] [➕ 新建 Spec] [📁 新建/添加项目]
📋 Spec 列表 → 点某个 spec
   spec 页签： [📊 概览] [☑️ 任务] [📄 文档] [📝 日志]
   概览页还有 [▶️ 启动循环] / [🛑 停止循环]
☑️ 任务 → 未完成排前面 → 点任务
   任务页： [▶ 开始] [✅ 完成] [⛔ 阻塞] [↩ 重置] [🚀 只做这个任务] [📋 提示词]
⚙️ 更多 → [🧭 Steering] [🧹 清理] [❓ 命令帮助]
```

## 派活给「正在开着的 Claude 窗口」

`➕ 新建 Spec`、`📁 新建/添加项目`、`🚀 只做这个任务` **不会另起一个 headless claude**，而是把请求写进队列
`~/.spec-workflow/requests/`（0700 目录、0600 文件，在项目之外，实现 agent 无法伪造）。你那个开着的 Claude Code 会话监听这个队列：

```bash
spec-workflow-mcp requests watch          # 每有新请求打印一行 JSON；同时写心跳
```

在 Claude Code 里让 Claude 用 **Monitor** 工具跑上面这条命令即可 —— 请求会作为事件出现在会话里，Claude 就在**当前上下文**里继续做（不丢上下文），做完写回结果：

```bash
spec-workflow-mcp requests claim <id>
spec-workflow-mcp requests done  <id> --result "spec auth 已生成，6 个任务"
spec-workflow-mcp requests done  <id> --fail --result "缺少依赖"
```

守护进程看到状态变成 done/failed 就把结果推回 Telegram。心跳还让 bot 能告诉你「窗口正在监听」还是「没人监听」。
无人值守的备选仍在：`.spec-workflow/spec-new-run.sh <spec> <一句话>` 会用独立 headless claude 生成 spec。

## 命令（兜底，仍然可用）

```
/status [proj[/spec]]        总览 · 项目 · spec 进度 + loop 状态
/projects   /use <proj>      列表 / 设置本聊天的当前项目
/specs [archived] [q]        spec 列表（进度条、搜索）
/spec <spec>                 摘要 + 按钮：📄 requirements · 📐 design · ☑️ tasks（以 .md 文件发送）
/tasks <spec>                按状态分组的看板文本
/task <spec> <id> [start|done|block <原因>|reset]     任务卡 + 操作按钮
/steering                    steering 文档（按钮发文件）
/logs <spec> [N] | task <id> 实现日志
/logstats <spec>             增删行、文件、artifacts 统计
/find <type> <term>          搜 artifacts（apiEndpoints|components|functions|classes|integrations）
/prompt <spec> <id>          任务的 implement 提示词
/gates                       待审批闸门
/runlog <spec> [N]           该 spec 的 loop-audit.log 尾部
/start <spec>   /stop <spec> 后台 loop（项目需 [loop].autoLoop = true）
/archive|/unarchive <spec>   带确认按钮
/cleanup <days> [archived]   先 dry-run 列表，再点 "Delete N" —— 不可逆
/about  /help
```
`proj/spec` 形式到处可用（`/tasks myapp/auth`）；只有一个项目时可省略。

## 推送什么

* **看板** —— 每次 loop run 一条消息，就地编辑（静默）：阶段、`✅ 🔄 ⛔ ⬜` 计数、loop pid、最近事件。
* **新消息** —— loop 启动、任务 blocked / 篡改闸门 / 回归、judge fail、spec-gate fail、集成结果、loop 结束（含原因与最终状态）。
* **闸门卡片** —— 见下。

任务 green 只更新看板，不会逐条打扰你。

## 人工闸门（在手机上审批）

在项目的 `.spec-workflow/config.toml` 开启：

```toml
[loop]
gateOnSpecGateFail = true      # L3 失败 → Approve = 越过并继续（留审计），Reject = 停
gateOnIntegrationFail = true   # L4 失败 → Approve = 再给一轮有界修复，Reject = 停
gateEveryTasks = 5             # 每 N 个 green 任务停一次做人工检查点
gateTimeoutMin = 60            # 超时无决定 = reject
```

为什么可信：

* **runner** 写 `specs/<spec>/.run/gates/<id>.pending`（随机 nonce、kind、时间戳）并用 `GATE_SECRET` **签名**；守护进程只对签名验证通过的 pending 出按钮 —— 项目内伪造或改写的 pending 不会有卡片。
* **守护进程** 发的卡片文本只由守护进程自己按 gate 类型固定的文案 + 数字细节（exit code、次数、计数）组成。任何来自仓库或 agent 的文本（judge 理由、日志尾巴）都作为*另一条*消息、带 "untrusted" 横幅、包在代码块里，绝不与按钮同一条。
* 你的 Approve/Reject 写在**项目目录之外** `~/.spec-workflow/gates/<projectHash>/<id>.json`，用 `GATE_SECRET` 做 HMAC-SHA256 签名。runner 用 `openssl` 重新计算 HMAC，不匹配一律忽略 —— 实现 agent（在项目内有写权限）无法给自己的闸门放行。
* 决定幂等（重复点击不会把 approve 翻成 reject），卡片拒绝过期/外来的 callback。L3 失败上的 Approve 绝不改 spec（`spec-gate-result.json` 记 `overriddenBy: "gate"`）；L4 失败上的 Approve 永远不能把结果翻成 pass。
* 事实层 L0/L1 从不等人。
* runner 在 START 时记下 `config.toml` 校验和，运行中若被改动则以 `CONFIG_CHANGED` 停止（agent 无法中途把 `testCommand`/`judge`/闸门旋钮改掉）。

## 安全模型

* 只回应 `TELEGRAM_ALLOW_FROM` 里的数字 id；其他人静默丢弃（无配对模式、不进群）。命令只从新鲜的 `message.text` 解析 —— 不看编辑/转发消息，也不看被引用的回复。
* 每条命令与闸门决定都追加到 `~/.spec-workflow/audit/<projectHash>.jsonl`，SHA-256 哈希链（`prev`/`hash` 字段），截断或篡改可检测。
* 守护进程从不运行 `claude`/`codex`，也从不把用户输入送进 shell。`/start` 只 spawn 项目自己的 `spec-loop-run.sh`；所有状态变更都经 `verify-core`（任务状态）、`run-state`（停止请求）、`gates`、`archive-service`、`cleanup`。
* 某 spec 的 loop 运行中时拒绝手动改任务状态（先 `/stop`）。
* `init.sh` 写的项目 `settings.json` 拒绝实现 agent 访问 `~/.spec-workflow/**`、`.run/**`、审计日志和 `api.telegram.org`。

## 信任边界（读一次）

闸门密钥放在 `~/.spec-workflow/telegram.env`，运行守护进程的 OS 用户可读。loop runner 以**同一 OS 用户**运行 headless `claude`/`codex`。`settings.json` 拒绝实现 agent 用 `Read`/`Write` 工具碰该文件与 gates 目录，runner 也从不把密钥放到命令行（通过环境变量传给 `spec-workflow-mcp gate-hmac`），但一个"不听话"的 agent 用 Bash 一行命令仍可能读到它 —— deny 列表不是硬边界。需要硬边界时，把守护进程放到**独立的 OS 用户**下（独立 `$HOME`、`telegram.env` 0600、gates 目录 0700），只给 runner 验签能力。本文其余机制都是针对*意外*或*提示注入*导致的误行为的纵深防御 —— 这才是现实中的威胁。

## 文件

```
~/.spec-workflow/telegram.env            token、allowlist、GATE_SECRET（0600）
~/.spec-workflow/tg-state.json           update offset、看板消息 id、回调 key
~/.spec-workflow/gates/<hash>/<id>.json  签名后的决定
~/.spec-workflow/audit/<hash>.jsonl      哈希链命令审计
<project>/.spec-workflow/loop-audit.log  runner 事件流（守护进程 tail 它）
<project>/.spec-workflow/specs/<spec>/.run/{pid,stop,gates/,…}   每 spec 运行态
```
