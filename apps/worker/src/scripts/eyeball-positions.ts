/**
 * `pnpm positions` — end-to-end demo of the trader-persistence path:
 *
 *   1. Pull candidates across leaderboard windows.
 *   2. Pick a trader (USER env, default = first candidate).
 *   3. Vet → upsert TrackedTrader.
 *   4. syncTraderPositions → upsert TraderPosition + delete-stale.
 *   5. Print a table of derived enteredAt + conviction weights.
 *
 * Run it twice: the first pass derives enteredAt for every position; the
 * second pass should show 0 new positions (cache hit) and the same
 * enteredAt values (idempotent).
 *
 * Usage:
 *   pnpm positions                    # default top candidate
 *   USER=0x... pnpm positions         # specific trader
 *   POOL=15 pnpm positions            # bigger candidate pool
 */

import {
  DataApiClient,
  GammaApiClient,
  RateLimiter,
  DEFAULT_BUCKETS,
  type LeaderboardCategory,
  type LeaderboardWindow,
} from "@poly/polymarket-api";
import { DEFAULT_CONFIG } from "@poly/shared";
import { selectCandidates, type Candidate } from "../pipeline/candidates.js";
import { vetTrader } from "../pipeline/vet.js";
import { upsertTrackedTrader } from "../pipeline/trackers.js";
import { syncTraderPositions } from "../pipeline/positions.js";
import { getOrFetchMarkets } from "../pipeline/market-cache.js";
import { getPrisma, disconnectPrisma } from "../db.js";
import { log } from "../log.js";

const POOL = Number(process.env.POOL ?? 8);
const CATEGORY = (process.env.CATEGORY ?? "OVERALL") as LeaderboardCategory;
const WINDOWS = (process.env.WINDOWS ?? "WEEK,MONTH,ALL")
  .split(",")
  .map((s) => s.trim().toUpperCase()) as LeaderboardWindow[];
const USER_OVERRIDE = process.env.USER?.startsWith("0x")
  ? process.env.USER
  : null;

async function main(): Promise<void> {
  const limiter = new RateLimiter(DEFAULT_BUCKETS);
  const api = new DataApiClient({ limiter });
  const gamma = new GammaApiClient({ limiter });
  const prisma = getPrisma();

  log.info(
    { pool: POOL, category: CATEGORY, windows: WINDOWS },
    "fetching candidates",
  );
  const candidates = await selectCandidates(api, {
    windows: WINDOWS,
    category: CATEGORY,
    poolSize: POOL,
  });

  let pick: Candidate | undefined;
  if (USER_OVERRIDE) {
    pick = candidates.find(
      (c) => c.proxyWallet.toLowerCase() === USER_OVERRIDE.toLowerCase(),
    );
    if (!pick) {
      // Off-leaderboard override — synthesize a candidate.
      pick = {
        proxyWallet: USER_OVERRIDE,
        username: "(override)",
        bestRank: 999,
        pnl: 0,
        volume: 0,
        windowsAppeared: 1,
      };
    }
  } else {
    pick = candidates[0];
  }
  if (!pick) {
    log.error("no candidate");
    await disconnectPrisma();
    return;
  }

  log.info(
    {
      user: pick.username,
      addr: pick.proxyWallet,
      windowsAppeared: pick.windowsAppeared,
    },
    "vetting",
  );
  const tVet = Date.now();
  const outcome = await vetTrader(api, DEFAULT_CONFIG, {
    proxyAddress: pick.proxyWallet,
    windowsAppeared: pick.windowsAppeared,
  });
  log.info(
    {
      ms: Date.now() - tVet,
      passed: outcome.passed,
      trustWeight:
        outcome.trustWeight != null ? +outcome.trustWeight.toFixed(3) : null,
      resolved: outcome.resolvedTrades,
    },
    "vetted",
  );

  await upsertTrackedTrader(prisma, {
    candidate: pick,
    outcome,
    seenOnLeaderboard: !USER_OVERRIDE,
  });

  const tSync = Date.now();
  const sync = await syncTraderPositions(prisma, api, pick.proxyWallet);
  log.info(
    {
      ...sync,
      durationMs: Date.now() - tSync,
    },
    "positions synced",
  );

  // Re-read from DB so the table reflects what's actually persisted.
  const rows = await prisma.traderPosition.findMany({
    where: { traderId: pick.proxyWallet },
    orderBy: [{ pctOfPortfolio: "desc" }, { enteredAt: "desc" }],
  });
  // Populate market cache for nice questions in the table.
  const conditionIds = [...new Set(rows.map((r) => r.conditionId))];
  const cacheResult = await getOrFetchMarkets(prisma, gamma, conditionIds);
  log.info(
    {
      wanted: conditionIds.length,
      fetched: cacheResult.fetched,
      missing: cacheResult.missing.length,
    },
    "market cache populated",
  );
  const qByCond = new Map<string, string>();
  for (const [cid, m] of cacheResult.markets) qByCond.set(cid, m.question);

  printTable(rows, qByCond);

  await disconnectPrisma();
}

interface Row {
  conditionId: string;
  tokenId: string;
  outcome: string;
  size: number;
  avgPrice: number;
  pctOfPortfolio: number | null;
  enteredAt: Date;
}

function printTable(rows: Row[], qByCond: Map<string, string>): void {
  const header = [
    "question",
    "outcome",
    "size",
    "avg%",
    "pct%",
    "enteredAt",
    "ageH",
  ];
  const now = Date.now();
  const data = rows.map((r) => {
    const q = qByCond.get(r.conditionId) ?? r.conditionId.slice(0, 10);
    const ageHrs = (now - r.enteredAt.getTime()) / 36e5;
    return [
      truncate(q, 42),
      r.outcome.slice(0, 7),
      fmt(r.size, 0),
      pct(r.avgPrice),
      pctSmall(r.pctOfPortfolio),
      fmtDate(r.enteredAt),
      ageHrs < 999 ? ageHrs.toFixed(1) : "old",
    ];
  });

  const widths = header.map((h, i) =>
    Math.max(h.length, ...data.map((row) => row[i]!.length)),
  );
  const sep = "  ";
  const fmtRow = (cells: string[]) =>
    cells.map((c, i) => c.padEnd(widths[i]!)).join(sep);

  // Limit table to top 20 rows; print summary after.
  const shown = data.slice(0, 20);
  const truncated = data.length - shown.length;

  const summary = [
    `Total positions: ${rows.length}`,
    `Concentration: top 5 = ${pctSmall(rows.slice(0, 5).reduce((s, r) => s + (r.pctOfPortfolio ?? 0), 0))}%, top 10 = ${pctSmall(rows.slice(0, 10).reduce((s, r) => s + (r.pctOfPortfolio ?? 0), 0))}%`,
  ].join("\n");

  const out = [
    "",
    "─── PERSISTED POSITIONS (top 20 by pct) ─────────────────────────",
    fmtRow(header),
    fmtRow(widths.map((w) => "─".repeat(w))),
    ...shown.map(fmtRow),
    truncated > 0 ? `\n  … (${truncated} more)` : "",
    "",
    summary,
    "",
  ].join("\n");
  process.stdout.write(out);
}

function fmt(n: number, dp = 2): string {
  if (!Number.isFinite(n)) return "–";
  return n.toFixed(dp);
}
function pct(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return "–";
  return (n * 100).toFixed(1);
}
/** Like `pct` but uses 2dp for sub-1% values so tiny positions don't display as 0.0. */
function pctSmall(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return "–";
  const v = n * 100;
  return v < 1 ? v.toFixed(2) : v.toFixed(1);
}
function fmtDate(d: Date): string {
  // YYYY-MM-DD HH:MM (UTC) — compact + comparable
  return d.toISOString().replace("T", " ").slice(0, 16);
}
function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

main().catch((err) => {
  log.error(
    { err: (err as Error).message, stack: (err as Error).stack },
    "fatal",
  );
  process.exit(1);
});
