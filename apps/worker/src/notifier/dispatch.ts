/**
 * Dispatcher — turn a Suggestion id into a NotifierPayload, call the
 * configured channel, log the attempt, and stamp the Suggestion on success.
 *
 * Lifecycle on success:
 *   - Append a row to NotificationLog (success=true).
 *   - Update Suggestion:
 *       lastNotifiedAt        = now
 *       lastNotifiedConfidence = current confidence
 *       notifyCount           += 1
 *       status                = NEW → NOTIFIED  (only NEW transitions; later
 *                                                statuses are untouched)
 *
 * Lifecycle on transient failure:
 *   - Append a NotificationLog row (success=false, error, retryable=true).
 *   - DO NOT stamp the Suggestion. Next poll's writer will re-flag it as
 *     shouldRenotify=true (since lastNotifiedConfidence is still null/below
 *     current) and we'll try again automatically. Acts as an infinite-retry
 *     queue with one attempt per poll cycle — fine for a single-user tool.
 *
 * Lifecycle on permanent failure:
 *   - Same as transient (logs + no stamp) — but we surface it loudly in
 *     the warn log and the dashboard NotificationLog view. Manual fix
 *     (rotate token, unblock bot, etc.) is required.
 */

import type { PrismaClient, Suggestion } from "@prisma/client";
import type { WriteSuggestionsRow } from "../pipeline/suggestion-writer.js";
import type { WriteExitsRow } from "../pipeline/exit-writer.js";
import type {
  NotifierChannel,
  NotifierPayload,
  NotifierTraderLine,
} from "./types.js";
import { log } from "../log.js";

export interface DispatcherDeps {
  prisma: PrismaClient;
  channel: NotifierChannel;
}

export interface DispatchSummary {
  attempted: number;
  succeeded: number;
  failed: number;
  retryableFailures: number;
}

/**
 * Send notifications for a batch of writer rows. Returns aggregate counts
 * so the caller can roll them up into the WorkerRun heartbeat.
 *
 * Each row is sent serially. Telegram per-chat limit is 1 msg/sec, so a
 * tiny natural pause is fine; if we ever batch >50 in one poll we'll add
 * an explicit delay.
 */
export async function dispatchBuyNotifications(
  deps: DispatcherDeps,
  rows: WriteSuggestionsRow[],
): Promise<DispatchSummary> {
  const summary: DispatchSummary = {
    attempted: 0,
    succeeded: 0,
    failed: 0,
    retryableFailures: 0,
  };
  for (const r of rows) {
    summary.attempted++;
    const out = await sendOne(deps, {
      suggestionId: r.suggestionId,
      reason: r.wasJustCreated ? "NEW" : "CONFIDENCE_RISE",
    });
    if (out.ok) summary.succeeded++;
    else {
      summary.failed++;
      if (out.retryable) summary.retryableFailures++;
    }
  }
  return summary;
}

export async function dispatchExitNotifications(
  deps: DispatcherDeps,
  rows: WriteExitsRow[],
): Promise<DispatchSummary> {
  const summary: DispatchSummary = {
    attempted: 0,
    succeeded: 0,
    failed: 0,
    retryableFailures: 0,
  };
  for (const r of rows) {
    summary.attempted++;
    const out = await sendOne(deps, {
      suggestionId: r.exitSuggestionId,
      reason: "EXIT",
    });
    if (out.ok) summary.succeeded++;
    else {
      summary.failed++;
      if (out.retryable) summary.retryableFailures++;
    }
  }
  return summary;
}

interface SendArgs {
  suggestionId: number;
  reason: NotifierPayload["reason"];
}

async function sendOne(
  deps: DispatcherDeps,
  args: SendArgs,
): Promise<{ ok: boolean; retryable: boolean }> {
  const { prisma, channel } = deps;

  // Re-fetch the Suggestion fresh so the message reflects the latest write.
  const suggestion = await prisma.suggestion.findUnique({
    where: { id: args.suggestionId },
  });
  if (!suggestion) {
    log.warn(
      { suggestionId: args.suggestionId },
      "suggestion vanished before notify",
    );
    return { ok: false, retryable: false };
  }

  const traders = await loadSupportingTraders(prisma, suggestion);
  const marketUrl = await loadMarketUrl(prisma, suggestion.conditionId);

  const payload: NotifierPayload = {
    suggestion,
    traders,
    marketUrl,
    reason: args.reason,
  };

  const attempt =
    (await prisma.notificationLog.count({
      where: { suggestionId: suggestion.id },
    })) + 1;

  let result;
  try {
    result = await channel.send(payload);
  } catch (err) {
    // A channel that throws is a bug, but DON'T crash the worker.
    result = {
      ok: false,
      error: `channel threw: ${(err as Error).message}`,
      retryable: true,
    };
  }

  // Log the attempt regardless of outcome.
  await safelyWriteLog(prisma, {
    suggestionId: suggestion.id,
    channel: channel.name,
    success: result.ok,
    error: result.ok ? null : (result.error ?? "unknown"),
    attempt,
  });

  if (!result.ok) {
    log.warn(
      {
        suggestionId: suggestion.id,
        channel: channel.name,
        attempt,
        retryable: result.retryable,
        error: result.error,
      },
      "notification send failed",
    );
    return { ok: false, retryable: result.retryable === true };
  }

  // Stamp the suggestion: NEW → NOTIFIED, and update dedup bookkeeping.
  await prisma.suggestion.update({
    where: { id: suggestion.id },
    data: {
      lastNotifiedAt: new Date(),
      lastNotifiedConfidence: suggestion.confidence,
      notifyCount: { increment: 1 },
      ...(suggestion.status === "NEW" ? { status: "NOTIFIED" } : {}),
    },
  });

  return { ok: true, retryable: false };
}

async function loadSupportingTraders(
  prisma: PrismaClient,
  suggestion: Suggestion,
): Promise<NotifierTraderLine[]> {
  const ids = parseIds(suggestion.supportingIds);
  if (ids.length === 0) return [];
  const rows = await prisma.trackedTrader.findMany({
    where: { id: { in: ids } },
  });
  return rows
    .map((r) => ({
      proxyAddress: r.id,
      username: r.username,
      trustWeight: r.trustWeight,
      winRate: r.winRate,
      profitFactor: r.profitFactor,
      resolvedTrades: r.resolvedTrades,
    }))
    .sort((a, b) => b.trustWeight - a.trustWeight);
}

/** Build the Polymarket UI URL for a market, preferring slug when known. */
async function loadMarketUrl(
  prisma: PrismaClient,
  conditionId: string,
): Promise<string> {
  const m = await prisma.market.findUnique({ where: { conditionId } });
  if (m?.slug) return `https://polymarket.com/event/${m.slug}`;
  // Fallback: conditionId-based URL still resolves on polymarket.com.
  return `https://polymarket.com/market/${conditionId}`;
}

async function safelyWriteLog(
  prisma: PrismaClient,
  data: {
    suggestionId: number;
    channel: string;
    success: boolean;
    error: string | null;
    attempt: number;
  },
): Promise<void> {
  try {
    await prisma.notificationLog.create({ data });
  } catch (err) {
    // Per spec: never crash the worker on a notification-log write failure.
    log.error(
      { err: (err as Error).message },
      "failed to write NotificationLog row",
    );
  }
}

function parseIds(json: string): string[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v)
      ? v.filter((x): x is string => typeof x === "string")
      : [];
  } catch {
    return [];
  }
}
