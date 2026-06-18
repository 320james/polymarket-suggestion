// One-shot smoke test of the Server Action LOGIC (no wire layer).
// Imports the same module the dashboard uses and drives each action with
// a synthetic FormData. Verifies DB state after each call.
import { prisma } from "../src/lib/db";
import {
  updateConfig,
  setSuggestionStatus,
  logTakenTrade,
  closeTakenTrade,
} from "../src/lib/actions";

function fd(obj: Record<string, string | number | boolean>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(obj)) f.set(k, String(v));
  return f;
}

async function main() {
  // ── 1. Config: flip kill switch + change poll interval, then revert ─────
  const before = await prisma.config.findUnique({ where: { id: 1 } });
  if (!before) throw new Error("no Config row");
  console.log("[1a] before:", { kill: before.killSwitch, poll: before.pollIntervalSec });

  await updateConfig(fd({
    killSwitch: "on",
    pollIntervalSec: 200,
    candidatePoolSize: before.candidatePoolSize,
    leaderboardWindows: before.leaderboardWindows,
    category: before.category,
    notifyChannel: before.notifyChannel,
    alertConfidenceStep: before.alertConfidenceStep,
    exitFraction: before.exitFraction,
    minResolvedTrades: before.minResolvedTrades,
    winRateFloor: before.winRateFloor,
    minProfitFactor: before.minProfitFactor,
    minWindowsAppeared: before.minWindowsAppeared,
    pfTarget: before.pfTarget,
    confidenceK: before.confidenceK,
    favoriteOddsThreshold: before.favoriteOddsThreshold,
    minDistinctHolders: before.minDistinctHolders,
    consensusScoreMin: before.consensusScoreMin,
    recencyHalfLifeHours: before.recencyHalfLifeHours,
    maxSlippageCents: before.maxSlippageCents,
    herdingWindowMinutes: before.herdingWindowMinutes,
    herdingClusterFrac: before.herdingClusterFrac,
    herdingSizeCv: before.herdingSizeCv,
    herdingPenalty: before.herdingPenalty,
    scoreTarget: before.scoreTarget,
    holderTarget: before.holderTarget,
  }));

  const mid = await prisma.config.findUnique({ where: { id: 1 } });
  console.log("[1b] after  :", { kill: mid?.killSwitch, poll: mid?.pollIntervalSec });
  if (!mid?.killSwitch || mid.pollIntervalSec !== 200) throw new Error("config write failed");

  await updateConfig(fd({
    killSwitch: "",
    pollIntervalSec: before.pollIntervalSec,
    candidatePoolSize: before.candidatePoolSize,
    leaderboardWindows: before.leaderboardWindows,
    category: before.category,
    notifyChannel: before.notifyChannel,
    alertConfidenceStep: before.alertConfidenceStep,
    exitFraction: before.exitFraction,
    minResolvedTrades: before.minResolvedTrades,
    winRateFloor: before.winRateFloor,
    minProfitFactor: before.minProfitFactor,
    minWindowsAppeared: before.minWindowsAppeared,
    pfTarget: before.pfTarget,
    confidenceK: before.confidenceK,
    favoriteOddsThreshold: before.favoriteOddsThreshold,
    minDistinctHolders: before.minDistinctHolders,
    consensusScoreMin: before.consensusScoreMin,
    recencyHalfLifeHours: before.recencyHalfLifeHours,
    maxSlippageCents: before.maxSlippageCents,
    herdingWindowMinutes: before.herdingWindowMinutes,
    herdingClusterFrac: before.herdingClusterFrac,
    herdingSizeCv: before.herdingSizeCv,
    herdingPenalty: before.herdingPenalty,
    scoreTarget: before.scoreTarget,
    holderTarget: before.holderTarget,
  }));
  const restored = await prisma.config.findUnique({ where: { id: 1 } });
  console.log("[1c] restored:", { kill: restored?.killSwitch, poll: restored?.pollIntervalSec });
  if (restored?.killSwitch) throw new Error("kill switch did not flip back");

  // ── 2. setSuggestionStatus: DISMISS #10 ──────────────────────────────────
  await setSuggestionStatus(fd({ id: 10, status: "DISMISSED" }));
  const s10 = await prisma.suggestion.findUnique({ where: { id: 10 } });
  console.log("[2 ] suggestion 10:", s10?.status);
  if (s10?.status !== "DISMISSED") throw new Error("dismiss failed");

  // ── 3. logTakenTrade on #11 ──────────────────────────────────────────────
  await logTakenTrade(fd({
    suggestionId: 11,
    side: "BUY",
    size: 100,
    fillPrice: 0.27,
  }));
  const s11 = await prisma.suggestion.findUnique({
    where: { id: 11 },
    include: { takenTrades: true },
  });
  console.log("[3 ] suggestion 11:", s11?.status, "trades:", s11?.takenTrades.length);
  if (s11?.status !== "TAKEN" || s11.takenTrades.length === 0) {
    throw new Error("log-fill failed");
  }
  const trade = s11.takenTrades[0]!;
  console.log("    trade:", { side: trade.side, size: trade.size, fill: trade.fillPrice });

  // ── 4. closeTakenTrade ───────────────────────────────────────────────────
  await closeTakenTrade(fd({ tradeId: trade.id, closedPrice: 0.42 }));
  const closed = await prisma.takenTrade.findUnique({ where: { id: trade.id } });
  console.log("[4 ] closed:", {
    closedPrice: closed?.closedPrice,
    realizedPnl: closed?.realizedPnl,
  });
  // BUY 100 @ 0.27 → close @ 0.42 = (0.42 - 0.27) * 100 = 15.00
  if (Math.abs((closed?.realizedPnl ?? 0) - 15) > 1e-6) {
    throw new Error(`pnl math wrong: got ${closed?.realizedPnl}, expected 15`);
  }

  // ── 5. Validation: bad status should throw ───────────────────────────────
  let threw = false;
  try {
    await setSuggestionStatus(fd({ id: 12, status: "BANANAS" }));
  } catch (e) {
    threw = true;
    console.log("[5a] correctly rejected bad status:", (e as Error).message);
  }
  if (!threw) throw new Error("validation should have rejected BANANAS");

  // ── 6. Validation: out-of-range fillPrice should throw ───────────────────
  threw = false;
  try {
    await logTakenTrade(fd({
      suggestionId: 12,
      side: "BUY",
      size: 10,
      fillPrice: 1.5,
    }));
  } catch (e) {
    threw = true;
    console.log("[6a] correctly rejected fillPrice=1.5:", (e as Error).message);
  }
  if (!threw) throw new Error("validation should have rejected fillPrice 1.5");

  // ── 7. Restore: revert #10 + #11 + drop the test TakenTrade ─────────────
  await prisma.takenTrade.delete({ where: { id: trade.id } });
  await prisma.suggestion.updateMany({
    where: { id: { in: [10, 11] } },
    data: { status: "NOTIFIED" },
  });
  console.log("[7 ] cleanup done");

  await prisma.$disconnect();
  console.log("\n✓ all action checks passed");
}

main().catch(async (e) => {
  console.error("✗ FAIL:", e);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
