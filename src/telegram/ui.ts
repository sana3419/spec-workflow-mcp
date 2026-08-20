import { promises as fs } from 'fs';
import { join } from 'path';
import { SpecParser } from '../core/parser.js';
import { PathUtils } from '../core/path-utils.js';
import { getLoopStatus } from '../core/run-state.js';
import { listPendingGates } from '../core/gates.js';
import { ImplementationLogManager } from '../core/implementation-log-manager.js';
import { cleanupSpecs } from '../core/cleanup.js';
import { tailAudit } from '../core/run-watcher.js';
import { listWatchers } from '../core/requests.js';
import { getProjectState } from '../core/project-state.js';
import { esc, b, code, ago, bar, pct, inlineUntrusted, untrusted, statusIcon, shortPath } from './render.js';
import { T } from './strings.js';
import { projectLabel, specStatusText, loadTasks, readVerify, specExists, Reply, CommandCtx } from './commands.js';
import type { InlineKeyboardButton, InlineKeyboardMarkup } from './api.js';

/**
 * Button-driven UI ("tabs"): one message that navigates in place, instead of typed commands.
 *
 * Every button carries `n:<key>`; the key resolves (via the daemon's cbKeys state) to a NavState —
 * callback_data is capped at 64 bytes, so the state never travels in the button itself. Screens are
 * pure: (nav, deps) → {text, keyboard}. The daemon edits the current message with the new screen,
 * which is what makes it feel like tabs rather than a chat log.
 *
 * Typed commands still work (handleCommand) — this is the primary surface, not the only one.
 */

export type Screen =
  | 'home' | 'projects' | 'specs' | 'spec' | 'tasks' | 'task' | 'logs' | 'runlog'
  | 'gates' | 'docs' | 'steering' | 'more' | 'cleanup' | 'help'
  | 'new-spec' | 'new-project' | 'windows' | 'components';

export interface NavState {
  s: Screen;
  project?: string;
  spec?: string;
  taskId?: string;
  /** list page (0-based) */
  pg?: number;
  /** spec list: show archived */
  arch?: boolean;
  /** cleanup: days */
  days?: number;
  /** windows screen: watcher id to pin/unpin */
  watcher?: string;
}

export interface UiDeps {
  ctx: CommandCtx;
  /** register a nav target, returns the short callback key */
  nav(state: NavState): Promise<string>;
  /** watcher id this chat currently addresses work to (if any) */
  pinnedWatcher?: string;
}

const PAGE = 8;

const row = (...btns: InlineKeyboardButton[]) => btns;
const kb = (rows: InlineKeyboardButton[][]): InlineKeyboardMarkup => ({ inline_keyboard: rows.filter(r => r.length) });

async function navBtn(d: UiDeps, text: string, state: NavState): Promise<InlineKeyboardButton> {
  return { text, callback_data: `n:${await d.nav(state)}` };
}

/** Tab strip shown on every spec screen so switching views is one tap. */
async function specTabs(d: UiDeps, project: string, spec: string, active: Screen): Promise<InlineKeyboardButton[]> {
  const mark = (s: Screen, label: string) => (s === active ? `· ${label} ·` : label);
  return [
    await navBtn(d, mark('spec', T.tabOverview()), { s: 'spec', project, spec }),
    await navBtn(d, mark('tasks', T.tabTasks()), { s: 'tasks', project, spec, pg: 0 }),
    await navBtn(d, mark('docs', T.tabDocs()), { s: 'docs', project, spec }),
    await navBtn(d, mark('logs', T.tabLogs()), { s: 'logs', project, spec }),
  ];
}

function currentProject(d: UiDeps, nav: NavState): string | undefined {
  return nav.project || d.ctx.currentProject || (d.ctx.projects.length === 1 ? d.ctx.projects[0] : undefined);
}

export async function renderScreen(nav: NavState, d: UiDeps): Promise<Reply> {
  switch (nav.s) {
    case 'home': return screenHome(d);
    case 'projects': return screenProjects(d, nav);
    case 'specs': return screenSpecs(d, nav);
    case 'spec': return screenSpec(d, nav);
    case 'tasks': return screenTasks(d, nav);
    case 'task': return screenTask(d, nav);
    case 'docs': return screenDocs(d, nav);
    case 'logs': return screenLogs(d, nav);
    case 'runlog': return screenRunlog(d, nav);
    case 'gates': return screenGates(d);
    case 'steering': return screenSteering(d, nav);
    case 'more': return screenMore(d, nav);
    case 'cleanup': return screenCleanup(d, nav);
    case 'new-spec': return { text: T.askNewSpec(), keyboard: kb([[await navBtn(d, T.btnBack(), { s: 'specs', project: nav.project, pg: 0 })]]) };
    case 'new-project': return { text: T.askNewProject(), keyboard: kb([[await navBtn(d, T.btnBack(), { s: 'home' })]]) };
    case 'windows': return screenWindows(d);
    case 'components': return screenComponents(d, nav);
    case 'help': return { text: T.help(), keyboard: kb([[await navBtn(d, T.btnHome(), { s: 'home' })]]) };
    default: return screenHome(d);
  }
}

// ---------------------------------------------------------------- home

async function screenHome(d: UiDeps): Promise<Reply> {
  const lines = [b(T.hHome()), ''];
  const live = await listWatchers();
  const windows = live.length;
  let gates = 0, running = 0;
  for (const p of d.ctx.projects) {
    const specs = await new SpecParser(p).getAllSpecs();
    let tot = 0, done = 0;
    for (const s of specs) {
      tot += s.taskProgress?.total ?? 0; done += s.taskProgress?.completed ?? 0;
      if ((await getLoopStatus(p, s.name)).running) running++;
      gates += (await listPendingGates(p, s.name)).length;
    }
    const cur = p === d.ctx.currentProject ? '▶️' : '▫️';
    const newest = specs.map(s => s.lastModified || '').sort().pop();
    lines.push(`${cur} ${b(projectLabel(p))}　${T.lSpecs()} ${specs.length} · ${done}/${tot} ${bar(done, tot, 8)} ${pct(done, tot)}`);
    if (newest) lines.push(`     ${T.lUpdated()} ${ago(newest)}`);
  }
  if (!d.ctx.projects.length) lines.push(esc(T.noProjects()));
  if (running) lines.push('', `🔄 ${running} ${T.lRunning()}`);
  if (gates) lines.push(`⏸ ${esc(T.gatesWaitingShort(gates))}`);
  const pinnedLabel = live.find(w => w.id === d.pinnedWatcher)?.label;
  if (pinnedLabel) lines.push(T.windowPinned(esc(pinnedLabel)));

  const project = d.ctx.currentProject || (d.ctx.projects.length === 1 ? d.ctx.projects[0] : undefined);
  return {
    text: lines.join('\n'),
    keyboard: kb([
      row(await navBtn(d, T.tabSpecs(), { s: 'specs', project, pg: 0 }), await navBtn(d, T.tabProjects(), { s: 'projects' })),
      row(await navBtn(d, gates ? `⏸ ${T.tabGates()} (${gates})` : T.tabGates(), { s: 'gates' }), await navBtn(d, T.tabMore(), { s: 'more', project })),
      row(await navBtn(d, T.btnNewSpec(), { s: 'new-spec', project }), await navBtn(d, T.btnNewProject(), { s: 'new-project' })),
      row(await navBtn(d, `${T.tabWindows()}${windows ? ` (${windows})` : ''}`, { s: 'windows' }), await navBtn(d, T.btnRefresh(), { s: 'home' })),
    ]),
  };
}

// ---------------------------------------------------------------- components (what this project has)

async function screenComponents(d: UiDeps, nav: NavState): Promise<Reply> {
  const project = currentProject(d, nav);
  if (!project) return screenProjects(d, nav);
  const lines = [b(T.hComponents(projectLabel(project))), ''];

  const state = await getProjectState(project);
  lines.push(esc(T.projectStateLabel(state?.status ?? 'unknown')));
  if (state?.status === 'pending') lines.push(esc(T.projectPending()));
  lines.push('');

  // MCP servers come from the project's own .mcp.json — the file the picker writes.
  const servers: string[] = [];
  try {
    const raw = JSON.parse(await fs.readFile(join(project, '.mcp.json'), 'utf-8'));
    for (const [name, cfg] of Object.entries(raw.mcpServers ?? {})) {
      const c = cfg as { command?: string; url?: string; args?: string[] };
      servers.push(`${name} ${c.url ? '(http)' : `(${[c.command, ...(c.args ?? [])].join(' ').slice(0, 46)})`}`);
    }
  } catch { /* none */ }
  lines.push(`<b>${T.compMcp()}</b> (${servers.length})`);
  lines.push(servers.length ? servers.map(x => `  · ${esc(x)}`).join('\n') : `  ${T.compNone()}`);

  const listDir = async (dir: string) => {
    try { return (await fs.readdir(join(project, '.claude', dir), { withFileTypes: true })).filter(e => e.isDirectory() || e.name.endsWith('.md')).map(e => e.name.replace(/\.md$/, '')); }
    catch { return [] as string[]; }
  };
  const skills = await listDir('skills'), agents = await listDir('agents');
  lines.push('', `<b>${T.compSkills()}</b> (${skills.length})`, skills.length ? `  ${esc(skills.join('、'))}` : `  ${T.compNone()}`);
  lines.push('', `<b>${T.compAgents()}</b> (${agents.length})`);
  lines.push(agents.length ? `  ${esc(agents.slice(0, 12).join('、'))}${agents.length > 12 ? ` … +${agents.length - 12}` : ''}` : `  ${T.compNone()}`);
  lines.push('', esc(T.compHint()));

  return {
    text: lines.join('\n'),
    keyboard: kb([
      row(await navBtn(d, T.btnRefresh(), { s: 'components', project }), await navBtn(d, T.btnBack(), { s: 'more', project }), await navBtn(d, T.btnHome(), { s: 'home' })),
    ]),
  };
}

// ---------------------------------------------------------------- windows (listening sessions)

async function screenWindows(d: UiDeps): Promise<Reply> {
  const live = await listWatchers();          // already newest-heartbeat-first
  const lines = [b(T.hWindows()), ''];
  const rows: InlineKeyboardButton[][] = [];
  if (!live.length) lines.push(esc(T.noWindows()));
  for (const w of live) {
    const pinned = w.id === d.pinnedWatcher;
    const scope = w.projects.length ? w.projects.map(p => projectLabel(p)).join(', ') : T.windowScopeAll();
    lines.push(T.windowRow(pinned, b(w.label), esc(scope), ago(w.lastActiveAt ?? w.lastSeen), w.note ? esc(w.note) : esc(T.windowNoNote())));
    rows.push(row(await navBtn(d, `${pinned ? '📌 ' : ''}${plain(w.label, 28)}`, { s: 'windows', watcher: w.id })));
  }
  lines.push('', esc(T.windowsHint()));
  rows.push(row(await navBtn(d, T.btnRefresh(), { s: 'windows' }), await navBtn(d, T.btnHome(), { s: 'home' })));
  return { text: lines.join('\n'), keyboard: kb(rows) };
}

// ---------------------------------------------------------------- projects

async function screenProjects(d: UiDeps, nav: NavState): Promise<Reply> {
  const rows: InlineKeyboardButton[][] = [];
  const lines = [b(T.hProjects()), ''];
  for (const p of d.ctx.projects) {
    const specs = await new SpecParser(p).getAllSpecs();
    const cur = p === d.ctx.currentProject;
    lines.push(`${cur ? '▶️' : '▫️'} ${b(projectLabel(p))}　${specs.length} ${T.lSpecs()}\n     ${code(shortPath(p))}`);
    rows.push(row(await navBtn(d, `${cur ? '▶️ ' : ''}${projectLabel(p)}`, { s: 'specs', project: p, pg: 0 })));
  }
  if (!d.ctx.projects.length) lines.push(esc(T.noProjects()));
  rows.push(row(await navBtn(d, T.btnNewProject(), { s: 'new-project' })));
  rows.push(row(await navBtn(d, T.btnHome(), { s: 'home' })));
  return { text: lines.join('\n'), keyboard: kb(rows) };
}

// ---------------------------------------------------------------- spec list

async function screenSpecs(d: UiDeps, nav: NavState): Promise<Reply> {
  const project = currentProject(d, nav);
  if (!project) return screenProjects(d, nav);
  const parser = new SpecParser(project);
  const archived = !!nav.arch;
  const specs = (archived ? await parser.getAllArchivedSpecs() : await parser.getAllSpecs())
    .sort((a, b2) => (b2.lastModified || '').localeCompare(a.lastModified || ''));
  const page = nav.pg ?? 0;
  const slice = specs.slice(page * PAGE, page * PAGE + PAGE);

  const lines = [b(T.hSpecs(archived, projectLabel(project))), ''];
  const rows: InlineKeyboardButton[][] = [];
  for (const s of slice) {
    const tp = s.taskProgress;
    const loop = archived ? { running: false } : await getLoopStatus(project, s.name);
    lines.push(`${loop.running ? '🔄' : '▫️'} ${b(s.name)}${tp ? `　${tp.completed}/${tp.total} ${bar(tp.completed, tp.total, 8)}` : ''} · ${ago(s.lastModified)}`);
    rows.push(row(await navBtn(d, `${loop.running ? '🔄 ' : ''}${s.name}`, { s: 'spec', project, spec: s.name })));
  }
  if (!specs.length) lines.push(esc(T.noSpecs(archived, '', projectLabel(project))));

  const pager: InlineKeyboardButton[] = [];
  if (page > 0) pager.push(await navBtn(d, T.btnPrev(), { ...nav, s: 'specs', project, pg: page - 1 }));
  if (specs.length > (page + 1) * PAGE) pager.push(await navBtn(d, T.btnNext(), { ...nav, s: 'specs', project, pg: page + 1 }));
  rows.push(pager);
  rows.push(row(await navBtn(d, T.btnNewSpec(), { s: 'new-spec', project })));
  rows.push(row(
    await navBtn(d, archived ? T.btnShowActive() : T.btnShowArchived(), { s: 'specs', project, pg: 0, arch: !archived }),
    await navBtn(d, T.btnHome(), { s: 'home' }),
  ));
  return { text: lines.join('\n'), keyboard: kb(rows) };
}

// ---------------------------------------------------------------- spec overview

async function screenSpec(d: UiDeps, nav: NavState): Promise<Reply> {
  const project = currentProject(d, nav)!, spec = nav.spec!;
  const text = await specStatusText(project, spec);
  const loop = await getLoopStatus(project, spec);
  const loc = await specExists(project, spec);
  const gates = await listPendingGates(project, spec);

  const actions: InlineKeyboardButton[] = [];
  if (loc === 'active') {
    actions.push(loop.running
      ? await navBtn(d, T.btnStopLoop(), { s: 'spec', project, spec, taskId: '__stop' })
      : await navBtn(d, T.btnStartLoop(), { s: 'spec', project, spec, taskId: '__start' }));
  }
  const rows = [
    await specTabs(d, project, spec, 'spec'),
    actions,
    row(
      gates.length ? await navBtn(d, `⏸ ${T.tabGates()} (${gates.length})`, { s: 'gates' }) : await navBtn(d, T.btnRefresh(), { s: 'spec', project, spec }),
      await navBtn(d, T.btnBackSpecs(), { s: 'specs', project, pg: 0 }),
      await navBtn(d, T.btnHome(), { s: 'home' }),
    ),
  ];
  return { text, keyboard: kb(rows) };
}

// ---------------------------------------------------------------- tasks

async function screenTasks(d: UiDeps, nav: NavState): Promise<Reply> {
  const project = currentProject(d, nav)!, spec = nav.spec!;
  let tasks;
  try { tasks = await loadTasks(project, spec); } catch { return { text: T.noTasksFile(code(spec)), keyboard: kb([await specTabs(d, project, spec, 'tasks')]) }; }
  const real = tasks.filter(t => !t.isHeader);
  const done = real.filter(t => t.status === 'completed').length;
  const page = nav.pg ?? 0;
  // Unfinished first — that is what a human is looking for on a phone.
  const order = { 'in-progress': 0, blocked: 1, pending: 2, completed: 3 } as Record<string, number>;
  const sorted = [...real].sort((a, b2) => (order[a.status] ?? 9) - (order[b2.status] ?? 9) || a.id.localeCompare(b2.id, undefined, { numeric: true }));
  const slice = sorted.slice(page * PAGE, page * PAGE + PAGE);

  const lines = [`☑️ ${b(spec)}　${done}/${real.length} ${bar(done, real.length)} ${pct(done, real.length)}`, ''];
  const rows: InlineKeyboardButton[][] = [];
  for (const t of slice) {
    lines.push(`${statusIcon(t.status)} ${code(t.id)} ${inlineUntrusted(t.description, 60)}`);
    rows.push(row(await navBtn(d, `${statusIcon(t.status)} ${t.id}  ${plain(t.description, 24)}`, { s: 'task', project, spec, taskId: t.id, pg: page })));
  }
  const pager: InlineKeyboardButton[] = [];
  if (page > 0) pager.push(await navBtn(d, T.btnPrev(), { s: 'tasks', project, spec, pg: page - 1 }));
  if (sorted.length > (page + 1) * PAGE) pager.push(await navBtn(d, T.btnNext(), { s: 'tasks', project, spec, pg: page + 1 }));
  rows.push(pager);
  rows.push(await specTabs(d, project, spec, 'tasks'));
  rows.push(row(await navBtn(d, T.btnBackSpecs(), { s: 'specs', project, pg: 0 }), await navBtn(d, T.btnHome(), { s: 'home' })));
  return { text: lines.join('\n'), keyboard: kb(rows) };
}

/** Button labels cannot carry HTML — strip tags/entities and clamp. */
function plain(s: string, max: number): string {
  const t = String(s ?? '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

// ---------------------------------------------------------------- task detail

async function screenTask(d: UiDeps, nav: NavState): Promise<Reply> {
  const project = currentProject(d, nav)!, spec = nav.spec!, taskId = nav.taskId!;
  let tasks;
  try { tasks = await loadTasks(project, spec); } catch { return { text: T.noTasksFile(code(spec)) }; }
  const t = tasks.find(x => x.id === taskId);
  if (!t) return { text: T.taskNotFound(code(taskId), code(spec)) };
  const v = await readVerify(project, spec, taskId);
  const loop = await getLoopStatus(project, spec);
  const statusWord = { completed: T.stCompleted(), 'in-progress': T.stInProgress(), blocked: T.stBlocked(), pending: T.stPending() }[t.status] ?? t.status;

  const lines = [
    `${statusIcon(t.status)} ${b(`${spec} · ${T.lTasks()} ${t.id}`)}　${esc(statusWord)}`,
    inlineUntrusted(t.description, 300),
  ];
  const meta: string[] = [];
  if (t.engine) meta.push(`${T.lEngine()} ${code(t.engine)}`);
  if (t.tests) meta.push(`${T.lTests()} ${code(t.tests)}`);
  if (t.requirements?.length) meta.push(`${T.lReqs()} ${esc(t.requirements.join(', '))}`);
  if (meta.length) lines.push('', meta.join('　'));
  if (t.status === 'blocked' && t.blockedReason) lines.push(`⛔ ${inlineUntrusted(t.blockedReason, 200)}`);
  if (v) {
    const parts = [
      v.lastSignal === 'green' ? T.vGreen() : v.lastSignal === 'red' ? T.vRed() : '—',
      v.exitCode !== undefined ? T.vExit(v.exitCode) : '',
      v.failureClass ? T.vClass(esc(v.failureClass)) : '',
      v.fixAttempts ? T.vFix(v.fixAttempts) : '',
      v.judge ? T.vJudge(esc(v.judge.verdict), esc(v.judge.engine)) : '',
    ].filter(Boolean);
    lines.push('', `🧪 ${parts.join(' · ')} · ${ago(v.lastTimestamp)}`);
    if (v.lastSignal === 'red' && v.lastFixNote) lines.push(untrusted(v.lastFixNote, 400, T.lastFailureLabel()));
  }
  if (loop.running) lines.push('', esc(T.loopLocksEdit(spec)));

  const acts: InlineKeyboardButton[] = [];
  if (!loop.running) {
    if (t.status !== 'in-progress') acts.push({ text: T.btnStart(), callback_data: `t:${await d.ctx.registerCallback({ kind: 'task', project, spec, taskId })}:s` });
    if (t.status !== 'completed') acts.push({ text: T.btnDone(), callback_data: `t:${await d.ctx.registerCallback({ kind: 'task', project, spec, taskId })}:c` });
    if (t.status !== 'blocked') acts.push({ text: T.btnBlock(), callback_data: `t:${await d.ctx.registerCallback({ kind: 'task', project, spec, taskId })}:b` });
    if (t.status !== 'pending') acts.push({ text: T.btnReset(), callback_data: `t:${await d.ctx.registerCallback({ kind: 'task', project, spec, taskId })}:p` });
  }
  return {
    text: lines.join('\n'),
    keyboard: kb([
      acts,
      (!loop.running && (t.status === 'pending' || t.status === 'in-progress'))
        ? row(await navBtn(d, T.btnDispatchTask(), { s: 'task', project, spec, taskId, days: 1 }))
        : [],
      row(
        { text: T.btnPrompt(), callback_data: `t:${await d.ctx.registerCallback({ kind: 'task', project, spec, taskId })}:q` },
        await navBtn(d, T.btnRefresh(), { s: 'task', project, spec, taskId, pg: nav.pg }),
      ),
      row(await navBtn(d, T.btnBackTasks(), { s: 'tasks', project, spec, pg: nav.pg ?? 0 }), await navBtn(d, T.btnHome(), { s: 'home' })),
    ]),
  };
}

// ---------------------------------------------------------------- docs

async function screenDocs(d: UiDeps, nav: NavState): Promise<Reply> {
  const project = currentProject(d, nav)!, spec = nav.spec!;
  const parser = new SpecParser(project);
  const s = (await parser.getSpec(spec)) || (await parser.getArchivedSpec(spec));
  const key = await d.ctx.registerCallback({ kind: 'doc', project, spec });
  const lines = [`📄 ${b(spec)} · ${T.lDocs()}`, '', esc(T.docsHint())];
  const docs: InlineKeyboardButton[] = [];
  if (s?.phases.requirements.exists) docs.push({ text: T.btnRequirements(), callback_data: `d:${key}:r` });
  if (s?.phases.design.exists) docs.push({ text: T.btnDesign(), callback_data: `d:${key}:d` });
  if (s?.phases.tasks.exists) docs.push({ text: T.btnTasks(), callback_data: `d:${key}:t` });
  if (!docs.length) lines.push('', esc(T.noDocs()));
  return {
    text: lines.join('\n'),
    keyboard: kb([
      docs,
      await specTabs(d, project, spec, 'docs'),
      row(await navBtn(d, T.btnBackSpecs(), { s: 'specs', project, pg: 0 }), await navBtn(d, T.btnHome(), { s: 'home' })),
    ]),
  };
}

// ---------------------------------------------------------------- logs

async function screenLogs(d: UiDeps, nav: NavState): Promise<Reply> {
  const project = currentProject(d, nav)!, spec = nav.spec!;
  const mgr = new ImplementationLogManager(PathUtils.getSpecPath(project, spec));
  const all = (await mgr.getAllLogs()).sort((a, b2) => b2.timestamp.localeCompare(a.timestamp));
  const lines = [b(T.hLogs(spec, '')), ''];
  if (!all.length) lines.push(esc(T.noLogs(spec)));
  for (const e of all.slice(0, 5)) {
    lines.push(`${code(e.taskId)} · ${ago(e.timestamp)} · +${e.statistics.linesAdded}/-${e.statistics.linesRemoved} · ${e.statistics.filesChanged} ${T.lFiles()}`);
    lines.push(`   ${inlineUntrusted(e.summary, 160)}`);
  }
  return {
    text: lines.join('\n'),
    keyboard: kb([
      row(await navBtn(d, T.btnRunlog(), { s: 'runlog', project, spec })),
      await specTabs(d, project, spec, 'logs'),
      row(await navBtn(d, T.btnBackSpecs(), { s: 'specs', project, pg: 0 }), await navBtn(d, T.btnHome(), { s: 'home' })),
    ]),
  };
}

async function screenRunlog(d: UiDeps, nav: NavState): Promise<Reply> {
  const project = currentProject(d, nav)!, spec = nav.spec!;
  const lines = await tailAudit(project, 20, spec);
  return {
    text: lines.length ? `${b(T.hAudit(spec, lines.length))}\n${untrusted(lines.join('\n'), 2500, 'loop-audit.log')}` : T.noAudit(code(spec)),
    keyboard: kb([
      row(await navBtn(d, T.btnRefresh(), { s: 'runlog', project, spec })),
      await specTabs(d, project, spec, 'logs'),
      row(await navBtn(d, T.btnHome(), { s: 'home' })),
    ]),
  };
}

// ---------------------------------------------------------------- gates

async function screenGates(d: UiDeps): Promise<Reply> {
  const lines = [b(T.hGates()), ''];
  let n = 0;
  for (const p of d.ctx.projects) {
    for (const s of await new SpecParser(p).getAllSpecs()) {
      for (const g of await listPendingGates(p, s.name)) {
        n++;
        lines.push(`⏸ ${b(projectLabel(p))}/${b(s.name)} · ${esc(g.kind)} · ${ago(g.createdAt)}`);
      }
    }
  }
  if (!n) lines.push(T.noGates());
  else lines.push('', T.gatesFooter());
  return { text: lines.join('\n'), keyboard: kb([row(await navBtn(d, T.btnRefresh(), { s: 'gates' }), await navBtn(d, T.btnHome(), { s: 'home' }))]) };
}

// ---------------------------------------------------------------- steering / more / cleanup

async function screenSteering(d: UiDeps, nav: NavState): Promise<Reply> {
  const project = currentProject(d, nav)!;
  const st = await new SpecParser(project).getProjectSteeringStatus();
  const key = await d.ctx.registerCallback({ kind: 'steer', project });
  const lines = [b(T.hSteering(projectLabel(project))), ''];
  const btns: InlineKeyboardButton[] = [];
  for (const doc of ['product', 'tech', 'structure'] as const) {
    const ok = st.documents[doc];
    lines.push(`${ok ? '✅' : '—'} ${doc}.md`);
    if (ok) btns.push({ text: `📄 ${doc}`, callback_data: `s:${key}:${doc[0]}` });
  }
  return { text: lines.join('\n'), keyboard: kb([btns, row(await navBtn(d, T.btnBack(), { s: 'more', project }), await navBtn(d, T.btnHome(), { s: 'home' }))]) };
}

async function screenMore(d: UiDeps, nav: NavState): Promise<Reply> {
  const project = currentProject(d, nav);
  return {
    text: `${b(T.hMore())}\n\n${esc(T.moreHint())}`,
    keyboard: kb([
      row(await navBtn(d, T.tabSteering(), { s: 'steering', project }), await navBtn(d, T.tabComponents(), { s: 'components', project })),
      row(await navBtn(d, T.tabCleanup(), { s: 'cleanup', project }), await navBtn(d, T.tabHelp(), { s: 'help' })),
      row(await navBtn(d, T.btnHome(), { s: 'home' })),
    ]),
  };
}

async function screenCleanup(d: UiDeps, nav: NavState): Promise<Reply> {
  const project = currentProject(d, nav);
  if (!project) return screenProjects(d, nav);
  const days = nav.days;
  if (days === undefined) {
    return {
      text: `${b(T.hCleanup())}\n\n${esc(T.cleanupPick())}`,
      keyboard: kb([
        row(await navBtn(d, '30d', { s: 'cleanup', project, days: 30 }), await navBtn(d, '90d', { s: 'cleanup', project, days: 90 }), await navBtn(d, '180d', { s: 'cleanup', project, days: 180 })),
        row(await navBtn(d, T.btnBack(), { s: 'more', project }), await navBtn(d, T.btnHome(), { s: 'home' })),
      ]),
    };
  }
  const dry = await cleanupSpecs(project, { daysOld: days, dryRun: true });
  if (!dry.candidates.length) {
    return { text: esc(T.cleanupNothing(days, false, projectLabel(project), dry.processed)), keyboard: kb([row(await navBtn(d, T.btnBack(), { s: 'cleanup', project }), await navBtn(d, T.btnHome(), { s: 'home' }))]) };
  }
  const list = dry.candidates.slice(0, 20).map(c => `• ${code(c.name)}（${ago(c.createdAt)}）`).join('\n');
  const key = await d.ctx.registerCallback({ kind: 'clean', project, num: days, flag: '0' });
  return {
    text: T.cleanupConfirm(dry.candidates.length, days, false, esc(projectLabel(project)), list, dry.candidates.length > 20),
    keyboard: kb([
      row({ text: T.btnDelete(dry.candidates.length), callback_data: `c:${key}:y` }, { text: T.btnCancel(), callback_data: `c:${key}:n` }),
      row(await navBtn(d, T.btnBack(), { s: 'cleanup', project }), await navBtn(d, T.btnHome(), { s: 'home' })),
    ]),
  };
}

/** "Run just this task" is an action on the task screen, flagged with days:1 (no other meaning there). */
export function isDispatch(nav: NavState): boolean { return nav.s === 'task' && nav.days === 1; }

/** Loop start/stop are actions, not screens — the spec screen encodes them in `taskId`. */
export function loopActionOf(nav: NavState): 'start' | 'stop' | null {
  if (nav.s !== 'spec') return null;
  if (nav.taskId === '__start') return 'start';
  if (nav.taskId === '__stop') return 'stop';
  return null;
}

export async function specHasLogs(project: string, spec: string): Promise<boolean> {
  try { return (await fs.readdir(join(PathUtils.getSpecPath(project, spec), 'Implementation Logs'))).length > 0; } catch { return false; }
}
