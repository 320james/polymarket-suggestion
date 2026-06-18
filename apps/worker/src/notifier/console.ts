/**
 * Console channel — fallback / dry-run.
 *
 * Used when the configured channel can't be initialized (missing creds) or
 * when you want to eyeball notifications without spamming Telegram. Prints
 * to stdout via the worker's pino logger.
 */

import type { NotifierChannel, NotifierPayload, SendResult } from "./types.js";
import { formatPlainBody } from "./formatter.js";
import { log } from "../log.js";

export class ConsoleChannel implements NotifierChannel {
  readonly name = "CONSOLE" as const;

  async send(payload: NotifierPayload): Promise<SendResult> {
    const body = formatPlainBody(payload);
    log.info(
      {
        suggestionId: payload.suggestion.id,
        type: payload.suggestion.type,
        confidence: payload.suggestion.confidence,
        reason: payload.reason,
      },
      "[CONSOLE notifier]\n" + body,
    );
    return { ok: true };
  }
}
