# 工作状态（固定记录）

**版本 3.2.0 · 2026-08-20 · `main` = `v3-telegram`，与 `origin` 同步（tip 用 `git log --oneline -1` 看）**
[English](STATUS.md)

这份文件记录**当前是什么状态、为什么这么设计、还剩什么**。代码怎么用看 README 和 `docs/`；
这里只记结论和未完项，方便任何人（或新开的会话）接手。

---

## 1. 这个项目现在是什么

Claude 主导的规格驱动开发工具箱：Claude 规划 / 实现 / 审查 / 验证，Codex 是可选的外包引擎
（任务打 `_Engine: codex`）。三条支柱：

| 支柱 | 落点 |
|---|---|
| **验证阶梯 L3→L0→L1→L2→L4** | `templates/spec-loop-run.sh` + `src/core/verify-core.ts`；"任务完成"由 harness 判定，不由 agent 自称 |
| **Telegram 控制面** | `src/telegram/`（守护进程 `--telegram`）；v3 起取代原来的 Web Dashboard |
| **38 个审查 agent + 确定性路由** | `agents/` + `src/core/review-router.ts` + `review-route` MCP 工具 |

上游：仍是 [Pimzino/spec-workflow-mcp](https://github.com/Pimzino/spec-workflow-mcp) 的衍生作品
（`src/core/` 的任务解析/注册表/路径工具，以及 `src/markdown/templates/` 六个模板仍源自上游），
因此**许可证保持 GPL-3.0**，署名必须保留。见 `THIRD_PARTY_NOTICES.md`。

---

## 2. 已完成（v3.0 → v3.2）

**v3.0.0 — 删除 Web Dashboard，Telegram 成为控制面**
- 前端 + fastify/WS 后端 + job scheduler + i18n + e2e 全删；依赖 738 → 175 包。
- 新增 `src/telegram/`：零框架 Bot API 客户端、allowlist + 哈希链审计、HTML 渲染（仓库/agent 文本一律 `untrusted()` 包裹）。
- **HMAC 签名的远程闸门**：runner 写 `specs/<spec>/.run/gates/<id>.pending` 并签名；决定写在**项目之外**
  `~/.spec-workflow/gates/<projectHash>/`，runner 用 openssl 验签 —— 实现 agent 无法给自己放行。
- 每个 spec 独立运行态 `.run/{pid,stop,gates/}`；红灯带 `failureClass`；CLI `stop/status/reset/set-status/cleanup`。
- `init.sh` 的 `settings.json` 收紧：不再有 `Bash(*)`/`Write(*)` 这类会绕过 auto mode 分类器的白名单。

**v3.1.0 — 38 个审查 agent + 确定性路由**
- Tier 0 常开 6 个（含 `test-adequacy-judge` = L2 rubric、`spec-drift-detector`）、Tier 1 横切 12 个、
  Tier 2 spec 阶段 5 个、Tier 3 语言栈 9 个、Tier 4 infra 3 个、Tier 5 LLM 应用 3 个。
- 路由从 agent frontmatter（`tier/tags/triggers`）+ 项目画像 + diff 推导，**同一 diff → 同一集合**，
  每个 agent 附触发原因；`langs` 必须命中改动文件；上限 12；`route` CLI 可 dry-run。
- `/review` 输出改为首行 `VERDICT: safe-to-merge | fix-first | blocked` + 白话段落 + 跨 agent 去重；
  未改动行的问题归入 `## PRE-EXISTING (info)`，不算 BLOCK。

**v3.1.1 — 代码审查收尾**
- 8 个确认 bug + 6 项结构性问题修完；删除死代码 `task-validator.ts`；
- Docker 路径翻译收口到 `PathUtils` 访问器（修好 4 处静默失效）。

**v3.2.0 — 按钮 UI、请求队列、组件选择器**
- **Telegram 按钮菜单**（`src/telegram/ui.ts`）：首页 / 项目 / Spec / 任务 / 文档 / 日志 / 闸门 /
  窗口 / 组件 / 更多 / 清理，选项卡就地编辑同一条消息；全中文（`TELEGRAM_LANG=en` 切英文）。
- **请求队列**（`src/core/requests.ts`）：`➕ 新建 Spec`、`📁 新建项目`、`🚀 只做这个任务`
  **不另起 headless claude**，而是写请求给**正在开着的 Claude 窗口**处理。
- **窗口注册与绑定**：每个 `requests watch` 注册自己（心跳 90 秒过期），可 `--project` 绑定项目；
  一条请求必须赢得原子领取（`O_EXCL`）才会派发 —— 多窗口不会重复做；Telegram `👂 窗口` 屏按最近活跃
  排序、显示"正在做什么"、点选把后续任务钉给某个窗口。
- **组件选择器**（`templates/catalog.json` + `templates/lib/search.sh`）：零预装、零内置；搜索
  白名单目录 + 本机 Claude Code 市场 + npm；多关键词、多选（`1 3 5` / `2-6` / `all`）；
  **许可读不到的一律拒绝**；市场组件直接复制成 `.claude/` 下的普通文件（不用 `claude plugin install`），
  上游 LICENSE 落 `.claude/licenses/`；装完写 `.spec-workflow/INSTALLED.md` 并只授予 `mcp__<server>__*`。
- **项目状态参数化**：`~/.spec-workflow/projects.json` 记 `initialized/pending/ignored`，
  SessionStart hook 只查这一个参数（首次才检测并写回），只对 `pending` 提示一行，绝不自动初始化。

---

## 3. 关键设计决定（不要回退）

1. **verify-core 是任务状态唯一写者**。runner、CLI、Telegram 都经它；手动改状态在 loop 运行时被拒绝。
2. **L2/L3/L4 的 judge 必须跨模型家族**（codex ↔ claude）。Claude Code 的 Workflow `agent()` 只能起
   Claude，所以 judge 永远走 `codex exec`（Bash 步）；这也是**不把 bash runner 换成 Workflow** 的原因
   （见 `docs/WORKFLOW-SPIKE.md`）。
3. **闸门决定存在项目之外并签名**；runner 中途发现 `config.toml` 变化即以 `CONFIG_CHANGED` 停机。
4. **仓库/agent 文本一律当数据**：Telegram 侧 `untrusted()` 包裹、命令只从新鲜 `message.text` 解析、
   闸门卡片只含守护进程自己的文案。
5. **两个 bot**：orchestrator（官方 channel 插件，接交互会话）与 loop_bot（本项目守护进程）必须
   分开 —— Telegram 一个 token 只允许一个 `getUpdates` 消费者。
6. **第三方只拉取不内置**，许可不明不收（GPL-3.0 项目的现实约束）。
7. **审查 agent 是只读视角**，输出契约 BLOCK/WARN/PASSED/PRE-EXISTING，必须给 `file:line`。

---

## 4. 现在怎么跑

```bash
# 构建
npm ci && npm run build

# 初始化一个项目（会打开组件选择器）
bash templates/init.sh /abs/project            # --no-add 跳过选择器，--force 覆盖

# Telegram 守护进程（每台机器一个）
#   ~/.spec-workflow/telegram.env: TELEGRAM_BOT_TOKEN / TELEGRAM_ALLOW_FROM [/ TELEGRAM_PROJECTS]
node dist/index.js --telegram

# 让当前 Claude 窗口接管 Telegram 派来的活（Monitor 跑它）
node dist/index.js requests watch --label "主窗口" [--project /abs/project]

# 后台循环 / 停止 / 状态
nohup bash .spec-workflow/spec-loop-run.sh <spec> >/dev/null 2>&1 &
node dist/index.js stop <spec>
node dist/index.js status [spec]

# 审查选集 dry-run
node dist/index.js route --base HEAD~1
```

测试：`npx vitest run`（199 通过）、`bash scripts/test-loop-l{1,2,3,4}.sh`、`test-loop-l5-gates.sh`（11 项）。

---

## 5. 未完成 / 待定

| 项 | 状态 | 说明 |
|---|---|---|
| **独立成自己的项目** | **等你定名字** | 改 package/MCP server/CLI/plugin/仓库名 + README 重新定位 + NOTICE。**许可仍须 GPL-3.0 并保留上游署名**（`src/core/` 与 6 个模板仍是上游代码）；要彻底切断需重写这些文件 |
| 并行任务（`_DependsOn` + worktree） | 设计已定，未实现 | 需要 per-worktree 快照、合并后再记 L0/L1（见 `docs/WORKFLOW-SPIKE.md`） |
| Telegram 里增删组件 | 有意不做 | 装包/填 key 在终端更合适；`🧩 组件` 屏只读 |
| 上游同步 | 无 | 上游 2026-05 后基本停更，不再跟随 |

---

## 6. 机器上的现存状态（本机）

- Telegram 守护进程**已配好但未运行** —— 用 `node dist/index.js --telegram` 启动（bot `@worm2018_bot`，
  allowlist = 本人 id，见 `~/.spec-workflow/telegram.env`）。`~/.spec-workflow/telegram.log` 里最后一次
  运行以 `stopped` 收尾，之前是连续的 `getUpdates` TLS 失败。
- 本窗口注册为请求监听者（无项目绑定 = 接所有请求）。
- 本仓库自身已 `init.sh` 初始化（`.spec-workflow/` 被 gitignore），内含演示 spec `demo-auth`
  （4 个假任务，仅用于展示 Telegram 界面，可随时删）。
