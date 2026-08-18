/**
 * Minimal Telegram Bot API client (native fetch, no framework). Only what the daemon needs.
 * Telegram hard caps: 4096 chars per message, 64 bytes per callback_data, 50 MB per document.
 */

export interface TgUser { id: number; is_bot?: boolean; username?: string; first_name?: string }
export interface TgChat { id: number; type: 'private' | 'group' | 'supergroup' | 'channel' }
export interface TgMessage {
  message_id: number;
  date: number;
  chat: TgChat;
  from?: TgUser;
  text?: string;
  forward_date?: number;
  forward_from?: TgUser;
  reply_to_message?: TgMessage;
  edit_date?: number;
}
export interface TgCallbackQuery { id: string; from: TgUser; message?: TgMessage; data?: string }
export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  edited_message?: TgMessage;
  callback_query?: TgCallbackQuery;
}
export interface InlineKeyboardButton { text: string; callback_data: string }
export interface InlineKeyboardMarkup { inline_keyboard: InlineKeyboardButton[][] }

export type ParseMode = 'HTML' | undefined;

export class TelegramApiError extends Error {
  constructor(public method: string, public code: number, public description: string) {
    super(`telegram ${method}: ${code} ${description}`);
  }
}

export const TG_MAX_TEXT = 4096;

export class TelegramApi {
  private base: string;
  constructor(token: string, private fetchImpl: typeof fetch = fetch) {
    if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(token)) throw new Error('TELEGRAM_BOT_TOKEN looks malformed');
    this.base = `https://api.telegram.org/bot${token}`;
  }

  private async call<T>(method: string, body?: Record<string, unknown> | FormData, timeoutMs = 30_000, outer?: AbortSignal): Promise<T> {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    outer?.addEventListener('abort', () => ctl.abort(), { once: true });
    try {
      const init: RequestInit = { method: 'POST', signal: ctl.signal };
      if (body instanceof FormData) init.body = body;
      else if (body) { init.headers = { 'content-type': 'application/json' }; init.body = JSON.stringify(body); }
      const res = await this.fetchImpl(`${this.base}/${method}`, init);
      const json = await res.json().catch(() => ({})) as { ok?: boolean; result?: T; error_code?: number; description?: string; parameters?: { retry_after?: number } };
      if (!json.ok) {
        if (json.error_code === 429 && json.parameters?.retry_after) {
          await new Promise(r => setTimeout(r, (json.parameters!.retry_after! + 1) * 1000));
          return this.call<T>(method, body, timeoutMs);
        }
        throw new TelegramApiError(method, json.error_code ?? res.status, json.description ?? res.statusText);
      }
      return json.result as T;
    } finally {
      clearTimeout(t);
    }
  }

  getMe() { return this.call<TgUser>('getMe'); }

  /** Long-poll. `timeout` seconds server-side; we allow +10s on the client. */
  getUpdates(offset: number, timeout = 25, signal?: AbortSignal): Promise<TgUpdate[]> {
    return this.call<TgUpdate[]>('getUpdates', { offset, timeout, allowed_updates: ['message', 'callback_query'] }, (timeout + 10) * 1000, signal);
  }

  async sendMessage(chat_id: number, text: string, opts: { parse_mode?: ParseMode; reply_markup?: InlineKeyboardMarkup; disable_notification?: boolean; reply_to_message_id?: number } = {}): Promise<TgMessage> {
    const chunks = chunk(text, TG_MAX_TEXT);
    let last: TgMessage | undefined;
    for (let i = 0; i < chunks.length; i++) {
      const isLast = i === chunks.length - 1;
      last = await this.call<TgMessage>('sendMessage', {
        chat_id, text: chunks[i],
        ...(opts.parse_mode ? { parse_mode: opts.parse_mode } : {}),
        ...(isLast && opts.reply_markup ? { reply_markup: opts.reply_markup } : {}),
        ...(opts.disable_notification ? { disable_notification: true } : {}),
        ...(i === 0 && opts.reply_to_message_id ? { reply_to_message_id: opts.reply_to_message_id } : {}),
        disable_web_page_preview: true,
      });
    }
    return last!;
  }

  editMessageText(chat_id: number, message_id: number, text: string, opts: { parse_mode?: ParseMode; reply_markup?: InlineKeyboardMarkup } = {}): Promise<TgMessage | true> {
    return this.call<TgMessage | true>('editMessageText', {
      chat_id, message_id, text: text.slice(0, TG_MAX_TEXT),
      ...(opts.parse_mode ? { parse_mode: opts.parse_mode } : {}),
      ...(opts.reply_markup ? { reply_markup: opts.reply_markup } : {}),
      disable_web_page_preview: true,
    });
  }

  editMessageReplyMarkup(chat_id: number, message_id: number, reply_markup?: InlineKeyboardMarkup): Promise<TgMessage | true> {
    return this.call<TgMessage | true>('editMessageReplyMarkup', { chat_id, message_id, reply_markup: reply_markup ?? { inline_keyboard: [] } });
  }

  answerCallbackQuery(callback_query_id: string, text?: string, show_alert = false): Promise<true> {
    return this.call<true>('answerCallbackQuery', { callback_query_id, ...(text ? { text: text.slice(0, 200) } : {}), show_alert });
  }

  async sendDocument(chat_id: number, filename: string, content: Buffer | string, caption?: string): Promise<TgMessage> {
    const fd = new FormData();
    fd.append('chat_id', String(chat_id));
    if (caption) fd.append('caption', caption.slice(0, 1024));
    const bytes = typeof content === 'string' ? Buffer.from(content, 'utf-8') : content;
    fd.append('document', new Blob([bytes]), filename);
    return this.call<TgMessage>('sendDocument', fd, 120_000);
  }
}

/** Split on line boundaries where possible. */
export function chunk(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const out: string[] = [];
  let rest = text;
  let openPre = false;
  const budget = max - 12; // room for </pre> / <pre> wrappers
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', budget);
    if (cut < budget * 0.5) cut = budget;
    let piece = rest.slice(0, cut);
    rest = rest.slice(cut).replace(/^\n/, '');
    if (openPre) piece = '<pre>' + piece;
    const opens = (piece.match(/<pre>/g) || []).length, closes = (piece.match(/<\/pre>/g) || []).length;
    openPre = opens > closes;
    if (openPre) piece += '</pre>';
    out.push(piece);
  }
  if (rest) out.push((openPre ? '<pre>' : '') + rest);
  return out;
}
