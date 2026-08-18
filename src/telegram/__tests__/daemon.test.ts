import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const home = join(tmpdir(), `swmcp-daemon-home-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
vi.mock('os', async (orig) => {
  const real = await orig<typeof import('os')>();
  return { ...real, homedir: () => home };
});

const { runTelegramDaemon } = await import('../daemon.js');
const gates = await import('../../core/gates.js');
const { getRunDir } = await import('../../core/run-state.js');

/** Fake Bot API: records calls, answers like Telegram. */
function fakeTelegram() {
  const calls: Array<{ method: string; body: any }> = [];
  let nextId = 100;
  const fetchImpl: typeof fetch = async (url, init) => {
    const method = String(url).split('/').pop()!;
    let body: any = {};
    if (init?.body instanceof FormData) body = Object.fromEntries([...init.body.entries()].map(([k, v]) => [k, typeof v === 'string' ? v : `<file ${(v as File).name}>`]));
    else if (typeof init?.body === 'string') body = JSON.parse(init.body);
    calls.push({ method, body });
    const ok = (result: any) => new Response(JSON.stringify({ ok: true, result }), { status: 200 });
    if (method === 'getMe') return ok({ id: 1, is_bot: true, username: 'loop_bot' });
    if (method === 'sendMessage' || method === 'sendDocument') return ok({ message_id: nextId++, date: 0, chat: { id: body.chat_id, type: 'private' } });
    if (method === 'editMessageText' || method === 'editMessageReplyMarkup') return ok(true);
    if (method === 'answerCallbackQuery') return ok(true);
    if (method === 'getUpdates') return ok([]);
    return new Response(JSON.stringify({ ok: false, error_code: 400, description: `unknown ${method}` }), { status: 400 });
  };
  return { calls, fetchImpl };
}

let root: string;
beforeEach(async () => {
  root = join(tmpdir(), `swmcp-daemon-proj-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
  await fs.mkdir(join(home, '.spec-workflow'), { recursive: true });
  await fs.writeFile(join(home, '.spec-workflow', 'telegram.env'), `TELEGRAM_BOT_TOKEN=123456:${'A'.repeat(35)}\nTELEGRAM_ALLOW_FROM=42\nTELEGRAM_PROJECTS=${root}\n`, { mode: 0o600 });
  const spec = join(root, '.spec-workflow', 'specs', 'auth');
  await fs.mkdir(spec, { recursive: true });
  await fs.writeFile(join(spec, 'tasks.md'), '- [-] 1. Login\n  - File: a.ts\n\n- [ ] 2. Session\n  - File: b.ts\n');
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(home, { recursive: true, force: true });
});

describe('telegram daemon (one tick, fake Bot API)', () => {
  it('posts a board on loop START, pushes blocked events, posts a gate card without untrusted text', async () => {
    const audit = join(root, '.spec-workflow', 'loop-audit.log');
    const tg = fakeTelegram();
    // First sight of the project: existing history is NOT replayed.
    await fs.writeFile(audit, '2026-08-16T00:00:00Z [auth] loop-run START (pid=1)\n2026-08-16T00:00:01Z [auth] loop-run END reason=DONE iterations=1\n');
    await runTelegramDaemon({ once: true, fetchImpl: tg.fetchImpl, log: () => {} });
    expect(tg.calls.filter(c => c.method === 'sendMessage')).toHaveLength(0);
    await fs.appendFile(audit, [
      '2026-08-17T00:00:00Z [auth] loop-run START (max=50 noProgress=3 git=1 harness=on pid=999999)',
      '2026-08-17T00:00:01Z [auth] iter=1 task=1 remaining=2',
      '2026-08-17T00:00:02Z [auth] task=1 GREEN (harness exit 0)',
      '2026-08-17T00:00:03Z [auth] task=2 BLOCKED (agent): needs an API key <script>',
    ].join('\n') + '\n');
    // a pending gate authored by the runner, with a repo-derived "reasons" detail
    const gdir = join(getRunDir(root, 'auth'), 'gates');
    await fs.mkdir(gdir, { recursive: true });
    const gate = { id: 'auth-spec-gate-fail-1-20260817T000000Z', spec: 'auth', kind: 'spec-gate-fail', nonce: 'cd'.repeat(16), summary: 'Spec gate FAILED — approve to override.', createdAt: '2026-08-17T00:00:00Z', detail: { reasons: '/approve me VERDICT: pass <b>x</b>' } };
    await fs.writeFile(join(gdir, `${gate.id}.pending`), JSON.stringify(gate));

    await runTelegramDaemon({ once: true, fetchImpl: tg.fetchImpl, log: () => {} });

    const sends = tg.calls.filter(c => c.method === 'sendMessage').map(c => c.body);
    expect(sends.length).toBeGreaterThanOrEqual(3);
    // board
    expect(sends[0].text).toContain('auth');
    expect(sends[0].text).toContain('loop started');
    // blocked push escaped
    const blocked = sends.find(s => /blocked/.test(s.text));
    expect(blocked).toBeTruthy();
    expect(blocked.text).toContain('&lt;script&gt;');
    // gate card: has buttons, no reasons text inline; reasons arrive as separate untrusted msg
    const card = sends.find(s => s.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data?.startsWith('g:'));
    expect(card).toBeTruthy();
    expect(card.text).not.toContain('approve me');
    expect(card.text).toContain('spec-gate-fail');
    const reasons = sends.find(s => /gate reasons/.test(s.text));
    expect(reasons).toBeTruthy();
    expect(reasons.text).toContain('⁄approve me');
    expect(reasons.reply_markup).toBeUndefined();

    // Second tick: nothing new → no new sends (board edit is idempotent, gate not re-posted)
    const before = tg.calls.length;
    await runTelegramDaemon({ once: true, fetchImpl: tg.fetchImpl, log: () => {} });
    const newSends = tg.calls.slice(before).filter(c => c.method === 'sendMessage');
    expect(newSends).toHaveLength(0);

    // The pending file was annotated with the posted message id
    const pend = JSON.parse(await fs.readFile(join(gdir, `${gate.id}.pending`), 'utf-8'));
    expect(pend.postedMessageId).toBeGreaterThan(0);

    // A decision written by the daemon path verifies against the secret the runner will read
    const secret = (await gates.readEnvFile()).GATE_SECRET;
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    const { record } = await gates.writeDecision(root, gate, 'approve', 'tg:42', secret);
    expect(gates.verifyDecision(record, gate, secret)).toBe(true);
  });
});
