/**
 * `pnpm consensus` — end-to-end demo of:
 *   leaderboard → vet → upsert → sync positions → score → write Suggestions
 *   → check exits → write EXIT Suggestions / transition BUYs to EXITED
 *
 * Vets up to POOL candidates (default 15) serially, persists those that
 * pass, syncs their positions, then runs buildConsensusSignals across all
 * vetted traders in the DB. Writes any fired BUY signals as Suggestion rows
 * and prints a table.
 *
 * After consensus, runs buildExitSignals against the open BUYs and writes
 * any fired EXIT rows (transitioning the parent BUY to EXITED). Prints an
 * EXIT WATCH table so you can see how close each open BUY is to triggering
 * an exit even when none fired.
 *
 * Run twice:
 *   - First pass: creates new Suggestions ("created" count > 0).
 *   - Second pass shortly after: updates existing rows; confidence ~unchanged;
 *     `shouldRenotify=false` for rows that haven't moved ≥ alertConfidenceStep.
 *
 * Usage:
 *   pnpm consensus
 *   POOL=20 CATEGORY=SPORTS pnpm consensus
 *   ALERT_STEP=5 pnpm consensus
 *   SIMULATE_EXIT=1 pnpm consensus    # delete enough original holders to force every open BUY to exit (destructive: next sync restores positions)
 */

import {
  ClobApiClient,
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
import { buildConsensusSignals } from "../pipeline/consensus.js";
import { writeBuySuggestions } from "../pipeline/suggestion-writer.js";
import { buildExitSignals } from "../pipeline/exits.js";
import { writeExitSuggestions } from "../pipeline/exit-writer.js";
import { getPrisma, disconnectPrisma } from "../db.js";
import { log } from "../log.js";

const POOL = Number(process.env.POOL ?? 15);
const CATEGORY = (process.env.CATEGORY ?? "OVERALL") as LeaderboardCategory;
const WINDOWS = (process.env.WINDOWS ?? "WEEK,MONTH,ALL")
  .split(",")
  .map((s) => s.trim().toUpperCase()) as LeaderboardWindow[];
const ALERT_STEP = Number(process.env.ALERT_STEP ?? 10);
/** Override scoring.minDistinctHolders for demo runs with a small vetted pool. */
const MIN_HOLDERS = process.env.MIN_HOLDERS ? Number(process.env.MIN_HOLDERS) : null;
/** Override scoring.consensusScoreMin for demo runs. */
const SCORE_MIN = process.env.SCORE_MIN ? Number(process.env.SCORE_MIN) : null;
/** Skip the vet+sync phases (assumes DB already populated). */
const SKIP_VET = process.env.SKIP_VET === "1";
/** Force exit by deleting enough original holders' positions per open BUY. */
const SIMULATE_EXIT = process.env.SIMULATE_EXIT === "1";
/** Override exit fraction (default 0.6 per Config table default). */
const EXIT_FRACTION = Number(process.env.EXIT_FRACTION ?? 0.6);

async function main(): Promise<void> {
  const limiter = new RateLimiter(DEFAULT_BUCKETS);
  const api = new DataApiClient({ limiter });
  const gamma = new GammaApiClient({ limiter });
  const clob = new ClobApiClient({ limiter });
  const prisma = getPrisma();

  // ─── Phase 1: candidates ───────────────────────────────────────────────
  if (SKIP_VET) {
    log.info("SKIP_VET=1 — reusing DB state, going straight to consensus");
  } else {
    log.info({ pool: POOL, category: CATEGORY, windows: WINDOWS }, "fetching candidates");
    const tCand = Date.now();
    const candidates = await selectCandidates(api, {
      windows: WINDOWS,
      category: CATEGORY,
      poolSize: POOL,
    });
    log.info({ count: candidates.length, ms: Date.now() - tCand }, "candidates selected");

    // ─── Phase 2: vet + persist (serial; rate-limit safe) ───────────────────
    const passed: Candidate[] = [];
    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i]!;
      const t0 = Date.now();
      try {
        const outcome = await vetTrader(api, DEFAULT_CONFIG, {
          proxyAddress: c.proxyWallet,
          windowsAppeared: c.windowsAppeared,
        });
        await upsertTrackedTrader(prisma, {
          candidate: c,
          outcome,
          seenOnLeaderboard: true,
        });
        log.info(
          {
            n: `${i + 1}/${candidates.length}`,
            user: c.username || c.proxyWallet,
            passed: outcome.passed,
            trustW: outcome.trustWeight != null ? +outcome.trustWeight.toFixed(3) : null,
            resolved: outcome.resolvedTrades,
            ms: Date.now() - t0,
          },
          "vetted",
        );
        if (outcome.passed) passed.push(c);
      } catch (err) {
        log.error({ user: c.username, err: (err as Error).message }, "vet failed");
      }
    }
    log.info({ passed: passed.length }, "vet phase complete");

    if (passed.length < 2) {
      log.warn(
        { passed: passed.length },
        "fewer than 2 vetted — consensus will be sparse. Bump POOL or relax gates.",
      );
    }

    // ─── Phase 3: sync positions for everyone who passed ────────────────────
    for (const c of passed) {
      const t0 = Date.now();
      const sync = await syncTraderPositions(prisma, api, c.proxyWallet);
      log.info(
        {
          user: c.username,
          apiPositions: sync.apiPositions,
          newPositions: sync.newPositions,
          derived: sync.enteredAtDerived,
          fallback: sync.enteredAtFallback,
          ms: Date.now() - t0,
        },
        "positions synced",
      );
    }
  }

  // ─── Phase 4: consensus ────────────────────────────────────────────────
  const cfg = {
    ...DEFAULT_CONFIG,
    ...(MIN_HOLDERS != null ? { minDistinctHolders: MIN_HOLDERS } : {}),
    ...(SCORE_MIN != null ? { consensusScoreMin: SCORE_MIN } : {}),
  };
  if (MIN_HOLDERS != null) log.info({ minHolders: MIN_HOLDERS }, "using overridden minDistinctHolders");
  if (SCORE_MIN != null) log.info({ scoreMin: SCORE_MIN }, "using overridden consensusScoreMin");
  const tCons = Date.now();
  const consensus = await buildConsensusSignals(prisma, gamma, clob, cfg);
  log.info(
    {
      considered: consensus.tokensConsidered,
      signals: consensus.signals.length,
      fired: consensus.fired.length,
      skippedNoPrice: consensus.tokensSkippedNoPrice,
      skippedNoMarket: consensus.tokensSkippedNoMarket,
      ms: Date.now() - tCons,
    },
    "consensus computed",
  );

  // ─── Phase 5: persist as Suggestions ───────────────────────────────────
  const writeResult = await writeBuySuggestions(prisma, consensus.signals, {
    alertConfidenceStep: ALERT_STEP,
  });
  log.info(
    {
      created: writeResult.created,
      updated: writeResult.updated,
      active: writeResult.active.length,
      renotify: writeResult.active.filter((r) => r.shouldRenotify).length,
    },
    "suggestions written",
  );

  printTokenTable(consensus.signals);
  printSuggestionsTable(await loadOpenBuys(prisma));

  // ─── Phase 6: exits ────────────────────────────────────────────────────
  if (SIMULATE_EXIT) {
    const removed = await simulateExitByDeletingHolders(prisma, EXIT_FRACTION);
    log.warn(
      { rowsDeleted: removed.rowsDeleted, buysTouched: removed.buysTouched },
      "SIMULATE_EXIT=1 — deleted vetted holders' positions to force exits (next sync restores)",
    );
  }

  const tExit = Date.now();
  const exits = await buildExitSignals(prisma, clob, EXIT_FRACTION);
  log.info(
    {
      buysConsidered: exits.buysConsidered,
      signals: exits.signals.length,
      skippedNoPrice: exits.tokensSkippedNoPrice,
      ms: Date.now() - tExit,
    },
    "exit signals computed",
  );

  const exitWrite = await writeExitSuggestions(prisma, exits.signals, {
    alertConfidenceStep: ALERT_STEP,
  });
  log.info(
    {
      created: exitWrite.created,
      updated: exitWrite.updated,
      active: exitWrite.active.length,
      buysTransitioned: exitWrite.buysTransitioned,
      renotify: exitWrite.active.filter((r) => r.shouldRenotify).length,
    },
    "exit suggestions written",
  );

  printExitWatchTable(await loadExitWatch(prisma, EXIT_FRACTION));
  printOpenExitsTable(await loadOpenExits(prisma));

  await disconnectPrisma();
}

async function loadOpenBuys(prisma: ReturnType<typeof getPrisma>) {
  return prisma.suggestion.findMany({
    where: { type: "BUY", status: { in: ["NEW", "NOTIFIED"] } },
    orderBy: { confidence: "desc" },
  });
}

function printTokenTable(signals: Awaited<ReturnType<typeof buildConsensusSignals>>["signals"]): void {
  if (signals.length === 0) {
    process.stdout.write("\n(no tokens met the ≥2 vetted holder threshold)\n\n");
    return;
  }
  // Order by raw score so the most interesting are at the top regardless
  // of whether they fired.
  const sorted = [...signals].sort((a, b) => b.result.rawScore - a.result.rawScore);

  const header = ["question", "outcome", "n", "score", "conf", "blendC", "liveC", "slipC", "herd", "fired"];
  const data = sorted.slice(0, 25).map((s) => [
    truncate(s.marketQuestion, 36),
    s.outcome.slice(0, 7),
    String(s.result.distinctHolders),
    s.result.rawScore.toFixed(2),
    String(s.result.confidence),
    (s.result.blendedEntry * 100).toFixed(0),
    (s.livePrice * 100).toFixed(0),
    (s.result.slippageCents >= 0 ? "+" : "") + String(s.result.slippageCents),
    s.result.herdingPenalty < 1 ? "✗" : "·",
    s.result.fired ? "✓" : "·",
  ]);

  const widths = header.map((h, i) => Math.max(h.length, ...data.map((r) => r[i]!.length)));
  const fmtRow = (r: string[]) => r.map((c, i) => c.padEnd(widths[i]!)).join("  ");

  process.stdout.write(
    "\n─── CONSENSUS — top 25 tokens by raw score ──────────────────────────\n" +
      fmtRow(header) + "\n" +
      fmtRow(widths.map((w) => "─".repeat(w))) + "\n" +
      data.map(fmtRow).join("\n") + "\n" +
      (sorted.length > 25 ? `\n  … (${sorted.length - 25} more)\n` : "") +
      `\nTotals: ${sorted.length} considered, ${sorted.filter((s) => s.result.fired).length} fired\n`,
  );
}

function printSuggestionsTable(rows: Array<{
  id: number;
  marketQuestion: string;
  outcome: string;
  confidence: number;
  distinctHolders: number;
  blendedEntry: number;
  priceAtSignal: number;
  status: string;
  notifyCount: number;
  lastNotifiedConfidence: number | null;
  rationale: string;
}>): void {
  if (rows.length === 0) {
    process.stdout.write("\n(no open BUY suggestions in DB)\n\n");
    return;
  }
  const header = ["id", "status", "question", "outcome", "n", "conf", "lastNot", "notifyN"];
  const data = rows.map((r) => [
    String(r.id),
    r.status,
    truncate(r.marketQuestion, 36),
    r.outcome.slice(0, 7),
    String(r.distinctHolders),
    String(r.confidence),
    r.lastNotifiedConfidence != null ? String(Math.round(r.lastNotifiedConfidence)) : "–",
    String(r.notifyCount),
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...data.map((row) => row[i]!.length)));
  const fmtRow = (r: string[]) => r.map((c, i) => c.padEnd(widths[i]!)).join("  ");

  process.stdout.write(
    "\n─── OPEN BUY SUGGESTIONS (DB) ─────────────────────────────────────\n" +
      fmtRow(header) + "\n" +
      fmtRow(widths.map((w) => "─".repeat(w))) + "\n" +
      data.map(fmtRow).join("\n") + "\n\n" +
      `Sample rationale: ${rows[0]!.rationale}\n\n`,
  );
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

interface ExitWatchRow {
  buyId: number;
  question: string;
  outcome: string;
  originalCount: number;
  stillIn: number;
  goneCount: number;
  fracGone: number;
  wouldFire: boolean;
}

async function loadExitWatch(
  prisma: ReturnType<typeof getPrisma>,
  exitFraction: number,
): Promise<ExitWatchRow[]> {
  const openBuys = await prisma.suggestion.findMany({
    where: { type: "BUY", status: { in: ["NEW", "NOTIFIED"] } },
    orderBy: { id: "asc" },
  });
  if (openBuys.length === 0) return [];

  const tokenIds = [...new Set(openBuys.map((b) => b.tokenId))];
  const positions = await prisma.traderPosition.findMany({
    where: { tokenId: { in: tokenIds }, trader: { vetted: true } },
    select: { tokenId: true, traderId: true },
  });
  const currentByToken = new Map<string, Set<string>>();
  for (const p of positions) {
    let set = currentByToken.get(p.tokenId);
    if (!set) {
      set = new Set();
      currentByToken.set(p.tokenId, set);
    }
    set.add(p.traderId);
  }

  return openBuys.map((b) => {
    const originalIds = parseIds(b.originalHolderIds);
    const cur = currentByToken.get(b.tokenId) ?? new Set<string>();
    const stillIn = originalIds.filter((id) => cur.has(id)).length;
    const goneCount = originalIds.length - stillIn;
    const fracGone = originalIds.length === 0 ? 0 : goneCount / originalIds.length;
    return {
      buyId: b.id,
      question: b.marketQuestion,
      outcome: b.outcome,
      originalCount: originalIds.length,
      stillIn,
      goneCount,
      fracGone,
      wouldFire: fracGone >= exitFraction,
    };
  });
}

function printExitWatchTable(rows: ExitWatchRow[]): void {
  if (rows.length === 0) {
    process.stdout.write("\n(no open BUYs to watch for exits)\n\n");
    return;
  }
  const header = ["buyId", "question", "outcome", "orig", "stillIn", "gone", "fracGone", "fires"];
  const data = rows.map((r) => [
    String(r.buyId),
    truncate(r.question, 36),
    r.outcome.slice(0, 7),
    String(r.originalCount),
    String(r.stillIn),
    String(r.goneCount),
    `${Math.round(r.fracGone * 100)}%`,
    r.wouldFire ? "✓" : "·",
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...data.map((row) => row[i]!.length)));
  const fmtRow = (r: string[]) => r.map((c, i) => c.padEnd(widths[i]!)).join("  ");

  process.stdout.write(
    "\n─── EXIT WATCH — open BUYs vs current holder set ─────────────────\n" +
      fmtRow(header) + "\n" +
      fmtRow(widths.map((w) => "─".repeat(w))) + "\n" +
      data.map(fmtRow).join("\n") + "\n" +
      `\nTotals: ${rows.length} watched, ${rows.filter((r) => r.wouldFire).length} would fire at exitFraction\n`,
  );
}

async function loadOpenExits(prisma: ReturnType<typeof getPrisma>) {
  return prisma.suggestion.findMany({
    where: { type: "EXIT", status: { in: ["NEW", "NOTIFIED"] } },
    orderBy: { confidence: "desc" },
  });
}

function printOpenExitsTable(rows: Array<{
  id: number;
  status: string;
  marketQuestion: string;
  outcome: string;
  distinctHolders: number;
  confidence: number;
  notifyCount: number;
  lastNotifiedConfidence: number | null;
  relatedSuggestionId: number | null;
  rationale: string;
}>): void {
  if (rows.length === 0) {
    process.stdout.write("\n(no open EXIT suggestions in DB)\n\n");
    return;
  }
  const header = ["id", "buyId", "status", "question", "outcome", "stillIn", "conf%", "lastNot", "notifyN"];
  const data = rows.map((r) => [
    String(r.id),
    r.relatedSuggestionId != null ? String(r.relatedSuggestionId) : "–",
    r.status,
    truncate(r.marketQuestion, 36),
    r.outcome.slice(0, 7),
    String(r.distinctHolders),
    String(r.confidence),
    r.lastNotifiedConfidence != null ? String(Math.round(r.lastNotifiedConfidence)) : "–",
    String(r.notifyCount),
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...data.map((row) => row[i]!.length)));
  const fmtRow = (r: string[]) => r.map((c, i) => c.padEnd(widths[i]!)).join("  ");

  process.stdout.write(
    "\n─── OPEN EXIT SUGGESTIONS (DB) ────────────────────────────────────\n" +
      fmtRow(header) + "\n" +
      fmtRow(widths.map((w) => "─".repeat(w))) + "\n" +
      data.map(fmtRow).join("\n") + "\n\n" +
      `Sample rationale: ${rows[0]!.rationale}\n\n`,
  );
}

/**
 * Force enough original holders out of each open BUY's token to trip the
 * exitFraction threshold. Deletes rows from TraderPosition. The next call
 * to syncTraderPositions for those traders will restore them.
 */
async function simulateExitByDeletingHolders(
  prisma: ReturnType<typeof getPrisma>,
  exitFraction: number,
): Promise<{ rowsDeleted: number; buysTouched: number }> {
  const openBuys = await prisma.suggestion.findMany({
    where: { type: "BUY", status: { in: ["NEW", "NOTIFIED"] } },
  });
  let rowsDeleted = 0;
  let buysTouched = 0;
  for (const b of openBuys) {
    const originalIds = parseIds(b.originalHolderIds);
    if (originalIds.length === 0) continue;
    // Need ≥ exitFraction gone. Round up to be safe.
    const toRemove = Math.max(1, Math.ceil(exitFraction * originalIds.length));
    const victimIds = originalIds.slice(0, toRemove);
    const del = await prisma.traderPosition.deleteMany({
      where: { tokenId: b.tokenId, traderId: { in: victimIds } },
    });
    rowsDeleted += del.count;
    if (del.count > 0) buysTouched++;
  }
  return { rowsDeleted, buysTouched };
}

function parseIds(json: string): string[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

main().catch((err) => {
  log.error({ err: (err as Error).message, stack: (err as Error).stack }, "fatal");
  process.exit(1);
});
