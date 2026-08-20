/**
 * User-facing strings for the Telegram bot, zh (default) + en.
 *
 * Deliberately a plain table, not an i18n framework: the whole surface is ~60 strings and the v3
 * dashboard removal took i18next with it. `TELEGRAM_LANG=en` in ~/.spec-workflow/telegram.env
 * switches back to English.
 */

export type Lang = 'zh' | 'en';
let LANG: Lang = 'zh';
export function setLang(l: Lang) { LANG = l; }
export function getLang(): Lang { return LANG; }

type S = Record<Lang, string>;
const pick = (s: S) => s[LANG];

export const T = {
  // ---- generic
  unknownCmd: (c: string) => pick({ zh: `未知命令 ${c} —— 发 /help 看全部命令`, en: `unknown command ${c} — /help` }),
  needProject: () => pick({ zh: '先选项目：/projects 看列表，/use <名字> 设为当前', en: 'which project? /use <proj> or /projects' }),
  noProjects: () => pick({ zh: '还没有可监控的项目。\n在项目里跑一次 MCP 会话（会自动注册），或在 ~/.spec-workflow/telegram.env 里设 TELEGRAM_PROJECTS=/绝对/路径', en: 'no projects known. Start an MCP session in a project (it registers itself) or set TELEGRAM_PROJECTS.' }),
  unknownProject: (t: string) => pick({ zh: `没有这个项目：${t} —— /projects 看可选项`, en: `unknown project ${t} — /projects` }),
  missingSpec: () => pick({ zh: '缺少 spec 名字', en: 'missing spec name' }),
  invalidSpec: () => pick({ zh: 'spec 名字不合法（只允许字母、数字、. _ -）', en: 'invalid spec name' }),
  ambiguousProject: () => pick({ zh: '有多个项目：先 /use <项目>，或写成 项目/spec', en: 'several projects known — say /use <proj> first or use proj/spec' }),
  specNotFound: (s: string) => pick({ zh: `找不到 spec ${s}`, en: `spec ${s} not found` }),
  taskNotFound: (id: string, s: string) => pick({ zh: `${s} 里没有任务 ${id}`, en: `task ${id} not found in ${s}` }),
  noTasksFile: (s: string) => pick({ zh: `${s} 还没有 tasks.md`, en: `no tasks.md for ${s}` }),
  currentProjectSet: (n: string, p: string) => pick({ zh: `当前项目 → ${n}\n${p}`, en: `current project → ${n}\n${p}` }),
  currentProjectCleared: () => pick({ zh: '已清除当前项目', en: 'current project cleared' }),

  // ---- headers / labels
  hOverview: () => pick({ zh: '📊 总览', en: '📊 Overview' }),
  hProjects: () => pick({ zh: '📁 项目', en: '📁 Projects' }),
  hSpecs: (archived: boolean, proj: string) => pick({ zh: `${archived ? '📦 已归档 spec' : '📋 Spec 列表'} · ${proj}`, en: `${archived ? '📦 Archived specs' : '📋 Specs'} · ${proj}` }),
  hSteering: (proj: string) => pick({ zh: `🧭 Steering 文档 · ${proj}`, en: `🧭 Steering · ${proj}` }),
  hGates: () => pick({ zh: '⏸ 待审批闸门', en: '⏸ Pending gates' }),
  hLogs: (spec: string, extra: string) => pick({ zh: `📝 实现日志 · ${spec}${extra}`, en: `📝 logs · ${spec}${extra}` }),
  hLogStats: (spec: string) => pick({ zh: `📈 日志统计 · ${spec}`, en: `📈 log stats · ${spec}` }),
  hAudit: (spec: string, n: number) => pick({ zh: `🧾 运行日志 · ${spec} · 最近 ${n} 行`, en: `🧾 audit · ${spec} · last ${n}` }),
  hPrompt: (spec: string, id: string) => pick({ zh: `📋 实现提示词 · ${spec} · 任务 ${id}`, en: `📋 implement prompt · ${spec} · ${id}` }),
  hFind: (type: string, term: string) => pick({ zh: `🔍 ${type} 里搜 “${term}”`, en: `🔍 find ${type} "${term}"` }),

  lSpecs: () => pick({ zh: '规格', en: 'specs' }),
  lTasks: () => pick({ zh: '任务', en: 'tasks' }),
  lDocs: () => pick({ zh: '文档', en: 'docs' }),
  lLoop: () => pick({ zh: '循环', en: 'loop' }),
  lUpdated: () => pick({ zh: '更新', en: 'updated' }),
  lRunning: () => pick({ zh: '运行中', en: 'running' }),
  lReq: () => pick({ zh: '需求', en: 'req' }),
  lDesign: () => pick({ zh: '设计', en: 'design' }),
  lTasksDoc: () => pick({ zh: '任务', en: 'tasks' }),
  lEngine: () => pick({ zh: '引擎', en: 'engine' }),
  lTests: () => pick({ zh: '测试', en: 'tests' }),
  lVerify: () => pick({ zh: '验证', en: 'verify' }),
  lReqs: () => pick({ zh: '需求', en: 'req' }),
  lLast: () => pick({ zh: '最近', en: 'last' }),
  lEntries: () => pick({ zh: '条目', en: 'entries' }),
  lArtifacts: () => pick({ zh: '产出', en: 'artifacts' }),
  lFiles: () => pick({ zh: '文件', en: 'files' }),
  lNone: () => pick({ zh: '无', en: '—' }),

  // ---- status words
  stCompleted: () => pick({ zh: '完成', en: 'done' }),
  stInProgress: () => pick({ zh: '进行中', en: 'in progress' }),
  stBlocked: () => pick({ zh: '阻塞', en: 'blocked' }),
  stPending: () => pick({ zh: '待办', en: 'pending' }),
  loopRunning: (pid?: number) => pick({ zh: `🔄 运行中${pid ? `（pid ${pid}）` : ''}`, en: `🔄 running${pid ? ` (pid ${pid})` : ''}` }),
  loopStale: () => pick({ zh: '💤 已停止（pid 残留）', en: '💤 stopped (stale pid)' }),
  loopIdle: () => pick({ zh: '💤 空闲', en: '💤 idle' }),
  loopStopRequested: () => pick({ zh: '· 已请求停止', en: '· stop requested' }),
  archivedBadge: () => pick({ zh: ' 📦 已归档', en: ' 📦 archived' }),
  gatesWaiting: (n: number) => pick({ zh: `⏸ ${n} 个闸门等待审批 —— /gates`, en: `⏸ ${n} gate(s) waiting — /gates` }),

  // ---- lists / hints
  noSpecs: (archived: boolean, q: string, proj: string) => pick({
    zh: `${proj} 里没有${archived ? '已归档的' : ''} spec${q ? `（匹配 “${q}”）` : ''}`,
    en: `no ${archived ? 'archived ' : ''}specs${q ? ` matching "${q}"` : ''} in ${proj}` }),
  moreSpecs: (n: number, archived: boolean) => pick({ zh: `\n… 还有 ${n} 个，用 /specs ${archived ? 'archived ' : ''}<关键词> 缩小范围`, en: `\n… ${n} more (narrow with /specs ${archived ? 'archived ' : ''}<q>)` }),
  useHint: () => pick({ zh: '\n/use <名字> 设为当前项目', en: '\n/use <name> to make one current' }),
  taskDetailHint: (spec: string) => pick({ zh: `\n查看单个任务：/task ${spec} <编号>`, en: `\n/task ${spec} <id> for details` }),
  noGates: () => pick({ zh: '没有待审批的闸门', en: 'no pending gates' }),
  gatesFooter: () => pick({ zh: '\n<i>闸门出现时会自动推送带按钮的卡片；错过了也会在守护进程重启后补发</i>', en: '\n<i>cards with Approve/Reject were posted when they appeared; if you missed one it is re-posted on daemon restart</i>' }),
  noLogs: (spec: string) => pick({ zh: `${spec} 还没有实现日志`, en: `no implementation logs for ${spec}` }),
  noAudit: (spec: string) => pick({ zh: `${spec} 还没有运行日志`, en: `no audit lines for ${spec}` }),
  nothingFound: (type: string, term: string) => pick({ zh: `没找到 ${type} 里的 “${term}”`, en: `nothing found for ${type} "${term}"` }),
  plusMore: (n: number) => pick({ zh: `  … 还有 ${n} 条`, en: `  … +${n}` }),

  // ---- usage
  usageTask: () => pick({ zh: '用法：/task <spec> <编号> [start|done|block 原因|reset]', en: 'usage: /task &lt;spec&gt; &lt;id&gt; [start|done|block &lt;reason&gt;|reset]' }),
  usagePrompt: () => pick({ zh: '用法：/prompt <spec> <编号>', en: 'usage: /prompt &lt;spec&gt; &lt;id&gt;' }),
  usageFind: () => pick({ zh: '用法：/find <apiEndpoints|components|functions|classes|integrations> <关键词>', en: 'usage: /find &lt;apiEndpoints|components|functions|classes|integrations&gt; &lt;term&gt;' }),
  usageCleanup: () => pick({ zh: '用法：/cleanup <天数> [archived]', en: 'usage: /cleanup &lt;days&gt; [archived]' }),
  unknownAction: (a: string) => pick({ zh: `未知操作 ${a}`, en: `unknown action ${a}` }),

  // ---- control
  loopStarted: (spec: string, proj: string, pid?: number) => pick({
    zh: `▶️ 已在 ${proj} 启动 ${spec} 的循环${pid ? `（pid ${pid}）` : ''}。\n若 config.toml 里 [loop].autoLoop = false 会立即退出 —— 稍后用 /status ${spec} 确认。`,
    en: `▶️ started loop for ${spec} in ${proj}${pid ? ` (pid ${pid})` : ''}.\nIt exits at once if [loop].autoLoop is false — check /status ${spec} in a moment.` }),
  loopAlreadyRunning: (spec: string, pid?: number) => pick({ zh: `${spec} 的循环已经在跑了${pid ? `（pid ${pid}）` : ''}`, en: `loop already running for ${spec}${pid ? ` (pid ${pid})` : ''}` }),
  noRunner: (proj: string) => pick({ zh: `${proj} 里没有 .spec-workflow/spec-loop-run.sh —— 先在该项目跑一次 init.sh`, en: `no loop runner in ${proj} — run init.sh there` }),
  stopRequested: (spec: string, pid?: number) => pick({ zh: `🛑 已请求停止 ${spec}${pid ? `（pid ${pid}）` : ''}，当前这一轮跑完就退出`, en: `🛑 stop requested for ${spec}${pid ? ` (pid ${pid})` : ''}; it exits after the current iteration` }),
  stopNotRunning: (spec: string) => pick({ zh: `${spec} 当前没有循环在跑（停止标记已写入，下次启动会自动清理）`, en: `no loop is running for ${spec} — stop file written anyway (cleared at next START)` }),
  loopLocksEdit: (spec: string) => pick({ zh: `🔄 循环运行中，暂时不能手动改状态（先 /stop ${spec}）`, en: `🔄 loop running — manual state changes disabled (/stop ${spec} first)` }),
  askBlockReason: (id: string, spec: string) => pick({ zh: `⛔ 请回复阻塞 ${spec} 任务 ${id} 的原因（下一条消息；发任何 /命令 则取消）`, en: `⛔ reply with the reason to block task ${id} of ${spec} (next message; any /command cancels)` }),
  notActiveSpec: (s: string) => pick({ zh: `${s} 不是活跃的 spec`, en: `${s} is not an active spec` }),
  notArchived: (s: string) => pick({ zh: `${s} 没有被归档`, en: `${s} is not archived` }),
  loopBlocksArchive: (s: string) => pick({ zh: `${s} 的循环在运行中 —— 先 /stop`, en: `loop is running for ${s} — /stop it first` }),
  confirmArchive: (arch: boolean, spec: string, proj: string) => pick({ zh: `${arch ? '📦 归档' : '📤 取消归档'} ${proj} 的 ${spec}？`, en: `${arch ? '📦 Archive' : '📤 Unarchive'} ${spec} in ${proj}?` }),
  cleanupNothing: (days: number, archived: boolean, proj: string, checked: number) => pick({
    zh: `${proj} 里没有超过 ${days} 天的${archived ? '已归档 ' : ''}spec（共检查 ${checked} 个）`,
    en: `nothing ${archived ? 'archived ' : ''}older than ${days}d in ${proj} (${checked} checked)` }),
  cleanupConfirm: (n: number, days: number, archived: boolean, proj: string, list: string, more: boolean) => pick({
    zh: `🧹 将删除 ${proj} 里 ${n} 个超过 ${days} 天的${archived ? '已归档 ' : ''}spec：\n${list}${more ? '\n…' : ''}\n\n<b>此操作不可撤销。</b>`,
    en: `🧹 Would delete ${n} ${archived ? 'archived ' : ''}spec(s) older than ${days}d in ${proj}:\n${list}${more ? '\n…' : ''}\n\n<b>This is irreversible.</b>` }),
  cleanupDone: (deleted: string[], failed: number) => pick({
    zh: `🧹 已删除 ${deleted.length} 个${failed ? `，失败 ${failed} 个` : ''}${deleted.length ? '：' + deleted.join('、') : ''}`,
    en: `🧹 deleted ${deleted.length}${failed ? `, failed ${failed}` : ''}: ${deleted.join(', ') || '—'}` }),
  archiveDone: (arch: boolean, spec: string) => pick({ zh: `${arch ? '📦 已归档' : '📤 已取消归档'} ${spec}`, en: `${arch ? '📦 archived' : '📤 unarchived'} ${spec}` }),
  docMissing: (name: string, spec: string) => pick({ zh: `${spec} 还没有 ${name}`, en: `${name} does not exist yet for ${spec}` }),
  fileMissing: (name: string) => pick({ zh: `没有 ${name}`, en: `${name} not found` }),

  // ---- buttons
  btnRequirements: () => pick({ zh: '📄 需求', en: '📄 requirements' }),
  btnDesign: () => pick({ zh: '📐 设计', en: '📐 design' }),
  btnTasks: () => pick({ zh: '☑️ 任务', en: '☑️ tasks' }),
  btnStart: () => pick({ zh: '▶ 开始', en: '▶ start' }),
  btnDone: () => pick({ zh: '✅ 完成', en: '✅ done' }),
  btnBlock: () => pick({ zh: '⛔ 阻塞', en: '⛔ block' }),
  btnReset: () => pick({ zh: '↩ 重置', en: '↩ reset' }),
  btnPrompt: () => pick({ zh: '📋 提示词', en: '📋 prompt' }),
  btnRefresh: () => pick({ zh: '🔄 刷新', en: '🔄 refresh' }),
  btnApprove: () => pick({ zh: '✅ 批准', en: '✅ Approve' }),
  btnReject: () => pick({ zh: '⛔ 拒绝', en: '⛔ Reject' }),
  btnCancel: () => pick({ zh: '取消', en: 'Cancel' }),
  btnDelete: (n: number) => pick({ zh: `删除 ${n} 个`, en: `Delete ${n}` }),
  btnArchive: (arch: boolean) => pick({ zh: arch ? '归档' : '取消归档', en: arch ? 'Archive' : 'Unarchive' }),

  // ---- callback acks
  ackExpired: () => pick({ zh: '已过期，请重新发命令', en: 'expired — re-run the command' }),
  ackCancelled: () => pick({ zh: '已取消', en: 'cancelled' }),
  ackDone: () => pick({ zh: '完成', en: 'done' }),
  ackFailed: () => pick({ zh: '失败', en: 'failed' }),
  ackRefreshed: () => pick({ zh: '已刷新', en: 'refreshed' }),
  ackGateGone: () => pick({ zh: '这个闸门已经不在等待了（超时或循环已停止）', en: 'this gate is no longer pending (timeout or runner stopped)' }),
  ackAlreadyDecided: (d: string, by: string) => pick({ zh: `已由 ${by} ${d === 'approve' ? '批准' : '拒绝'}`, en: `already ${d}d by ${by}` }),
  ackDecided: (d: string) => pick({ zh: d === 'approve' ? '已批准' : '已拒绝', en: `${d}d` }),
  ackLoopRunning: () => pick({ zh: '循环运行中 —— 请先 /stop', en: 'loop is running — /stop first' }),

  // ---- gate card
  gateTitle: () => pick({ zh: '⏸ 需要你确认', en: '⏸ GATE' }),
  gateKind: (k: string) => pick({ zh: `类型：${k}`, en: `kind: ${k}` }),
  gateOpened: (id: string, ago: string) => pick({ zh: `编号 ${id} · ${ago}前发起`, en: `id ${id} · opened ${ago} ago` }),
  gateHint: () => pick({ zh: '<i>以上文字由 harness 生成 —— 下方按钮做决定</i>', en: '<i>harness-authored card — approve/reject below</i>' }),
  gateDecided: (d: string, by: string, at: string) => pick({ zh: `\n${d === 'approve' ? '✅ 已批准' : '⛔ 已拒绝'} · ${by} · ${at}`, en: `\n${d === 'approve' ? '✅ APPROVED' : '⛔ REJECTED'} by ${by} at ${at}` }),
  gateKindText: (k: string) => pick({
    zh: ({
      'spec-gate-fail': '规格闸门（L3）未通过 —— 跨模型家族的审计员认为这份 spec 会让「错但绿」的实现蒙混过关。\n批准 = 明知如此仍继续实现（会留审计，结果仍记为 fail）；拒绝 = 停止。',
      'integration-fail': '集成闸门（L4）未通过 —— 组装后的构建/启动没跑通。\n批准 = 再给一轮有界自动修复；拒绝 = 停止。（批准永远不会把它变成通过。）',
      'every-n-tasks': '检查点 —— 已有 N 个任务通过验证。批准 = 继续跑；拒绝 = 停止。',
      'manual': '人工闸门。批准 = 继续；拒绝 = 停止。',
    } as Record<string, string>)[k] ?? '',
    en: ({
      'spec-gate-fail': 'Spec gate (L3) FAILED — the cross-family auditor thinks the spec lets wrong-but-green outcomes through.\nApprove = override and implement anyway (audited, result stays "fail"). Reject = stop.',
      'integration-fail': 'Integration gate (L4) FAILED — the assembled build/boot did not pass.\nApprove = ONE more bounded auto-fix round. Reject = stop. (Approve can never turn this into a pass.)',
      'every-n-tasks': 'Checkpoint — N tasks went green. Approve = continue the loop. Reject = stop.',
      'manual': 'Manual gate. Approve = continue. Reject = stop.',
    } as Record<string, string>)[k] ?? '',
  }),
  gateContextLabel: () => pick({ zh: '闸门上下文（来自 runner / 审计员的原文）', en: 'gate context (runner/auditor text)' }),

  // ---- push events
  evLoopStarted: (pid?: number) => pick({ zh: `▶️ 循环已启动${pid ? `（pid ${pid}）` : ''}`, en: `▶️ loop started${pid ? ` (pid ${pid})` : ''}` }),
  evIter: (iter: number, task: string, left: number) => pick({ zh: `第 ${iter} 轮 → 任务 ${task}（还剩 ${left} 个）`, en: `iter ${iter} → task ${task} (${left} left)` }),
  evGreen: (task: string) => pick({ zh: `✅ 任务 ${task} 通过`, en: `✅ task ${task} green` }),
  evRed: (task: string, code: string, cls?: string) => pick({ zh: `❌ 任务 ${task} 失败（退出码 ${code}${cls ? `，${cls}` : ''}）`, en: `❌ task ${task} red (exit ${code}${cls ? `, ${cls}` : ''})` }),
  evBlocked: (task: string, reason: string) => pick({ zh: `⛔ 任务 ${task} 被阻塞${reason ? ` —— ${reason}` : ''}`, en: `⛔ task ${task} blocked${reason ? ` — ${reason}` : ''}` }),
  evTamper: (task: string, reason: string) => pick({ zh: `🚨 任务 ${task} 触发防篡改闸门：${reason}`, en: `🚨 tamper gate on task ${task}: ${reason}` }),
  evUnverified: (task: string) => pick({ zh: `⚠️ 任务 ${task} 在没有独立验证的情况下被标记完成`, en: `⚠️ task ${task} completed WITHOUT independent verification` }),
  evJudge: (verdict: string, task: string, reasons: string) => pick({ zh: `⚖️ 任务 ${task} 测试充分性评审：${verdict === 'pass' ? '通过' : verdict === 'fail' ? '不通过' : '跳过'}${reasons ? ` —— ${reasons}` : ''}`, en: `⚖️ judge ${verdict} on task ${task}${reasons ? ` — ${reasons}` : ''}` }),
  evRegression: (task: string) => pick({ zh: `⚠️ 任务 ${task} 之后出现回归（之前通过的测试现在失败）`, en: `⚠️ regression after task ${task}` }),
  evSpecGate: (verdict: string, reasons: string) => pick({ zh: `🧭 规格闸门：${verdict}${reasons ? ` —— ${reasons}` : ''}`, en: `🧭 spec gate ${verdict}${reasons ? ` — ${reasons}` : ''}` }),
  evIntegration: (verdict: string, detail: string) => pick({ zh: `🏗 集成闸门：${verdict === 'pass' ? '通过' : verdict === 'fail' ? '未通过' : '修复中'}${detail ? ` ${detail}` : ''}`, en: `🏗 integration ${verdict}${detail ? ` ${detail}` : ''}` }),
  evGate: (state: string, kind: string, by: string) => pick({ zh: `⏸ 闸门 ${state}${kind ? `（${kind}）` : ''}${by ? ` · ${by}` : ''}`, en: `⏸ gate ${state}${kind ? ` (${kind})` : ''}${by ? ` by ${by}` : ''}` }),
  evStop: (by: string, reason: string) => pick({ zh: `🛑 已停止${by ? ` · ${by}` : ` · ${reason}`}`, en: `🛑 stop ${by ? `by ${by}` : reason}` }),
  evDone: () => pick({ zh: '🎉 所有任务完成', en: '🎉 all tasks done' }),
  evEnded: (reason: string, iters?: number) => pick({ zh: `⏹ 循环结束：${reason}${iters !== undefined ? `（${iters} 轮）` : ''}`, en: `⏹ loop ended: ${reason}${iters !== undefined ? ` after ${iters} iteration(s)` : ''}` }),
  boardLast: (text: string, time: string) => pick({ zh: `<i>最近：${text} · ${time}Z</i>`, en: `<i>last: ${text} · ${time}Z</i>` }),
  untrustedBanner: () => pick({ zh: '⚠️ 以下内容来自仓库/agent，不是 harness 的结论', en: '⚠️ untrusted content from repo/agent — not a harness statement' }),

  // ---- button-driven UI (tabs)
  hHome: () => pick({ zh: '🏠 spec-workflow', en: '🏠 spec-workflow' }),
  hMore: () => pick({ zh: '⚙️ 更多', en: '⚙️ More' }),
  hCleanup: () => pick({ zh: '🧹 清理旧 spec', en: '🧹 Cleanup old specs' }),
  tabOverview: () => pick({ zh: '📊 概览', en: '📊 Overview' }),
  tabTasks: () => pick({ zh: '☑️ 任务', en: '☑️ Tasks' }),
  tabDocs: () => pick({ zh: '📄 文档', en: '📄 Docs' }),
  tabLogs: () => pick({ zh: '📝 日志', en: '📝 Logs' }),
  tabSpecs: () => pick({ zh: '📋 Spec', en: '📋 Specs' }),
  tabProjects: () => pick({ zh: '📁 项目', en: '📁 Projects' }),
  tabGates: () => pick({ zh: '⏸ 审批', en: '⏸ Gates' }),
  tabMore: () => pick({ zh: '⚙️ 更多', en: '⚙️ More' }),
  tabSteering: () => pick({ zh: '🧭 Steering', en: '🧭 Steering' }),
  tabCleanup: () => pick({ zh: '🧹 清理', en: '🧹 Cleanup' }),
  tabHelp: () => pick({ zh: '❓ 命令帮助', en: '❓ Commands' }),
  btnHome: () => pick({ zh: '🏠 首页', en: '🏠 Home' }),
  btnBack: () => pick({ zh: '⬅️ 返回', en: '⬅️ Back' }),
  btnBackSpecs: () => pick({ zh: '⬅️ Spec 列表', en: '⬅️ Specs' }),
  btnBackTasks: () => pick({ zh: '⬅️ 任务列表', en: '⬅️ Tasks' }),
  btnPrev: () => pick({ zh: '◀️ 上一页', en: '◀️ Prev' }),
  btnNext: () => pick({ zh: '下一页 ▶️', en: 'Next ▶️' }),
  btnShowArchived: () => pick({ zh: '📦 看归档', en: '📦 Archived' }),
  btnShowActive: () => pick({ zh: '📋 看活跃', en: '📋 Active' }),
  btnStartLoop: () => pick({ zh: '▶️ 启动循环', en: '▶️ Start loop' }),
  btnStopLoop: () => pick({ zh: '🛑 停止循环', en: '🛑 Stop loop' }),
  btnRunlog: () => pick({ zh: '🧾 运行日志', en: '🧾 Runner log' }),
  gatesWaitingShort: (n: number) => pick({ zh: `${n} 个闸门等待审批`, en: `${n} gate(s) waiting` }),
  docsHint: () => pick({ zh: '点按钮把文档作为 .md 文件发给你（不会在聊天里贴长文）', en: 'Buttons send the document as a .md file (nothing long is pasted into chat)' }),
  noDocs: () => pick({ zh: '这个 spec 还没有任何文档', en: 'this spec has no documents yet' }),
  moreHint: () => pick({ zh: '不常用的操作放在这里；命令仍然可用（❓ 命令帮助）', en: 'Less common actions live here; typed commands still work (❓ Commands)' }),
  cleanupPick: () => pick({ zh: '删除超过多少天的 spec？（先预览，再确认；不可撤销）', en: 'Delete specs older than…? (preview first, then confirm — irreversible)' }),
  vGreen: () => pick({ zh: '✅ 通过', en: '✅ green' }),
  vRed: () => pick({ zh: '❌ 失败', en: '❌ red' }),
  vExit: (c: number) => pick({ zh: `退出码 ${c}`, en: `exit ${c}` }),
  vClass: (c: string) => pick({ zh: `类型 ${c}`, en: `class ${c}` }),
  vFix: (n: number) => pick({ zh: `修复 ${n} 次`, en: `${n} fix attempts` }),
  vJudge: (verdict: string, engine: string) => pick({ zh: `评审 ${verdict}（${engine}）`, en: `judge ${verdict} (${engine})` }),
  lastFailureLabel: () => pick({ zh: '最近一次失败输出', en: 'last failure output' }),
  menuHint: () => pick({ zh: '用下面的按钮操作即可；也可以直接发命令（❓ 命令帮助）', en: 'Use the buttons below; typed commands still work (❓ Commands)' }),

  // ---- create / dispatch
  btnNewSpec: () => pick({ zh: '➕ 新建 Spec', en: '➕ New spec' }),
  btnNewProject: () => pick({ zh: '📁 新建/添加项目', en: '📁 New / add project' }),
  btnDispatchTask: () => pick({ zh: '🚀 只做这个任务', en: '🚀 Run just this task' }),
  askNewSpec: () => pick({
    zh: '➕ 回复一行：<code>spec名字 一句话说明要做什么</code>\n例如：<code>auth 用邮箱密码登录，失败要限流</code>\n\n我会用一个独立的 headless Claude 写出 requirements / design / tasks，写完发给你审阅（不写任何代码）。发 /cancel 取消。',
    en: '➕ Reply with one line: <code>spec-name one sentence about what to build</code>\ne.g. <code>auth email+password login, rate-limit failures</code>\n\nA separate headless Claude writes requirements / design / tasks and sends them to you for review (it writes no code). /cancel to abort.' }),
  askNewProject: () => pick({
    zh: '📁 回复项目的绝对路径（不存在会创建）\n例如：<code>/home/worm/code/my-app</code>\n\n我会在那里跑 init.sh（生成 .spec-workflow、CLAUDE.md、循环脚本），然后把它加入监控。发 /cancel 取消。',
    en: '📁 Reply with the absolute project path (created if missing)\ne.g. <code>/home/me/code/my-app</code>\n\ninit.sh runs there (.spec-workflow, CLAUDE.md, loop runner) and the project is added to the watch list. /cancel to abort.' }),
  cancelled: () => pick({ zh: '已取消', en: 'cancelled' }),
  badSpecInput: () => pick({ zh: '格式不对：第一段是 spec 名字（字母数字 . _ -），后面是说明。例：<code>auth 邮箱密码登录</code>', en: 'Bad input: first word is the spec name ([A-Za-z0-9._-]), the rest is the idea. e.g. <code>auth email+password login</code>' }),
  specExists: (s: string) => pick({ zh: `已经有叫 ${s} 的 spec 了，换个名字`, en: `a spec named ${s} already exists` }),
  specNewStarted: (s: string) => pick({ zh: `🚧 正在生成 spec <b>${s}</b>（独立进程，通常 1–3 分钟）。写完我会通知你，然后你可以审阅文档再启动循环。`, en: `🚧 Writing spec <b>${s}</b> in a separate process (usually 1–3 min). I'll ping you when it's ready to review.` }),
  specNewDone: (s: string, n: number) => pick({ zh: `✅ spec <b>${s}</b> 已生成（${n} 个任务）—— 请审阅文档后再启动循环`, en: `✅ spec <b>${s}</b> is ready (${n} tasks) — review the documents before starting the loop` }),
  specNewFail: (s: string, why: string) => pick({ zh: `❌ 生成 spec <b>${s}</b> 失败：${why}`, en: `❌ failed to create spec <b>${s}</b>: ${why}` }),
  badProjectPath: () => pick({ zh: '需要绝对路径（以 / 开头），且不能包含 ..', en: 'An absolute path is required (starting with /), without ..' }),
  projectInitStarted: (p: string) => pick({ zh: `🚧 正在初始化项目 <code>${p}</code>…`, en: `🚧 initialising <code>${p}</code>…` }),
  projectInitDone: (p: string) => pick({ zh: `✅ 项目已就绪并加入监控：<b>${p}</b>\n下一步：➕ 新建 Spec`, en: `✅ project ready and watched: <b>${p}</b>\nNext: ➕ New spec` }),
  projectInitFail: (why: string) => pick({ zh: `❌ 初始化失败：${why}`, en: `❌ init failed: ${why}` }),
  dispatchStarted: (id: string, spec: string) => pick({ zh: `🚀 已派发 ${spec} 的任务 ${id}（单任务模式，独立进程）。完成后会推送验证结果。`, en: `🚀 dispatched task ${id} of ${spec} (single-task run, separate process). You'll get the verdict when it finishes.` }),
  dispatchNotOpen: () => pick({ zh: '只有「待办 / 进行中」的任务可以派发', en: 'only pending / in-progress tasks can be dispatched' }),
  needAutoLoop: () => pick({ zh: '项目 config.toml 里 [loop].autoLoop 还是 false —— 需要先改成 true 才能跑循环', en: '[loop].autoLoop is false in the project config — set it to true first' }),

  // ---- request queue (live session does the work)
  queuedNewSpec: (spec: string, live: boolean) => pick({
    zh: `📥 已把「新建 spec <b>${spec}</b>」放进队列。${live ? '你的 Claude 窗口正在监听，马上会开始。' : '⚠️ 当前没有会话在监听队列 —— 在 Claude Code 里跑 <code>spec-workflow-mcp requests watch</code>（或让 Claude 用 Monitor 监听）即可。'}`,
    en: `📥 Queued "new spec <b>${spec}</b>". ${live ? 'Your Claude session is listening — it starts now.' : '⚠️ No session is watching the queue — run <code>spec-workflow-mcp requests watch</code> in Claude Code (or ask Claude to Monitor it).'}` }),
  queuedNewProject: (path: string, live: boolean) => pick({
    zh: `📥 已把「初始化项目 <code>${path}</code>」放进队列。${live ? '你的 Claude 窗口正在监听。' : '⚠️ 当前没有会话在监听队列。'}`,
    en: `📥 Queued "init project <code>${path}</code>". ${live ? 'Your Claude session is listening.' : '⚠️ No session is watching the queue.'}` }),
  queuedDispatch: (spec: string, id: string, live: boolean) => pick({
    zh: `📥 已把「实现 ${spec} 的任务 ${id}」放进队列。${live ? '你的 Claude 窗口正在监听。' : '⚠️ 当前没有会话在监听队列。'}`,
    en: `📥 Queued "implement task ${id} of ${spec}". ${live ? 'Your Claude session is listening.' : '⚠️ No session is watching the queue.'}` }),
  requestDone: (kind: string, what: string, result: string) => pick({
    zh: `✅ 完成：${kind} · <b>${what}</b>${result ? `\n${result}` : ''}`,
    en: `✅ Done: ${kind} · <b>${what}</b>${result ? `\n${result}` : ''}` }),
  requestFailed: (kind: string, what: string, result: string) => pick({
    zh: `❌ 失败：${kind} · <b>${what}</b>${result ? `\n${result}` : ''}`,
    en: `❌ Failed: ${kind} · <b>${what}</b>${result ? `\n${result}` : ''}` }),
  listeners: (labels: string[]) => pick({ zh: `👂 正在监听：${labels.join('、')}`, en: `👂 listening: ${labels.join(', ')}` }),
  noListener: () => pick({ zh: '⚠️ 没有 Claude 窗口在监听队列 —— 在窗口里让 Claude 用 Monitor 跑 spec-workflow-mcp requests watch', en: '⚠️ no Claude window is watching the queue — Monitor `spec-workflow-mcp requests watch` in one' }),
  kindNewSpec: () => pick({ zh: '新建 spec', en: 'new spec' }),
  kindNewProject: () => pick({ zh: '初始化项目', en: 'init project' }),
  kindDispatch: () => pick({ zh: '实现任务', en: 'implement task' }),

  // ---- windows (listening Claude sessions)
  hWindows: () => pick({ zh: '👂 Claude 窗口', en: '👂 Claude windows' }),
  tabWindows: () => pick({ zh: '👂 窗口', en: '👂 Windows' }),
  windowsHint: () => pick({
    zh: '新活跃的排在最前。点一个窗口把后续任务指派给它；再点一次取消指派（改为「任何窗口」）。',
    en: 'Most recently active first. Tap a window to address new work to it; tap again to unpin (any window).' }),
  noWindows: () => pick({
    zh: '当前没有窗口在监听。\n在 Claude Code 里让它用 Monitor 跑：\n<code>spec-workflow-mcp requests watch --label "窗口名" [--project /绝对/路径]</code>',
    en: 'No window is listening.\nIn Claude Code, Monitor:\n<code>spec-workflow-mcp requests watch --label "name" [--project /abs/path]</code>' }),
  windowRow: (pinned: boolean, label: string, scope: string, seen: string, note: string) => pick({
    zh: `${pinned ? '📌' : '▫️'} ${label}\n     ${scope} · 活跃 ${seen}前${note ? `\n     ${note}` : ''}`,
    en: `${pinned ? '📌' : '▫️'} ${label}\n     ${scope} · seen ${seen} ago${note ? `\n     ${note}` : ''}` }),
  windowScopeAll: () => pick({ zh: '全部项目', en: 'all projects' }),
  windowNoNote: () => pick({ zh: '（还没有活动）', en: '(no activity yet)' }),
  windowPinned: (label: string) => pick({ zh: `📌 后续任务将指派给：<b>${label}</b>`, en: `📌 new work goes to: <b>${label}</b>` }),
  windowUnpinned: () => pick({ zh: '已取消指派：任务交给任意在听的窗口', en: 'unpinned: work goes to any listening window' }),
  windowGone: () => pick({ zh: '这个窗口已经不在监听了', en: 'that window is no longer listening' }),
  targetedTo: (label: string) => pick({ zh: `🎯 已指派给窗口：${label}`, en: `🎯 addressed to: ${label}` }),

  about: (version: string, projects: number) => pick({ zh: `spec-workflow-mcp ${version} · loop_bot\n监控项目：${projects} 个`, en: `spec-workflow-mcp ${version} · loop_bot\nprojects: ${projects}` }),

  help: () => pick({
    zh: `<b>spec-workflow loop_bot</b>

<b>看</b>
/status [项目[/spec]] — 总览 / 项目 / spec 进度
/projects · /use &lt;项目&gt; — 项目列表 / 设当前项目
/specs [archived] [关键词] — spec 列表
/spec &lt;spec&gt; — 摘要 + 文档按钮（发 .md 文件）
/tasks &lt;spec&gt; — 任务看板
/task &lt;spec&gt; &lt;编号&gt; — 单任务卡片 + 操作按钮
/steering — steering 文档
/logs &lt;spec&gt; [N] · /logs &lt;spec&gt; task &lt;编号&gt; — 实现日志
/logstats &lt;spec&gt; · /find &lt;类型&gt; &lt;关键词&gt; — 统计 / 产出搜索
/prompt &lt;spec&gt; &lt;编号&gt; — 任务的实现提示词
/gates — 待审批闸门 · /runlog &lt;spec&gt; [N] — 运行日志

<b>控制</b>
/start &lt;spec&gt; · /stop &lt;spec&gt; — 后台循环
/archive · /unarchive &lt;spec&gt;
/cleanup &lt;天数&gt; [archived] — 清理旧 spec（先预览再确认）
/about · /help

<i>哪里都能写成「项目/spec」，例如 /tasks myapp/auth；只有一个项目时可省略</i>`,
    en: `<b>spec-workflow loop_bot</b>
<b>View</b>
/status [proj[/spec]] – overview / project / spec + loop state
/projects · /use &lt;proj&gt; – list / pick current project
/specs [archived] [q] – spec list
/spec &lt;spec&gt; – summary + document buttons
/tasks &lt;spec&gt; – task board · /task &lt;spec&gt; &lt;id&gt; – task card
/steering – steering docs
/logs &lt;spec&gt; [N] · /logs &lt;spec&gt; task &lt;id&gt; – implementation logs
/logstats &lt;spec&gt; · /find &lt;type&gt; &lt;term&gt; – log stats / artifact search
/prompt &lt;spec&gt; &lt;id&gt; – implement prompt
/gates – pending approvals · /runlog &lt;spec&gt; [N] – audit tail
<b>Control</b>
/start &lt;spec&gt; · /stop &lt;spec&gt; – background loop
/archive|/unarchive &lt;spec&gt;
/cleanup &lt;days&gt; [archived] – delete old specs (dry-run first)
/about · /help
<i>proj/spec form works everywhere, e.g. /tasks myapp/auth</i>` }),
};
