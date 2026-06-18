/**
 * One full poll — orchestrates every phase that turns public data into
 * Suggestion rows. Wrapped in a WorkerRun heartbeat so the dashboard always
 * has a "last poll …" tile.
 *
 * Error isolation:
 *   - Every phase runs inside its own try/catch.
 *   - Per-candidate vet errors and per-trader position errors are caught at
 *     the loop level so one bad trader can't kill the poll.
 *   - errorCount is incremented for each caught error; the WorkerRun row
 *     records that. ok=true only when every phase completed without a
 *     top-level throw.
 *
 * Notifier is wired through opts (so this stays testable). Pass `null` to
 * skip the send step — the writer's `shouldRenotify` flags are still
 * surfaced in the return value for the dashboard.
 */

import type { PrismaClient } from "@prisma/client";
import type {
  ClobApiClient,
  DataApiClient,
  GammaApiClient,
  LeaderboardCategory,
  LeaderboardWindow,
} from "@poly/polymarket-api";
import type { RuntimeConfig } from "../config-bootstrap.js";
import { log } from "../log.js";
import { selectCandidates, type Candidate } from "./candidates.js";
import { vetTrader } from "./vet.js";
import { upsertTrackedTrader } from "./trackers.js";
import { syncTraderPositions } from "./positions.js";
import { buildConsensusSignals } from "./consensus.js";
import {
  writeBuySuggestions,
  type WriteSuggestionsRow,
} from "./suggestion-writer.js";
import { buildExitSignals } from "./exits.js";
import { writeExitSuggestions, type WriteExitsRow } from "./exit-writer.js";
import { createChannel } from "../notifier/factory.js";
import {
  dispatchBuyNotifications,
  dispatchExitNotifications,
} from "../notifier/dispatch.js";

export interface RunPollResult {
  workerRunId: number;
  ok: boolean;
  durationMs: number;
  candidates: number;
  vetted: number;
  positionsSeen: number;
  buysCreated: number;
  buysUpdated: number;
  exitsCreated: number;
  exitsUpdated: number;
  buysTransitioned: number;
  notificationsSent: number;
  notificationsFailed: number;
  errorCount: number;
  killed: boolean;
  /** BUYs that the notifier should fire on (NEW or material confidence rise). */
  buysToNotify: WriteSuggestionsRow[];
  /** EXITs that the notifier should fire on. */
  exitsToNotify: WriteExitsRow[];
}

export interface RunPollDeps {
  prisma: PrismaClient;
  api: DataApiClient;
  gamma: GammaApiClient;
  clob: ClobApiClient;
  config: RuntimeConfig;
}

export async function runPoll(deps: RunPollDeps): Promise<RunPollResult> {
  const { prisma, api, gamma, clob, config } = deps;
  const t0 = Date.now();

  // killSwitch short-circuits BEFORE we open a WorkerRun row — these aren't
  // failed polls, they're skipped polls, and we don't want them inflating
  // error metrics or rate-limit usage.
  if (config.ops.killSwitch) {
    log.warn("killSwitch=true — skipping poll");
    return zeroResult({ killed: true });
  }

  const run = await prisma.workerRun.create({
    data: { startedAt: new Date(), ok: false, notes: "in-flight" },
  });

  let errorCount = 0;
  const note = (m: string) => log.error({ workerRunId: run.id }, m);

  // ─── Phase 1: candidates ─────────────────────────────────────────────
  let candidates: Candidate[] = [];
  try {
    const tCand = Date.now();
    candidates = await selectCandidates(api, {
      windows: config.ops.leaderboardWindows as LeaderboardWindow[],
      category: config.ops.category as LeaderboardCategory,
      poolSize: config.ops.candidatePoolSize,
    });
    log.info(
      { workerRunId: run.id, count: candidates.length, ms: Date.now() - tCand },
      "candidates selected",
    );
  } catch (err) {
    errorCount++;
    note(`candidates phase failed: ${(err as Error).message}`);
  }

  // ─── Phase 2: vet + persist (serial, per-candidate isolated) ─────────
  const passed: Candidate[] = [];
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i]!;
    try {
      const outcome = await vetTrader(api, config.scoring, {
        proxyAddress: c.proxyWallet,
        windowsAppeared: c.windowsAppeared,
      });
      await upsertTrackedTrader(prisma, {
        candidate: c,
        outcome,
        seenOnLeaderboard: true,
      });
      if (outcome.passed) passed.push(c);
    } catch (err) {
      errorCount++;
      log.warn(
        { workerRunId: run.id, user: c.username, err: (err as Error).message },
        "vet failed for candidate",
      );
    }
  }
  log.info(
    {
      workerRunId: run.id,
      candidates: candidates.length,
      passed: passed.length,
    },
    "vet phase complete",
  );

  // ─── Phase 3: sync positions for everyone who passed ─────────────────
  let positionsSeen = 0;
  for (const c of passed) {
    try {
      const sync = await syncTraderPositions(prisma, api, c.proxyWallet);
      positionsSeen += sync.apiPositions;
    } catch (err) {
      errorCount++;
      log.warn(
        { workerRunId: run.id, user: c.username, err: (err as Error).message },
        "position sync failed for trader",
      );
    }
  }
  log.info(
    { workerRunId: run.id, traders: passed.length, positionsSeen },
    "positions sync phase complete",
  );

  // ─── Phase 4: consensus + Phase 5: BUY write ──────────────────────────
  let buysCreated = 0;
  let buysUpdated = 0;
  let buysToNotify: WriteSuggestionsRow[] = [];
  try {
    const consensus = await buildConsensusSignals(
      prisma,
      gamma,
      clob,
      config.scoring,
    );
    const writeResult = await writeBuySuggestions(prisma, consensus.signals, {
      alertConfidenceStep: config.ops.alertConfidenceStep,
    });
    buysCreated = writeResult.created;
    buysUpdated = writeResult.updated;
    buysToNotify = writeResult.active.filter((r) => r.shouldRenotify);
    if (consensus.gammaFetchErrors > 0) {
      // Non-fatal: stale cache covered the missing IDs. Worth surfacing
      // so we can correlate with Gamma incidents.
      log.warn(
        {
          workerRunId: run.id,
          gammaFetchErrors: consensus.gammaFetchErrors,
        },
        "consensus completed with Gamma fetch errors (stale cache used)",
      );
    }
    log.info(
      {
        workerRunId: run.id,
        considered: consensus.tokensConsidered,
        fired: consensus.fired.length,
        created: buysCreated,
        updated: buysUpdated,
        toNotify: buysToNotify.length,
      },
      "BUY consensus complete",
    );
  } catch (err) {
    errorCount++;
    note(`consensus/BUY-write phase failed: ${(err as Error).message}`);
  }

  // ─── Phase 6: EXIT detection + write ──────────────────────────────────
  let exitsCreated = 0;
  let exitsUpdated = 0;
  let buysTransitioned = 0;
  let exitsToNotify: WriteExitsRow[] = [];
  try {
    const exits = await buildExitSignals(prisma, clob, config.ops.exitFraction);
    const exitWrite = await writeExitSuggestions(prisma, exits.signals, {
      alertConfidenceStep: config.ops.alertConfidenceStep,
    });
    exitsCreated = exitWrite.created;
    exitsUpdated = exitWrite.updated;
    buysTransitioned = exitWrite.buysTransitioned;
    exitsToNotify = exitWrite.active.filter((r) => r.shouldRenotify);
    log.info(
      {
        workerRunId: run.id,
        buysConsidered: exits.buysConsidered,
        fired: exits.signals.length,
        created: exitsCreated,
        updated: exitsUpdated,
        buysTransitioned,
        toNotify: exitsToNotify.length,
      },
      "EXIT phase complete",
    );
  } catch (err) {
    errorCount++;
    note(`exit phase failed: ${(err as Error).message}`);
  }

  // ─── Phase 7: notifier dispatch ─────────────────────────────────────────
  let notificationsSent = 0;
  let notificationsFailed = 0;
  try {
    const channel = createChannel(config.ops.notifyChannel);
    const buySummary = await dispatchBuyNotifications(
      { prisma, channel },
      buysToNotify,
    );
    const exitSummary = await dispatchExitNotifications(
      { prisma, channel },
      exitsToNotify,
    );
    notificationsSent = buySummary.succeeded + exitSummary.succeeded;
    notificationsFailed = buySummary.failed + exitSummary.failed;
    log.info(
      {
        workerRunId: run.id,
        channel: channel.name,
        buys: buySummary,
        exits: exitSummary,
      },
      "notifier dispatch complete",
    );
  } catch (err) {
    errorCount++;
    note(`notifier dispatch phase failed: ${(err as Error).message}`);
  }

  // ─── Persist heartbeat ─────────────────────────────────────────────────
  const durationMs = Date.now() - t0;
  const ok = errorCount === 0;
  await prisma.workerRun.update({
    where: { id: run.id },
    data: {
      finishedAt: new Date(),
      ok,
      candidates: candidates.length,
      vetted: passed.length,
      positionsSeen,
      firings: buysCreated + buysUpdated,
      exits: exitsCreated + exitsUpdated,
      notifications: notificationsSent,
      errorCount,
      notes: ok ? null : `${errorCount} error(s) during poll`,
    },
  });

  log.info(
    {
      workerRunId: run.id,
      ok,
      ms: durationMs,
      errorCount,
      buysCreated,
      buysUpdated,
      exitsCreated,
      exitsUpdated,
      notificationsSent,
      notificationsFailed,
    },
    "poll complete",
  );

  return {
    workerRunId: run.id,
    ok,
    durationMs,
    candidates: candidates.length,
    vetted: passed.length,
    positionsSeen,
    buysCreated,
    buysUpdated,
    exitsCreated,
    exitsUpdated,
    buysTransitioned,
    notificationsSent,
    notificationsFailed,
    errorCount,
    killed: false,
    buysToNotify,
    exitsToNotify,
  };
}

function zeroResult(over: Partial<RunPollResult> = {}): RunPollResult {
  return {
    workerRunId: -1,
    ok: true,
    durationMs: 0,
    candidates: 0,
    vetted: 0,
    positionsSeen: 0,
    buysCreated: 0,
    buysUpdated: 0,
    exitsCreated: 0,
    exitsUpdated: 0,
    buysTransitioned: 0,
    notificationsSent: 0,
    notificationsFailed: 0,
    errorCount: 0,
    killed: false,
    buysToNotify: [],
    exitsToNotify: [],
    ...over,
  };
}
