/**
 * Suggestion writer — translate ConsensusSignals into Suggestion DB rows
 * with proper dedup and re-alert semantics.
 *
 * Lifecycle of a single (conditionId, tokenId) BUY suggestion:
 *
 *   1. First fire: no open Suggestion row exists ⇒ CREATE one.
 *       - status='NEW'
 *       - originalHolderIds = current holder set (FROZEN)
 *       - supportingIds      = current holder set
 *       - lastNotifiedConfidence = null (notifier hasn't sent yet)
 *
 *   2. Re-poll, signal still fires ⇒ UPDATE the existing OPEN row.
 *       - originalHolderIds NEVER changes after first create
 *       - supportingIds refreshed to current holder set
 *       - confidence/score/herding/price refreshed
 *       - status stays NEW or NOTIFIED — DOES NOT regress
 *
 *   3. Confidence climbs ≥ alertConfidenceStep above lastNotifiedConfidence
 *      ⇒ the writer flags `shouldRenotify=true` in its return value so the
 *      notifier knows to fire again (the notifier sets lastNotifiedAt etc).
 *
 *   4. Signal stops firing ⇒ writer does NOT touch the row. Expiry/exit
 *      handling lives in a separate pipeline step (next iteration).
 *
 * "Open" = status in (NEW, NOTIFIED). TAKEN/DISMISSED/EXITED/EXPIRED rows
 * are terminal and a fresh signal will create a brand-new row.
 */

import type { PrismaClient, Prisma } from "@prisma/client";
import type { ConsensusSignal } from "./consensus.js";

const OPEN_STATUSES = ["NEW", "NOTIFIED"] as const;
type OpenStatus = (typeof OPEN_STATUSES)[number];

export interface WriteSuggestionsOptions {
  /** Confidence rise that triggers a re-notify. */
  alertConfidenceStep: number;
}

export interface WriteSuggestionsResult {
  /** All open BUY rows after this write pass, with renotify flags. */
  active: WriteSuggestionsRow[];
  created: number;
  updated: number;
}

export interface WriteSuggestionsRow {
  suggestionId: number;
  conditionId: string;
  tokenId: string;
  confidence: number;
  status: OpenStatus;
  /**
   * True if confidence has risen by ≥ alertConfidenceStep since
   * lastNotifiedConfidence (or if the row has never been notified). The
   * notifier reads this to decide whether to fire.
   */
  shouldRenotify: boolean;
  /** True if just created this pass — useful for logging. */
  wasJustCreated: boolean;
}

export async function writeBuySuggestions(
  prisma: PrismaClient,
  signals: ConsensusSignal[],
  opts: WriteSuggestionsOptions,
): Promise<WriteSuggestionsResult> {
  let created = 0;
  let updated = 0;
  const active: WriteSuggestionsRow[] = [];

  for (const sig of signals) {
    if (!sig.result.fired) continue;

    const supportingIds = sig.holders.map((h) => h.trader.proxyAddress);
    const supportingJson = JSON.stringify(supportingIds);

    // Look for an open BUY row for this (conditionId, tokenId). The
    // schema's composite index `[conditionId, tokenId, type, status]`
    // makes this efficient.
    const existing = await prisma.suggestion.findFirst({
      where: {
        conditionId: sig.conditionId,
        tokenId: sig.tokenId,
        type: "BUY",
        status: { in: [...OPEN_STATUSES] },
      },
    });

    const common: Prisma.SuggestionUncheckedUpdateInput = {
      marketQuestion: sig.marketQuestion,
      outcome: sig.outcome,
      outcomeIndex: sig.outcomeIndex,
      confidence: sig.result.confidence,
      consensusScore: sig.result.rawScore,
      distinctHolders: sig.result.distinctHolders,
      blendedEntry: sig.result.blendedEntry,
      priceAtSignal: sig.livePrice,
      slippageCents: sig.result.slippageCents,
      alreadyRan: sig.result.alreadyRan,
      herdingPenalty: sig.result.herdingPenalty,
      rationale: sig.result.rationale,
      supportingIds: supportingJson,
    };

    if (existing) {
      await prisma.suggestion.update({
        where: { id: existing.id },
        data: common,
      });
      updated++;
      const shouldRenotify =
        existing.lastNotifiedConfidence == null
          ? true
          : sig.result.confidence - existing.lastNotifiedConfidence >=
            opts.alertConfidenceStep;
      active.push({
        suggestionId: existing.id,
        conditionId: sig.conditionId,
        tokenId: sig.tokenId,
        confidence: sig.result.confidence,
        status: existing.status as OpenStatus,
        shouldRenotify,
        wasJustCreated: false,
      });
    } else {
      const row = await prisma.suggestion.create({
        data: {
          type: "BUY",
          conditionId: sig.conditionId,
          tokenId: sig.tokenId,
          marketQuestion: sig.marketQuestion,
          outcome: sig.outcome,
          outcomeIndex: sig.outcomeIndex,
          confidence: sig.result.confidence,
          consensusScore: sig.result.rawScore,
          distinctHolders: sig.result.distinctHolders,
          blendedEntry: sig.result.blendedEntry,
          priceAtSignal: sig.livePrice,
          slippageCents: sig.result.slippageCents,
          alreadyRan: sig.result.alreadyRan,
          herdingPenalty: sig.result.herdingPenalty,
          rationale: sig.result.rationale,
          originalHolderIds: supportingJson, // frozen here, forever
          supportingIds: supportingJson,
          status: "NEW",
        },
      });
      created++;
      active.push({
        suggestionId: row.id,
        conditionId: sig.conditionId,
        tokenId: sig.tokenId,
        confidence: sig.result.confidence,
        status: "NEW",
        shouldRenotify: true,
        wasJustCreated: true,
      });
    }
  }

  return { active, created, updated };
}
