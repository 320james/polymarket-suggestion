/**
 * Exit writer — persist ExitSignals as Suggestion(type=EXIT) rows and
 * transition the triggering BUY to status=EXITED in a single transaction.
 *
 * Dedup: if an open EXIT row already exists for (conditionId, tokenId, type=EXIT),
 * refresh it instead of creating a duplicate. originalHolderIds on the EXIT
 * row is copied from the BUY's frozen list and never changes thereafter.
 *
 * Note on priceAtSignal: Suggestion.priceAtSignal is non-null. For exits
 * whose CLOB midpoint was unavailable, we fall back to the BUY row's
 * priceAtSignal (the last known price). This keeps the column populated
 * for the dashboard.
 */

import type { PrismaClient, Prisma } from "@prisma/client";
import type { ExitSignal } from "./exits.js";

const OPEN_STATUSES = ["NEW", "NOTIFIED"] as const;
type OpenStatus = (typeof OPEN_STATUSES)[number];

export interface WriteExitsOptions {
  alertConfidenceStep: number;
}

export interface WriteExitsResult {
  /** All open EXIT rows produced/refreshed this pass. */
  active: WriteExitsRow[];
  created: number;
  updated: number;
  buysTransitioned: number;
}

export interface WriteExitsRow {
  exitSuggestionId: number;
  buySuggestionId: number;
  conditionId: string;
  tokenId: string;
  confidence: number;
  status: OpenStatus;
  shouldRenotify: boolean;
  wasJustCreated: boolean;
}

export async function writeExitSuggestions(
  prisma: PrismaClient,
  signals: ExitSignal[],
  opts: WriteExitsOptions,
): Promise<WriteExitsResult> {
  let created = 0;
  let updated = 0;
  let buysTransitioned = 0;
  const active: WriteExitsRow[] = [];

  for (const sig of signals) {
    const { buy } = sig;
    const supportingJson = JSON.stringify(sig.stillHoldingIds);
    const livePrice = sig.livePrice ?? buy.priceAtSignal;

    // confidence: percentage of original holders who have exited (0..100).
    const confidence = Math.round(sig.exitFractionObserved * 100);
    // consensusScore: the raw fraction (0..1), useful for trend tracking.
    const consensusScore = sig.exitFractionObserved;
    // distinctHolders on an EXIT row = who STILL holds (small number).
    const distinctHolders = sig.stillHoldingIds.length;

    const rationale =
      `${sig.goneCount} of ${sig.originalHolderIds.length} ` +
      `original vetted holders have exited this position. ` +
      `Live ${formatCents(livePrice)} vs blended entry ${formatCents(buy.blendedEntry)}.`;

    const existing = await prisma.suggestion.findFirst({
      where: {
        conditionId: buy.conditionId,
        tokenId: buy.tokenId,
        type: "EXIT",
        status: { in: [...OPEN_STATUSES] },
      },
    });

    const common: Prisma.SuggestionUncheckedUpdateInput = {
      marketQuestion: buy.marketQuestion,
      outcome: buy.outcome,
      outcomeIndex: buy.outcomeIndex,
      confidence,
      consensusScore,
      distinctHolders,
      blendedEntry: buy.blendedEntry,
      priceAtSignal: livePrice,
      slippageCents: 0,
      alreadyRan: false,
      herdingPenalty: 1,
      rationale,
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
          : confidence - existing.lastNotifiedConfidence >= opts.alertConfidenceStep;
      active.push({
        exitSuggestionId: existing.id,
        buySuggestionId: buy.id,
        conditionId: buy.conditionId,
        tokenId: buy.tokenId,
        confidence,
        status: existing.status as OpenStatus,
        shouldRenotify,
        wasJustCreated: false,
      });
      // Note: BUY was already transitioned to EXITED on the first exit fire.
      // We don't re-transition here (it's already terminal).
      continue;
    }

    // First time this exit fires: create the EXIT row AND transition the BUY
    // to EXITED in one transaction so we never end up with an orphan.
    const [exitRow] = await prisma.$transaction([
      prisma.suggestion.create({
        data: {
          type: "EXIT",
          conditionId: buy.conditionId,
          tokenId: buy.tokenId,
          marketQuestion: buy.marketQuestion,
          outcome: buy.outcome,
          outcomeIndex: buy.outcomeIndex,
          confidence,
          consensusScore,
          distinctHolders,
          blendedEntry: buy.blendedEntry,
          priceAtSignal: livePrice,
          slippageCents: 0,
          alreadyRan: false,
          herdingPenalty: 1,
          rationale,
          originalHolderIds: buy.originalHolderIds, // copy of the BUY's frozen list
          supportingIds: supportingJson,
          status: "NEW",
          relatedSuggestionId: buy.id,
        },
      }),
      prisma.suggestion.update({
        where: { id: buy.id },
        data: { status: "EXITED" },
      }),
    ]);
    created++;
    buysTransitioned++;

    active.push({
      exitSuggestionId: exitRow.id,
      buySuggestionId: buy.id,
      conditionId: buy.conditionId,
      tokenId: buy.tokenId,
      confidence,
      status: "NEW",
      shouldRenotify: true,
      wasJustCreated: true,
    });
  }

  return { active, created, updated, buysTransitioned };
}

function formatCents(p: number): string {
  return `${Math.round(p * 100)}¢`;
}
