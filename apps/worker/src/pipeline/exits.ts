/**
 * Exit pipeline — for each open BUY suggestion, check whether a critical
 * mass of the ORIGINAL vetted holders have closed out their positions.
 *
 * "Original holders" = the proxy addresses frozen in Suggestion.originalHolderIds
 * when the BUY first fired. shouldSuggestExit() compares that list against
 * the current vetted holder set for the same tokenId. When ≥ exitFraction
 * of the originals are gone, an exit signal fires.
 *
 * This step is DB-bound except for one CLOB midpoint batch at the end
 * (just for tokens that are firing — typically a small set).
 */

import type { PrismaClient, Suggestion } from "@prisma/client";
import type { ClobApiClient } from "@poly/polymarket-api";
import { shouldSuggestExit } from "@poly/shared";

const OPEN_STATUSES = ["NEW", "NOTIFIED"] as const;

export interface ExitSignal {
  /** The triggering BUY row. */
  buy: Suggestion;
  /** Frozen original holder set captured at first BUY fire. */
  originalHolderIds: string[];
  /** Subset of original holders who still hold the token right now. */
  stillHoldingIds: string[];
  /** Number of original holders gone (originalHolderIds.length - stillIn). */
  goneCount: number;
  /** Observed exit fraction (0..1). */
  exitFractionObserved: number;
  /** Live CLOB midpoint at signal time (null if CLOB had no price). */
  livePrice: number | null;
}

export interface BuildExitsResult {
  signals: ExitSignal[];
  buysConsidered: number;
  tokensSkippedNoPrice: number;
}

export async function buildExitSignals(
  prisma: PrismaClient,
  clob: ClobApiClient,
  exitFraction: number,
): Promise<BuildExitsResult> {
  // 1. All open BUYs.
  const openBuys = await prisma.suggestion.findMany({
    where: { type: "BUY", status: { in: [...OPEN_STATUSES] } },
  });

  if (openBuys.length === 0) {
    return { signals: [], buysConsidered: 0, tokensSkippedNoPrice: 0 };
  }

  // 2. Current vetted holders for every tokenId we care about.
  const tokenIds = [...new Set(openBuys.map((b) => b.tokenId))];
  const positions = await prisma.traderPosition.findMany({
    where: { tokenId: { in: tokenIds }, trader: { vetted: true } },
    select: { tokenId: true, traderId: true },
  });
  const currentByToken = new Map<string, Set<string>>();
  for (const p of positions) {
    let set = currentByToken.get(p.tokenId);
    if (!set) {
      set = new Set<string>();
      currentByToken.set(p.tokenId, set);
    }
    set.add(p.traderId);
  }

  // 3. Decide per BUY.
  const firing: Array<{
    buy: Suggestion;
    originalIds: string[];
    stillHoldingIds: string[];
  }> = [];
  for (const buy of openBuys) {
    const originalIds = parseHolderIds(buy.originalHolderIds);
    if (originalIds.length === 0) continue; // shouldn't happen, but guard
    const currentSet = currentByToken.get(buy.tokenId) ?? new Set<string>();
    if (!shouldSuggestExit(originalIds, currentSet, exitFraction)) continue;
    const stillHoldingIds = originalIds.filter((id) => currentSet.has(id));
    firing.push({ buy, originalIds, stillHoldingIds });
  }

  if (firing.length === 0) {
    return {
      signals: [],
      buysConsidered: openBuys.length,
      tokensSkippedNoPrice: 0,
    };
  }

  // 4. Batch live prices for the firing set only.
  const firingTokenIds = [...new Set(firing.map((f) => f.buy.tokenId))];
  const midpoints = await clob.getMidpoints(firingTokenIds);
  let tokensSkippedNoPrice = 0;

  const signals: ExitSignal[] = firing.map(
    ({ buy, originalIds, stillHoldingIds }) => {
      const livePrice = midpoints.get(buy.tokenId) ?? null;
      if (livePrice == null) tokensSkippedNoPrice++;
      const goneCount = originalIds.length - stillHoldingIds.length;
      return {
        buy,
        originalHolderIds: originalIds,
        stillHoldingIds,
        goneCount,
        exitFractionObserved: goneCount / originalIds.length,
        livePrice,
      };
    },
  );

  return {
    signals,
    buysConsidered: openBuys.length,
    tokensSkippedNoPrice,
  };
}

function parseHolderIds(json: string): string[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v)
      ? v.filter((x): x is string => typeof x === "string")
      : [];
  } catch {
    return [];
  }
}
