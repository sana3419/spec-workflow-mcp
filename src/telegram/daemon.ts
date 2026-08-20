import { promises as fs } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomBytes } from 'crypto';
import { TelegramApi, TelegramApiError, TgUpdate, InlineKeyboardMarkup } from './api.js';
import { loadConfig, loadState, saveState, TelegramConfig, DaemonState } from './config.js';
import { acceptMessage, acceptCallback, Audit } from './access.js';
import { handleCommand, projectLabel, specStatusText, specDocument, taskCard, applyTaskAction, promptFor, steeringDocument, doArchive, doCleanup, specExists, HELP, CommandCtx, CallbackPayload, Reply } from './commands.js';
import { esc, b, code, ago, untrusted, inlineUntrusted } from './render.js';
import { T, setLang } from './strings.js';
import { renderScreen, NavState, UiDeps, loopActionOf, isDispatch } from './ui.js';
import { createRequest, listRequests, watcherAlive, WorkRequest } from '../core/requests.js';
import { ProjectRegistry } from '../core/project-registry.js';
import { PathUtils } from '../core/path-utils.js';
import { readNewEvents, LoopEvent } from '../core/run-watcher.js';
import { listPendingGates, updatePendingGate, writeDecision, readDecision, verifyPendingSig, PendingGate, GateKind } from '../core/gates.js';
import { getLoopStatus } from '../core/run-state.js';
import type { ManualTaskStatus } from '../core/verify-core.js';

/**
 * loop_bot daemon — ONE process per machine (Telegram allows a single getUpdates consumer per
 * token). Discovers projects from the MCP project registry (+ TELEGRAM_PROJECTS), tails each
 * project's loop-audit.log, keeps one "board" message per running spec up to date, posts gate
 * cards, and answers commands from allowlisted users. Never runs claude/codex itself; all state
 * writes go through core (verify-core / run-state / gates / archive / cleanup).
 */

const TICK_MS = 4000;
const SPEC_NAMES_TTL_MS = 60_000;

export interface DaemonOptions {
  once?: boolean;             // run one tick and exit (tests / cron)
  fetchImpl?: typeof fetch;
  log?: (s: string) => void;
  /** tests only: updates to feed through handleUpdate during a `once` run (instead of polling) */
  injectUpdates?: TgUpdate[];
  /** override the env file (tests / multiple bots on one machine) */
  envFile?: string;
}

export async function runTelegramDaemon(opts: DaemonOptions = {}): Promise<void> {
  const log = opts.log ?? ((s: string) => console.error(`[telegram] ${s}`));
  const cfg = await loadConfig(opts.envFile);
  setLang(cfg.lang);
  const api = new TelegramApi(cfg.token, opts.fetchImpl);
  const state = await loadState(cfg.stateFile);
  const audit = new Audit(cfg.auditDir);
  const version = await readVersion();
  const me = await api.getMe().catch(e => { throw new Error(`Telegram getMe failed: ${e.message}`); });
  log(`connected as @${me.username} · allowFrom=${cfg.allowFrom.join(',')} · notify=${cfg.notify.join(',')} · sendOnly=${cfg.sendOnly}`);

  const d = new Daemon(api, cfg, state, audit, version, log);
  await d.discoverProjects();
  await d.tick();          // pushes + gate cards
  if (opts.once) {
    for (const u of opts.injectUpdates ?? []) {
      state.offset = Math.max(state.offset, u.update_id + 1); d.markDirty();
      try { await d.handleUpdate(u); } catch (e) { log(`update ${u.update_id} error: ${(e as Error).message}`); }
    }
    await d.flush(); return;
  }

  let stopping = false;
  const pollAbort = new AbortController();
  const onSig = () => { if (stopping) process.exit(130); stopping = true; pollAbort.abort(); };
  process.on('SIGINT', onSig); process.on('SIGTERM', onSig);

  // Two loops: long-poll for commands (unless send-only) and a periodic watcher tick.
  const watcher = (async () => {
    while (!stopping) {
      try { await d.tick(); } catch (e) { log(`tick error: ${(e as Error).message}`); }
      await sleep(TICK_MS);
    }
  })();
  const poller = (async () => {
    if (cfg.sendOnly) return;
    let backoff = 1000;
    while (!stopping) {
      try {
        const updates = await api.getUpdates(state.offset, 25, pollAbort.signal);
        if (stopping) break;
        backoff = 1000;
        for (const u of updates) {
          state.offset = Math.max(state.offset, u.update_id + 1); d.markDirty();
          try { await d.handleUpdate(u); } catch (e) { log(`update ${u.update_id} error: ${(e as Error).message}`); }
        }
        if (updates.length) await d.flush();
      } catch (e) {
        const msg = (e as Error).message;
        if (e instanceof TelegramApiError && e.code === 409) {
          log('409 Conflict: another process is polling this bot token (the orchestrator plugin? a second daemon?). Use a dedicated loop_bot token or TELEGRAM_SEND_ONLY=true.');
        } else if (!/aborted/i.test(msg)) log(`poll error: ${msg}`);
        await sleep(backoff); backoff = Math.min(backoff * 2, 60_000);
      }
    }
  })();
  await Promise.all([watcher, poller]);
  await d.flush();
  log('stopped');
}

class Daemon {
  private projects: string[] = [];
  private lastDiscover = 0;
  private dirty = false;
  private awaitingReason = new Map<number, { project: string; spec: string; taskId: string }>();
  /** chat → a screen is waiting for a free-text answer (new spec idea / project path) */
  private awaitingInput = new Map<number, { kind: 'new-spec' | 'new-project'; project?: string }>();
  /** request id → the chat that filed it, so results go back to the right place */
  private requestWatch = new Map<string, { chatId: number; kind: WorkRequest['kind']; what: string }>();
  private specNames = new Map<string, { names: string[]; at: number }>();

  constructor(
    private api: TelegramApi,
    private cfg: TelegramConfig,
    private state: DaemonState,
    private audit: Audit,
    private version: string,
    private log: (s: string) => void,
  ) {}

  // ------------------------------------------------------------ projects

  async discoverProjects(): Promise<void> {
    const found = new Set<string>(this.cfg.extraProjects);
    try {
      const reg = new ProjectRegistry();
      for (const p of await reg.getAllProjects()) found.add(p.workflowRootPath || p.projectPath);
    } catch (e) { this.log(`registry read failed: ${(e as Error).message}`); }
    const alive: string[] = [];
    for (const p of found) {
      try { await fs.access(PathUtils.getWorkflowRoot(p)); alive.push(p); } catch { /* not a spec-workflow project (yet) */ }
    }
    this.projects = alive.sort();
    this.lastDiscover = Date.now();
  }

  private ctx(userId: number, chatId: number): CommandCtx {
    return {
      userId, chatId,
      projects: this.projects,
      currentProject: this.state.currentProject[String(chatId)],
      setCurrentProject: async (p) => { if (p) this.state.currentProject[String(chatId)] = p; else delete this.state.currentProject[String(chatId)]; this.dirty = true; },
      registerCallback: async (payload) => this.registerKey(payload),
      version: this.version,
    };
  }

  private async registerKey(payload: CallbackPayload): Promise<string> {
    // 8 hex chars keeps callback_data well under 64 bytes: "t:xxxxxxxx:s"
    const key = randomBytes(4).toString('hex');
    this.state.cbKeys[key] = { ...payload, at: Date.now() };
    for (const [k, v] of Object.entries(this.state.cbKeys)) if (Date.now() - v.at > 7 * 86400e3) delete this.state.cbKeys[k];
    this.dirty = true;
    return key;
  }
  private async registerNav(nav: NavState): Promise<string> {
    const key = randomBytes(4).toString('hex');
    this.state.navKeys[key] = { nav, at: Date.now() };
    for (const [k, v] of Object.entries(this.state.navKeys)) if (Date.now() - v.at > 7 * 86400e3) delete this.state.navKeys[k];
    this.dirty = true;
    return key;
  }
  private navFor(key: string): NavState | undefined { return this.state.navKeys[key]?.nav as NavState | undefined; }

  private uiDeps(userId: number, chatId: number): UiDeps {
    return { ctx: this.ctx(userId, chatId), nav: (s: NavState) => this.registerNav(s) };
  }

  /** Render a screen into the message the button belongs to (tab-like navigation). */
  private async showScreen(chatId: number, messageId: number | undefined, userId: number, nav: NavState): Promise<void> {
    const reply = await renderScreen(nav, this.uiDeps(userId, chatId));
    if (messageId !== undefined) await this.editCard(chatId, messageId, reply);
    else await this.send(chatId, reply);
  }

  private payloadFor(key: string, kind: CallbackPayload['kind']): (CallbackPayload & { at: number }) | undefined {
    const p = this.state.cbKeys[key];
    return p && p.kind === kind ? (p as CallbackPayload & { at: number }) : undefined;
  }

  markDirty(): void { this.dirty = true; }

  async flush(): Promise<void> {
    if (!this.dirty) return;
    await saveState(this.state, this.cfg.stateFile);
    this.dirty = false;
  }

  // ------------------------------------------------------------ inbound

  async handleUpdate(u: TgUpdate): Promise<void> {
    if (u.callback_query) return this.handleCallback(u);
    const acc = acceptMessage(u.message ?? u.edited_message, this.cfg.allowFrom);
    if (!acc.ok) return; // silently drop — never reveal the bot exists to strangers
    const { text, userId, chatId } = acc;

    // A pending "new spec / new project" prompt consumes the next non-command message.
    const input = this.awaitingInput.get(chatId);
    if (input && !text.startsWith('/')) {
      this.awaitingInput.delete(chatId);
      await this.handleInput(userId, chatId, u.update_id, input, text);
      return;
    }
    if (input && /^\/cancel\b/i.test(text)) { this.awaitingInput.delete(chatId); await this.send(chatId, { text: T.cancelled() }); return; }

    // A pending "send me the block reason" prompt consumes the next non-command message.
    const pending = this.awaitingReason.get(chatId);
    if (pending && !text.startsWith('/')) {
      this.awaitingReason.delete(chatId);
      const ctx = this.ctx(userId, chatId);
      const r = await applyTaskAction(ctx, pending.project, pending.spec, pending.taskId, 'blocked', text.slice(0, 300));
      await this.auditCmd(userId, chatId, u.update_id, 'task.block', [pending.spec, pending.taskId], pending.project, pending.spec, r.message);
      if (r.ok) await this.showScreen(chatId, undefined, userId, { s: 'task', project: pending.project, spec: pending.spec, taskId: pending.taskId });
      else await this.send(chatId, { text: `❌ ${esc(r.message)}` });
      return;
    }
    if (!text.startsWith('/')) { await this.showScreen(chatId, undefined, userId, { s: 'home' }); return; }
    if (this.awaitingReason.has(chatId)) this.awaitingReason.delete(chatId);

    if (Date.now() - this.lastDiscover > 30_000) await this.discoverProjects();
    const bare = text.split(/\s+/)[0].replace(/^\//, '').replace(/@\w+$/, '').toLowerCase();
    if (bare === 'menu' || (bare === 'start' && text.trim().split(/\s+/).length === 1)) {
      await this.auditCmd(userId, chatId, u.update_id, `/${bare}`, [], this.state.currentProject[String(chatId)], undefined, 'menu');
      await this.showScreen(chatId, undefined, userId, { s: 'home' });
      return;
    }
    const ctx = this.ctx(userId, chatId);
    const replies = await handleCommand(text, ctx);
    const [cmd, ...args] = text.split(/\s+/);
    await this.auditCmd(userId, chatId, u.update_id, cmd, args, ctx.currentProject, undefined, replies.map(r => r.text.slice(0, 80)).join(' | '));
    for (const r of replies) {
      try { await this.send(chatId, r); }
      catch (e) { this.log(`reply to ${cmd} failed after retries: ${(e as Error).message}`); }
    }
  }

  private async handleCallback(u: TgUpdate): Promise<void> {
    const cb = u.callback_query!;
    const acc = acceptCallback(cb, this.cfg.allowFrom);
    if (!acc.ok) { await this.api.answerCallbackQuery(cb.id, acc.why === 'stale' ? 'expired — re-run the command' : undefined).catch(() => {}); return; }
    const { userId, chatId, messageId, data } = acc;
    const [kind, key, arg] = data.split(':');
    const ctx = this.ctx(userId, chatId);
    const ack = (t?: string, alert = false) => this.api.answerCallbackQuery(cb.id, t, alert).catch(() => {});

    if (kind === 'g') return this.handleGateCallback(cb.id, userId, chatId, messageId, key, arg, u.update_id);

    if (kind === 'n') { // screen navigation
      const nav = this.navFor(key);
      if (!nav) { await ack(T.ackExpired()); return; }
      const action = loopActionOf(nav);
      if (action) {
        const project = nav.project ?? this.state.currentProject[String(chatId)] ?? '';
        const res = await handleCommand(`/${action} ${nav.spec}`, this.ctx(userId, chatId));
        await this.auditCmd(userId, chatId, u.update_id, `loop.${action}`, [String(nav.spec)], project, nav.spec, res.map(r => r.text.slice(0, 60)).join(' | '));
        await ack(action === 'start' ? T.btnStartLoop() : T.btnStopLoop());
        for (const r of res) await this.send(chatId, r);
        await this.showScreen(chatId, messageId, userId, { s: 'spec', project, spec: nav.spec });
        return;
      }
      if (nav.s === 'new-spec' || nav.s === 'new-project') {
        this.awaitingInput.set(chatId, { kind: nav.s, project: nav.project });
      }
      if (isDispatch(nav)) {
        await ack();
        await this.fileRequest(userId, chatId, u.update_id, {
          kind: 'dispatch-task', project: nav.project ?? '', spec: nav.spec, taskId: nav.taskId, by: `tg:${userId}`,
        }, `${nav.spec} · ${nav.taskId}`);
        await this.showScreen(chatId, messageId, userId, { s: 'task', project: nav.project, spec: nav.spec, taskId: nav.taskId, pg: nav.pg });
        return;
      }
      // Picking a project from the list also makes it current for this chat.
      if (nav.s === 'specs' && nav.project) { this.state.currentProject[String(chatId)] = nav.project; this.dirty = true; }
      await ack();
      await this.showScreen(chatId, messageId, userId, nav);
      return;
    }

    const kindMap: Record<string, CallbackPayload['kind']> = { d: 'doc', s: 'steer', t: 'task', a: 'arch', c: 'clean' };
    const payload = kindMap[kind] ? this.payloadFor(key, kindMap[kind]) : undefined;
    if (!payload) { await ack('expired — re-run the command'); return; }
    const project = payload.project, spec = payload.spec ?? '', taskId = payload.taskId ?? '';
    switch (kind) {
      case 'd': { // spec document
        await ack();
        await this.send(chatId, await specDocument(project, spec, arg as 'r' | 'd' | 't'));
        return;
      }
      case 's': { await ack(); await this.send(chatId, await steeringDocument(project, arg)); return; }
      case 't': { // task actions
        if (arg === 'q') { await ack(); await this.send(chatId, await promptFor(project, spec, taskId)); return; }
        if (arg === 'r') { await ack('refreshed'); await this.editCard(chatId, messageId, await taskCard(ctx, project, spec, taskId)); return; }
        if (arg === 'b') {
          this.awaitingReason.set(chatId, { project, spec, taskId });
          await ack();
          await this.send(chatId, { text: `⛔ reply with the reason to block task ${code(taskId)} of ${code(spec)} (next message; any /command cancels)` });
          return;
        }
        const map: Record<string, ManualTaskStatus> = { s: 'in-progress', c: 'completed', p: 'pending' };
        const status = map[arg];
        if (!status) { await ack('?'); return; }
        const r = await applyTaskAction(ctx, project, spec, taskId, status);
        await this.auditCmd(userId, chatId, u.update_id, `task.${status}`, [spec, taskId], project, spec, r.message);
        await ack(r.ok ? T.ackDone() : r.message.slice(0, 190));
        if (r.ok) await this.showScreen(chatId, messageId, userId, { s: 'task', project, spec, taskId });
        else await this.send(chatId, { text: `❌ ${esc(r.message)}` });
        return;
      }
      case 'a': { // archive confirm
        const flag = payload.flag;
        if (arg !== 'y') { await ack(T.ackCancelled()); await this.api.editMessageReplyMarkup(chatId, messageId).catch(() => {}); return; }
        if (flag === '1' && (await getLoopStatus(project, spec)).running) { await ack('loop is running — /stop first', true); await this.api.editMessageReplyMarkup(chatId, messageId).catch(() => {}); return; }
        try {
          const msg = await doArchive(project, spec, flag === '1');
          await this.auditCmd(userId, chatId, u.update_id, flag === '1' ? 'archive' : 'unarchive', [spec], project, spec, msg);
          await ack(T.ackDone()); await this.editCard(chatId, messageId, { text: esc(msg) });
        } catch (e) { await ack(T.ackFailed()); await this.send(chatId, { text: `❌ ${esc((e as Error).message)}` }); }
        return;
      }
      case 'c': { // cleanup confirm
        const flag = payload.flag, days = payload.num ?? NaN;
        if (arg !== 'y' || !Number.isFinite(days)) { await ack(T.ackCancelled()); await this.api.editMessageReplyMarkup(chatId, messageId).catch(() => {}); return; }
        const msg = await doCleanup(project, days, flag === '1');
        await this.auditCmd(userId, chatId, u.update_id, 'cleanup', [String(days), flag === '1' ? 'archived' : 'active'], project, undefined, msg.replace(/<[^>]+>/g, ''));
        await ack(T.ackDone()); await this.editCard(chatId, messageId, { text: msg });
        return;
      }
      default: await ack('?');
    }
  }

  private async handleGateCallback(cbId: string, userId: number, chatId: number, messageId: number, key: string, arg: string, updateId: number): Promise<void> {
    const ack = (t?: string, alert = false) => this.api.answerCallbackQuery(cbId, t, alert).catch(() => {});
    const ref = this.state.gateKeys[key];
    if (!ref) { await ack(T.ackExpired()); return; }
    if (arg !== 'a' && arg !== 'r') { await ack('?'); return; }
    const decision = arg === 'a' ? 'approve' : 'reject';
    // Still pending? (runner may have timed out)
    const stillPending = (await listPendingGates(ref.project, ref.spec)).find(g => g.id === ref.id && g.nonce === ref.nonce);
    const already = await readDecision(ref.project, ref.id);
    if (!stillPending && !already) {
      await ack(T.ackGateGone(), true);
      await this.api.editMessageReplyMarkup(chatId, messageId).catch(() => {});
      return;
    }
    const { record, alreadyDecided } = await writeDecision(ref.project, { id: ref.id, nonce: ref.nonce }, decision, `tg:${userId}`, this.cfg.gateSecret);
    await this.auditCmd(userId, chatId, updateId, `gate.${record.decision}`, [ref.id], ref.project, ref.spec, alreadyDecided ? 'already decided' : 'recorded');
    await ack(alreadyDecided ? T.ackAlreadyDecided(record.decision, record.by) : T.ackDecided(record.decision));
    // Update every chat's card for this gate (each chat has its own key/message).
    for (const [k, r] of Object.entries(this.state.gateKeys)) {
      if (r.id !== ref.id || r.project !== ref.project) continue;
      await this.api.editMessageText(r.chatId, r.messageId, this.gateCardText(r.spec, r.project, r.id, r.createdAt, undefined, record), { parse_mode: 'HTML' }).catch(() => {});
      delete this.state.gateKeys[k];
    }
    this.dirty = true;
  }

  // ------------------------------------------------------------ work requests

  /** Free-text answer to a "new spec" / "new project" prompt. */
  private async handleInput(userId: number, chatId: number, updateId: number, input: { kind: 'new-spec' | 'new-project'; project?: string }, text: string): Promise<void> {
    if (input.kind === 'new-spec') {
      const m = text.trim().match(/^([A-Za-z0-9._-]{1,64})[\s:：,，-]+([\s\S]{3,})$/);
      if (!m) { await this.send(chatId, { text: T.badSpecInput() }); return; }
      const [, spec, idea] = m;
      const project = input.project ?? this.state.currentProject[String(chatId)] ?? this.projects[0];
      if (!project) { await this.send(chatId, { text: esc(T.noProjects()) }); return; }
      if ((await specExists(project, spec)) !== 'missing') { await this.send(chatId, { text: T.specExists(code(spec)) }); return; }
      await this.fileRequest(userId, chatId, updateId, { kind: 'new-spec', project, spec, idea: idea.trim(), by: `tg:${userId}` }, spec);
      return;
    }
    const path = text.trim();
    if (!path.startsWith('/') || path.includes('..')) { await this.send(chatId, { text: esc(T.badProjectPath()) }); return; }
    await this.fileRequest(userId, chatId, updateId, { kind: 'new-project', project: '', path, by: `tg:${userId}` }, path);
  }

  /** File a request for the live session and tell the user whether anyone is listening. */
  private async fileRequest(userId: number, chatId: number, updateId: number, r: Omit<WorkRequest, 'id' | 'status' | 'at'>, what: string): Promise<void> {
    const live = await watcherAlive();
    const req = await createRequest(r);
    this.requestWatch.set(req.id, { chatId, kind: req.kind, what });
    await this.auditCmd(userId, chatId, updateId, `request.${req.kind}`, [what], r.project || undefined, r.spec, req.id);
    const text = req.kind === 'new-spec' ? T.queuedNewSpec(esc(what), live)
      : req.kind === 'new-project' ? T.queuedNewProject(esc(what), live)
      : T.queuedDispatch(esc(String(r.spec)), esc(String(r.taskId)), live);
    await this.send(chatId, { text });
  }

  /** Push finished requests back to whoever asked (called from tick). */
  private async pollRequests(): Promise<void> {
    if (!this.requestWatch.size) return;
    for (const r of await listRequests()) {
      const w = this.requestWatch.get(r.id);
      if (!w || (r.status !== 'done' && r.status !== 'failed')) continue;
      this.requestWatch.delete(r.id);
      const kind = r.kind === 'new-spec' ? T.kindNewSpec() : r.kind === 'new-project' ? T.kindNewProject() : T.kindDispatch();
      const body = r.result ? inlineUntrusted(r.result, 400) : '';
      await this.send(w.chatId, { text: r.status === 'done' ? T.requestDone(kind, esc(w.what), body) : T.requestFailed(kind, esc(w.what), body) });
      if (r.status === 'done' && r.kind !== 'new-project') await this.discoverProjects();
    }
  }

  // ------------------------------------------------------------ outbound helpers

  private async send(chatId: number, r: Reply): Promise<number | undefined> {
    let id: number | undefined;
    if (r.text) {
      const m = await this.api.sendMessage(chatId, r.text, { parse_mode: 'HTML', reply_markup: r.keyboard, disable_notification: r.silent });
      id = m.message_id;
    }
    for (const f of r.files || []) {
      await this.api.sendDocument(chatId, f.name, f.content, f.caption).catch(async e => {
        await this.api.sendMessage(chatId, `❌ could not send ${esc(f.name)}: ${esc(e.message)}`, { parse_mode: 'HTML' });
      });
    }
    return id;
  }

  private async editCard(chatId: number, messageId: number, r: Reply): Promise<void> {
    await this.api.editMessageText(chatId, messageId, r.text, { parse_mode: 'HTML', reply_markup: r.keyboard }).catch(async (e: Error) => {
      if (!/message is not modified/i.test(e.message)) await this.send(chatId, r);
    });
  }

  private async broadcast(r: Reply): Promise<void> {
    for (const chatId of this.cfg.notify) {
      try { await this.send(chatId, r); } catch (e) { this.log(`broadcast to ${chatId} failed: ${(e as Error).message}`); }
    }
  }

  private async auditCmd(senderId: number, chatId: number, updateId: number | undefined, cmd: string, args: string[], project?: string, spec?: string, result = ''): Promise<void> {
    try { await this.audit.append({ ts: new Date().toISOString(), senderId, chatId, updateId, cmd, args, project, spec, result: result.slice(0, 200) }); }
    catch (e) { this.log(`audit append failed: ${(e as Error).message}`); }
  }

  // ------------------------------------------------------------ watcher tick

  async tick(): Promise<void> {
    if (Date.now() - this.lastDiscover > 60_000) await this.discoverProjects();
    for (const p of this.projects) {
      const seen = this.state.auditOffsets[p];
      const { events, offset, truncated } = await readNewEvents(p, seen ?? 0);
      // Never-seen project (or a rotated/truncated log): don't replay history into Telegram — remember
      // the end and only report what happens from now on. (Gates are scanned regardless, below.)
      if (seen === undefined || truncated) {
        if (truncated) this.log(`audit log for ${p} was truncated/rotated — resynced to end`);
        this.state.auditOffsets[p] = offset; this.dirty = true;
      } else if (events.length) {
        this.state.auditOffsets[p] = offset; this.dirty = true;
        for (const ev of events) {
          try { await this.onEvent(p, ev); } catch (e) { this.log(`event error: ${(e as Error).message}`); }
        }
      }
      await this.scanGates(p);
    }
    await this.pollRequests();
    await this.flush();
  }

  private async specsOf(project: string): Promise<string[]> {
    const cached = this.specNames.get(project);
    if (cached && Date.now() - cached.at < SPEC_NAMES_TTL_MS) return cached.names;
    // Directory names only — a full getAllSpecs() here would read and parse every
    // tasks.md on every refresh just to throw the parse away.
    let names: string[];
    try {
      const root = PathUtils.getSpecPath(project, '');
      names = (await fs.readdir(root, { withFileTypes: true }))
        .filter(e => e.isDirectory())
        .map(e => e.name)
        .sort((x, y) => x.localeCompare(y));
    } catch { names = []; }
    this.specNames.set(project, { names, at: Date.now() });
    return names;
  }

  private label(project: string): string { return projectLabel(project) || project; }

  private async onEvent(project: string, ev: LoopEvent): Promise<void> {
    const key = `${project}::${ev.spec}`;
    const head = `${b(this.label(project))}/${b(ev.spec)}`;
    switch (ev.type) {
      case 'start': {
        // New board message per run.
        const text = await this.boardText(project, ev.spec, esc(T.evLoopStarted(ev.pid)));
        const refs = [];
        for (const chatId of this.cfg.notify) {
          try {
            const id = await this.send(chatId, { text });
            if (id) refs.push({ chatId, messageId: id, runStartedAt: ev.ts, lastText: text });
          } catch (e) { this.log(`board post to ${chatId} failed: ${(e as Error).message}`); }
        }
        this.state.boards[key] = refs; this.dirty = true;
        return;
      }
      case 'green': case 'iter': case 'judge': case 'unverified': case 'spec-gate':
        await this.updateBoard(project, ev.spec, describe(ev));
        if (ev.type === 'spec-gate' && (ev.verdict === 'fail' || ev.verdict === 'overridden')) await this.broadcast({ text: `${head} · ${describe(ev)}` });
        if (ev.type === 'judge' && ev.verdict === 'fail') await this.broadcast({ text: `${head} · ${describe(ev)}`, silent: true });
        return;
      case 'red':
        await this.updateBoard(project, ev.spec, describe(ev));
        return;
      case 'blocked': case 'tamper': case 'regression': case 'integration': case 'warn':
        await this.updateBoard(project, ev.spec, describe(ev));
        await this.broadcast({ text: `${head} · ${describe(ev)}` });
        return;
      case 'gate':
        if (ev.state !== 'pending') await this.updateBoard(project, ev.spec, describe(ev));
        return;
      case 'stop': case 'done':
        await this.updateBoard(project, ev.spec, describe(ev));
        return;
      case 'end': {
        await this.updateBoard(project, ev.spec, esc(T.evEnded(ev.reason, ev.iterations)));
        await this.broadcast({ text: `${head} · ${esc(T.evEnded(ev.reason, ev.iterations))}\n\n${await specStatusText(project, ev.spec)}` });
        delete this.state.boards[key]; this.dirty = true;
        return;
      }
      default: return;
    }
  }

  private async boardText(project: string, spec: string, last: string): Promise<string> {
    return `${await specStatusText(project, spec)}\n\n${T.boardLast(last, esc(new Date().toISOString().slice(11, 19)))}`;
  }

  private async updateBoard(project: string, spec: string, last: string): Promise<void> {
    const key = `${project}::${spec}`;
    const boards = this.state.boards[key];
    const text = await this.boardText(project, spec, last);
    if (!boards || !boards.length) {
      // Loop is running but we have no board (daemon started mid-run) → create one silently.
      if (!(await getLoopStatus(project, spec)).running) return;
      const refs = [];
      for (const chatId of this.cfg.notify) {
        try {
          const id = await this.send(chatId, { text, silent: true });
          if (id) refs.push({ chatId, messageId: id, runStartedAt: new Date().toISOString(), lastText: text });
        } catch (e) { this.log(`board post to ${chatId} failed: ${(e as Error).message}`); }
      }
      this.state.boards[key] = refs; this.dirty = true;
      return;
    }
    for (const board of boards) {
      if (board.lastText === text) continue;
      await this.api.editMessageText(board.chatId, board.messageId, text, { parse_mode: 'HTML' }).catch((e: Error) => {
        if (!/not modified/i.test(e.message)) this.log(`board edit failed: ${e.message}`);
      });
      board.lastText = text; this.dirty = true;
    }
  }

  // ------------------------------------------------------------ gates

  private async scanGates(project: string): Promise<void> {
    for (const spec of await this.specsOf(project)) {
      const pending = await listPendingGates(project, spec);
      for (const g of pending) {
        const pkey = `${project}::${spec}::${g.id}`;
        if (this.state.postedGates[pkey]) continue;
        // Was it decided already (e.g. via another chat) — skip posting.
        if (await readDecision(project, g.id)) { this.state.postedGates[pkey] = 'decided'; this.dirty = true; continue; }
        if (!verifyPendingSig(g, this.cfg.gateSecret)) {
          // Not signed by the runner (forged / rewritten inside the project) → never show buttons for it.
          this.log(`gate ${g.id} in ${spec}: bad or missing runner signature — ignored`);
          this.state.postedGates[pkey] = 'unsigned'; this.dirty = true; continue;
        }
        let delivered = 0;
        try { delivered = await this.postGate(project, spec, g); } catch (e) { this.log(`gate post failed: ${(e as Error).message}`); }
        // Mark posted only if at least one chat actually got a card; otherwise retry on the next tick
        // (a transient Telegram outage must not leave a gate silently waiting for its timeout).
        if (delivered > 0) { this.state.postedGates[pkey] = new Date().toISOString(); this.dirty = true; }
        else this.log(`gate ${g.id}: no chat reached — will retry`);
      }
      // prune postedGates for gates no longer pending
      const ids = new Set(pending.map(g => g.id));
      for (const k of Object.keys(this.state.postedGates)) {
        if (k.startsWith(`${project}::${spec}::`) && !ids.has(k.split('::')[2])) { delete this.state.postedGates[k]; this.dirty = true; }
      }
    }
  }

  /** Card text is composed ONLY from daemon-owned strings keyed by gate kind + numeric details. */
  private gateCardText(spec: string, project: string, id: string, createdAt: string, g?: PendingGate, decided?: { decision: string; by: string; at: string }): string {
    const KINDS: GateKind[] = ['spec-gate-fail', 'integration-fail', 'every-n-tasks', 'manual'];
    const kind = g && KINDS.includes(g.kind) ? g.kind : undefined;
    const NUM_KEYS = ['exitCode', 'attempts', 'greens', 'remaining'];
    const nums = g?.detail ? Object.entries(g.detail).filter(([k, v]) => NUM_KEYS.includes(k) && Number.isFinite(Number(v))).map(([k, v]) => `${esc(k)} ${Number(v)}`).join(' · ') : '';
    const lines = [
      `${b(T.gateTitle())} · ${b(this.label(project))}/${b(spec)}`,
      '',
      kind ? esc(T.gateKind(kind)) : '',
      kind ? esc(T.gateKindText(kind)) : '',
      nums,
      '',
      esc(T.gateOpened(id, ago(createdAt))),
      decided ? esc(T.gateDecided(decided.decision, decided.by, decided.at)) : T.gateHint(),
    ].filter(Boolean);
    return lines.join('\n');
  }

  private async postGate(project: string, spec: string, g: PendingGate): Promise<number> {
    let delivered = 0;
    // The card is HARNESS text only. Repo-derived detail (e.g. judge reasons) is sent as a
    // separate untrusted message so it can never sit next to the buttons.
    for (const chatId of this.cfg.notify) {
      const key = randomBytes(4).toString('hex'); // one key per chat so every card can be updated
      const keyboard: InlineKeyboardMarkup = { inline_keyboard: [[{ text: T.btnApprove(), callback_data: `g:${key}:a` }, { text: T.btnReject(), callback_data: `g:${key}:r` }]] };
      try {
        const id = await this.send(chatId, { text: this.gateCardText(spec, project, g.id, g.createdAt, g), keyboard });
        if (id) {
          delivered++;
          this.state.gateKeys[key] = { project, spec, id: g.id, nonce: g.nonce, chatId, messageId: id, createdAt: g.createdAt };
          try { await updatePendingGate(project, spec, g.id, { postedMessageId: id, postedChatId: chatId }); } catch { /* runner may have consumed it */ }
        }
        // Repo/agent-derived text (auditor reasons, runner summary) goes in a SEPARATE untrusted message.
        const extra = [g.summary, ...(g.detail ? Object.entries(g.detail).filter(([k]) => /reason|output|log|note|summary/i.test(k)).map(([, v]) => String(v)) : [])].filter(Boolean).join('\n');
        if (extra) await this.send(chatId, { text: untrusted(extra, 800, T.gateContextLabel()), silent: true });
      } catch (e) { this.log(`gate card to ${chatId} failed: ${(e as Error).message}`); }
    }
    this.dirty = true;
    return delivered;
  }
}

// ---------------------------------------------------------------- helpers

function describe(ev: LoopEvent): string {
  switch (ev.type) {
    case 'iter': return esc(T.evIter(ev.iter, ev.taskId, ev.remaining));
    case 'green': return esc(T.evGreen(ev.taskId));
    case 'red': return esc(T.evRed(ev.taskId, String(ev.exitCode ?? '?'), ev.failureClass));
    case 'blocked': return `${esc(T.evBlocked(ev.taskId, ''))}${ev.reason ? ` — ${inlineUntrusted(ev.reason)}` : ''}`;
    case 'tamper': return `${esc(T.evTamper(ev.taskId, ''))} ${inlineUntrusted(ev.reason)}`;
    case 'unverified': return esc(T.evUnverified(ev.taskId));
    case 'judge': return `${esc(T.evJudge(ev.verdict, ev.taskId, ''))}${ev.reasons ? ` — ${inlineUntrusted(ev.reasons)}` : ''}`;
    case 'regression': return esc(T.evRegression(ev.taskId ?? '?'));
    case 'spec-gate': return `${esc(T.evSpecGate(ev.verdict, ''))}${ev.reasons ? ` — ${inlineUntrusted(ev.reasons)}` : ''}`;
    case 'integration': return `${esc(T.evIntegration(ev.verdict, ''))}${ev.detail ? ` ${inlineUntrusted(ev.detail)}` : ''}`;
    case 'gate': return esc(T.evGate(ev.state, ev.kind ?? '', ev.by ?? ''));
    case 'stop': return esc(T.evStop(ev.by ?? '', ev.reason));
    case 'done': return esc(T.evDone());
    case 'warn': return `⚠️ ${inlineUntrusted(ev.message)}`;
    case 'start': return esc(T.evLoopStarted());
    case 'end': return esc(T.evEnded(ev.reason));
    default: return esc((ev as any).message ?? ev.raw).slice(0, 200);
  }
}

async function readVersion(): Promise<string> {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    for (const rel of ['../../package.json', '../package.json']) {
      try { return JSON.parse(await fs.readFile(join(here, rel), 'utf-8')).version; } catch { /* next */ }
    }
  } catch { /* ignore */ }
  return 'unknown';
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
