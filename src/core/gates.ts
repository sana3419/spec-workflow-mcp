import { promises as fs, realpathSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { PathUtils } from './path-utils.js';
import { getRunDir, RUN_FILES } from './run-state.js';

/**
 * Remote approval gates — the contract shared by the bash loop runner (writer of *.pending,
 * reader of decisions) and the Telegram daemon (reader of *.pending, writer of decisions).
 *
 *   PENDING   <project>/.spec-workflow/specs/<spec>/.run/gates/<id>.pending      (runner writes)
 *   DECISION  ~/.spec-workflow/gates/<projectHash>/<id>.json                    (daemon writes)
 *
 * Decisions live OUTSIDE the project on purpose: the implementing agent runs inside the project
 * with write access and must not be able to approve its own gate. Every decision carries an
 * HMAC-SHA256 over (id, nonce, decision, by, at) keyed by GATE_SECRET from
 * ~/.spec-workflow/telegram.env; the runner recomputes it with openssl before honouring it.
 *
 * Bash equivalents (spec-loop-run.sh):
 *   hash    = printf '%s' "$(realpath "$PWD")" | sha256sum | cut -c1-16
 *   hmac    = printf '%s' "$id:$nonce:$decision:$by:$at" | openssl dgst -sha256 -hmac "$GATE_SECRET" | awk '{print $NF}'
 */

export type GateKind = 'spec-gate-fail' | 'integration-fail' | 'every-n-tasks' | 'manual';
export type GateDecision = 'approve' | 'reject';

export interface PendingGate {
  id: string;
  spec: string;
  kind: GateKind;
  nonce: string;
  /** Harness-authored, trusted fields only. */
  summary: string;
  createdAt: string;
  /** Optional harness-authored details (exit codes, counters). Never raw agent output. */
  detail?: Record<string, string | number | boolean>;
  /** Filled in by the daemon once it has posted the card (so a restart doesn't re-post). */
  postedMessageId?: number;
  postedChatId?: number;
  /** HMAC(id:nonce:kind:createdAt, GATE_SECRET) written by the runner — proves the runner authored it. */
  sig?: string;
}

export interface GateDecisionRecord {
  id: string;
  nonce: string;
  decision: GateDecision;
  by: string;
  at: string;
  hmac: string;
}

export const GATES_HOME = join(homedir(), '.spec-workflow', 'gates');
export const TELEGRAM_ENV = join(homedir(), '.spec-workflow', 'telegram.env');

export function projectHash(projectPath: string): string {
  let real = PathUtils.translatePath(projectPath);
  try { real = realpathSync(real); } catch { /* keep as-is */ }
  return createHash('sha256').update(real).digest('hex').slice(0, 16);
}

export function gatesDecisionDir(projectPath: string): string {
  return join(GATES_HOME, projectHash(projectPath));
}

export function gatesPendingDir(projectPath: string, spec: string): string {
  return join(getRunDir(projectPath, spec), RUN_FILES.gatesDir);
}

/** Parse KEY=VALUE lines (no interpolation). Missing file → {}. */
export async function readEnvFile(file: string = TELEGRAM_ENV): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  let raw: string;
  try { raw = await fs.readFile(file, 'utf-8'); } catch { return out; }
  for (const line of raw.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

/** Ensure GATE_SECRET exists in the env file (generated once, 0600). Returns the secret. */
export async function ensureGateSecret(file: string = TELEGRAM_ENV): Promise<string> {
  const env = await readEnvFile(file);
  if (env.GATE_SECRET && env.GATE_SECRET.length >= 32) return env.GATE_SECRET;
  const secret = randomBytes(32).toString('hex');
  await fs.mkdir(join(file, '..'), { recursive: true, mode: 0o700 });
  let existing = '';
  try { existing = await fs.readFile(file, 'utf-8'); } catch { /* new */ }
  const next = existing.replace(/^GATE_SECRET=.*$/m, '').replace(/\n+$/, '') + `\nGATE_SECRET=${secret}\n`;
  await fs.writeFile(file, next.replace(/^\n/, ''), { mode: 0o600 });
  await fs.chmod(file, 0o600).catch(() => {});
  return secret;
}

/** Verify the runner's signature on a pending gate (agent-writable location → must be signed). */
export function verifyPendingSig(g: Pick<PendingGate, 'id' | 'nonce' | 'kind' | 'createdAt' | 'sig'>, secret: string): boolean {
  if (!g.sig) return false;
  const expect = createHmac('sha256', secret).update(`${g.id}:${g.nonce}:${g.kind}:${g.createdAt}`).digest('hex');
  const a = Buffer.from(expect, 'hex'), b = Buffer.from(String(g.sig), 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

export function gateHmac(secret: string, id: string, nonce: string, decision: GateDecision, by: string, at: string): string {
  return createHmac('sha256', secret).update(`${id}:${nonce}:${decision}:${by}:${at}`).digest('hex');
}

export async function listPendingGates(projectPath: string, spec: string): Promise<PendingGate[]> {
  const dir = gatesPendingDir(projectPath, spec);
  let names: string[];
  try { names = await fs.readdir(dir); } catch { return []; }
  const out: PendingGate[] = [];
  for (const n of names) {
    if (!n.endsWith('.pending')) continue;
    try {
      const g = JSON.parse(await fs.readFile(join(dir, n), 'utf-8')) as PendingGate;
      if (g && typeof g.id === 'string' && /^[A-Za-z0-9._-]{1,128}$/.test(g.id) && typeof g.nonce === 'string') out.push(g);
    } catch { /* partial write or junk — skip */ }
  }
  return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** Atomically annotate a pending file (e.g. with the posted Telegram message id). */
export async function updatePendingGate(projectPath: string, spec: string, id: string, patch: Partial<PendingGate>): Promise<void> {
  const file = join(gatesPendingDir(projectPath, spec), `${id}.pending`);
  const g = JSON.parse(await fs.readFile(file, 'utf-8')) as PendingGate;
  const tmp = `${file}.tmp-${process.pid}`;
  await fs.writeFile(tmp, JSON.stringify({ ...g, ...patch }, null, 2));
  await fs.rename(tmp, file);
}

export async function readDecision(projectPath: string, id: string): Promise<GateDecisionRecord | null> {
  try {
    return JSON.parse(await fs.readFile(join(gatesDecisionDir(projectPath), `${id}.json`), 'utf-8'));
  } catch { return null; }
}

/**
 * Record a human decision for a pending gate. Idempotent: an existing decision is returned as-is
 * (so a redelivered Telegram callback cannot flip approve→reject or vice versa).
 */
export async function writeDecision(
  projectPath: string,
  gate: Pick<PendingGate, 'id' | 'nonce'>,
  decision: GateDecision,
  by: string,
  secret: string,
): Promise<{ record: GateDecisionRecord; alreadyDecided: boolean }> {
  const existing = await readDecision(projectPath, gate.id);
  if (existing) return { record: existing, alreadyDecided: true };
  const dir = gatesDecisionDir(projectPath);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const at = new Date().toISOString();
  const record: GateDecisionRecord = { id: gate.id, nonce: gate.nonce, decision, by, at, hmac: gateHmac(secret, gate.id, gate.nonce, decision, by, at) };
  const target = join(dir, `${gate.id}.json`);
  const tmp = `${target}.tmp-${process.pid}`;
  await fs.writeFile(tmp, JSON.stringify(record), { mode: 0o600 });
  await fs.rename(tmp, target);
  return { record, alreadyDecided: false };
}

/** Verify a decision record against a pending gate + secret (what the runner does in bash). */
export function verifyDecision(record: GateDecisionRecord, gate: Pick<PendingGate, 'id' | 'nonce'>, secret: string): boolean {
  if (record.id !== gate.id || record.nonce !== gate.nonce) return false;
  if (record.decision !== 'approve' && record.decision !== 'reject') return false;
  const expect = gateHmac(secret, record.id, record.nonce, record.decision, record.by, record.at);
  const a = Buffer.from(expect, 'hex'), b = Buffer.from(String(record.hmac || ''), 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}
