import { promises as fs } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { readEnvFile, ensureGateSecret, TELEGRAM_ENV } from '../core/gates.js';

/**
 * Daemon configuration + persisted state.
 *
 * ~/.spec-workflow/telegram.env      (0600)  — secrets & policy, KEY=VALUE:
 *   TELEGRAM_BOT_TOKEN=123:ABC...           the loop_bot token (NOT the orchestrator bot's)
 *   TELEGRAM_ALLOW_FROM=111,222             numeric Telegram user ids allowed to command the daemon
 *   TELEGRAM_NOTIFY=111                     (optional) chat ids that receive pushes; default = ALLOW_FROM
 *   TELEGRAM_PROJECTS=/abs/a,/abs/b         (optional) extra project roots besides the MCP registry
 *   TELEGRAM_SEND_ONLY=true                 (optional) never poll — pushes only (safe with a shared token)
 *   GATE_SECRET=<hex>                       auto-generated
 * ~/.spec-workflow/tg-state.json     — update offset, board messages, gate keys, per-chat current project.
 */

export interface TelegramConfig {
  token: string;
  allowFrom: number[];
  notify: number[];
  extraProjects: string[];
  sendOnly: boolean;
  gateSecret: string;
  stateFile: string;
  auditDir: string;
}

export const STATE_FILE = join(homedir(), '.spec-workflow', 'tg-state.json');
export const AUDIT_DIR = join(homedir(), '.spec-workflow', 'audit');

function idList(v: string | undefined): number[] {
  return (v || '').split(/[,\s]+/).map(s => s.trim()).filter(Boolean).map(Number).filter(n => Number.isInteger(n) && n > 0);
}

export async function loadConfig(): Promise<TelegramConfig> {
  const env = { ...(await readEnvFile(TELEGRAM_ENV)), ...pickProcessEnv() };
  const token = env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error(`TELEGRAM_BOT_TOKEN missing. Put it in ${TELEGRAM_ENV} (chmod 600) or the environment.`);
  const allowFrom = idList(env.TELEGRAM_ALLOW_FROM);
  if (allowFrom.length === 0) throw new Error(`TELEGRAM_ALLOW_FROM is empty — refusing to start a bot nobody may command. Set numeric user ids in ${TELEGRAM_ENV}.`);
  const notify = idList(env.TELEGRAM_NOTIFY);
  const gateSecret = await ensureGateSecret(TELEGRAM_ENV);
  return {
    token,
    allowFrom,
    notify: notify.length ? notify : allowFrom,
    extraProjects: (env.TELEGRAM_PROJECTS || '').split(',').map(s => s.trim()).filter(Boolean),
    sendOnly: /^(1|true|yes)$/i.test(env.TELEGRAM_SEND_ONLY || ''),
    gateSecret,
    stateFile: STATE_FILE,
    auditDir: AUDIT_DIR,
  };
}

function pickProcessEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_ALLOW_FROM', 'TELEGRAM_NOTIFY', 'TELEGRAM_PROJECTS', 'TELEGRAM_SEND_ONLY']) {
    if (process.env[k]) out[k] = process.env[k]!;
  }
  return out;
}

// ---------------------------------------------------------------- persisted state

export interface BoardRef { chatId: number; messageId: number; runStartedAt: string; lastText?: string }
export interface GateKeyRef { project: string; spec: string; id: string; nonce: string; chatId: number; messageId: number; createdAt: string }

export interface DaemonState {
  offset: number;
  /** per-project byte offset into loop-audit.log */
  auditOffsets: Record<string, number>;
  /** chatId → current project path (for commands that omit <project>) */
  currentProject: Record<string, string>;
  /** `${project}::${spec}` → one board message per notify chat */
  boards: Record<string, BoardRef[]>;
  /** short callback key → gate */
  gateKeys: Record<string, GateKeyRef>;
  /** `${project}::${spec}::${gateId}` → posted (dedupe across restarts) */
  postedGates: Record<string, string>;
  /** short callback key → typed payload (documents / task actions / confirmations) */
  cbKeys: Record<string, { kind: string; project: string; spec?: string; taskId?: string; flag?: string; num?: number; at: number }>;
}

export function emptyState(): DaemonState {
  return { offset: 0, auditOffsets: {}, currentProject: {}, boards: {}, gateKeys: {}, postedGates: {}, cbKeys: {} };
}

export async function loadState(file: string = STATE_FILE): Promise<DaemonState> {
  try {
    const raw = JSON.parse(await fs.readFile(file, 'utf-8'));
    return { ...emptyState(), ...raw };
  } catch {
    return emptyState();
  }
}

export async function saveState(state: DaemonState, file: string = STATE_FILE): Promise<void> {
  await fs.mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  await fs.writeFile(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  await fs.rename(tmp, file);
}
