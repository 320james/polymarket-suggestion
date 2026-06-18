/**
 * Notifier abstraction — pluggable per-channel `send`.
 *
 * Concrete channels (telegram, pushover, ntfy, email) implement the
 * `NotifierChannel` interface. The dispatcher picks one based on
 * `Config.notifyChannel` and calls `send(payload)`.
 *
 * All channels MUST be:
 *   - Stateless (no mutable instance state).
 *   - Idempotent at the message level (the dispatcher handles dedup).
 *   - Free of secrets in the returned error message (it gets persisted
 *     to NotificationLog and rendered in the dashboard).
 */

import type { Suggestion } from "@prisma/client";

/** Channel identifier persisted in Config.notifyChannel and NotificationLog.channel. */
export type ChannelName = "TELEGRAM" | "PUSHOVER" | "NTFY" | "EMAIL" | "CONSOLE";

/** Per-trader summary line for the notification body. */
export interface NotifierTraderLine {
  proxyAddress: string;
  username: string | null;
  trustWeight: number;
  winRate: number | null;
  profitFactor: number | null;
  resolvedTrades: number;
}

/** Everything a channel needs to render a message. */
export interface NotifierPayload {
  /** The Suggestion row that triggered the send. */
  suggestion: Suggestion;
  /** Vetted traders currently supporting the suggestion (deduped, ordered by trustWeight desc). */
  traders: NotifierTraderLine[];
  /** Polymarket UI link for the market. */
  marketUrl: string;
  /** Why we sent THIS message right now (NEW signal vs confidence-rise vs exit). */
  reason: "NEW" | "CONFIDENCE_RISE" | "EXIT";
}

/** A single send attempt's outcome. The dispatcher uses this for retry decisions. */
export interface SendResult {
  ok: boolean;
  /** Short, human-readable error (safe for NotificationLog.error). Always set when !ok. */
  error?: string;
  /** True if the error looks transient (network blip, 429, 5xx). Drives retry behaviour. */
  retryable?: boolean;
}

export interface NotifierChannel {
  readonly name: ChannelName;
  send(payload: NotifierPayload): Promise<SendResult>;
}
