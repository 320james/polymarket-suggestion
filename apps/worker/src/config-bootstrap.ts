/**
 * Config bootstrap — enforce the Config singleton and provide a typed view
 * into the slice the scoring layer needs.
 *
 * The Prisma `Config` model owns every operational knob (poll cadence, kill
 * switch, notify channel, alert step, etc.) PLUS a superset of the canonical
 * `ScoringConfig` from @poly/shared/scoring. The worker keeps scoring config
 * canonical-typed (so it can pass it straight into `scoreConsensus`, etc.)
 * while treating the row's operational columns separately.
 *
 * The row is upserted at id=1 with the schema defaults; on subsequent runs
 * we just read whatever the dashboard wrote there.
 */

import type { PrismaClient, Config } from "@prisma/client";
import type { ScoringConfig } from "@poly/shared";

/** What the worker needs from the Config row. */
export interface RuntimeConfig {
  /** Canonical scoring spec — feed straight into @poly/shared functions. */
  scoring: ScoringConfig;
  /** Operational + notifier knobs. */
  ops: {
    killSwitch: boolean;
    pollIntervalSec: number;
    candidatePoolSize: number;
    leaderboardWindows: string[]; // e.g. ["WEEK","MONTH","ALL"]
    category: string; // e.g. "OVERALL"
    notifyChannel: string; // TELEGRAM|PUSHOVER|NTFY|EMAIL
    alertConfidenceStep: number;
    exitFraction: number;
  };
}

/**
 * Ensure the singleton row exists and return the runtime view.
 * `upsert` with empty `update:{}` is the standard "create-if-missing" idiom
 * — we never overwrite the dashboard's edits at startup.
 */
export async function loadConfig(prisma: PrismaClient): Promise<RuntimeConfig> {
  const row = await prisma.config.upsert({
    where: { id: 1 },
    create: { id: 1 },
    update: {},
  });
  return toRuntimeConfig(row);
}

function toRuntimeConfig(row: Config): RuntimeConfig {
  return {
    scoring: {
      minResolvedTrades: row.minResolvedTrades,
      winRateFloor: row.winRateFloor,
      minProfitFactor: row.minProfitFactor,
      minWindowsAppeared: row.minWindowsAppeared,
      pfTarget: row.pfTarget,
      confidenceK: row.confidenceK,
      favoriteOddsThreshold: row.favoriteOddsThreshold,
      minDistinctHolders: row.minDistinctHolders,
      consensusScoreMin: row.consensusScoreMin,
      recencyHalfLifeHours: row.recencyHalfLifeHours,
      maxSlippageCents: row.maxSlippageCents,
      herdingWindowMinutes: row.herdingWindowMinutes,
      herdingClusterFrac: row.herdingClusterFrac,
      herdingSizeCv: row.herdingSizeCv,
      herdingPenalty: row.herdingPenalty,
      scoreTarget: row.scoreTarget,
      holderTarget: row.holderTarget,
    },
    ops: {
      killSwitch: row.killSwitch,
      pollIntervalSec: row.pollIntervalSec,
      candidatePoolSize: row.candidatePoolSize,
      leaderboardWindows: row.leaderboardWindows
        .split(",")
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean),
      category: row.category,
      notifyChannel: row.notifyChannel,
      alertConfidenceStep: row.alertConfidenceStep,
      exitFraction: row.exitFraction,
    },
  };
}
