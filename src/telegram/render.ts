/**
 * Rendering helpers. Everything the daemon sends uses parse_mode=HTML with EVERY dynamic value
 * passed through `esc()`. Text that originates from the repository or from an agent (task
 * descriptions, judge reasons, log tails, fixnotes) is additionally routed through `untrusted()`,
 * which strips command-looking lines, caps length, and wraps it in <pre> under an explicit
 * "untrusted" banner — so a malicious spec/report cannot impersonate a harness card or plant a
 * "/approve" instruction. Gate cards NEVER include untrusted text (see daemon.ts).
 */

export function esc(s: unknown): string {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

import { T } from './strings.js';

/** Kept as a getter so the language switch applies to messages rendered later. */
export const untrustedBanner = () => T.untrustedBanner();

/** Lines that look like bot commands or harness verdict markers are neutralised. */
const SUSPICIOUS = /^\s*(\/[a-z]|VERDICT\s*:|BLOCKER\s*:|REASONS\s*:|APPROVE|REJECT|✅|❌)/i;

export function untrusted(text: string, maxChars = 1200, label?: string): string {
  const cleaned = String(text ?? '')
    .split('\n')
    .map(l => (SUSPICIOUS.test(l) ? '· ' + l.replace(/^\s*\//, '⁄') : l))
    .join('\n');
  // Cap AFTER escaping so HTML entity inflation can never push a message past Telegram's 4096 limit.
  const cap = Math.min(maxChars, 3000);
  let body = esc(cleaned);
  if (body.length > cap) { const shown = body.slice(0, cap).replace(/&[^;]{0,6}$/, ''); body = shown + `\n… (+${Math.max(0, body.length - shown.length)} chars)`; }
  const banner = untrustedBanner();
  return `<i>${esc(label ? `${banner} · ${label}` : banner)}</i>\n<pre>${body}</pre>`;
}

/** Inline variant for short agent/repo strings inside harness lines: escaped, command/verdict markers neutralised, capped. */
export function inlineUntrusted(s: unknown, max = 200): string {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  const cut = t.length > max ? t.slice(0, max) + '…' : t;
  return `<code>${esc(cut.replace(/(^|\s)\/([a-z])/gi, '$1⁄$2').replace(/\b(VERDICT|APPROVED?|REJECTED?|BLOCKER)\b\s*:?/gi, m => '·' + m.toLowerCase()))}</code>`;
}

export function code(s: unknown): string { return `<code>${esc(s)}</code>`; }
export function b(s: unknown): string { return `<b>${esc(s)}</b>`; }

export function ago(iso?: string, now = Date.now()): string {
  if (!iso) return '–';
  const d = now - new Date(iso).getTime();
  if (!Number.isFinite(d) || d < 0) return '–';
  const m = Math.floor(d / 60000);
  if (m < 1) return 'now';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

export function bar(done: number, total: number, width = 10): string {
  if (!total) return '─'.repeat(width);
  const f = Math.round((done / total) * width);
  return '█'.repeat(f) + '░'.repeat(width - f);
}

/** 0–100% label for a progress bar (empty when there is nothing to measure). */
export function pct(done: number, total: number): string {
  return total ? `${Math.round((done / total) * 100)}%` : '';
}

export function shortPath(p: string): string {
  const parts = p.replace(/\/+$/, '').split('/');
  return parts.slice(-2).join('/');
}

export function statusIcon(s: string): string {
  return s === 'completed' ? '✅' : s === 'in-progress' ? '🔄' : s === 'blocked' ? '⛔' : '⬜';
}
