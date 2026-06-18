/**
 * `pnpm vet` — sanity-check the vet pipeline end-to-end against live data.
 *
 * Pulls leaderboards across WEEK/MONTH/ALL, dedups, vets the top N
 * candidates, and prints a table so you can eyeball derived stats before
 * we wire consensus/notifications/dashboard.
 *
 * Usage:
 *   pnpm vet                 # default: top 8 OVERALL across WEEK/MONTH/ALL
 *   POOL=15 pnpm vet         # top 15
 *   CATEGORY=POLITICS pnpm vet
 *   WINDOWS=MONTH,ALL pnpm vet
 */

import { DEFAULT_CONFIG } from "@poly/shared";
import {
  DataApiClient,
  type LeaderboardCategory,
  type LeaderboardWindow,
} from "@poly/polymarket-api";
import { selectCandidates, type Candidate } from "../pipeline/candidates.js";
import { vetTrader, type VetOutcome } from "../pipeline/vet.js";
import { log } from "../log.js";

const POOL = Number(process.env.POOL ?? 8);
const CATEGORY = (process.env.CATEGORY ?? "OVERALL") as LeaderboardCategory;
const WINDOWS = (process.env.WINDOWS ?? "WEEK,MONTH,ALL")
  .split(",")
  .map((s) => s.trim().toUpperCase()) as LeaderboardWindow[];

async function main(): Promise<void> {
  const api = new DataApiClient();
  log.info(
    { pool: POOL, category: CATEGORY, windows: WINDOWS },
    "fetching leaderboard candidates",
  );

  const t0 = Date.now();
  const candidates = await selectCandidates(api, {
    windows: WINDOWS,
    category: CATEGORY,
    poolSize: POOL,
  });
  log.info(
    { count: candidates.length, ms: Date.now() - t0 },
    "candidates selected",
  );

  // Process candidates serially so the rate limiter stays well-behaved
  // (parallel here would race the bucket for /trades and /activity).
  const results: { c: Candidate; v: VetOutcome }[] = [];
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i]!;
    const tStart = Date.now();
    try {
      const v = await vetTrader(api, DEFAULT_CONFIG, {
        proxyAddress: c.proxyWallet,
        windowsAppeared: c.windowsAppeared,
      });
      const ms = Date.now() - tStart;
      log.info(
        {
          n: `${i + 1}/${candidates.length}`,
          user: c.username || c.proxyWallet,
          rawTrades: v.rawTrades,
          rawRedeems: v.rawRedeems,
          mkts: v.uniqueSettledMarkets,
          resolved: v.resolvedTrades,
          passed: v.passed,
          trustWeight: v.trustWeight != null ? +v.trustWeight.toFixed(3) : null,
          ms,
        },
        "vetted",
      );
      results.push({ c, v });
    } catch (err) {
      log.error(
        { user: c.username, err: (err as Error).message },
        "vet failed",
      );
    }
  }

  printTable(results);
}

function printTable(rows: { c: Candidate; v: VetOutcome }[]): void {
  const header = [
    "rank",
    "user",
    "wAppr",
    "rawTr",
    "rdm",
    "mkts",
    "resN",
    "winRt",
    "PF",
    "avgROI",
    "avgEntry",
    "trustW",
    "pass",
  ];
  const data = rows.map(({ c, v }) => [
    String(c.bestRank),
    (c.username || short(c.proxyWallet)).slice(0, 18),
    String(c.windowsAppeared),
    String(v.rawTrades),
    String(v.rawRedeems),
    String(v.uniqueSettledMarkets),
    String(v.stats.resolvedTrades),
    pct(v.stats.winRate),
    fmt(v.stats.profitFactor, 2),
    pct(v.stats.avgRoi),
    pct(v.stats.avgEntryOdds),
    v.trustWeight != null ? fmt(v.trustWeight, 3) : "–",
    v.passed ? "✓" : "·",
  ]);

  const widths = header.map((h, i) =>
    Math.max(h.length, ...data.map((r) => r[i]!.length)),
  );

  const sep = "  ";
  const fmtRow = (cells: string[]) =>
    cells.map((c, i) => c.padEnd(widths[i]!)).join(sep);

  const out = [
    "",
    "─── VET RESULTS ─────────────────────────────────────────────────────",
    fmtRow(header),
    fmtRow(widths.map((w) => "─".repeat(w))),
    ...data.map(fmtRow),
    "",
    `Vetted ${rows.filter((r) => r.v.passed).length} / ${rows.length} candidates ` +
      `(gates: ≥${DEFAULT_CONFIG.minResolvedTrades} resolved, winRate ≥` +
      `${DEFAULT_CONFIG.winRateFloor}, PF ≥${DEFAULT_CONFIG.minProfitFactor}, ` +
      `windowsAppeared ≥${DEFAULT_CONFIG.minWindowsAppeared})`,
    "",
  ].join("\n");

  // Bypass pino formatting for the table so it's grep/copy-friendly.
  process.stdout.write(out);
}

function fmt(n: number | undefined, dp = 2): string {
  if (n == null || !Number.isFinite(n)) return "–";
  return n.toFixed(dp);
}
function pct(n: number | undefined): string {
  if (n == null || !Number.isFinite(n)) return "–";
  return (n * 100).toFixed(1) + "%";
}
function short(addr: string): string {
  return addr.slice(0, 6) + "…" + addr.slice(-4);
}

main().catch((err) => {
  log.error(
    { err: (err as Error).message, stack: (err as Error).stack },
    "fatal",
  );
  process.exit(1);
});
