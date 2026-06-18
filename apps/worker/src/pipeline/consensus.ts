/**
 * Consensus pipeline — turn persisted positions into Suggestion rows.
 *
 * For each tokenId held by ≥1 vetted trader:
 *   1. Build the HolderPosition[] from TraderPosition rows joined to
 *      TrackedTrader (vetted=true only).
 *   2. Pull the live CLOB midpoint for that tokenId.
 *   3. Call scoreConsensus() — returns rawScore, confidence, fired, etc.
 *   4. Hand back a structured result the writer can persist.
 *
 * Critically:
 *   - We compute consensus for every (tokenId) that has ≥2 vetted holders.
 *     `scoreConsensus` itself decides `fired` based on minDistinctHolders.
 *     We don't pre-filter to ≥3 because we still want NEW suggestions to
 *     UPDATE existing ones even if holder count temporarily dips to 2 (the
 *     writer applies that nuance).
 *   - Tokens with no live price (404 from CLOB → null) are skipped — we
 *     can't compute slippage without a price.
 */

import type { PrismaClient } from "@prisma/client";
import type {
  ClobApiClient,
  GammaApiClient,
  GammaMarket,
} from "@poly/polymarket-api";
import {
  scoreConsensus,
  type ConsensusResult,
  type HolderPosition,
  type ScoringConfig,
  type VettedTrader,
} from "@poly/shared";
import { getOrFetchMarkets } from "./market-cache.js";

/** What the writer needs to persist a Suggestion. */
export interface ConsensusSignal {
  conditionId: string;
  marketQuestion: string;
  tokenId: string;
  outcome: string;
  outcomeIndex: number;
  livePrice: number;
  holders: HolderPosition[];
  result: ConsensusResult;
  market: GammaMarket;
}

export interface BuildConsensusOptions {
  /** Minimum distinct vetted holders to even compute consensus. Defaults to 2. */
  minHoldersToConsider?: number;
  /** Optional cap on tokens we'll process per run (debugging). */
  maxTokens?: number;
}

export interface BuildConsensusResult {
  signals: ConsensusSignal[];
  fired: ConsensusSignal[];
  tokensConsidered: number;
  tokensSkippedNoPrice: number;
  tokensSkippedNoMarket: number;
  /**
   * Count of Gamma chunk fetches that failed after all retries.
   * Non-fatal — stale cache covers the affected condition IDs — but
   * worth surfacing so we can correlate with Gamma incidents.
   */
  gammaFetchErrors: number;
}

export async function buildConsensusSignals(
  prisma: PrismaClient,
  gamma: GammaApiClient,
  clob: ClobApiClient,
  cfg: ScoringConfig,
  opts: BuildConsensusOptions = {},
): Promise<BuildConsensusResult> {
  const minHoldersToConsider = opts.minHoldersToConsider ?? 2;

  // 1. Pull every position held by a vetted trader, joined to trader stats.
  const rows = await prisma.traderPosition.findMany({
    where: { trader: { vetted: true } },
    include: { trader: true },
  });

  // 2. Group by tokenId.
  const byToken = new Map<string, typeof rows>();
  for (const row of rows) {
    const arr = byToken.get(row.tokenId);
    if (arr) arr.push(row);
    else byToken.set(row.tokenId, [row]);
  }

  // 3. Drop tokens below the holder floor.
  let candidates = [...byToken.entries()].filter(
    ([, rs]) => rs.length >= minHoldersToConsider,
  );
  if (opts.maxTokens) candidates = candidates.slice(0, opts.maxTokens);

  if (candidates.length === 0) {
    return {
      signals: [],
      fired: [],
      tokensConsidered: 0,
      tokensSkippedNoPrice: 0,
      tokensSkippedNoMarket: 0,
      gammaFetchErrors: 0,
    };
  }

  // 4. In parallel, load: market metadata + live midpoints.
  const tokenIds = candidates.map(([t]) => t);
  const conditionIds = [
    ...new Set(candidates.flatMap(([, rs]) => rs.map((r) => r.conditionId))),
  ];

  const [marketCache, midpoints] = await Promise.all([
    getOrFetchMarkets(prisma, gamma, conditionIds),
    clob.getMidpoints(tokenIds),
  ]);

  // 5. Score each token.
  const signals: ConsensusSignal[] = [];
  let skippedNoPrice = 0;
  let skippedNoMarket = 0;

  for (const [tokenId, holderRows] of candidates) {
    const livePrice = midpoints.get(tokenId);
    if (livePrice == null) {
      skippedNoPrice++;
      continue;
    }
    // All rows for the same tokenId share the same conditionId.
    const conditionId = holderRows[0]!.conditionId;
    const market = marketCache.markets.get(conditionId);
    if (!market) {
      skippedNoMarket++;
      continue;
    }

    const holders: HolderPosition[] = holderRows.map((r) =>
      toHolderPosition(r),
    );
    const result = scoreConsensus(holders, livePrice, cfg);

    // Resolve outcome/index from the position rows (they all agree per
    // tokenId, so the first row is canonical).
    const firstRow = holderRows[0]!;

    signals.push({
      conditionId,
      marketQuestion: market.question,
      tokenId,
      outcome: firstRow.outcome,
      outcomeIndex: firstRow.outcomeIndex,
      livePrice,
      holders,
      result,
      market,
    });
  }

  return {
    signals,
    fired: signals.filter((s) => s.result.fired),
    tokensConsidered: candidates.length,
    tokensSkippedNoPrice: skippedNoPrice,
    tokensSkippedNoMarket: skippedNoMarket,
    gammaFetchErrors: marketCache.fetchErrors.length,
  };
}

/**
 * Adapt a DB row (TraderPosition + included TrackedTrader) into the pure
 * `HolderPosition` shape that scoring.ts expects.
 */
function toHolderPosition(row: {
  size: number;
  avgPrice: number;
  pctOfPortfolio: number | null;
  enteredAt: Date;
  trader: {
    id: string;
    resolvedTrades: number;
    winRate: number | null;
    profitFactor: number | null;
    avgRoi: number | null;
    avgEntryOdds: number | null;
    windowsAppeared: number;
    trustWeight: number;
  };
}): HolderPosition {
  const trader: VettedTrader = {
    proxyAddress: row.trader.id,
    resolvedTrades: row.trader.resolvedTrades,
    winRate: row.trader.winRate ?? 0,
    profitFactor: row.trader.profitFactor ?? 0,
    avgRoi: row.trader.avgRoi ?? 0,
    avgEntryOdds: row.trader.avgEntryOdds ?? 0,
    windowsAppeared: row.trader.windowsAppeared,
    trustWeight: row.trader.trustWeight,
  };

  // sizeUsd is the dollar value of the trader's open position in this
  // outcome, i.e. shares × entry price. (currentValue would conflate price
  // movement; the scoring engine wants what they committed.)
  const sizeUsd = row.size * row.avgPrice;

  return {
    trader,
    sizeUsd,
    avgPrice: row.avgPrice,
    pctOfPortfolio: row.pctOfPortfolio ?? 0,
    firstSeen: row.enteredAt,
  };
}
