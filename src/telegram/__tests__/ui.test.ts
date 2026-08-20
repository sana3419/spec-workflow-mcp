import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Isolate the watcher registry from the machine's real ~/.spec-workflow (a live daemon/monitor there
// would otherwise leak into the window-list assertions).
const home = join(tmpdir(), `swmcp-ui-home-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
vi.mock('os', async (orig) => {
  const real = await orig<typeof import('os')>();
  return { ...real, homedir: () => home };
});

const { renderScreen } = await import('../ui.js');
type NavState = import('../ui.js').NavState;
type UiDeps = import('../ui.js').UiDeps;
type CommandCtx = import('../commands.js').CommandCtx;
const { T } = await import('../strings.js');

/**
 * The button UI is the primary surface, so these tests assert the things a user would notice:
 * every screen is reachable, every button resolves to a screen, nothing exceeds Telegram's
 * callback_data cap, and button labels never leak HTML.
 */

let root: string;
const navs = new Map<string, NavState>();

const ctx = (): CommandCtx => ({
  userId: 42, chatId: 42, projects: [root], currentProject: root,
  setCurrentProject: async () => {}, registerCallback: async () => 'cb01cb01', version: 'test',
});
const deps = (): UiDeps => ({
  ctx: ctx(),
  nav: async (s) => { const k = `k${navs.size}`; navs.set(k, s); return k; },
});

beforeEach(async () => {
  navs.clear();
  root = join(tmpdir(), `swmcp-ui-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
  const spec = join(root, '.spec-workflow', 'specs', 'auth');
  await fs.mkdir(spec, { recursive: true });
  await fs.writeFile(join(spec, 'requirements.md'), '# req\n');
  await fs.writeFile(join(spec, 'tasks.md'), '- [x] 1. Login\n  - File: a.ts\n\n- [-] 2. Session <b>cookie</b>\n  - File: b.ts\n\n- [ ] 3. Rate limit\n  - File: c.ts\n\n- [~] 4. OAuth\n  - File: d.ts\n  - _Blocked: waiting on keys_\n');
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

const buttons = (r: Awaited<ReturnType<typeof renderScreen>>) => (r.keyboard?.inline_keyboard ?? []).flat();

describe('telegram button UI', () => {
  it('home shows progress and offers the four tabs', async () => {
    const r = await renderScreen({ s: 'home' }, deps());
    expect(r.text).toContain(T.hHome());
    expect(r.text).toContain('1/4');
    const labels = buttons(r).map(x => x.text);
    for (const l of [T.tabSpecs(), T.tabProjects(), T.tabGates(), T.tabMore()]) expect(labels).toContain(l);
    for (const btn of buttons(r)) expect(Buffer.byteLength(btn.callback_data)).toBeLessThanOrEqual(64);
  });

  it('spec screen carries the tab strip, a loop action and navigates to tasks', async () => {
    const r = await renderScreen({ s: 'spec', project: root, spec: 'auth' }, deps());
    const labels = buttons(r).map(x => x.text);
    expect(labels.some(l => l.includes(T.tabTasks()))).toBe(true);
    expect(labels).toContain(T.btnStartLoop());          // idle loop → start offered
    const tasksBtn = buttons(r).find(x => x.text.includes(T.tabTasks()))!;
    const target = navs.get(tasksBtn.callback_data.replace(/^n:/, ''))!;
    expect(target).toMatchObject({ s: 'tasks', spec: 'auth' });
  });

  it('task list puts unfinished work first and every row opens a task screen', async () => {
    const r = await renderScreen({ s: 'tasks', project: root, spec: 'auth', pg: 0 }, deps());
    const rows = buttons(r).filter(x => navs.get(x.callback_data.replace(/^n:/, ''))?.s === 'task');
    const ids = rows.map(x => navs.get(x.callback_data.replace(/^n:/, ''))!.taskId);
    expect(ids).toEqual(['2', '4', '3', '1']);           // in-progress, blocked, pending, completed
    for (const btn of rows) {
      expect(btn.text).not.toMatch(/[<>]/);              // labels are plain text, never HTML
      expect(Buffer.byteLength(btn.callback_data)).toBeLessThanOrEqual(64);
    }
  });

  it('task screen escapes repo text, offers state actions and a way back to the list', async () => {
    const r = await renderScreen({ s: 'task', project: root, spec: 'auth', taskId: '2', pg: 0 }, deps());
    expect(r.text).toContain('&lt;b&gt;cookie&lt;/b&gt;');
    const labels = buttons(r).map(x => x.text);
    expect(labels).toContain(T.btnDone());
    expect(labels).toContain(T.btnBackTasks());
    const back = buttons(r).find(x => x.text === T.btnBackTasks())!;
    expect(navs.get(back.callback_data.replace(/^n:/, ''))).toMatchObject({ s: 'tasks', pg: 0 });
  });

  it('docs screen only offers documents that exist', async () => {
    const r = await renderScreen({ s: 'docs', project: root, spec: 'auth' }, deps());
    const labels = buttons(r).map(x => x.text);
    expect(labels).toContain(T.btnRequirements());       // requirements.md exists
    expect(labels).toContain(T.btnTasks());              // tasks.md exists
    expect(labels).not.toContain(T.btnDesign());         // design.md does not
  });

  it('windows screen lists listeners newest-first, marks the pinned one and offers pin buttons', async () => {
    const q = await import('../../core/requests.js');
    const a = await q.registerWatcher('窗口 A');
    await new Promise(r => setTimeout(r, 5));
    const b2 = await q.registerWatcher('窗口 B', ['/repo/b']);
    await q.setWatcherNote(b2.id, '⏳ new-spec auth');
    const r = await renderScreen({ s: 'windows' }, { ...deps(), pinnedWatcher: b2.id });
    expect(r.text.indexOf('窗口 B')).toBeLessThan(r.text.indexOf('窗口 A'));   // newest first
    expect(r.text).toContain('📌');                                            // pinned marker
    expect(r.text).toContain('new-spec auth');                                 // what it is doing
    const pins = buttons(r).filter(x => navs.get(x.callback_data.replace(/^n:/, ''))?.watcher);
    expect(pins).toHaveLength(2);
    await q.unregisterWatcher(a.id); await q.unregisterWatcher(b2.id);
  });

  it('components screen reflects .mcp.json, .claude/skills and the recorded project state', async () => {
    await fs.writeFile(join(root, '.mcp.json'), JSON.stringify({ mcpServers: {
      context7: { command: 'npx', args: ['-y', '@upstash/context7-mcp'] },
      deepwiki: { type: 'http', url: 'https://mcp.deepwiki.com/mcp' },
    } }));
    await fs.mkdir(join(root, '.claude', 'skills', 'systematic-debugging'), { recursive: true });
    await fs.mkdir(join(root, '.claude', 'agents'), { recursive: true });
    await fs.writeFile(join(root, '.claude', 'agents', 'security-reviewer.md'), '---\nname: security-reviewer\n---\n');
    const ps = await import('../../core/project-state.js');
    await ps.setProjectState(root, 'initialized');

    const r = await renderScreen({ s: 'components', project: root }, deps());
    expect(r.text).toContain('context7');
    expect(r.text).toContain('(http)');                    // hosted endpoint rendered differently
    expect(r.text).toContain('systematic-debugging');
    expect(r.text).toContain('security-reviewer');
    expect(r.text).toContain(T.projectStateLabel('initialized'));
    expect(r.text).toContain('init.sh');                    // tells you where adding happens
  });

  it('every screen renders and every nav button resolves (no dead ends)', async () => {
    const seeds: NavState[] = [
      { s: 'home' }, { s: 'projects' }, { s: 'specs', project: root, pg: 0 },
      { s: 'spec', project: root, spec: 'auth' }, { s: 'tasks', project: root, spec: 'auth', pg: 0 },
      { s: 'task', project: root, spec: 'auth', taskId: '1' }, { s: 'docs', project: root, spec: 'auth' },
      { s: 'logs', project: root, spec: 'auth' }, { s: 'runlog', project: root, spec: 'auth' },
      { s: 'gates' }, { s: 'steering', project: root }, { s: 'more', project: root },
      { s: 'cleanup', project: root }, { s: 'help' }, { s: 'windows' }, { s: 'components', project: root },
    ];
    for (const seed of seeds) {
      const r = await renderScreen(seed, deps());
      expect(r.text.length).toBeGreaterThan(0);
      for (const btn of buttons(r)) {
        expect(Buffer.byteLength(btn.callback_data)).toBeLessThanOrEqual(64);
        if (!btn.callback_data.startsWith('n:')) continue;
        const target = navs.get(btn.callback_data.slice(2));
        expect(target, `dead button "${btn.text}" on ${seed.s}`).toBeTruthy();
        await expect(renderScreen(target!, deps())).resolves.toBeTruthy(); // one level deeper still renders
      }
    }
  });
});
