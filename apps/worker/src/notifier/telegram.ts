/**
 * Telegram channel — POST to /sendMessage with MarkdownV2 body.
 *
 * Credentials come from env (TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID).
 * NEVER throw on missing creds at module load — the dispatcher checks
 * `isConfigured()` and falls back to CONSOLE if not.
 *
 * Transient failure classification (retryable=true):
 *   - Any network error (fetch threw).
 *   - HTTP 429 (rate-limited) — Telegram includes Retry-After; we honour
 *     it lazily by just marking retryable and letting the dispatcher
 *     re-call us next poll. (Telegram per-bot limit is ~30 msg/sec global,
 *     1 msg/sec per chat — we will never hit either.)
 *   - HTTP 5xx (Telegram outage).
 * Permanent failures (retryable=false):
 *   - HTTP 400 (usually our fault — bad markdown escape, invalid chat id).
 *   - HTTP 401/403 (bad token, bot blocked by user). We log + give up.
 */

import type { NotifierChannel, NotifierPayload, SendResult } from "./types.js";
import { formatTelegramBody } from "./formatter.js";

interface TelegramCreds {
  token: string;
  chatId: string;
}

export class TelegramChannel implements NotifierChannel {
  readonly name = "TELEGRAM" as const;
  constructor(private readonly creds: TelegramCreds) {}

  static fromEnv(): TelegramChannel | null {
    const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
    const chatId = process.env.TELEGRAM_CHAT_ID?.trim();
    if (!token || !chatId) return null;
    return new TelegramChannel({ token, chatId });
  }

  async send(payload: NotifierPayload): Promise<SendResult> {
    const body = formatTelegramBody(payload);
    const url = `https://api.telegram.org/bot${this.creds.token}/sendMessage`;

    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: this.creds.chatId,
          text: body,
          parse_mode: "MarkdownV2",
          disable_web_page_preview: false,
        }),
      });
    } catch (err) {
      return {
        ok: false,
        error: `network: ${(err as Error).message}`,
        retryable: true,
      };
    }

    if (res.ok) return { ok: true };

    // Read error text but cap length so we don't bloat NotificationLog.
    const text = (await safeText(res)).slice(0, 400);
    const retryable = res.status === 429 || res.status >= 500;
    return {
      ok: false,
      error: `HTTP ${res.status}: ${text}`,
      retryable,
    };
  }
}

async function safeText(r: Response): Promise<string> {
  try {
    return await r.text();
  } catch {
    return "(could not read body)";
  }
}
