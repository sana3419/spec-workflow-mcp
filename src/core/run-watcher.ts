import { promises as fs } from 'fs';
import { join } from 'path';
import { PathUtils } from './path-utils.js';

/**
 * Incremental reader of `.spec-workflow/loop-audit.log` — the loop runner's single event stream.
 * Every line is `<iso-ts> [<spec>] <message>`. This module tails the file by byte offset (so a
 * daemon restart resumes where it left off) and parses the well-known message shapes into typed
 * events. Anything it does not recognise still surfaces as `{ type: 'other' }` so nothing is lost.
 */

export type LoopEvent =
  | { type: 'start'; spec: string; ts: string; pid?: number; raw: string }
  | { type: 'end'; spec: string; ts: string; reason: string; iterations?: number; raw: string }
  | { type: 'iter'; spec: string; ts: string; iter: number; taskId: string; remaining: number; raw: string }
  | { type: 'green'; spec: string; ts: string; taskId: string; raw: string }
  | { type: 'red'; spec: string; ts: string; taskId: string; exitCode?: number; failureClass?: string; raw: string }
  | { type: 'blocked'; spec: string; ts: string; taskId: string; reason: string; raw: string }
  | { type: 'tamper'; spec: string; ts: string; taskId: string; reason: string; raw: string }
  | { type: 'unverified'; spec: string; ts: string; taskId: string; raw: string }
  | { type: 'judge'; spec: string; ts: string; taskId: string; verdict: 'pass' | 'fail' | 'skipped'; reasons?: string; raw: string }
  | { type: 'regression'; spec: string; ts: string; taskId?: string; raw: string }
  | { type: 'spec-gate'; spec: string; ts: string; verdict: 'pass' | 'fail' | 'skipped' | 'advisory-pass' | 'overridden'; reasons?: string; raw: string }
  | { type: 'integration'; spec: string; ts: string; verdict: 'pass' | 'fail' | 'fix'; detail?: string; raw: string }
  | { type: 'gate'; spec: string; ts: string; state: 'pending' | 'approve' | 'reject' | 'timeout' | 'unavailable' | 'invalid' | 'aborted'; id?: string; kind?: string; by?: string; raw: string }
  | { type: 'stop'; spec: string; ts: string; by?: string; reason: string; raw: string }
  | { type: 'done'; spec: string; ts: string; raw: string }
  | { type: 'warn'; spec: string; ts: string; message: string; raw: string }
  | { type: 'other'; spec: string; ts: string; message: string; raw: string };

const LINE = /^(\S+)\s+\[([^\]]+)\]\s+(.*)$/;

export function parseAuditLine(line: string): LoopEvent | null {
  const m = line.match(LINE);
  if (!m) return null;
  const [, ts, spec, msg] = m;
  const raw = line;
  let x: RegExpMatchArray | null;

  if ((x = msg.match(/^loop-run START .*?pid=(\d+)/))) return { type: 'start', spec, ts, pid: Number(x[1]), raw };
  if (msg.startsWith('loop-run START')) return { type: 'start', spec, ts, raw };
  if ((x = msg.match(/^loop-run END reason=(\S+)(?: iterations=(\d+))?/))) return { type: 'end', spec, ts, reason: x[1], iterations: x[2] ? Number(x[2]) : undefined, raw };
  if ((x = msg.match(/^loop-run END \(iterations=(\d+)\)/))) return { type: 'end', spec, ts, reason: 'UNKNOWN', iterations: Number(x[1]), raw };
  if ((x = msg.match(/^loop-run ABORTED/))) return { type: 'end', spec, ts, reason: 'ABORTED', raw };
  if ((x = msg.match(/^ABORT /))) return { type: 'end', spec, ts, reason: 'ABORT', raw };
  if ((x = msg.match(/^iter=(\d+) task=(\S+) remaining=(\d+)/))) return { type: 'iter', spec, ts, iter: Number(x[1]), taskId: x[2], remaining: Number(x[3]), raw };
  if ((x = msg.match(/^task=(\S+) GREEN/))) return { type: 'green', spec, ts, taskId: x[1], raw };
  if ((x = msg.match(/^task=(\S+) RED \(harness exit (\d+)(?:, class=(\S+))?\)/))) return { type: 'red', spec, ts, taskId: x[1], exitCode: Number(x[2]), failureClass: x[3], raw };
  if ((x = msg.match(/^task=(\S+) BLOCKED(?: \(agent\))?:?\s*(.*)$/))) return { type: 'blocked', spec, ts, taskId: x[1], reason: x[2], raw };
  if ((x = msg.match(/^task=(\S+) TAMPER:\s*(.*)$/))) return { type: 'tamper', spec, ts, taskId: x[1], reason: x[2], raw };
  if ((x = msg.match(/^task=(\S+) (UNVERIFIED|SELF-CERTIFIED)/))) return { type: 'unverified', spec, ts, taskId: x[1], raw };
  if ((x = msg.match(/^task=(\S+) JUDGE (pass|fail|skipped)\b(?:.*?:\s*(.*))?$/))) return { type: 'judge', spec, ts, taskId: x[1], verdict: x[2] as any, reasons: x[3], raw };
  if ((x = msg.match(/^WARN REGRESSION after task=(\S+)/))) return { type: 'regression', spec, ts, taskId: x[1], raw };
  if ((x = msg.match(/^SPEC-GATE (pass|fail|skipped|advisory-pass|overridden)\b(?:.*?:\s*(.*))?$/))) return { type: 'spec-gate', spec, ts, verdict: x[1] as any, reasons: x[2], raw };
  if ((x = msg.match(/^INTEGRATION (pass|fail)\b\s*(.*)$/))) return { type: 'integration', spec, ts, verdict: x[1] as any, detail: x[2], raw };
  if ((x = msg.match(/^INTEGRATION (judge fail|extra fix)/))) return { type: 'integration', spec, ts, verdict: 'fix', detail: msg, raw };
  if ((x = msg.match(/^GATE (pending|approve|reject|timeout|unavailable|aborted) (?:id=(\S+))?(?:.*?kind=(\S+))?(?:.*?by=(\S+))?/))) return { type: 'gate', spec, ts, state: x[1] as any, id: x[2], kind: x[3], by: x[4], raw };
  if ((x = msg.match(/^GATE id=(\S+) (INVALID|aborted)/))) return { type: 'gate', spec, ts, state: x[2] === 'INVALID' ? 'invalid' : 'aborted', id: x[1], raw };
  if ((x = msg.match(/^STOP by=(\S+)/))) return { type: 'stop', spec, ts, by: x[1], reason: 'stop', raw };
  if ((x = msg.match(/^STOP (.*)$/))) return { type: 'stop', spec, ts, reason: x[1], raw };
  if (msg.startsWith('DONE')) return { type: 'done', spec, ts, raw };
  if ((x = msg.match(/^WARN (.*)$/))) return { type: 'warn', spec, ts, message: x[1], raw };
  return { type: 'other', spec, ts, message: msg, raw };
}

export function auditLogPath(projectPath: string): string {
  return join(PathUtils.getWorkflowRoot(PathUtils.translatePath(projectPath)), 'loop-audit.log');
}

/**
 * Read new complete lines since `offset`. Handles truncation/rotation (size < offset → restart at 0).
 * Returns the events and the new offset to persist.
 */
export async function readNewEvents(projectPath: string, offset: number): Promise<{ events: LoopEvent[]; offset: number; truncated: boolean }> {
  const file = auditLogPath(projectPath);
  let size: number;
  try { size = (await fs.stat(file)).size; } catch { return { events: [], offset, truncated: false }; }
  let truncated = false;
  if (size < offset) { offset = 0; truncated = true; }
  if (size === offset) return { events: [], offset, truncated };

  const fh = await fs.open(file, 'r');
  try {
    const len = size - offset;
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, offset);
    let text = buf.toString('utf-8');
    // keep a trailing partial line for next time
    const lastNl = text.lastIndexOf('\n');
    if (lastNl < 0) return { events: [], offset, truncated };
    const consumed = Buffer.byteLength(text.slice(0, lastNl + 1), 'utf-8');
    text = text.slice(0, lastNl);
    const events: LoopEvent[] = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      const ev = parseAuditLine(line);
      if (ev) events.push(ev);
    }
    return { events, offset: offset + consumed, truncated };
  } finally {
    await fh.close();
  }
}

/** Last N raw lines of the audit log for a spec (or all specs). */
export async function tailAudit(projectPath: string, n: number, spec?: string): Promise<string[]> {
  let raw: string;
  try { raw = await fs.readFile(auditLogPath(projectPath), 'utf-8'); } catch { return []; }
  const lines = raw.split('\n').filter(l => l.trim() && (!spec || l.includes(`[${spec}]`)));
  return lines.slice(-n);
}
