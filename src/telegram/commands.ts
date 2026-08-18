import { promises as fs } from 'fs';
import { join, basename } from 'path';
import { spawn } from 'child_process';
import { SpecParser } from '../core/parser.js';
import { PathUtils } from '../core/path-utils.js';
import { parseTasksFromMarkdown, getTaskById } from '../core/task-parser.js';
import { ImplementationLogManager } from '../core/implementation-log-manager.js';
import { SpecArchiveService } from '../core/archive-service.js';
import { getLoopStatus, requestLoopStop } from '../core/run-state.js';
import { setTaskStatus, ManualTaskStatus } from '../core/verify-core.js';
import { cleanupSpecs } from '../core/cleanup.js';
import { listPendingGates } from '../core/gates.js';
import { tailAudit } from '../core/run-watcher.js';
import { SPEC_NAME, TASK_ID } from './access.js';
import { esc, untrusted, inlineUntrusted, code, b, ago, bar, shortPath, statusIcon } from './render.js';
import type { InlineKeyboardMarkup } from './api.js';
import type { VerifyResult } from '../types.js';

export interface Reply {
  text: string;
  keyboard?: InlineKeyboardMarkup;
  files?: Array<{ name: string; content: string | Buffer; caption?: string }>;
  /** silent = no notification sound */
  silent?: boolean;
}

export interface CallbackPayload { kind: 'doc' | 'task' | 'steer' | 'arch' | 'clean'; project: string; spec?: string; taskId?: string; flag?: string; num?: number }

export interface CommandCtx {
  userId: number;
  chatId: number;
  /** all known project roots (registry + TELEGRAM_PROJECTS) */
  projects: string[];
  currentProject?: string;
  setCurrentProject(p: string | undefined): Promise<void>;
  /** register a short callback key → typed payload; returns key */
  registerCallback(payload: CallbackPayload): Promise<string>;
  version: string;
}

export const HELP = `<b>spec-workflow loop_bot</b>
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
<i>proj/spec form works everywhere, e.g. /tasks myapp/auth</i>`;

const parseArgs = (text: string): { cmd: string; args: string[] } => {
  const [head, ...rest] = text.split(/\s+/);
  const cmd = head.replace(/^\//, '').replace(/@\w+$/, '').toLowerCase();
  return { cmd, args: rest };
};

// -------------------------------------------------------------- project / spec resolution

function projectLabel(p: string): string { return basename(p.replace(/\/+$/, '')); }

function matchProject(ctx: CommandCtx, token: string): string | undefined {
  const t = token.toLowerCase();
  return ctx.projects.find(p => p === token)
    || ctx.projects.find(p => projectLabel(p).toLowerCase() === t)
    || ctx.projects.find(p => shortPath(p).toLowerCase() === t);
}

/** Resolve "<proj>/<spec>" or "<spec>" (using current/only project). */
function resolveSpecRef(ctx: CommandCtx, ref: string | undefined): { project: string; spec: string } | { error: string } {
  if (!ref) return { error: 'missing spec name' };
  let project: string | undefined, spec: string;
  const slash = ref.lastIndexOf('/');
  if (slash > 0) {
    project = matchProject(ctx, ref.slice(0, slash));
    if (!project) return { error: `unknown project "${ref.slice(0, slash)}" — /projects` };
    spec = ref.slice(slash + 1);
  } else {
    spec = ref;
    project = ctx.currentProject || (ctx.projects.length === 1 ? ctx.projects[0] : undefined);
    if (!project) return { error: 'several projects known — say /use <proj> first or use proj/spec' };
  }
  if (!SPEC_NAME.test(spec)) return { error: 'invalid spec name' };
  return { project, spec };
}

function resolveProjectRef(ctx: CommandCtx, token?: string): string | undefined {
  if (token) return matchProject(ctx, token);
  return ctx.currentProject || (ctx.projects.length === 1 ? ctx.projects[0] : undefined);
}

async function specExists(project: string, spec: string): Promise<'active' | 'archived' | 'missing'> {
  const svc = new SpecArchiveService(PathUtils.translatePath(project));
  const loc = await svc.getSpecLocation(spec);
  return loc === 'not-found' ? 'missing' : loc;
}

// -------------------------------------------------------------- dispatcher

export async function handleCommand(text: string, ctx: CommandCtx): Promise<Reply[]> {
  const { cmd, args } = parseArgs(text);
  try {
    switch (cmd) {
      case 'start':
        // Telegram's /start is also the "open chat" command; without args show help.
        return args.length ? cmdStartLoop(ctx, args) : [{ text: HELP }];
      case 'help': return [{ text: HELP }];
      case 'about': return [{ text: `spec-workflow-mcp ${esc(ctx.version)} · loop_bot\nprojects: ${ctx.projects.length}` }];
      case 'projects': return cmdProjects(ctx);
      case 'use': return cmdUse(ctx, args[0]);
      case 'status': return cmdStatus(ctx, args[0]);
      case 'specs': return cmdSpecs(ctx, args);
      case 'spec': return cmdSpec(ctx, args[0]);
      case 'tasks': return cmdTasks(ctx, args[0]);
      case 'task': return cmdTask(ctx, args[0], args[1], args.slice(2));
      case 'steering': return cmdSteering(ctx, args[0]);
      case 'logs': return cmdLogs(ctx, args);
      case 'logstats': return cmdLogStats(ctx, args[0]);
      case 'find': return cmdFind(ctx, args);
      case 'prompt': return cmdPrompt(ctx, args[0], args[1]);
      case 'gates': return cmdGates(ctx);
      case 'runlog': return cmdRunlog(ctx, args[0], args[1]);
      case 'stop': return cmdStop(ctx, args[0]);
      case 'archive': return cmdArchive(ctx, args[0], true);
      case 'unarchive': return cmdArchive(ctx, args[0], false);
      case 'cleanup': return cmdCleanup(ctx, args);
      default: return [{ text: `unknown command ${code('/' + cmd)} — /help` }];
    }
  } catch (e) {
    return [{ text: `❌ ${esc(e instanceof Error ? e.message : String(e))}` }];
  }
}

// -------------------------------------------------------------- read commands

async function cmdProjects(ctx: CommandCtx): Promise<Reply[]> {
  if (!ctx.projects.length) return [{ text: 'no projects known. Start an MCP session in a project (it registers itself) or set TELEGRAM_PROJECTS.' }];
  const lines: string[] = [];
  for (const p of ctx.projects) {
    const specs = await new SpecParser(PathUtils.translatePath(p)).getAllSpecs();
    const running = (await Promise.all(specs.map(s => getLoopStatus(p, s.name)))).filter(l => l.running).length;
    lines.push(`${p === ctx.currentProject ? '▶️' : '•'} ${b(projectLabel(p))} ${code(shortPath(p))} · ${specs.length} specs${running ? ` · 🔄 ${running} loop` : ''}`);
  }
  return [{ text: `<b>Projects</b>\n${lines.join('\n')}\n\n/use &lt;name&gt; to make one current` }];
}

async function cmdUse(ctx: CommandCtx, token?: string): Promise<Reply[]> {
  if (!token) { await ctx.setCurrentProject(undefined); return [{ text: 'current project cleared' }]; }
  const p = matchProject(ctx, token);
  if (!p) return [{ text: `unknown project ${code(token)} — /projects` }];
  await ctx.setCurrentProject(p);
  return [{ text: `current project → ${b(projectLabel(p))} ${code(p)}` }];
}

async function cmdStatus(ctx: CommandCtx, ref?: string): Promise<Reply[]> {
  // /status            → global overview
  // /status proj       → project
  // /status proj/spec | spec → spec detail
  if (!ref) {
    if (!ctx.projects.length) return cmdProjects(ctx);
    const out: string[] = ['<b>Overview</b>'];
    for (const p of ctx.projects) {
      const specs = await new SpecParser(PathUtils.translatePath(p)).getAllSpecs();
      let tot = 0, done = 0, loops = 0;
      for (const s of specs) { tot += s.taskProgress?.total ?? 0; done += s.taskProgress?.completed ?? 0; if ((await getLoopStatus(p, s.name)).running) loops++; }
      out.push(`${b(projectLabel(p))}: ${specs.length} specs · tasks ${done}/${tot} ${bar(done, tot)}${loops ? ` · 🔄 ${loops} running` : ''}`);
    }
    return [{ text: out.join('\n') }];
  }
  const asProject = !ref.includes('/') ? matchProject(ctx, ref) : undefined;
  if (asProject && !(ctx.currentProject && await specExists(ctx.currentProject, ref) !== 'missing')) {
    return cmdSpecs({ ...ctx, currentProject: asProject }, []);
  }
  const r = resolveSpecRef(ctx, ref);
  if ('error' in r) return [{ text: `❌ ${esc(r.error)}` }];
  return [{ text: await specStatusText(r.project, r.spec) }];
}

export async function specStatusText(project: string, spec: string): Promise<string> {
  const parser = new SpecParser(PathUtils.translatePath(project));
  const s = (await parser.getSpec(spec)) || (await parser.getArchivedSpec(spec));
  if (!s) return `spec ${code(spec)} not found in ${esc(projectLabel(project))}`;
  const archived = !(await parser.getSpec(spec));
  const loop = archived ? { running: false } as Awaited<ReturnType<typeof getLoopStatus>> : await getLoopStatus(project, spec);
  const tp = s.taskProgress;
  const specDir = archived ? PathUtils.getArchiveSpecPath(PathUtils.translatePath(project), spec) : PathUtils.getSpecPath(PathUtils.translatePath(project), spec);
  const tasksFile = join(specDir, 'tasks.md');
  let counts = { completed: 0, inProgress: 0, blocked: 0, pending: 0, total: 0 };
  try {
    const t = parseTasksFromMarkdown(await fs.readFile(tasksFile, 'utf-8')).tasks.filter(x => !x.isHeader);
    counts = {
      total: t.length,
      completed: t.filter(x => x.status === 'completed').length,
      inProgress: t.filter(x => x.status === 'in-progress').length,
      blocked: t.filter(x => x.status === 'blocked').length,
      pending: t.filter(x => x.status === 'pending').length,
    };
  } catch { /* no tasks */ }
  const gates = archived ? [] : await listPendingGates(project, spec);
  const lines = [
    `${b(projectLabel(project))} / ${b(spec)}${archived ? ' 📦 archived' : ''}`,
    `phases: req ${s.phases.requirements.exists ? '✅' : '—'} · design ${s.phases.design.exists ? '✅' : '—'} · tasks ${s.phases.tasks.exists ? '✅' : '—'}`,
    tp ? `tasks ${counts.completed}/${counts.total} ${bar(counts.completed, counts.total)} · ✅${counts.completed} 🔄${counts.inProgress} ⛔${counts.blocked} ⬜${counts.pending}` : 'no tasks.md yet',
    archived ? '' : `loop: ${loop.running ? `🔄 running (pid ${loop.pid})` : loop.stale ? '💤 stopped (stale pid)' : '💤 idle'}${loop.stopRequested ? ' · stop requested' : ''}`,
    gates.length ? `⏸ ${gates.length} gate(s) waiting — /gates` : '',
    `updated ${ago(s.lastModified)} ago`,
  ].filter(Boolean);
  return lines.join('\n');
}

async function cmdSpecs(ctx: CommandCtx, args: string[]): Promise<Reply[]> {
  const archived = args[0]?.toLowerCase() === 'archived';
  const q = (archived ? args.slice(1) : args).join(' ').toLowerCase();
  const project = resolveProjectRef(ctx);
  if (!project) return [{ text: 'which project? /use <proj> or /projects' }];
  const parser = new SpecParser(PathUtils.translatePath(project));
  let specs = archived ? await parser.getAllArchivedSpecs() : await parser.getAllSpecs();
  if (q) specs = specs.filter(s => s.name.toLowerCase().includes(q) || s.displayName.toLowerCase().includes(q));
  specs.sort((a, b2) => (b2.lastModified || '').localeCompare(a.lastModified || ''));
  if (!specs.length) return [{ text: `no ${archived ? 'archived ' : ''}specs${q ? ` matching "${esc(q)}"` : ''} in ${esc(projectLabel(project))}` }];
  const rows: string[] = [];
  for (const s of specs.slice(0, 25)) {
    const tp = s.taskProgress;
    const loop = archived ? { running: false } : await getLoopStatus(project, s.name);
    rows.push(`${loop.running ? '🔄' : '•'} ${code(s.name)} ${tp ? `${tp.completed}/${tp.total} ${bar(tp.completed, tp.total, 6)}` : '—'} · ${ago(s.lastModified)}`);
  }
  const more = specs.length > 25 ? `\n… ${specs.length - 25} more (narrow with /specs ${archived ? 'archived ' : ''}&lt;q&gt;)` : '';
  return [{ text: `<b>${archived ? 'Archived specs' : 'Specs'} · ${esc(projectLabel(project))}</b>\n${rows.join('\n')}${more}` }];
}

async function cmdSpec(ctx: CommandCtx, ref?: string): Promise<Reply[]> {
  const r = resolveSpecRef(ctx, ref);
  if ('error' in r) return [{ text: `❌ ${esc(r.error)}` }];
  const loc = await specExists(r.project, r.spec);
  if (loc === 'missing') return [{ text: `spec ${code(r.spec)} not found` }];
  const text = await specStatusText(r.project, r.spec);
  const key = await ctx.registerCallback({ kind: 'doc', project: r.project, spec: r.spec });
  const keyboard: InlineKeyboardMarkup = { inline_keyboard: [[
    { text: '📄 requirements', callback_data: `d:${key}:r` },
    { text: '📐 design', callback_data: `d:${key}:d` },
    { text: '☑️ tasks', callback_data: `d:${key}:t` },
  ]] };
  return [{ text, keyboard }];
}

/** Send one of the spec documents as a file attachment. */
export async function specDocument(project: string, spec: string, which: 'r' | 'd' | 't'): Promise<Reply> {
  const name = which === 'r' ? 'requirements.md' : which === 'd' ? 'design.md' : 'tasks.md';
  const svc = new SpecArchiveService(PathUtils.translatePath(project));
  const loc = await svc.getSpecLocation(spec);
  const dir = loc === 'archived' ? PathUtils.getArchiveSpecPath(PathUtils.translatePath(project), spec) : PathUtils.getSpecPath(PathUtils.translatePath(project), spec);
  try {
    const content = await fs.readFile(join(dir, name), 'utf-8');
    return { text: '', files: [{ name: `${spec}-${name}`, content, caption: `${spec} · ${name} · ${content.length} chars` }] };
  } catch {
    return { text: `${code(name)} does not exist yet for ${code(spec)}` };
  }
}

async function loadTasks(project: string, spec: string) {
  const file = join(PathUtils.getSpecPath(PathUtils.translatePath(project), spec), 'tasks.md');
  const content = await fs.readFile(file, 'utf-8');
  return parseTasksFromMarkdown(content).tasks;
}

async function cmdTasks(ctx: CommandCtx, ref?: string): Promise<Reply[]> {
  const r = resolveSpecRef(ctx, ref);
  if ('error' in r) return [{ text: `❌ ${esc(r.error)}` }];
  let tasks;
  try { tasks = await loadTasks(r.project, r.spec); } catch { return [{ text: `no tasks.md for ${code(r.spec)}` }]; }
  const real = tasks.filter(t => !t.isHeader);
  const groups: Array<[string, string]> = [['in-progress', '🔄 In progress'], ['blocked', '⛔ Blocked'], ['pending', '⬜ Pending'], ['completed', '✅ Completed']];
  const out = [`<b>${esc(r.spec)}</b> · ${real.filter(t => t.status === 'completed').length}/${real.length}`];
  for (const [st, title] of groups) {
    const items = real.filter(t => t.status === st);
    if (!items.length) continue;
    out.push(`\n${title} (${items.length})`);
    for (const t of items.slice(0, 10)) out.push(`  ${code(t.id)} ${inlineUntrusted(t.description, 70)}${t.status === 'blocked' && t.blockedReason ? ` — ${inlineUntrusted(t.blockedReason, 60)}` : ''}`);
    if (items.length > 10) out.push(`  … +${items.length - 10}`);
  }
  out.push(`\n/task ${esc(r.spec)} &lt;id&gt; for details`);
  return [{ text: out.join('\n') }];
}

async function readVerify(project: string, spec: string, taskId: string): Promise<VerifyResult | null> {
  try {
    const f = join(PathUtils.getSpecPath(PathUtils.translatePath(project), spec), 'verify-results', `task-${taskId.replace(/\./g, '-')}.json`);
    return JSON.parse(await fs.readFile(f, 'utf-8'));
  } catch { return null; }
}

export async function taskCard(ctx: CommandCtx, project: string, spec: string, taskId: string): Promise<Reply> {
  let tasks;
  try { tasks = await loadTasks(project, spec); } catch { return { text: `no tasks.md for ${code(spec)}` }; }
  const t = getTaskById(tasks, taskId);
  if (!t) return { text: `task ${code(taskId)} not found in ${code(spec)}` };
  const v = await readVerify(project, spec, taskId);
  const loop = await getLoopStatus(project, spec);
  const lines = [
    `${statusIcon(t.status)} ${b(`${spec} · task ${t.id}`)} · ${esc(t.status)}`,
    untrusted(t.description, 400, 'task description'),
  ];
  const meta: string[] = [];
  if (t.engine) meta.push(`engine ${code(t.engine)}`);
  if (t.tests) meta.push(`tests ${code(t.tests)}`);
  if (t.verify) meta.push(`verify ${code(t.verify)}`);
  if (t.requirements?.length) meta.push(`req ${esc(t.requirements.join(', '))}`);
  if (meta.length) lines.push(meta.join(' · '));
  if (t.status === 'blocked' && t.blockedReason) lines.push(`⛔ ${untrusted(t.blockedReason, 300, 'blocked reason')}`);
  if (v) {
    const parts = [
      `last: ${esc(v.lastSignal ?? '—')}${v.verifiedBy ? ` (${esc(v.verifiedBy)})` : ''}`,
      v.exitCode !== undefined ? `exit ${esc(v.exitCode)}` : '',
      v.failureClass ? `class ${esc(v.failureClass)}` : '',
      `fix ${esc(v.fixAttempts)}`,
      v.tamperGate === 'off' ? '⚠️ tamperGate off' : '',
      v.judge ? `judge ${esc(v.judge.verdict)} (${esc(v.judge.engine)}${v.judge.attempts ? `, ${esc(v.judge.attempts)} reopen` : ''})` : '',
      v.manual ? `manual ${esc(v.manual.from)}→${esc(v.manual.to)} by ${esc(v.manual.by)}` : '',
    ].filter(Boolean);
    lines.push(`🧪 ${parts.join(' · ')} · ${ago(v.lastTimestamp)}`);
    if (v.lastSignal === 'red' && v.lastFixNote) lines.push(untrusted(v.lastFixNote, 500, 'last failure output'));
    if (v.judge?.verdict === 'fail' && v.judge.reasons) lines.push(untrusted(v.judge.reasons, 300, 'judge reasons'));
  }
  if (loop.running) lines.push(`🔄 loop running — manual state changes disabled (/stop ${esc(spec)} first)`);
  const key = await ctx.registerCallback({ kind: 'task', project, spec, taskId });
  const row: InlineKeyboardMarkup['inline_keyboard'][number] = [];
  if (!loop.running) {
    if (t.status !== 'in-progress') row.push({ text: '▶ start', callback_data: `t:${key}:s` });
    if (t.status !== 'completed') row.push({ text: '✅ done', callback_data: `t:${key}:c` });
    if (t.status !== 'blocked') row.push({ text: '⛔ block', callback_data: `t:${key}:b` });
    if (t.status !== 'pending') row.push({ text: '↩ reset', callback_data: `t:${key}:p` });
  }
  const row2 = [{ text: '📋 prompt', callback_data: `t:${key}:q` }, { text: '🔄 refresh', callback_data: `t:${key}:r` }];
  return { text: lines.join('\n'), keyboard: { inline_keyboard: row.length ? [row, row2] : [row2] } };
}

async function cmdTask(ctx: CommandCtx, ref?: string, taskId?: string, rest: string[] = []): Promise<Reply[]> {
  const r = resolveSpecRef(ctx, ref);
  if ('error' in r) return [{ text: `❌ ${esc(r.error)}` }];
  if (!taskId || !TASK_ID.test(taskId)) return [{ text: 'usage: /task &lt;spec&gt; &lt;id&gt; [start|done|block &lt;reason&gt;|reset]' }];
  const action = rest[0]?.toLowerCase();
  if (action) {
    const map: Record<string, ManualTaskStatus> = { start: 'in-progress', done: 'completed', block: 'blocked', reset: 'pending' };
    const status = map[action];
    if (!status) return [{ text: `unknown action ${code(action)}` }];
    const res = await setTaskStatus({ projectPath: r.project, specName: r.spec, taskId, status, reason: rest.slice(1).join(' ') || undefined, by: `tg:${ctx.userId}` });
    if (!res.ok) return [{ text: `❌ ${esc(res.message)}` }];
  }
  return [await taskCard(ctx, r.project, r.spec, taskId)];
}

export async function applyTaskAction(ctx: CommandCtx, project: string, spec: string, taskId: string, status: ManualTaskStatus, reason?: string): Promise<{ ok: boolean; message: string }> {
  return setTaskStatus({ projectPath: project, specName: spec, taskId, status, reason, by: `tg:${ctx.userId}` });
}

export async function promptFor(project: string, spec: string, taskId: string): Promise<Reply> {
  let tasks;
  try { tasks = await loadTasks(project, spec); } catch { return { text: `no tasks.md for ${code(spec)}` }; }
  const t = getTaskById(tasks, taskId);
  if (!t) return { text: `task ${code(taskId)} not found` };
  const p = t.prompt || `Please work on task ${t.id} for spec "${spec}"`;
  return { text: `<b>implement prompt · ${esc(spec)} · ${esc(t.id)}</b>\n${untrusted(p, 2500, 'from tasks.md')}` };
}

async function cmdPrompt(ctx: CommandCtx, ref?: string, taskId?: string): Promise<Reply[]> {
  const r = resolveSpecRef(ctx, ref);
  if ('error' in r) return [{ text: `❌ ${esc(r.error)}` }];
  if (!taskId || !TASK_ID.test(taskId)) return [{ text: 'usage: /prompt &lt;spec&gt; &lt;id&gt;' }];
  return [await promptFor(r.project, r.spec, taskId)];
}

async function cmdSteering(ctx: CommandCtx, token?: string): Promise<Reply[]> {
  const project = resolveProjectRef(ctx, token);
  if (!project) return [{ text: 'which project? /use <proj>' }];
  const st = await new SpecParser(PathUtils.translatePath(project)).getProjectSteeringStatus();
  const key = await ctx.registerCallback({ kind: 'steer', project });
  const row: InlineKeyboardMarkup['inline_keyboard'][number] = [];
  const lines = [`<b>Steering · ${esc(projectLabel(project))}</b>`];
  for (const d of ['product', 'tech', 'structure'] as const) {
    const ok = st.documents[d];
    lines.push(`${ok ? '✅' : '—'} ${d}.md`);
    if (ok) row.push({ text: `📄 ${d}`, callback_data: `s:${key}:${d[0]}` });
  }
  return [{ text: lines.join('\n'), keyboard: row.length ? { inline_keyboard: [row] } : undefined }];
}

export async function steeringDocument(project: string, which: string): Promise<Reply> {
  const name = which === 'p' ? 'product.md' : which === 't' ? 'tech.md' : 'structure.md';
  try {
    const content = await fs.readFile(join(PathUtils.getSteeringPath(PathUtils.translatePath(project)), name), 'utf-8');
    return { text: '', files: [{ name: `steering-${name}`, content, caption: `steering · ${name}` }] };
  } catch { return { text: `${code(name)} not found` }; }
}

async function cmdLogs(ctx: CommandCtx, args: string[]): Promise<Reply[]> {
  const r = resolveSpecRef(ctx, args[0]);
  if ('error' in r) return [{ text: `❌ ${esc(r.error)}` }];
  const mgr = new ImplementationLogManager(PathUtils.getSpecPath(PathUtils.translatePath(r.project), r.spec));
  let entries;
  let title = `logs · ${r.spec}`;
  if (args[1]?.toLowerCase() === 'task' && args[2] && TASK_ID.test(args[2])) {
    entries = await mgr.getTaskLogs(args[2]); title += ` · task ${args[2]}`;
  } else {
    const n = Math.min(Math.max(parseInt(args[1] || '5', 10) || 5, 1), 20);
    entries = (await mgr.getAllLogs()).sort((a, b2) => b2.timestamp.localeCompare(a.timestamp)).slice(0, n);
  }
  if (!entries.length) return [{ text: `no implementation logs for ${code(r.spec)}` }];
  const out = [`<b>${esc(title)}</b>`];
  for (const e of entries) {
    out.push(`\n${code(e.taskId)} · ${ago(e.timestamp)} · +${e.statistics.linesAdded}/-${e.statistics.linesRemoved} · ${e.statistics.filesChanged} files`);
    out.push(untrusted(e.summary, 300, 'log summary'));
  }
  return [{ text: out.join('\n') }];
}

async function cmdLogStats(ctx: CommandCtx, ref?: string): Promise<Reply[]> {
  const r = resolveSpecRef(ctx, ref);
  if ('error' in r) return [{ text: `❌ ${esc(r.error)}` }];
  const mgr = new ImplementationLogManager(PathUtils.getSpecPath(PathUtils.translatePath(r.project), r.spec));
  const all = await mgr.getAllLogs();
  if (!all.length) return [{ text: `no implementation logs for ${code(r.spec)}` }];
  const sum = all.reduce((a, e) => ({ add: a.add + e.statistics.linesAdded, rm: a.rm + e.statistics.linesRemoved, files: a.files + e.statistics.filesChanged }), { add: 0, rm: 0, files: 0 });
  const arts = all.reduce((a, e) => {
    for (const k of Object.keys(e.artifacts || {}) as Array<keyof typeof e.artifacts>) a[k] = (a[k] || 0) + ((e.artifacts as any)[k]?.length || 0);
    return a;
  }, {} as Record<string, number>);
  return [{ text: `<b>log stats · ${esc(r.spec)}</b>\nentries ${all.length} · tasks ${new Set(all.map(e => e.taskId)).size}\n+${sum.add} / -${sum.rm} lines · ${sum.files} file changes\nartifacts: ${Object.entries(arts).map(([k, v]) => `${esc(k)} ${v}`).join(', ') || '—'}` }];
}

async function cmdFind(ctx: CommandCtx, args: string[]): Promise<Reply[]> {
  const [type, ...terms] = args;
  const term = terms.join(' ');
  const project = resolveProjectRef(ctx);
  if (!project) return [{ text: 'which project? /use <proj>' }];
  if (!type || !term) return [{ text: 'usage: /find &lt;apiEndpoints|components|functions|classes|integrations&gt; &lt;term&gt;' }];
  const specs = await new SpecParser(PathUtils.translatePath(project)).getAllSpecs();
  const out: string[] = [];
  for (const s of specs) {
    const mgr = new ImplementationLogManager(PathUtils.getSpecPath(PathUtils.translatePath(project), s.name));
    const hits = await mgr.findArtifact(type, term);
    for (const h of hits.slice(0, 5)) out.push(`${code(s.name)} · task ${esc(h.log.taskId)} · ${untrusted(JSON.stringify(h.artifact), 200, type)}`);
    if (out.length > 15) break;
  }
  return [{ text: out.length ? `<b>find ${esc(type)} "${esc(term)}"</b>\n${out.join('\n')}` : `nothing found for ${esc(type)} "${esc(term)}"` }];
}

async function cmdGates(ctx: CommandCtx): Promise<Reply[]> {
  const out: string[] = [];
  for (const p of ctx.projects) {
    const specs = await new SpecParser(PathUtils.translatePath(p)).getAllSpecs();
    for (const s of specs) {
      for (const g of await listPendingGates(p, s.name)) out.push(`⏸ ${b(projectLabel(p))}/${b(s.name)} · ${esc(g.kind)} · ${ago(g.createdAt)} ago · ${code(g.id)}`);
    }
  }
  return [{ text: out.length ? `<b>Pending gates</b>\n${out.join('\n')}\n<i>cards with Approve/Reject were posted when they appeared; if you missed one it is re-posted on daemon restart</i>` : 'no pending gates' }];
}

async function cmdRunlog(ctx: CommandCtx, ref?: string, nRaw?: string): Promise<Reply[]> {
  const r = resolveSpecRef(ctx, ref);
  if ('error' in r) return [{ text: `❌ ${esc(r.error)}` }];
  const n = Math.min(Math.max(parseInt(nRaw || '20', 10) || 20, 1), 200);
  const lines = await tailAudit(r.project, n, r.spec);
  if (!lines.length) return [{ text: `no audit lines for ${code(r.spec)}` }];
  return [{ text: `<b>audit · ${esc(r.spec)} · last ${lines.length}</b>\n${untrusted(lines.join('\n'), 2800, 'loop-audit.log')}` }];
}

// -------------------------------------------------------------- control commands

async function cmdStartLoop(ctx: CommandCtx, args: string[]): Promise<Reply[]> {
  const r = resolveSpecRef(ctx, args[0]);
  if ('error' in r) return [{ text: `❌ ${esc(r.error)}` }];
  const project = PathUtils.translatePath(r.project);
  const runner = join(PathUtils.getWorkflowRoot(project), 'spec-loop-run.sh');
  try { await fs.access(runner); } catch { return [{ text: `no loop runner at ${code('.spec-workflow/spec-loop-run.sh')} in ${esc(projectLabel(r.project))} — run init.sh there` }]; }
  const loop = await getLoopStatus(r.project, r.spec);
  if (loop.running) return [{ text: `loop already running for ${code(r.spec)} (pid ${loop.pid})` }];
  const logDir = join(PathUtils.getSpecPath(project, r.spec));
  await fs.mkdir(logDir, { recursive: true });
  const outFile = await fs.open(join(logDir, 'loop-run.stdout'), 'a');
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^TELEGRAM_|^GATE_SECRET$/.test(k)));
  const child = spawn('bash', [runner, r.spec], { cwd: project, detached: true, stdio: ['ignore', outFile.fd, outFile.fd], env });
  child.unref();
  await outFile.close();
  return [{ text: `▶️ started loop for ${b(r.spec)} in ${esc(projectLabel(r.project))} (pid ${child.pid}).\nIt exits at once if [loop].autoLoop is false — check /status ${esc(r.spec)} in a moment.` }];
}

async function cmdStop(ctx: CommandCtx, ref?: string): Promise<Reply[]> {
  const r = resolveSpecRef(ctx, ref);
  if ('error' in r) return [{ text: `❌ ${esc(r.error)}` }];
  const loop = await getLoopStatus(r.project, r.spec);
  const req = await requestLoopStop(r.project, r.spec, `tg:${ctx.userId}`);
  return [{ text: loop.running
    ? `🛑 stop requested for ${b(r.spec)} (pid ${loop.pid}); it exits after the current iteration. nonce ${code(req.nonce.slice(0, 8))}`
    : `no loop is running for ${code(r.spec)} — stop file written anyway (cleared at next START)` }];
}

async function cmdArchive(ctx: CommandCtx, ref: string | undefined, archive: boolean): Promise<Reply[]> {
  const r = resolveSpecRef(ctx, ref);
  if ('error' in r) return [{ text: `❌ ${esc(r.error)}` }];
  const loc = await specExists(r.project, r.spec);
  if (archive && loc !== 'active') return [{ text: `${code(r.spec)} is not an active spec` }];
  if (!archive && loc !== 'archived') return [{ text: `${code(r.spec)} is not archived` }];
  if (archive && (await getLoopStatus(r.project, r.spec)).running) return [{ text: `loop is running for ${code(r.spec)} — /stop it first` }];
  const key = await ctx.registerCallback({ kind: 'arch', project: r.project, spec: r.spec, flag: archive ? '1' : '0' });
  return [{ text: `${archive ? '📦 Archive' : '📤 Unarchive'} ${b(r.spec)} in ${esc(projectLabel(r.project))}?`, keyboard: { inline_keyboard: [[{ text: archive ? 'Archive' : 'Unarchive', callback_data: `a:${key}:y` }, { text: 'Cancel', callback_data: `a:${key}:n` }]] } }];
}

export async function doArchive(project: string, spec: string, archive: boolean): Promise<string> {
  const svc = new SpecArchiveService(PathUtils.translatePath(project));
  if (archive) await svc.archiveSpec(spec); else await svc.unarchiveSpec(spec);
  return `${archive ? '📦 archived' : '📤 unarchived'} ${b(spec)}`;
}

async function cmdCleanup(ctx: CommandCtx, args: string[]): Promise<Reply[]> {
  const project = resolveProjectRef(ctx);
  if (!project) return [{ text: 'which project? /use <proj>' }];
  const days = parseInt(args[0] || '', 10);
  if (!Number.isFinite(days) || days < 0) return [{ text: 'usage: /cleanup &lt;days&gt; [archived]' }];
  const archived = args[1]?.toLowerCase() === 'archived';
  const dry = await cleanupSpecs(project, { daysOld: days, archived, dryRun: true });
  if (!dry.candidates.length) return [{ text: `nothing ${archived ? 'archived ' : ''}older than ${days}d in ${esc(projectLabel(project))} (${dry.processed} checked)` }];
  const key = await ctx.registerCallback({ kind: 'clean', project, num: days, flag: archived ? '1' : '0' });
  const list = dry.candidates.slice(0, 20).map(c => `• ${code(c.name)} (${ago(c.createdAt)})`).join('\n');
  return [{ text: `🧹 Would delete ${dry.candidates.length} ${archived ? 'archived ' : ''}spec(s) older than ${days}d in ${esc(projectLabel(project))}:\n${list}${dry.candidates.length > 20 ? '\n…' : ''}\n\n<b>This is irreversible.</b>`, keyboard: { inline_keyboard: [[{ text: `Delete ${dry.candidates.length}`, callback_data: `c:${key}:y` }, { text: 'Cancel', callback_data: `c:${key}:n` }]] } }];
}

export async function doCleanup(project: string, days: number, archived: boolean): Promise<string> {
  const r = await cleanupSpecs(project, { daysOld: days, archived, dryRun: false });
  return `🧹 deleted ${r.deleted.length}${r.failed.length ? `, failed ${r.failed.length}` : ''}: ${r.deleted.map(code).join(', ') || '—'}`;
}
