/**
 * Worker entry point — long-running scheduler around `runPoll`.
 *
 * Loop semantics:
 *   1. Re-read Config each poll (dashboard edits take effect on the next iteration).
 *   2. If killSwitch=true, skip the poll (don't even open a WorkerRun row).
 *   3. Otherwise call runPoll; never let it escape (it's already error-isolated).
 *   4. Sleep for cfg.ops.pollIntervalSec; SIGINT/SIGTERM wakes the sleep early
 *      and exits cleanly after the in-flight poll finishes.
 *
 * Modes:
 *   - default: run forever.
 *   - RUN_ONCE=1: execute one poll and exit (used by `pnpm poll`).
 */

import {
  ClobApiClient,
  DataApiClient,
  GammaApiClient,
  RateLimiter,
  DEFAULT_BUCKETS,
} from "@poly/polymarket-api";
import { loadConfig } from "./config-bootstrap.js";
import { runPoll } from "./pipeline/run-poll.js";
import { getPrisma, disconnectPrisma } from "./db.js";
import { log } from "./log.js";

const RUN_ONCE = process.env.RUN_ONCE === "1";

async function main(): Promise<void> {
  const limiter = new RateLimiter(DEFAULT_BUCKETS);
  const api = new DataApiClient({ limiter });
  const gamma = new GammaApiClient({ limiter });
  const clob = new ClobApiClient({ limiter });
  const prisma = getPrisma();

  // ─── Shutdown coordination ────────────────────────────────────────────
  let shuttingDown = false;
  /** Set when sleeping; calling it short-circuits the timer. */
  let wakeFromSleep: (() => void) | null = null;
  const onSignal = (sig: string) => {
    if (shuttingDown) {
      log.warn({ sig }, "second signal received — forcing exit");
      process.exit(130);
    }
    shuttingDown = true;
    log.warn({ sig }, "shutdown requested — will exit after current poll");
    if (wakeFromSleep) wakeFromSleep();
  };
  process.on("SIGINT", () => onSignal("SIGINT"));
  process.on("SIGTERM", () => onSignal("SIGTERM"));

  log.info({ runOnce: RUN_ONCE }, "worker starting");

  while (!shuttingDown) {
    let cfg;
    try {
      cfg = await loadConfig(prisma);
    } catch (err) {
      log.error({ err: (err as Error).message }, "config load failed — retrying in 30s");
      await abortableSleep(30_000, (cancel) => {
        wakeFromSleep = cancel;
      });
      wakeFromSleep = null;
      continue;
    }

    try {
      await runPoll({ prisma, api, gamma, clob, config: cfg });
    } catch (err) {
      // runPoll catches everything internally; this is defensive.
      log.error({ err: (err as Error).message }, "poll escaped its error boundary");
    }

    if (RUN_ONCE || shuttingDown) break;

    const sleepMs = Math.max(1, cfg.ops.pollIntervalSec) * 1000;
    log.info({ sleepMs }, "sleeping until next poll");
    await abortableSleep(sleepMs, (cancel) => {
      wakeFromSleep = cancel;
    });
    wakeFromSleep = null;
  }

  log.info("worker shutting down — disconnecting prisma");
  await disconnectPrisma();
  log.info("worker exited cleanly");
}

/**
 * Sleep that resolves either after `ms` or when the registered cancel
 * callback is invoked. Used by the loop so SIGINT can interrupt a long
 * wait between polls.
 */
function abortableSleep(ms: number, register: (cancel: () => void) => void): Promise<void> {
  return new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    register(() => {
      clearTimeout(t);
      resolve();
    });
  });
}

main().catch((err) => {
  log.error({ err: (err as Error).message, stack: (err as Error).stack }, "fatal");
  process.exit(1);
});
