import {
  computeTrustWeight,
  deriveTraderStats,
  passesVetting,
  type ScoringConfig,
  type TraderStats,
  type VettedTrader,
} from "@poly/shared";
import { DataApiClient } from "@poly/polymarket-api";
import type { Trade } from "@poly/polymarket-api";
import { buildResolvedTrades } from "./resolved-trades.js";

export interface VetInput {
  proxyAddress: string;
  windowsAppeared: number;
  /** Cap on how many distinct settled (REDEEMed) markets to deep-fetch. Default 200. */
  maxMarkets?: number;
  /** Max REDEEM activity rows to scan (most recent first). Default 2000. */
  maxRedeems?: number;
  /** Recent-trades sample to catch cycles closed by SELL in unresolved markets. Default 1000. */
  recentTrades?: number;
  /**
   * Only count cycles whose CLOSING event (SELL or REDEEM) is within this
   * many days. Keeps stats current — a great record from 2 years ago no
   * longer guarantees a vet pass. Default 90. Set to 0 to disable.
   */
  recencyDays?: number;
}

export interface VetOutcome {
  stats: TraderStats;
  passed: boolean;
  trustWeight: number | null; // null when !passed
  vetted: VettedTrader | null;
  /** Counts of raw inputs for debugging. */
  rawTrades: number;
  rawRedeems: number;
  uniqueSettledMarkets: number;
  resolvedTrades: number;
  /** Recency cutoff actually applied (null = unbounded). */
  closedSince: Date | null;
}

/**
 * Single-trader vet pass:
 *   1. Pull REDEEM activity → identify settled markets (capped to maxMarkets).
 *   2. Deep-fetch the user's full trade history for those markets (CSV chunked).
 *   3. Also pull a recent-trades sample to catch cycles closed by SELL before settlement.
 *   4. Dedup trades, reconstruct ResolvedTrade[] (closed cycles only).
 *   5. deriveTraderStats → passesVetting → (if passed) computeTrustWeight.
 *
 * Pure orchestration; all scoring logic lives in @poly/shared/scoring.
 */
export async function vetTrader(
  api: DataApiClient,
  cfg: ScoringConfig,
  input: VetInput,
): Promise<VetOutcome> {
  const maxMarkets = input.maxMarkets ?? 200;
  const maxRedeems = input.maxRedeems ?? 2000;
  const recentTradesMax = input.recentTrades ?? 1000;
  const recencyDays = input.recencyDays ?? 90;
  const closedSince =
    recencyDays > 0 ? new Date(Date.now() - recencyDays * 86_400_000) : null;

  // Step 1+3: pull REDEEMs and a recent-trades sample in parallel
  // (different rate-limit buckets, so no contention).
  const [redeems, recentTrades] = await Promise.all([
    api.getAllActivity(input.proxyAddress, {
      type: ["REDEEM"],
      maxTotal: maxRedeems,
    }),
    api.getAllTrades(input.proxyAddress, {
      maxTotal: recentTradesMax,
      takerOnly: false,
    }),
  ]);

  // Step 2: dedup settled conditionIds, take most recent N.
  const uniqueSettled: string[] = [];
  const seenMarket = new Set<string>();
  for (const r of redeems) {
    if (!r.conditionId || seenMarket.has(r.conditionId)) continue;
    seenMarket.add(r.conditionId);
    uniqueSettled.push(r.conditionId);
    if (uniqueSettled.length >= maxMarkets) break;
  }

  const settledTrades =
    uniqueSettled.length > 0
      ? await api.getTradesForMarkets(input.proxyAddress, uniqueSettled, {
          chunkSize: 30,
        })
      : [];

  // Step 4: dedup trades. A single tx can carry multiple trades (different assets),
  // so key on (txHash, asset, side, size, price).
  const seenTrade = new Set<string>();
  const trades: Trade[] = [];
  for (const t of [...settledTrades, ...recentTrades]) {
    const k = `${t.transactionHash}|${t.asset}|${t.side}|${t.size}|${t.price}`;
    if (seenTrade.has(k)) continue;
    seenTrade.add(k);
    trades.push(t);
  }

  // Step 5: reconstruct + score.
  const resolved = buildResolvedTrades(
    trades,
    redeems,
    closedSince ?? undefined,
  );
  const stats = deriveTraderStats(
    input.proxyAddress,
    resolved,
    input.windowsAppeared,
  );
  const passed = passesVetting(stats, cfg);
  const trustWeight = passed ? computeTrustWeight(stats, cfg) : null;

  return {
    stats,
    passed,
    trustWeight,
    vetted: passed && trustWeight != null ? { ...stats, trustWeight } : null,
    rawTrades: trades.length,
    rawRedeems: redeems.length,
    uniqueSettledMarkets: uniqueSettled.length,
    resolvedTrades: resolved.length,
    closedSince,
  };
}
