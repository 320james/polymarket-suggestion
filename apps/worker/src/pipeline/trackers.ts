/**
 * Tracker persistence — write/refresh TrackedTrader rows from a vet outcome.
 *
 * The Worker calls this after every vet pass (cold-vet on a new candidate,
 * or stats refresh on a tracked one). It also bumps lastSeenOnLeaderboardAt
 * if the trader showed up in the leaderboard fan-out this poll.
 */

import type { PrismaClient } from "@prisma/client";
import type { Candidate } from "./candidates.js";
import type { VetOutcome } from "./vet.js";

export interface UpsertTrackedTraderInput {
  candidate: Candidate;
  outcome: VetOutcome;
  /** True if the trader appeared on the leaderboard fan-out this poll. */
  seenOnLeaderboard: boolean;
  /**
   * True when `outcome` came from a fresh vetTrader() API run; false when
   * it was reconstructed from a cached TrackedTrader row (see vet-cache
   * path in run-poll Phase 2). When false we still refresh leaderboard
   * fields + the config-derived trustWeight/vetted flags, but we leave
   * `lastStatsComputedAt` alone so the TTL keeps counting from the real
   * compute time — otherwise the cache would never expire.
   */
  freshlyComputed: boolean;
}

export async function upsertTrackedTrader(
  prisma: PrismaClient,
  {
    candidate,
    outcome,
    seenOnLeaderboard,
    freshlyComputed,
  }: UpsertTrackedTraderInput,
): Promise<void> {
  const stats = outcome.stats;
  const now = new Date();
  const trustWeight = outcome.trustWeight ?? 0;

  const common = {
    username: candidate.username || null,
    bestRank: candidate.bestRank,
    pnl: candidate.pnl,
    volume: candidate.volume,
    winRate: stats.winRate,
    profitFactor: stats.profitFactor,
    avgRoi: stats.avgRoi,
    avgEntryOdds: stats.avgEntryOdds,
    resolvedTrades: stats.resolvedTrades,
    windowsAppeared: stats.windowsAppeared,
    trustWeight,
    vetted: outcome.passed,
    ...(freshlyComputed ? { lastStatsComputedAt: now } : {}),
    ...(seenOnLeaderboard ? { lastSeenOnLeaderboardAt: now } : {}),
  };

  await prisma.trackedTrader.upsert({
    where: { id: candidate.proxyWallet },
    create: { id: candidate.proxyWallet, ...common },
    update: common,
  });
}
