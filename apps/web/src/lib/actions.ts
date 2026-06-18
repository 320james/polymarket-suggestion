"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";

// ──────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────

/**
 * Best-effort cache revalidation. Inside a Next request context this calls
 * revalidatePath; outside one (e.g. from a smoke-test script) it no-ops
 * instead of crashing. Mutation already succeeded by the time we get here.
 */
function tryRevalidate(path: string): void {
  try {
    revalidatePath(path);
  } catch (err) {
    // Only swallow the "static generation store missing" case (running outside
    // Next). Surface anything else.
    if (!String(err).includes("static generation store missing")) throw err;
  }
}

function num(v: FormDataEntryValue | null, fallback: number): number {
  if (v == null) return fallback;
  const n = Number(String(v).trim());
  return Number.isFinite(n) ? n : fallback;
}

function int(v: FormDataEntryValue | null, fallback: number): number {
  return Math.trunc(num(v, fallback));
}

function str(v: FormDataEntryValue | null, fallback = ""): string {
  return v == null ? fallback : String(v).trim();
}

function bool(v: FormDataEntryValue | null): boolean {
  return v === "on" || v === "true" || v === "1";
}

// Terminal statuses the dashboard owns. Worker only writes NEW/NOTIFIED.
const TERMINAL_STATUSES = ["TAKEN", "DISMISSED", "EXITED", "EXPIRED"] as const;
type TerminalStatus = (typeof TERMINAL_STATUSES)[number];

function assertTerminal(s: string): TerminalStatus {
  if ((TERMINAL_STATUSES as readonly string[]).includes(s))
    return s as TerminalStatus;
  throw new Error(`invalid terminal status: ${s}`);
}

// ──────────────────────────────────────────────────────────────────────
// Config — single editable singleton row (id=1)
// ──────────────────────────────────────────────────────────────────────

export async function updateConfig(formData: FormData): Promise<void> {
  // Read everything once so we can validate before touching the DB.
  const data = {
    killSwitch: bool(formData.get("killSwitch")),

    // operational
    candidatePoolSize: int(formData.get("candidatePoolSize"), 50),
    leaderboardWindows: str(
      formData.get("leaderboardWindows"),
      "WEEK,MONTH,ALL",
    ),
    category: str(formData.get("category"), "OVERALL"),
    pollIntervalSec: int(formData.get("pollIntervalSec"), 120),
    notifyChannel: str(formData.get("notifyChannel"), "TELEGRAM"),
    alertConfidenceStep: num(formData.get("alertConfidenceStep"), 10),
    exitFraction: num(formData.get("exitFraction"), 0.6),

    // vetting
    minResolvedTrades: int(formData.get("minResolvedTrades"), 20),
    winRateFloor: num(formData.get("winRateFloor"), 0.55),
    minProfitFactor: num(formData.get("minProfitFactor"), 1.3),
    minWindowsAppeared: int(formData.get("minWindowsAppeared"), 2),

    // trust weight
    pfTarget: num(formData.get("pfTarget"), 2.0),
    confidenceK: num(formData.get("confidenceK"), 50),
    favoriteOddsThreshold: num(formData.get("favoriteOddsThreshold"), 0.8),

    // consensus
    minDistinctHolders: int(formData.get("minDistinctHolders"), 3),
    consensusScoreMin: num(formData.get("consensusScoreMin"), 1.5),
    recencyHalfLifeHours: num(formData.get("recencyHalfLifeHours"), 48),
    maxSlippageCents: num(formData.get("maxSlippageCents"), 4),

    // herding
    herdingWindowMinutes: num(formData.get("herdingWindowMinutes"), 30),
    herdingClusterFrac: num(formData.get("herdingClusterFrac"), 0.6),
    herdingSizeCv: num(formData.get("herdingSizeCv"), 0.2),
    herdingPenalty: num(formData.get("herdingPenalty"), 0.5),

    // display
    scoreTarget: num(formData.get("scoreTarget"), 4.0),
    holderTarget: num(formData.get("holderTarget"), 6),
  };

  // Light sanity bounds — refuse obviously broken values rather than persist them.
  if (data.pollIntervalSec < 10)
    throw new Error("pollIntervalSec must be >= 10");
  if (data.candidatePoolSize < 1)
    throw new Error("candidatePoolSize must be >= 1");
  if (data.winRateFloor < 0 || data.winRateFloor > 1)
    throw new Error("winRateFloor must be in [0,1]");
  if (data.exitFraction < 0 || data.exitFraction > 1)
    throw new Error("exitFraction must be in [0,1]");
  if (data.herdingClusterFrac < 0 || data.herdingClusterFrac > 1)
    throw new Error("herdingClusterFrac must be in [0,1]");

  await prisma.config.upsert({
    where: { id: 1 },
    create: { id: 1, ...data },
    update: data,
  });

  tryRevalidate("/config");
  tryRevalidate("/");
}

// ──────────────────────────────────────────────────────────────────────
// Suggestion status transitions (dashboard-driven terminal states)
// ──────────────────────────────────────────────────────────────────────

export async function setSuggestionStatus(formData: FormData): Promise<void> {
  const id = int(formData.get("id"), NaN);
  if (!Number.isFinite(id)) throw new Error("invalid suggestion id");
  const status = assertTerminal(str(formData.get("status")));

  await prisma.suggestion.update({
    where: { id },
    data: { status },
  });

  tryRevalidate(`/suggestions/${id}`);
  tryRevalidate("/");
}

// ──────────────────────────────────────────────────────────────────────
// TakenTrade lifecycle — log fills, close out with realized PnL
// ──────────────────────────────────────────────────────────────────────

export async function logTakenTrade(formData: FormData): Promise<void> {
  const suggestionId = int(formData.get("suggestionId"), NaN);
  if (!Number.isFinite(suggestionId)) throw new Error("invalid suggestion id");

  const suggestion = await prisma.suggestion.findUnique({
    where: { id: suggestionId },
  });
  if (!suggestion) throw new Error(`suggestion ${suggestionId} not found`);

  const side = str(formData.get("side"), "BUY").toUpperCase();
  if (side !== "BUY" && side !== "SELL")
    throw new Error("side must be BUY or SELL");

  const size = num(formData.get("size"), NaN);
  const fillPrice = num(formData.get("fillPrice"), NaN);
  if (!Number.isFinite(size) || size <= 0) throw new Error("size must be > 0");
  if (!Number.isFinite(fillPrice) || fillPrice < 0 || fillPrice > 1) {
    throw new Error("fillPrice must be in [0, 1]");
  }

  // Logging a fill auto-marks the suggestion TAKEN (idempotent — re-runs are fine).
  await prisma.$transaction([
    prisma.takenTrade.create({
      data: {
        suggestionId,
        conditionId: suggestion.conditionId,
        outcome: suggestion.outcome,
        side,
        size,
        fillPrice,
      },
    }),
    prisma.suggestion.update({
      where: { id: suggestionId },
      data: { status: "TAKEN" },
    }),
  ]);

  tryRevalidate(`/suggestions/${suggestionId}`);
  tryRevalidate("/");
}

export async function closeTakenTrade(formData: FormData): Promise<void> {
  const tradeId = int(formData.get("tradeId"), NaN);
  if (!Number.isFinite(tradeId)) throw new Error("invalid trade id");

  const closedPrice = num(formData.get("closedPrice"), NaN);
  if (!Number.isFinite(closedPrice) || closedPrice < 0 || closedPrice > 1) {
    throw new Error("closedPrice must be in [0, 1]");
  }

  const trade = await prisma.takenTrade.findUnique({ where: { id: tradeId } });
  if (!trade) throw new Error(`trade ${tradeId} not found`);

  // Cents-per-share P&L × size. BUY profits when close > fill; SELL is mirrored.
  const direction = trade.side === "BUY" ? 1 : -1;
  const realizedPnl = direction * (closedPrice - trade.fillPrice) * trade.size;

  await prisma.takenTrade.update({
    where: { id: tradeId },
    data: {
      closedPrice,
      closedAt: new Date(),
      realizedPnl,
    },
  });

  if (trade.suggestionId != null) {
    tryRevalidate(`/suggestions/${trade.suggestionId}`);
  }
  tryRevalidate("/");
}
