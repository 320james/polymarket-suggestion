/**
 * Positions pipeline — pull /positions for a trader, derive each position's
 * `enteredAt` from on-chain trade history, and persist to TraderPosition.
 *
 * `enteredAt` is what scoring.ts uses for recency + herding. It's the
 * timestamp at which the trader's running NET INVENTORY for this specific
 * tokenId last crossed 0 → >0. Definitions:
 *   - BUY adds to inventory; SELL subtracts.
 *   - When running inventory transitions from <=0 to >0 via a BUY, that
 *     BUY's timestamp becomes the candidate `enteredAt`.
 *   - When inventory returns to <=0 (full exit), the candidate is cleared.
 *   - We walk per-tokenId, so multi-outcome (negative-risk) markets are
 *     tracked independently for each side.
 *
 * Known gaps (acceptable for v1):
 *   - SPLIT/MERGE (negative-risk USDC↔YES+NO conversions) don't appear in
 *     /trades. A position created via SPLIT will fall back to `now` for its
 *     enteredAt. We log a "fallback" count so we can spot this.
 *   - We deep-fetch trades only for tokens we don't already have in DB.
 *     Existing rows keep their enteredAt forever — which is correct, since
 *     the trader still holds that token.
 */

import type { PrismaClient } from "@prisma/client";
import type { DataApiClient, Trade } from "@poly/polymarket-api";

export interface SyncPositionsResult {
  trader: string;
  apiPositions: number;
  upserted: number;
  removed: number;
  newPositions: number;
  enteredAtDerived: number;
  enteredAtFallback: number;
  durationMs: number;
}

export interface SyncPositionsOptions {
  /** API `sizeThreshold`. Defaults to 1 (USD value floor). */
  sizeThreshold?: number;
}

export async function syncTraderPositions(
  prisma: PrismaClient,
  api: DataApiClient,
  traderId: string,
  opts: SyncPositionsOptions = {},
): Promise<SyncPositionsResult> {
  const t0 = Date.now();
  const sizeThreshold = opts.sizeThreshold ?? 1;

  // 1. Current positions from API.
  const apiPositions = await api.getPositions({
    user: traderId,
    sizeThreshold,
    limit: 500, // API max
  });

  // 2. What we already track for this trader.
  const existing = await prisma.traderPosition.findMany({ where: { traderId } });
  const existingByToken = new Map(existing.map((p) => [p.tokenId, p]));

  // 3. Identify NEW positions (tokens we haven't seen) and the conditionIds
  //    they belong to — those are the only ones we need trade history for.
  const newTokens = new Set<string>();
  const newConditionIds = new Set<string>();
  for (const p of apiPositions) {
    if (!existingByToken.has(p.asset)) {
      newTokens.add(p.asset);
      newConditionIds.add(p.conditionId);
    }
  }

  // 4. Derive enteredAt for new positions.
  let enteredAtByToken = new Map<string, Date>();
  if (newTokens.size > 0) {
    const trades = await api.getTradesForMarkets(
      traderId,
      [...newConditionIds],
      { chunkSize: 30 },
    );
    enteredAtByToken = deriveEnteredAt(trades, newTokens);
  }

  // 5. Portfolio share — used as a conviction signal. Sum initialValue
  //    over CURRENT positions (so it's relative to what the trader is
  //    actively risking right now).
  const totalInitial = apiPositions.reduce(
    (s, p) => s + (Number.isFinite(p.initialValue) ? p.initialValue : 0),
    0,
  );

  // 6. Upsert.
  const now = new Date();
  let derived = 0;
  let fallback = 0;
  for (const p of apiPositions) {
    const prior = existingByToken.get(p.asset);
    let enteredAt: Date;
    if (prior) {
      enteredAt = prior.enteredAt;
    } else if (enteredAtByToken.has(p.asset)) {
      enteredAt = enteredAtByToken.get(p.asset)!;
      derived++;
    } else {
      // Trade-history walk found nothing — most likely a SPLIT/MERGE.
      // Use `now` so the position is at least tracked.
      enteredAt = now;
      fallback++;
    }

    const pct = totalInitial > 0 && Number.isFinite(p.initialValue)
      ? p.initialValue / totalInitial
      : null;

    await prisma.traderPosition.upsert({
      where: { traderId_tokenId: { traderId, tokenId: p.asset } },
      create: {
        traderId,
        conditionId: p.conditionId,
        tokenId: p.asset,
        outcome: p.outcome,
        outcomeIndex: p.outcomeIndex,
        size: p.size,
        avgPrice: p.avgPrice,
        pctOfPortfolio: pct,
        enteredAt,
      },
      update: {
        // conditionId/outcome/outcomeIndex are immutable for a given tokenId.
        size: p.size,
        avgPrice: p.avgPrice,
        pctOfPortfolio: pct,
        lastObservedAt: now,
      },
    });
  }

  // 7. Delete rows for tokens no longer held.
  const currentTokens = new Set(apiPositions.map((p) => p.asset));
  const toRemove = existing.filter((e) => !currentTokens.has(e.tokenId));
  if (toRemove.length > 0) {
    await prisma.traderPosition.deleteMany({
      where: {
        traderId,
        tokenId: { in: toRemove.map((p) => p.tokenId) },
      },
    });
  }

  return {
    trader: traderId,
    apiPositions: apiPositions.length,
    upserted: apiPositions.length,
    removed: toRemove.length,
    newPositions: newTokens.size,
    enteredAtDerived: derived,
    enteredAtFallback: fallback,
    durationMs: Date.now() - t0,
  };
}

/**
 * Per-tokenId walk. Trades arrive in API order (DESC by time) — we sort
 * ASC here so the inventory simulation is causal.
 */
export function deriveEnteredAt(
  trades: Trade[],
  targetTokens: Set<string>,
): Map<string, Date> {
  // Bucket trades per tokenId, skipping anything not in our target set.
  const byToken = new Map<string, Trade[]>();
  for (const t of trades) {
    if (!targetTokens.has(t.asset)) continue;
    const arr = byToken.get(t.asset);
    if (arr) arr.push(t);
    else byToken.set(t.asset, [t]);
  }

  const out = new Map<string, Date>();
  for (const [tokenId, ts] of byToken) {
    ts.sort((a, b) => a.timestamp - b.timestamp);
    let running = 0;
    let lastOpenAt: number | null = null;
    for (const t of ts) {
      if (t.side === "BUY") {
        if (running <= 0) lastOpenAt = t.timestamp;
        running += t.size;
      } else {
        running -= t.size;
        if (running <= 0) {
          running = 0;
          lastOpenAt = null;
        }
      }
    }
    if (lastOpenAt != null && running > 0) {
      out.set(tokenId, new Date(lastOpenAt * 1000));
    }
  }
  return out;
}
