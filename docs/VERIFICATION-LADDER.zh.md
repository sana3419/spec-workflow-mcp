# 验证阶梯（The Verification Ladder）

> [English](VERIFICATION-LADDER.md)

本 fork 如何让自主的阶段4循环值得信任:一条分层、对抗式的验证链,把"这个任务做完了"**从实现 agent 嘴里拿走**,改为锚定到独立、互相交叉核验的证据。

> 本文描述的是**本 fork 的当前行为**(非上游)。它对循环 runner(`templates/spec-loop-run.sh`)、`[loop]` 配置、`harden-spec` prompt 是权威说明。

## 它解决的问题

后台循环用"每个任务一个独立 headless agent"的方式把 spec 跑到完成。最朴素的设计会让这个 agent **自己实现任务、自己写测试、自己跑、自己宣布 green**——这是教科书级的 in-context reward hacking 面(自报通过、削弱测试、写一眼就能过的断言)。按 Verifier's Law,一个自主系统能被信任到什么程度,取决于它的验证信号有多**独立**。这条阶梯用五道独立的门取代"自证"。

## 阶梯一览

按它们捕获的失败排序,从"spec 本身就错了"一路到"零件装不起来"。每一层都通过 `.spec-workflow/config.toml [loop]` **opt-in**。

| 层 | 捕获的失败 | 判据来源 | 开关 |
|---|---|---|---|
| **L3** spec 门 + SSC | spec 被误读/模糊,导致代码**和**测试一起验错东西 | 跨家族审计员在写代码前批判 spec | `specGate` · `harden-spec` |
| **L0** 执行 ground truth | agent 谎报跑过 / 自宣 green | 循环**脚本**跑该任务作用域测试;exit code = 判据 | `testCommand` |
| **L1** harness 完整性 | agent 削弱/改写测试、特判可见用例 | 每轮篡改门 + 整套件回归 | (随 L0) |
| **L2** adequacy 判官 | 测试过了但很水 / 偏离意图 | **反引擎**判官(codex↔claude)评测试充分性 | `judge` · `_Verify: panel` |
| **L4** 集成终判 | 每件绿、装起来构建不了/起不来 | DONE 后真实 build+boot 一次;有界自动修复;可选跨模块判官 | `integrationCommand` |

两条原则贯穿始终:
- **执行 ground truth 优先。** LLM 判官永远是 exit code **之后**的第二道门,绝不当唯一裁决者(LLM 判官并非一致可靠)。软层产不出可读判据时降级为咨询性,绝不硬卡住好工作。
- **spec 归人拥有。** 任何环节都不自动改写 `requirements.md`/`tasks.md`。L3 只提议,人来批准。

---

## L3 — spec 门 + SSC(规格自我校正)

下游谁都抓不到的唯一洞:如果**验收标准本身**就模糊,agent 写出的代码和 `_Tests` 会忠实地验错东西,于是*每一道*门都绿(garbage-in)。

- **`harden-spec` prompt**(人手动调,写 spec 阶段):对抗式自我批判——"如果我钻空子实现,哪里能让 requirements/`_Tests` 通过却偏离意图?"它标出不可观测的模糊需求、一个水测试就能满足的 `_Tests`、缺失的对抗/边界/安全需求、requirements↔tasks 缺口,然后**提议**硬化编辑给你审。它不改文件。
- **pre-flight spec 门**(`specGate = true`):开工前,一个独立的**跨家族**审计员(`[engine].default` 的反家族)批判 spec。判 `fail` → 落 `spec-gate-result.json` + `.spec-gate-failed`,记 `SPEC-GATE fail`,循环**在碰任何任务之前中止**。无可读判据 / 反引擎不可用 → advisory pass(软的 pre-flight 不能因 infra 故障卡死所有活)。propose-only——门绝不改 spec;去跑 `harden-spec` 或手改,再重跑。

## L0 — 执行 ground truth

判据从 agent 移交给 harness。实现 agent 写代码**和**该任务的测试,但**不**调 `verify-task`、不碰任务标记。它返回后,循环**脚本**跑该任务的作用域测试,用 **exit code** 记 green/red(`verify-results/` 里 `verifiedBy: "harness-exec"`)。

- **按任务作用域,而非整套件。** 每个任务在 `tasks.md` 里声明一个 `_Tests:` 选择器(测试文件/glob)。门**只**跑这个作用域,所以多任务 spec 不会被后续任务尚未写的测试卡死。`testCommand` 是个模板,如 `"npm test -- {tests}"`,`{tests}` 替换成当前任务的作用域。
- agent 是测试**内容**的唯一作者(这是 L2 要堵的残留洞);harness 拥有"它们到底跑没跑、过没过"。
- 没配 `testCommand` 时,循环回退到已弃用的 agent 自报路径,并大声标注。

## L1 — harness 完整性

L0 证明 agent 的测试跑过;L1 阻止 agent 做局。所有检查都在循环内、围绕实现步骤进行:

- **篡改门。** agent 不得编辑 `tasks.md`(它的验收契约——含 `_Tests`/`_Verify` 选择器),也不得修改**既有的**作用域测试文件。循环在 pick 任务**之后**取基线(这样 `pick` 自己写的 `[-]` 不算篡改),然后比对:`tasks.md` 任何变化 → blocked;该任务作用域内某个既有 tracked 测试被改 → blocked。**新增**测试文件没问题。
- **回归信号。** 一个任务 green 后,把所有已完成作用域并起来跑一次;若某个先前 green 的作用域现在 fail,标记回归(但不会把当前任务的 green 撤掉)。
- **非 git 诚实。** git 仓库之外,"既有测试被改"这条查不了;循环记 `TAMPER-GATE OFF` 并给每条判据盖 `tamperGate: "off"`,让这次降级可被事后审计。

## L2 — 跨家族 adequacy 判官

堵 L0 的残留:agent 自己写的测试可能很水(`assert(true)`)。harness-green 之后,一个跑在**反引擎家族**(codex 判 claude 的活,反之亦然——干掉同模型自偏好)的独立判官,读需求、作用域测试、实现,只问一件事:**这些测试充分吗?**(是否调真实代码、断言有意义的行为、覆盖 `_Requirements`、覆盖任务类型的对抗洞)。

- 判官只能**降级**一个 green(把任务 reopen 去加强测试,受 `judgeMaxAttempts` 限,到上限就 block `[~]`)——绝不能推翻 red。
- 标了 `_Verify: panel` 的安全要害任务走多 lens 共识:跨家族判官**外加** `security-reviewer` 和 `logic-reviewer`;任一 fail → fail。
- `judge = true` 开启。判官无产出(超时/infra)→ 记 `skipped`,保留 green。判官有产出但解析不出判据 → 按 **fail** 处理(读不出的反对意见绝不能变成放行)。

## L4 — 集成终判

每件任务绿 ≠ 装起来能跑。spec 一到 **DONE**(且仅此时),循环跑 `integrationCommand`——真实 build + boot 冒烟,包括 per-task 验证故意跳过的整树 `tsc`/build。

- 失败时:一次**有界自动修复**(一遍 claude,喂入失败输出,禁止削弱测试),再重跑;超过 `integrationFixAttempts` 仍失败 → 报告并停。
- build 绿后,若 `integrationJudge = true`,一个跨模块判官读 boot 输出 + 各任务 Implementation Log,找绿 build 抓不住的契约洞(API↔前端字段不匹配、中间件顺序、bootstrap/secret 要求)。判官明确 `fail` → 拦 + 触发有界修复;判官读不出 → **不**推翻通过的 build(ground-truth-first)。
- 结果落 `integration-result.json`(失败再加 `.integration-failed` 标记),`incompleteBlocked` 标出任何 `[~]` 任务。

---

## 配置参考(`.spec-workflow/config.toml`)

```toml
[engine]
default = "claude"            # 实现者;判官/审计员用反家族
maxFixAttempts = 5            # L0 红灯修复次数,超出任务 block [~]

[loop]
autoLoop = true              # 后台 runner 总开关
maxIterations = 50
noProgressStop = 3

# L0 + L1
testCommand = "npm test -- {tests}"   # {tests} = 当前任务的 _Tests 作用域。不配 → 自证(已弃用)
coverageMin = 0              # 可选 L1 覆盖率下限(0-100),配了才门

# L2
judge = false                # opt-in 跨家族 adequacy 判官
judgeMaxAttempts = 2         # 判官 fail 的 reopen 轮数,超出 [~]

# L4
integrationCommand = "npm run build && npm run smoke"   # opt-in;装起来的 build+boot
integrationFixAttempts = 1   # 有界自动修复轮数
integrationJudge = false     # 绿 build+boot 后的可选跨模块审查

# L3
specGate = false             # opt-in 跨家族 spec 审计员;spec 可 hack 就中止循环
```

**任务元数据**(在 `tasks.md` 里,建 spec 时定,被 L1 锁住):
- `_Tests:` — 任务的验收选择器(L0 只跑这个)。
- `_Verify: panel` — 让该任务进 L2 reviewer panel。
- `_Engine:` — `claude`(默认)或 `codex`;判官家族取它的反面。
- `_Requirements:` / `_Leverage:` / `_Prompt:` — 同上游。

### 渐进启用

每一层都独立。一个合理的采用顺序:`testCommand`(L0/L1,地基)→ `judge`(L2)→ `specGate`(L3)→ `integrationCommand`(L4)。每加一道 LLM 门(L2/L3/L4 各多一个反引擎 agent)成本上升,所以默认关。

## 怎么验证的

每一层循环门都有一个确定性测试台:装上 fake `claude`/`codex` shim(shim 当对手,因为真模型没法稳定让它作恶),跑**真的** `spec-loop-run.sh`,断言 audit 日志 + 任务状态。shim 验**门逻辑**;真引擎单独在 happy path 和真实对抗输入上验过。

| 套件 | 命令 | 覆盖 |
|---|---|---|
| 单测 | `npx vitest run` | `verify-core`(判据/来源/judge)、`_Tests`/`_Verify` 解析、`pick`/`scopes`/`verify`/`judge-record` CLI、`harden-spec` |
| L1 | `npm run test:loop` | 篡改(改测试/`_Tests`/`_Verify`)、回归、blocker、pick 写入不误判、非 git 标记 |
| L2 | `npm run test:loop:l2` | 跨家族路由、pass/fail→reopen→cap、panel 任一 fail、无产出→skip vs 解析不到→fail、disabled |
| L3 | `npm run test:loop:l3` | 门 pass→开工、fail→开工前中止、无产出→advisory、disabled |
| L4 | `npm run test:loop:l4` | pass、fail→有界修→pass、fail→耗尽、跨模块判官 fail、非 DONE→跳过、disabled |

**做过的真引擎 live 检查:** L2——真 codex 对一个水 `assert(true)` 测试返回 `VERDICT: fail`、对一个写得好的测试返回 `VERDICT: pass`(双向,无假阴性)。L3——真 codex 对一个模糊 spec(`"login should be secure"`)判 `VERDICT: fail`:*"该 spec 允许一个不工作或不安全的 login 实现通过 trivial 测试。"*

## 诚实的局限

- **L3 是最软的一层:** LLM 在审自然语言意图——"spec 是否表达了人真正想要的"没有 exit code。它 propose-only,是对人工 spec 评审的补充而非替代。
- **L2 的残留:** 跨家族判官能减小、但消不掉共享模型的盲点;它是第二道门,不是 ground truth。
- **L4 的深度 = 你 `integrationCommand` 里跑的东西。** harness 保证它*跑了*并按 exit code 把关;它不会凭空造出你没写的集成测试。
- **有界自动修复理论上可能做局骗过 build。** 它被禁止削弱测试、受 `*FixAttempts` 限、且落进持久结果供人审。

这条阶梯抬高了每一种 reward hacking 动作的成本、并让每一种都可审计——它不声称能让自主产出永不出错。
