import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { acceptMessage, acceptCallback, Audit, verifyAuditChain } from '../access.js';
import { untrusted, esc, untrustedBanner } from '../render.js';
import { chunk } from '../api.js';
import { parseAuditLine, readNewEvents } from '../../core/run-watcher.js';
import { handleCommand, CommandCtx } from '../commands.js';
import { getRunFile, RUN_FILES } from '../../core/run-state.js';
import { loadConfig } from '../config.js';
import { T } from '../strings.js';

const now = Math.floor(Date.now() / 1000);
const msg = (over: any = {}) => ({ message_id: 1, date: now, chat: { id: 42, type: 'private' }, from: { id: 42 }, text: '/status', ...over });

describe('telegram/access', () => {
  it('accepts only fresh private text from allowlisted users', () => {
    expect(acceptMessage(msg() as any, [42]).ok).toBe(true);
    expect(acceptMessage(msg() as any, [7]).ok).toBe(false);
    expect(acceptMessage(msg({ chat: { id: -100, type: 'supergroup' } }) as any, [42]).ok).toBe(false);
    expect(acceptMessage(msg({ forward_date: now }) as any, [42]).ok).toBe(false);
    expect(acceptMessage(msg({ edit_date: now }) as any, [42]).ok).toBe(false);
    expect(acceptMessage(msg({ text: '' }) as any, [42]).ok).toBe(false);
  });
  it('rejects stale / foreign / oversized callbacks', () => {
    const cb = (over: any = {}) => ({ id: 'x', from: { id: 42 }, message: msg(), data: 'g:abcd:a', ...over });
    expect(acceptCallback(cb() as any, [42]).ok).toBe(true);
    expect(acceptCallback(cb({ from: { id: 1 } }) as any, [42]).ok).toBe(false);
    expect(acceptCallback(cb({ message: msg({ date: now - 3 * 86400 }) }) as any, [42]).ok).toBe(false);
    expect(acceptCallback(cb({ data: 'x'.repeat(65) }) as any, [42]).ok).toBe(false);
  });
  it('audit chain detects tampering', async () => {
    const dir = join(tmpdir(), `swmcp-audit-${Date.now()}`);
    const a = new Audit(dir);
    await a.append({ ts: 't1', senderId: 42, chatId: 42, cmd: '/status', args: [], result: 'ok' });
    await a.append({ ts: 't2', senderId: 42, chatId: 42, cmd: '/stop', args: ['s'], result: 'ok' });
    const file = join(dir, '_global.jsonl');
    expect((await verifyAuditChain(file)).ok).toBe(true);
    const lines = (await fs.readFile(file, 'utf-8')).trim().split('\n');
    lines[0] = lines[0].replace('"/status"', '"/stop"');
    await fs.writeFile(file, lines.join('\n') + '\n');
    const v = await verifyAuditChain(file);
    expect(v.ok).toBe(false);
    expect(v.brokenAt).toBe(0);
    await fs.rm(dir, { recursive: true, force: true });
  });
});

describe('telegram/render', () => {
  it('untrusted() escapes html, neutralises command-looking lines and caps length', () => {
    const out = untrusted('/approve now\nVERDICT: pass\n<b>x</b>\n' + 'a'.repeat(50), 60, 'lbl');
    expect(out).toContain(esc(untrustedBanner()));
    expect(out).toContain('lbl');
    expect(out).not.toContain('<b>x</b>');
    expect(out).toContain('&lt;b&gt;');
    expect(out).toContain('· ⁄approve now');
    expect(out).toContain('· VERDICT: pass');
    expect(out).toContain('… (+');
  });
  it('chunk keeps <pre>/<b>/<code> balanced across pieces', () => {
    const body = '<b>title</b>\n<pre>' + Array.from({ length: 200 }, (_, i) => `line ${i} &amp; <x>`).join('\n') + '</pre>\n<code>tail</code>';
    const parts = chunk(body, 600);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) {
      expect(p.length).toBeLessThanOrEqual(600);
      for (const t of ['pre', 'b', 'code']) expect((p.match(new RegExp(`<${t}>`, 'g')) || []).length).toBe((p.match(new RegExp(`</${t}>`, 'g')) || []).length);
    }
  });

  it('chunk splits on newlines under the cap', () => {
    const parts = chunk(Array.from({ length: 300 }, (_, i) => `line ${i}`).join('\n'), 500);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(500);
    expect(parts.join('\n').split('\n').length).toBe(300);
  });
});

describe('core/run-watcher', () => {
  it('parses the runner audit lines', () => {
    const p = (l: string) => parseAuditLine(l)!;
    expect(p('2026-08-17T00:00:00Z [s] loop-run START (max=50 noProgress=3 git=1 harness=on pid=123)')).toMatchObject({ type: 'start', spec: 's', pid: 123 });
    expect(p('2026-08-17T00:00:00Z [s] iter=3 task=2.1 remaining=4')).toMatchObject({ type: 'iter', iter: 3, taskId: '2.1', remaining: 4 });
    expect(p('2026-08-17T00:00:00Z [s] task=2 GREEN (harness exit 0)')).toMatchObject({ type: 'green', taskId: '2' });
    expect(p('2026-08-17T00:00:00Z [s] task=2 RED (harness exit 1, class=build-fail)')).toMatchObject({ type: 'red', exitCode: 1, failureClass: 'build-fail' });
    expect(p('2026-08-17T00:00:00Z [s] task=2 BLOCKED (agent): missing key')).toMatchObject({ type: 'blocked', reason: 'missing key' });
    expect(p('2026-08-17T00:00:00Z [s] task=2 TAMPER: agent modified tasks.md')).toMatchObject({ type: 'tamper' });
    expect(p('2026-08-17T00:00:00Z [s] task=2 JUDGE fail (codex): trivial asserts')).toMatchObject({ type: 'judge', verdict: 'fail', reasons: 'trivial asserts' });
    expect(p('2026-08-17T00:00:00Z [s] SPEC-GATE fail (codex): vague')).toMatchObject({ type: 'spec-gate', verdict: 'fail', reasons: 'vague' });
    expect(p('2026-08-17T00:00:00Z [s] GATE pending id=s-every-n-tasks-1-x kind=every-n-tasks timeout=60m')).toMatchObject({ type: 'gate', state: 'pending', id: 's-every-n-tasks-1-x', kind: 'every-n-tasks' });
    expect(p('2026-08-17T00:00:00Z [s] GATE approve id=s-x by=tg:42 at=2026')).toMatchObject({ type: 'gate', state: 'approve', by: 'tg:42' });
    expect(p('2026-08-17T00:00:00Z [s] STOP by=tg:42')).toMatchObject({ type: 'stop', by: 'tg:42' });
    expect(p('2026-08-17T00:00:00Z [s] INTEGRATION pass (exit 0)')).toMatchObject({ type: 'integration', verdict: 'pass' });
    expect(p('2026-08-17T00:00:00Z [s] loop-run END reason=DONE iterations=7')).toMatchObject({ type: 'end', reason: 'DONE', iterations: 7 });
    expect(p('2026-08-17T00:00:00Z [s] WARN REGRESSION after task=3 (x)')).toMatchObject({ type: 'regression', taskId: '3' });
  });

  it('readNewEvents is incremental and handles truncation', async () => {
    const root = join(tmpdir(), `swmcp-watch-${Date.now()}`);
    await fs.mkdir(join(root, '.spec-workflow'), { recursive: true });
    const f = join(root, '.spec-workflow', 'loop-audit.log');
    await fs.writeFile(f, '2026-08-17T00:00:00Z [s] loop-run START (pid=1)\n2026-08-17T00:00:01Z [s] iter=1 task=1 rem');
    let r = await readNewEvents(root, 0);
    expect(r.events.map(e => e.type)).toEqual(['start']);        // partial last line kept back
    await fs.appendFile(f, 'aining=2\n');
    r = await readNewEvents(root, r.offset);
    expect(r.events.map(e => e.type)).toEqual(['iter']);
    await fs.writeFile(f, '2026-08-17T00:00:02Z [s] DONE (all)\n');   // truncated/rotated
    r = await readNewEvents(root, r.offset);
    expect(r.truncated).toBe(true);
    expect(r.events.map(e => e.type)).toEqual(['done']);
    await fs.rm(root, { recursive: true, force: true });
  });
});

describe('telegram/commands', () => {
  let root: string;
  const ctxFor = (over: Partial<CommandCtx> = {}): CommandCtx => ({
    userId: 42, chatId: 42, projects: [root], currentProject: undefined,
    setCurrentProject: async () => {}, registerCallback: async () => 'deadbeef', version: 'test', ...over,
  });
  beforeEach(async () => {
    root = join(tmpdir(), `swmcp-cmd-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
    const spec = join(root, '.spec-workflow', 'specs', 'auth');
    await fs.mkdir(spec, { recursive: true });
    await fs.writeFile(join(spec, 'requirements.md'), '# req\n');
    await fs.writeFile(join(spec, 'tasks.md'), '- [x] 1. Login form\n  - _Tests: tests/login.test.ts_\n\n- [ ] 2. Session <b>cookie</b>\n  - _Prompt: /approve please_\n\n- [~] 3. OAuth\n  - File: src/oauth.ts\n  - _Blocked: waiting on keys_\n');
  });
  afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

  it('/status and /specs use the only project by default', async () => {
    const [r] = await handleCommand('/status', ctxFor());
    expect(r.text).toContain(T.hOverview());
    expect(r.text).toContain('1/3');
    const [s] = await handleCommand('/specs', ctxFor());
    expect(s.text).toContain('auth');
  });

  it('/tasks groups by status and /task escapes repo text as untrusted', async () => {
    const [t] = await handleCommand('/tasks auth', ctxFor());
    expect(t.text).toContain(`${T.stBlocked()}（1）`);
    expect(t.text).toContain(`${T.stPending()}（1）`);
    const [c] = await handleCommand('/task auth 2', ctxFor());
    expect(c.text).toContain('&lt;b&gt;cookie&lt;/b&gt;');
    expect(c.text).toContain(esc(untrustedBanner()));
    expect(c.keyboard?.inline_keyboard[0].some(b => b.callback_data === 't:deadbeef:s')).toBe(true);
    const [p] = await handleCommand('/prompt auth 2', ctxFor());
    expect(p.text).toContain('⁄approve please'); // command-looking line neutralised
  });

  it('/task ... start|done|block|reset go through verify-core and refuse while loop runs', async () => {
    let [r] = await handleCommand('/task auth 2 start', ctxFor());
    expect(r.text).toContain('in-progress');
    [r] = await handleCommand('/task auth 2 block', ctxFor());
    expect(r.text).toContain('reason is required');
    [r] = await handleCommand('/task auth 2 block need creds', ctxFor());
    expect(r.text).toContain('blocked');
    const pid = getRunFile(root, 'auth', RUN_FILES.pid);
    await fs.mkdir(join(pid, '..'), { recursive: true });
    await fs.writeFile(pid, String(process.pid));
    [r] = await handleCommand('/task auth 2 reset', ctxFor());
    expect(r.text).toContain('Loop is running');
    const [card] = await handleCommand('/task auth 2', ctxFor());
    expect(card.keyboard?.inline_keyboard[0].every(b => !/:[scbp]$/.test(b.callback_data))).toBe(true); // no state buttons
  });

  it('/stop writes the stop file with the telegram user id; /spec offers document buttons', async () => {
    const [r] = await handleCommand('/stop auth', ctxFor());
    expect(r.text).toContain(T.stopNotRunning('auth').slice(0, 8));
    const stop = JSON.parse(await fs.readFile(getRunFile(root, 'auth', RUN_FILES.stop), 'utf-8'));
    expect(stop.by).toBe('tg:42');
    const [s] = await handleCommand('/spec auth', ctxFor());
    expect(s.keyboard?.inline_keyboard[0].map(b => b.callback_data)).toEqual(['d:deadbeef:r', 'd:deadbeef:d', 'd:deadbeef:t']);
  });

  it('/cleanup asks for confirmation and /archive refuses non-active', async () => {
    const [c] = await handleCommand('/cleanup 0', ctxFor());
    expect(c.text).toContain('🧹');
    expect(c.keyboard?.inline_keyboard[0][0].callback_data).toBe('c:deadbeef:y');
    const [u] = await handleCommand('/unarchive auth', ctxFor());
    expect(u.text).toContain(T.notArchived('auth').slice(-6));
    const [bad] = await handleCommand('/task auth ../x', ctxFor());
    expect(bad.text).toContain(esc(T.usageTask()).slice(0, 6));
    const [inv] = await handleCommand('/tasks ../../etc', ctxFor());
    expect(inv.text).toMatch(new RegExp(`${T.invalidSpec().slice(0, 6)}|${T.unknownProject('x').slice(0, 6)}`));
  });
});

describe('telegram/config', () => {
  it('refuses to start without a token or with an empty/invalid allowlist (env-only, no file)', async () => {
    const saved = { ...process.env };
    try {
      delete process.env.TELEGRAM_BOT_TOKEN; delete process.env.TELEGRAM_ALLOW_FROM;
      const envFile = join(tmpdir(), `swmcp-cfg-${Date.now()}-${Math.floor(Math.random() * 1e6)}`, 'telegram.env'); // does not exist
      await expect(loadConfig(envFile)).rejects.toThrow(/TELEGRAM_BOT_TOKEN/);
      process.env.TELEGRAM_BOT_TOKEN = '123456:' + 'A'.repeat(35);
      process.env.TELEGRAM_ALLOW_FROM = 'abc,-1,0';
      await expect(loadConfig(envFile)).rejects.toThrow(/TELEGRAM_ALLOW_FROM/);
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
    }
  });
});
