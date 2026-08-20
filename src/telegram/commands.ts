import { promises as fs } from 'fs';
import { join, basename } from 'path';
import { spawn } from 'child_process';
import { SpecParser } from '../core/parser.js';
import { PathUtils } from '../core/path-utils.js';
import { parseTasksFromMarkdown, getTaskById } from '../core/task-parser.js';
import { ImplementationLogManager } from '../core/implementation-log-manager.js';
import { SpecArchiveService } from '../core/archive-service.js';
import { getLoopStatus, requestLoopStop } from '../core/run-state.js';
import { setTaskStatus, verifyResultFile, ManualTaskStatus } from '../core/verify-core.js';
import { cleanupSpecs } from '../core/cleanup.js';
import { listPendingGates } from '../core/gates.js';
import { tailAudit } from '../core/run-watcher.js';
import { SPEC_NAME, TASK_ID } from './access.js';
import { esc, untrusted, inlineUntrusted, code, b, ago, bar, pct, shortPath, statusIcon } from './render.js';
import { T } from './strings.js';
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

export const HELP = () => T.help();

const parseArgs = (text: string): { cmd: string; args: string[] } => {
  const [head, ...rest] = text.split(/\s+/);
  const cmd = head.replace(/^\//, '').replace(/@\w+$/, '').toLowerCase();
  return { cmd, args: rest };
};

// -------------------------------------------------------------- project / spec resolution

export function projectLabel(p: string): string { return basename(p.replace(/\/+$/, '')); }

function matchProject(ctx: CommandCtx, token: string): string | undefined {
  const t = token.toLowerCase();
  return ctx.projects.find(p => p === token)
    || ctx.projects.find(p => projectLabel(p).toLowerCase() === t)
    || ctx.projects.find(p => shortPath(p).toLowerCase() === t);
}

/** Resolve "<proj>/<spec>" or "<spec>" (using current/only project). */
function resolveSpecRef(ctx: CommandCtx, ref: string | undefined): { project: string; spec: string } | { error: string } {
  if (!ref) return { error: T.missingSpec() };
  let project: string | undefined, spec: string;
  const slash = ref.lastIndexOf('/');
  if (slash > 0) {
    project = matchProject(ctx, ref.slice(0, slash));
    if (!project) return { error: T.unknownProject(ref.slice(0, slash)) };
    spec = ref.slice(slash + 1);
  } else {
    spec = ref;
    project = ctx.currentProject || (ctx.projects.length === 1 ? ctx.projects[0] : undefined);
    if (!project) return { error: T.ambiguousProject() };
  }
  if (!SPEC_NAME.test(spec)) return { error: T.invalidSpec() };
  return { project, spec };
}

function resolveProjectRef(ctx: CommandCtx, token?: string): string | undefined {
  if (token) return matchProject(ctx, token);
  return ctx.currentProject || (ctx.projects.length === 1 ? ctx.projects[0] : undefined);
}

export async function specExists(project: string, spec: string): Promise<'active' | 'archived' | 'missing'> {
  const svc = new SpecArchiveService(project);
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
        return args.length ? cmdStartLoop(ctx, args) : [{ text: HELP() }];
      case 'help': return [{ text: HELP() }];
      case 'about': return [{ text: T.about(esc(ctx.version), ctx.projects.length) }];
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
      default: return [{ text: T.unknownCmd(code('/' + cmd)) }];
    }
  } catch (e) {
    return [{ text: `❌ ${esc(e instanceof Error ? e.message : String(e))}` }];
  }
}

// -------------------------------------------------------------- read commands

async function cmdProjects(ctx: CommandCtx): Promise<Reply[]> {
  if (!ctx.projects.length) return [{ text: esc(T.noProjects()) }];
  const lines: string[] = [];
  for (const p of ctx.projects) {
    const specs = await new SpecParser(p).getAllSpecs();
    const running = (await Promise.all(specs.map(s => getLoopStatus(p, s.name)))).filter(l => l.running).length;
    lines.push(`${p === ctx.currentProject ? '▶️' : '▫️'} ${b(projectLabel(p))}${running ? `  🔄 ${running}` : ''}\n     ${code(shortPath(p))} · ${specs.length} ${T.lSpecs()}`);
  }
  return [{ text: `${b(T.hProjects())}\n${lines.join('\n')}\n${esc(T.useHint())}` }];
}

async function cmdUse(ctx: CommandCtx, token?: string): Promise<Reply[]> {
  if (!token) { await ctx.setCurrentProject(undefined); return [{ text: T.currentProjectCleared() }]; }
  const p = matchProject(ctx, token);
  if (!p) return [{ text: T.unknownProject(code(token)) }];
  await ctx.setCurrentProject(p);
  return [{ text: T.currentProjectSet(b(projectLabel(p)), code(p)) }];
}

async function cmdStatus(ctx: CommandCtx, ref?: string): Promise<Reply[]> {
  // /status            → global overview
  // /status proj       → project
  // /status proj/spec | spec → spec detail
  if (!ref) {
    if (!ctx.projects.length) return cmdProjects(ctx);
    const out: string[] = [b(T.hOverview())];
    for (const p of ctx.projects) {
      const specs = await new SpecParser(p).getAllSpecs();
      let tot = 0, done = 0, loops = 0;
      for (const s of specs) { tot += s.taskProgress?.total ?? 0; done += s.taskProgress?.completed ?? 0; if ((await getLoopStatus(p, s.name)).running) loops++; }
      out.push(`\n▸ ${b(projectLabel(p))}${loops ? `   🔄 ${loops} ${T.lRunning()}` : ''}`);
      out.push(`   ${T.lSpecs()} ${specs.length} · ${T.lTasks()} ${done}/${tot}  ${bar(done, tot)} ${pct(done, tot)}`);
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
  const parser = new SpecParser(project);
  const active = await parser.getSpec(spec);
  const s = active || (await parser.getArchivedSpec(spec));
  if (!s) return T.specNotFound(code(spec));
  const archived = !active;
  const loop = archived ? { running: false } as Awaited<ReturnType<typeof getLoopStatus>> : await getLoopStatus(project, spec);
  const tp = s.taskProgress;
  const specDir = archived ? PathUtils.getArchiveSpecPath(project, spec) : PathUtils.getSpecPath(project, spec);
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
  const ok = (e: boolean) => (e ? '✅' : '—');
  const lines = [
    `📁 ${b(projectLabel(project))} / ${b(spec)}${archived ? esc(T.archivedBadge()) : ''}`,
    '',
    `${T.lDocs()}　${T.lReq()} ${ok(s.phases.requirements.exists)}  ${T.lDesign()} ${ok(s.phases.design.exists)}  ${T.lTasksDoc()} ${ok(s.phases.tasks.exists)}`,
    tp ? `${T.lTasks()}　${counts.completed}/${counts.total}  ${bar(counts.completed, counts.total)} ${pct(counts.completed, counts.total)}` : `${T.lTasks()}　—`,
    tp ? `　　　✅ ${counts.completed}　🔄 ${counts.inProgress}　⛔ ${counts.blocked}　⬜ ${counts.pending}` : '',
    archived ? '' : `${T.lLoop()}　${loop.running ? T.loopRunning(loop.pid) : loop.stale ? T.loopStale() : T.loopIdle()}${loop.stopRequested ? ' ' + T.loopStopRequested() : ''}`,
    gates.length ? esc(T.gatesWaiting(gates.length)) : '',
    `${T.lUpdated()}　${ago(s.lastModified)}`,
  ].filter(Boolean);
  return lines.join('\n');
}

async function cmdSpecs(ctx: CommandCtx, args: string[]): Promise<Reply[]> {
  const archived = args[0]?.toLowerCase() === 'archived';
  const q = (archived ? args.slice(1) : args).join(' ').toLowerCase();
  const project = resolveProjectRef(ctx);
  if (!project) return [{ text: esc(T.needProject()) }];
  const parser = new SpecParser(project);
  let specs = archived ? await parser.getAllArchivedSpecs() : await parser.getAllSpecs();
  if (q) specs = specs.filter(s => s.name.toLowerCase().includes(q) || s.displayName.toLowerCase().includes(q));
  specs.sort((a, b2) => (b2.lastModified || '').localeCompare(a.lastModified || ''));
  if (!specs.length) return [{ text: esc(T.noSpecs(archived, q, projectLabel(project))) }];
  const rows: string[] = [];
  for (const s of specs.slice(0, 25)) {
    const tp = s.taskProgress;
    const loop = archived ? { running: false } : await getLoopStatus(project, s.name);
    rows.push(`${loop.running ? '🔄' : '▫️'} ${b(s.name)}${tp ? `\n     ${tp.completed}/${tp.total} ${bar(tp.completed, tp.total, 8)} ${pct(tp.completed, tp.total)} · ${ago(s.lastModified)}` : `\n     · ${ago(s.lastModified)}`}`);
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
  const svc = new SpecArchiveService(project);
  const loc = await svc.getSpecLocation(spec);
  const dir = loc === 'archived' ? PathUtils.getArchiveSpecPath(project, spec) : PathUtils.getSpecPath(project, spec);
  try {
    const content = await fs.readFile(join(dir, name), 'utf-8');
    return { text: '', files: [{ name: `${spec}-${name}`, content, caption: `${spec} · ${name} · ${content.length} chars` }] };
  } catch {
    return { text: `${code(name)} does not exist yet for ${code(spec)}` };
  }
}

export async function loadTasks(project: string, spec: string) {
  const file = join(PathUtils.getSpecPath(project, spec), 'tasks.md');
  const content = await fs.readFile(file, 'utf-8');
  return parseTasksFromMarkdown(content).tasks;
}

async function cmdTasks(ctx: CommandCtx, ref?: string): Promise<Reply[]> {
  const r = resolveSpecRef(ctx, ref);
  if ('error' in r) return [{ text: `❌ ${esc(r.error)}` }];
  let tasks;
  try { tasks = await loadTasks(r.project, r.spec); } catch { return [{ text: T.noTasksFile(code(r.spec)) }]; }
  const real = tasks.filter(t => !t.isHeader);
  const done = real.filter(t => t.status === 'completed').length;
  const groups: Array<[string, string]> = [
    ['in-progress', `🔄 ${T.stInProgress()}`], ['blocked', `⛔ ${T.stBlocked()}`],
    ['pending', `⬜ ${T.stPending()}`], ['completed', `✅ ${T.stCompleted()}`],
  ];
  const out = [`☑️ ${b(r.spec)}　${done}/${real.length} ${bar(done, real.length)} ${pct(done, real.length)}`];
  for (const [st, title] of groups) {
    const items = real.filter(t => t.status === st);
    if (!items.length) continue;
    out.push(`\n${title}（${items.length}）`);
    for (const t of items.slice(0, 10)) out.push(`  ${code(t.id)} ${inlineUntrusted(t.description, 70)}${t.status === 'blocked' && t.blockedReason ? `\n      ↳ ${inlineUntrusted(t.blockedReason, 60)}` : ''}`);
    if (items.length > 10) out.push(esc(T.plusMore(items.length - 10)));
  }
  out.push(esc(T.taskDetailHint(r.spec)));
  return [{ text: out.join('\n') }];
}

export async function readVerify(project: string, spec: string, taskId: string): Promise<VerifyResult | null> {
  try {
    // Path convention owned by verify-core (the journal's sole writer).
    const f = verifyResultFile(PathUtils.getSpecPath(project, spec), taskId);
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
  if (!taskId || !TASK_ID.test(taskId)) return [{ text: esc(T.usageTask()) }];
  const action = rest[0]?.toLowerCase();
  if (action) {
    const map: Record<string, ManualTaskStatus> = { start: 'in-progress', done: 'completed', block: 'blocked', reset: 'pending' };
    const status = map[action];
    if (!status) return [{ text: T.unknownAction(code(action)) }];
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
  return { text: `${b(T.hPrompt(spec, t.id))}\n${untrusted(p, 2500, 'tasks.md')}` };
}

async function cmdPrompt(ctx: CommandCtx, ref?: string, taskId?: string): Promise<Reply[]> {
  const r = resolveSpecRef(ctx, ref);
  if ('error' in r) return [{ text: `❌ ${esc(r.error)}` }];
  if (!taskId || !TASK_ID.test(taskId)) return [{ text: esc(T.usagePrompt()) }];
  return [await promptFor(r.project, r.spec, taskId)];
}

async function cmdSteering(ctx: CommandCtx, token?: string): Promise<Reply[]> {
  const project = resolveProjectRef(ctx, token);
  if (!project) return [{ text: esc(T.needProject()) }];
  const st = await new SpecParser(project).getProjectSteeringStatus();
  const key = await ctx.registerCallback({ kind: 'steer', project });
  const row: InlineKeyboardMarkup['inline_keyboard'][number] = [];
  const lines = [b(T.hSteering(projectLabel(project)))];
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
    const content = await fs.readFile(join(PathUtils.getSteeringPath(project), name), 'utf-8');
    return { text: '', files: [{ name: `steering-${name}`, content, caption: `steering · ${name}` }] };
  } catch { return { text: T.fileMissing(code(name)) }; }
}

async function cmdLogs(ctx: CommandCtx, args: string[]): Promise<Reply[]> {
  const r = resolveSpecRef(ctx, args[0]);
  if ('error' in r) return [{ text: `❌ ${esc(r.error)}` }];
  const mgr = new ImplementationLogManager(PathUtils.getSpecPath(r.project, r.spec));
  let entries;
  let extra = '';
  if (args[1]?.toLowerCase() === 'task' && args[2] && TASK_ID.test(args[2])) {
    entries = await mgr.getTaskLogs(args[2]); extra = ` · ${T.lTasks()} ${args[2]}`;
  } else {
    const n = Math.min(Math.max(parseInt(args[1] || '5', 10) || 5, 1), 20);
    entries = (await mgr.getAllLogs()).sort((a, b2) => b2.timestamp.localeCompare(a.timestamp)).slice(0, n);
  }
  if (!entries.length) return [{ text: T.noLogs(code(r.spec)) }];
  const out = [b(T.hLogs(r.spec, extra))];
  for (const e of entries) {
    out.push(`\n${code(e.taskId)} · ${ago(e.timestamp)} · +${e.statistics.linesAdded}/-${e.statistics.linesRemoved} · ${e.statistics.filesChanged} ${T.lFiles()}`);
    out.push(inlineUntrusted(e.summary, 300));
  }
  return [{ text: out.join('\n') }];
}

async function cmdLogStats(ctx: CommandCtx, ref?: string): Promise<Reply[]> {
  const r = resolveSpecRef(ctx, ref);
  if ('error' in r) return [{ text: `❌ ${esc(r.error)}` }];
  const mgr = new ImplementationLogManager(PathUtils.getSpecPath(r.project, r.spec));
  const all = await mgr.getAllLogs();
  if (!all.length) return [{ text: T.noLogs(code(r.spec)) }];
  const sum = all.reduce((a, e) => ({ add: a.add + e.statistics.linesAdded, rm: a.rm + e.statistics.linesRemoved, files: a.files + e.statistics.filesChanged }), { add: 0, rm: 0, files: 0 });
  const arts = all.reduce((a, e) => {
    for (const k of Object.keys(e.artifacts || {}) as Array<keyof typeof e.artifacts>) a[k] = (a[k] || 0) + ((e.artifacts as any)[k]?.length || 0);
    return a;
  }, {} as Record<string, number>);
  return [{ text: `${b(T.hLogStats(r.spec))}\n${T.lEntries()} ${all.length} · ${T.lTasks()} ${new Set(all.map(e => e.taskId)).size}\n+${sum.add} / -${sum.rm} · ${sum.files} ${T.lFiles()}\n${T.lArtifacts()}：${Object.entries(arts).map(([k, v]) => `${esc(k)} ${v}`).join('、') || T.lNone()}` }];
}

async function cmdFind(ctx: CommandCtx, args: string[]): Promise<Reply[]> {
  const [type, ...terms] = args;
  const term = terms.join(' ');
  const project = resolveProjectRef(ctx);
  if (!project) return [{ text: esc(T.needProject()) }];
  if (!type || !term) return [{ text: esc(T.usageFind()) }];
  const specs = await new SpecParser(project).getAllSpecs();
  const out: string[] = [];
  for (const s of specs) {
    const mgr = new ImplementationLogManager(PathUtils.getSpecPath(project, s.name));
    const hits = await mgr.findArtifact(type, term);
    for (const h of hits.slice(0, 5)) out.push(`${code(s.name)} · task ${esc(h.log.taskId)} · ${untrusted(JSON.stringify(h.artifact), 200, type)}`);
    if (out.length > 15) break;
  }
  return [{ text: out.length ? `${b(T.hFind(type, term))}\n${out.join('\n')}` : esc(T.nothingFound(type, term)) }];
}

async function cmdGates(ctx: CommandCtx): Promise<Reply[]> {
  const out: string[] = [];
  for (const p of ctx.projects) {
    const specs = await new SpecParser(p).getAllSpecs();
    for (const s of specs) {
      for (const g of await listPendingGates(p, s.name)) out.push(`⏸ ${b(projectLabel(p))}/${b(s.name)} · ${esc(g.kind)} · ${ago(g.createdAt)} · ${code(g.id)}`);
    }
  }
  return [{ text: out.length ? `${b(T.hGates())}\n${out.join('\n')}\n${T.gatesFooter()}` : T.noGates() }];
}

async function cmdRunlog(ctx: CommandCtx, ref?: string, nRaw?: string): Promise<Reply[]> {
  const r = resolveSpecRef(ctx, ref);
  if ('error' in r) return [{ text: `❌ ${esc(r.error)}` }];
  const n = Math.min(Math.max(parseInt(nRaw || '20', 10) || 20, 1), 200);
  const lines = await tailAudit(r.project, n, r.spec);
  if (!lines.length) return [{ text: T.noAudit(code(r.spec)) }];
  return [{ text: `${b(T.hAudit(r.spec, lines.length))}\n${untrusted(lines.join('\n'), 2800, 'loop-audit.log')}` }];
}

// -------------------------------------------------------------- control commands

async function cmdStartLoop(ctx: CommandCtx, args: string[]): Promise<Reply[]> {
  const r = resolveSpecRef(ctx, args[0]);
  if ('error' in r) return [{ text: `❌ ${esc(r.error)}` }];
  // Explicit: this is the child process's real cwd, not a .spec-workflow path,
  // so it does not go through the translating accessors.
  const project = PathUtils.translatePath(r.project);
  const runner = join(PathUtils.getWorkflowRoot(project), 'spec-loop-run.sh');
  try { await fs.access(runner); } catch { return [{ text: esc(T.noRunner(projectLabel(r.project))) }]; }
  const loop = await getLoopStatus(r.project, r.spec);
  if (loop.running) return [{ text: T.loopAlreadyRunning(code(r.spec), loop.pid) }];
  const logDir = join(PathUtils.getSpecPath(project, r.spec));
  await fs.mkdir(logDir, { recursive: true });
  const outFile = await fs.open(join(logDir, 'loop-run.stdout'), 'a');
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^TELEGRAM_|^GATE_SECRET$/.test(k)));
  const child = spawn('bash', [runner, r.spec], { cwd: project, detached: true, stdio: ['ignore', outFile.fd, outFile.fd], env });
  child.unref();
  await outFile.close();
  return [{ text: esc(T.loopStarted(r.spec, projectLabel(r.project), child.pid)) }];
}

async function cmdStop(ctx: CommandCtx, ref?: string): Promise<Reply[]> {
  const r = resolveSpecRef(ctx, ref);
  if ('error' in r) return [{ text: `❌ ${esc(r.error)}` }];
  const loop = await getLoopStatus(r.project, r.spec);
  const req = await requestLoopStop(r.project, r.spec, `tg:${ctx.userId}`);
  return [{ text: loop.running
    ? `${esc(T.stopRequested(r.spec, loop.pid))} · ${code(req.nonce.slice(0, 8))}`
    : esc(T.stopNotRunning(r.spec)) }];
}

async function cmdArchive(ctx: CommandCtx, ref: string | undefined, archive: boolean): Promise<Reply[]> {
  const r = resolveSpecRef(ctx, ref);
  if ('error' in r) return [{ text: `❌ ${esc(r.error)}` }];
  const loc = await specExists(r.project, r.spec);
  if (archive && loc !== 'active') return [{ text: T.notActiveSpec(code(r.spec)) }];
  if (!archive && loc !== 'archived') return [{ text: T.notArchived(code(r.spec)) }];
  if (archive && (await getLoopStatus(r.project, r.spec)).running) return [{ text: T.loopBlocksArchive(code(r.spec)) }];
  const key = await ctx.registerCallback({ kind: 'arch', project: r.project, spec: r.spec, flag: archive ? '1' : '0' });
  return [{ text: T.confirmArchive(archive, b(r.spec), esc(projectLabel(r.project))), keyboard: { inline_keyboard: [[{ text: T.btnArchive(archive), callback_data: `a:${key}:y` }, { text: T.btnCancel(), callback_data: `a:${key}:n` }]] } }];
}

/** Plain-text result (no HTML) — callers render/escape; the audit log stores it verbatim. */
export async function doArchive(project: string, spec: string, archive: boolean): Promise<string> {
  const svc = new SpecArchiveService(project);
  if (archive) await svc.archiveSpec(spec); else await svc.unarchiveSpec(spec);
  return T.archiveDone(archive, spec);
}

async function cmdCleanup(ctx: CommandCtx, args: string[]): Promise<Reply[]> {
  const project = resolveProjectRef(ctx);
  if (!project) return [{ text: esc(T.needProject()) }];
  const days = parseInt(args[0] || '', 10);
  if (!Number.isFinite(days) || days < 0) return [{ text: esc(T.usageCleanup()) }];
  const archived = args[1]?.toLowerCase() === 'archived';
  const dry = await cleanupSpecs(project, { daysOld: days, archived, dryRun: true });
  if (!dry.candidates.length) return [{ text: esc(T.cleanupNothing(days, archived, projectLabel(project), dry.processed)) }];
  const key = await ctx.registerCallback({ kind: 'clean', project, num: days, flag: archived ? '1' : '0' });
  const list = dry.candidates.slice(0, 20).map(c => `• ${code(c.name)} (${ago(c.createdAt)})`).join('\n');
  return [{ text: T.cleanupConfirm(dry.candidates.length, days, archived, esc(projectLabel(project)), list, dry.candidates.length > 20), keyboard: { inline_keyboard: [[{ text: T.btnDelete(dry.candidates.length), callback_data: `c:${key}:y` }, { text: T.btnCancel(), callback_data: `c:${key}:n` }]] } }];
}

export async function doCleanup(project: string, days: number, archived: boolean): Promise<string> {
  const r = await cleanupSpecs(project, { daysOld: days, archived, dryRun: false });
  return esc(T.cleanupDone(r.deleted, r.failed.length));
}
