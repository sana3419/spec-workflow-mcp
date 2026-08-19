import { promises as fs } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';
import type { TgMessage, TgCallbackQuery } from './api.js';
import { projectHash } from '../core/gates.js';

/**
 * Access control + tamper-evident audit for the loop_bot daemon.
 *
 * Policy (fixed, no pairing mode):
 *  - only numeric user ids in TELEGRAM_ALLOW_FROM may command; everyone else is silently dropped
 *  - private chats only (Telegram DM chat_id == user_id); groups are ignored entirely
 *  - commands are read ONLY from fresh `message.text` — never from edited or forwarded messages
 *    and never from the text of a replied-to message (a repo-derived quote must not become a command)
 *  - callback queries must come from an allowlisted user and refer to a message ≤ MAX_CB_AGE old
 */

export const MAX_CB_AGE_SEC = 24 * 3600;
export const SPEC_NAME = /^[A-Za-z0-9._-]{1,64}$/;
export const TASK_ID = /^\d+(\.\d+)*$/;

export function isAllowed(userId: number | undefined, allowFrom: number[]): boolean {
  return userId !== undefined && allowFrom.includes(userId);
}

export function acceptMessage(msg: TgMessage | undefined, allowFrom: number[]): { ok: true; text: string; userId: number; chatId: number } | { ok: false; why: string } {
  if (!msg) return { ok: false, why: 'no message' };
  if (msg.chat.type !== 'private') return { ok: false, why: 'not a private chat' };
  if (!isAllowed(msg.from?.id, allowFrom)) return { ok: false, why: 'sender not allowlisted' };
  if (msg.forward_date || msg.forward_from) return { ok: false, why: 'forwarded' };
  if (msg.edit_date) return { ok: false, why: 'edited' };
  if (typeof msg.text !== 'string' || !msg.text.trim()) return { ok: false, why: 'no text' };
  return { ok: true, text: msg.text.trim(), userId: msg.from!.id, chatId: msg.chat.id };
}

export function acceptCallback(cb: TgCallbackQuery, allowFrom: number[], now = Date.now()): { ok: true; userId: number; chatId: number; messageId: number; data: string } | { ok: false; why: string } {
  if (!isAllowed(cb.from?.id, allowFrom)) return { ok: false, why: 'sender not allowlisted' };
  if (!cb.message) return { ok: false, why: 'no message' };
  if (cb.message.chat.type !== 'private') return { ok: false, why: 'not a private chat' };
  if (now / 1000 - cb.message.date > MAX_CB_AGE_SEC) return { ok: false, why: 'stale' };
  if (typeof cb.data !== 'string' || cb.data.length > 64) return { ok: false, why: 'bad data' };
  return { ok: true, userId: cb.from.id, chatId: cb.message.chat.id, messageId: cb.message.message_id, data: cb.data };
}

// ---------------------------------------------------------------- audit (hash-chained JSONL)

export interface AuditRecord {
  ts: string;
  senderId: number;
  chatId: number;
  updateId?: number;
  cmd: string;
  args: string[];
  project?: string;
  spec?: string;
  result: string;
  prev: string;
  hash?: string;
}

/**
 * Append-only per-project audit file under ~/.spec-workflow/audit/<projectHash>.jsonl (or
 * `_global.jsonl` when no project applies). Each record's `hash` = sha256(prevHash + canonical
 * record without hash) so truncation or in-place edits are detectable with `verifyAuditChain`.
 */
export class Audit {
  constructor(private dir: string) {}

  private file(project?: string) {
    return join(this.dir, `${project ? projectHash(project) : '_global'}.jsonl`);
  }

  async append(rec: Omit<AuditRecord, 'prev' | 'hash'>): Promise<AuditRecord> {
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
    const file = this.file(rec.project);
    const prev = await lastHash(file);
    const full: AuditRecord = { ...rec, prev };
    full.hash = chainHash(prev, full);
    await fs.appendFile(file, JSON.stringify(full) + '\n', { mode: 0o600 });
    return full;
  }
}

/**
 * Chain link for the audit log: sha256(prevHash + the record without its own hash).
 * Producer (`Audit.append`) and verifier (`verifyAuditChain`) must agree exactly, so
 * this is the only place the formula is written.
 */
function chainHash(prev: string, rec: AuditRecord): string {
  return createHash('sha256').update(prev + JSON.stringify({ ...rec, hash: undefined })).digest('hex');
}

async function lastHash(file: string): Promise<string> {
  try {
    const raw = await fs.readFile(file, 'utf-8');
    const lines = raw.trim().split('\n').filter(Boolean);
    if (!lines.length) return '';
    return (JSON.parse(lines[lines.length - 1]) as AuditRecord).hash || '';
  } catch { return ''; }
}

export async function verifyAuditChain(file: string): Promise<{ ok: boolean; records: number; brokenAt?: number }> {
  let raw: string;
  try { raw = await fs.readFile(file, 'utf-8'); } catch { return { ok: true, records: 0 }; }
  const lines = raw.trim().split('\n').filter(Boolean);
  let prev = '';
  for (let i = 0; i < lines.length; i++) {
    const rec = JSON.parse(lines[i]) as AuditRecord;
    const expect = chainHash(prev, rec);
    if (rec.prev !== prev || rec.hash !== expect) return { ok: false, records: lines.length, brokenAt: i };
    prev = rec.hash!;
  }
  return { ok: true, records: lines.length };
}
