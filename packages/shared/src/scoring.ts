/**
 * scoring.ts — Reference implementation of the suggestion engine's analysis logic.
 *
 * This is the heart of the system. It is intentionally PURE and DETERMINISTIC:
 * given the same inputs it always produces the same score, so every suggestion is
 * auditable and reproducible. No network calls, no randomness, no LLM.
 *
 * Pipeline:
 *   raw trade history  ->  deriveTraderStats()    (per trader)
 *   trader stats       ->  computeTrustWeight()   (per trader)
 *   holders of an outcome + live price  ->  scoreConsensus()  (per market/outcome)
 *
 * The CONSTANTS below are reasonable starting points. Tune them against the
 * paper-trading log once you have a few weeks of real data — the FORMULAS are the
 * part that matters; the exact numbers are calibration.
 */

// ---------------------------------------------------------------------------
// Config (mirror these in the Prisma `Config` row; passed in, never hard-coded)
// ---------------------------------------------------------------------------

export interface ScoringConfig {
  // Vetting gates (a trader must clear ALL of these to enter the pool)
  minResolvedTrades: number; // sample-size floor, e.g. 50
  winRateFloor: number; // e.g. 0.55
  minProfitFactor: number; // e.g. 1.3
  minWindowsAppeared: number; // 1-3, e.g. 2 (consistency across WEEK/MONTH/ALL)

  // Trust-weight shaping
  pfTarget: number; // profit factor that maps to a full score, e.g. 2.0
  confidenceK: number; // shrinkage constant for sample size, e.g. 50
  favoriteOddsThreshold: number; // above this avg entry, start penalizing, e.g. 0.80

  // Consensus
  minDistinctHolders: number; // distinct vetted traders required to fire, e.g. 3
  consensusScoreMin: number; // raw weighted-score gate to fire, e.g. 1.5
  recencyHalfLifeHours: number; // position recency decay, e.g. 48
  maxSlippageCents: number; // flag "already ran" past this, e.g. 4

  // Herding guard
  herdingWindowMinutes: number; // cluster window, e.g. 30
  herdingClusterFrac: number; // fraction in-window that triggers, e.g. 0.6
  herdingSizeCv: number; // size coeff-of-variation below which = suspicious, e.g. 0.2
  herdingPenalty: number; // multiplier when herding detected, e.g. 0.5

  // Confidence display mapping
  scoreTarget: number; // raw score that maps to top score, e.g. 4.0
  holderTarget: number; // holder count that maps to top, e.g. 6
}

export const DEFAULT_CONFIG: ScoringConfig = {
  minResolvedTrades: 20,
  winRateFloor: 0.55,
  minProfitFactor: 1.3,
  minWindowsAppeared: 2,
  pfTarget: 2.0,
  confidenceK: 50,
  favoriteOddsThreshold: 0.8,
  minDistinctHolders: 3,
  consensusScoreMin: 1.5,
  recencyHalfLifeHours: 48,
  maxSlippageCents: 4,
  herdingWindowMinutes: 30,
  herdingClusterFrac: 0.6,
  herdingSizeCv: 0.2,
  herdingPenalty: 0.5,
  scoreTarget: 4.0,
  holderTarget: 6,
};

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/** One resolved (settled or sold) trade pulled from the Data API trade history. */
export interface ResolvedTrade {
  entryPrice: number; // avg price paid per share, 0..1 (≈ implied probability at entry)
  exitValue: number; // 1 if won, 0 if lost; or the sell price if exited early, 0..1
  sizeUsd: number; // USDC invested in this trade
}

export interface TraderStats {
  proxyAddress: string;
  resolvedTrades: number;
  winRate: number; // fraction of trades with positive P&L
  profitFactor: number; // gross $ profit / gross $ loss
  avgRoi: number; // mean per-trade ROI
  avgEntryOdds: number; // mean entry price (favorite-buyer detector)
  windowsAppeared: number; // how many of WEEK/MONTH/ALL leaderboards they hit (1-3)
}

export interface VettedTrader extends TraderStats {
  trustWeight: number;
}

/** A vetted trader's current open position in the outcome under consideration. */
export interface HolderPosition {
  trader: VettedTrader;
  sizeUsd: number; // size of THIS position
  avgPrice: number; // their entry price for it, 0..1
  pctOfPortfolio: number; // 0..1, conviction signal
  firstSeen: Date; // when we first observed them holding it (recency/herding)
}

export interface ConsensusResult {
  fired: boolean;
  rawScore: number;
  confidence: number; // 0..100 display score
  distinctHolders: number;
  blendedEntry: number; // trust-weighted avg of holders' entries
  slippageCents: number; // livePrice - blendedEntry, in cents
  alreadyRan: boolean;
  herdingPenalty: number; // 1 = none applied
  rationale: string;
}

// ---------------------------------------------------------------------------
// Math helpers
// ---------------------------------------------------------------------------

const clamp = (x: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, x));
const clamp01 = (x: number) => clamp(x, 0, 1);
const mean = (xs: number[]) =>
  xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;

const stddev = (xs: number[]) => {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
};

const weightedMean = (vals: number[], weights: number[]) => {
  const wsum = weights.reduce((a, b) => a + b, 0);
  if (wsum === 0) return mean(vals);
  return vals.reduce((acc, v, i) => acc + v * weights[i], 0) / wsum;
};

const hoursSince = (d: Date) => (Date.now() - d.getTime()) / 3_600_000;

// ---------------------------------------------------------------------------
// 1. Derive real quality stats from a trader's trade history
// ---------------------------------------------------------------------------
//
// WHY: the leaderboard ranks by PnL or volume, neither of which is skill. We
// recompute the things that actually indicate an edge. Note that win rate alone is
// gameable (buy heavy favorites at 0.95 and "win" 95% of the time with terrible
// expected value) — which is exactly why profit factor and avg entry odds exist.
export function deriveTraderStats(
  proxyAddress: string,
  trades: ResolvedTrade[],
  windowsAppeared: number,
): TraderStats {
  const n = trades.length;
  if (n === 0) {
    return {
      proxyAddress,
      resolvedTrades: 0,
      winRate: 0,
      profitFactor: 0,
      avgRoi: 0,
      avgEntryOdds: 0,
      windowsAppeared,
    };
  }

  let wins = 0,
    grossProfit = 0,
    grossLoss = 0,
    roiSum = 0,
    entrySum = 0;
  for (const t of trades) {
    const roi = (t.exitValue - t.entryPrice) / t.entryPrice; // per-trade return
    const dollarPnl = roi * t.sizeUsd;
    if (dollarPnl >= 0) {
      wins++;
      grossProfit += dollarPnl;
    } else {
      grossLoss += -dollarPnl;
    }
    roiSum += roi;
    entrySum += t.entryPrice;
  }

  // Profit factor: cap the "no losses" case so one clean streak isn't infinite.
  const profitFactor =
    grossLoss === 0 ? (grossProfit > 0 ? 5 : 1) : grossProfit / grossLoss;

  return {
    proxyAddress,
    resolvedTrades: n,
    winRate: wins / n,
    profitFactor: clamp(profitFactor, 0, 5),
    avgRoi: roiSum / n,
    avgEntryOdds: entrySum / n,
    windowsAppeared,
  };
}

/** Hard vetting gate. Returns true only if the trader is worth listening to. */
export function passesVetting(s: TraderStats, cfg: ScoringConfig): boolean {
  return (
    s.resolvedTrades >= cfg.minResolvedTrades &&
    s.winRate >= cfg.winRateFloor &&
    s.profitFactor >= cfg.minProfitFactor &&
    s.windowsAppeared >= cfg.minWindowsAppeared
  );
}

// ---------------------------------------------------------------------------
// 2. Composite trust weight (how much this trader's vote counts)
// ---------------------------------------------------------------------------
//
// trustWeight = profitability × sample-confidence × consistency × favorite-penalty
// Each factor is in 0..~1 so the product stays interpretable and bounded.
export function computeTrustWeight(s: TraderStats, cfg: ScoringConfig): number {
  // Profitability core: profit factor of 1 (breakeven) -> 0, pfTarget -> 1.
  const pfScore = clamp01((s.profitFactor - 1) / (cfg.pfTarget - 1));

  // Sample-size confidence (shrinkage): n/(n+k). 50 trades @ k=50 -> 0.5; 200 -> 0.8.
  const confidence = s.resolvedTrades / (s.resolvedTrades + cfg.confidenceK);

  // Consistency: appearing in more time windows is much harder to do by luck.
  const consistency = 0.5 + 0.25 * (clamp(s.windowsAppeared, 1, 3) - 1); // 1->.5 2->.75 3->1

  // Favorite penalty: a trader who only buys heavy favorites has a high win rate but
  // thin edge, and their agreement carries little information. Above the threshold,
  // taper the weight down toward 0.5 as avg entry odds approach 1.0.
  let favoritePenalty = 1;
  if (s.avgEntryOdds > cfg.favoriteOddsThreshold) {
    const over =
      (s.avgEntryOdds - cfg.favoriteOddsThreshold) /
      (1 - cfg.favoriteOddsThreshold);
    favoritePenalty = clamp(1 - 0.5 * over, 0.5, 1);
  }

  return pfScore * confidence * consistency * favoritePenalty;
}

// ---------------------------------------------------------------------------
// Herding guard
// ---------------------------------------------------------------------------
//
// If most holders piled in within a short window at near-identical sizes, that's
// likely ONE copied signal, not independent agreement — so discount it.
export function detectHerding(
  holders: HolderPosition[],
  cfg: ScoringConfig,
): number {
  if (holders.length < 3) return 1;

  const windowMs = cfg.herdingWindowMinutes * 60_000;
  const times = holders.map((h) => h.firstSeen.getTime()).sort((a, b) => a - b);

  // Largest count of entries falling within any windowMs span.
  let maxCluster = 1;
  for (let i = 0; i < times.length; i++) {
    let j = i;
    while (j < times.length && times[j] - times[i] <= windowMs) j++;
    maxCluster = Math.max(maxCluster, j - i);
  }
  const clusterFrac = maxCluster / holders.length;

  const sizes = holders.map((h) => h.sizeUsd);
  const cv = mean(sizes) === 0 ? 1 : stddev(sizes) / mean(sizes);

  const looksLikeHerding =
    clusterFrac >= cfg.herdingClusterFrac && cv <= cfg.herdingSizeCv;
  return looksLikeHerding ? cfg.herdingPenalty : 1;
}

// ---------------------------------------------------------------------------
// 3. Score the consensus for one (market, outcome)
// ---------------------------------------------------------------------------
export function scoreConsensus(
  holders: HolderPosition[],
  livePrice: number, // current CLOB price for this outcome, 0..1
  cfg: ScoringConfig,
): ConsensusResult {
  const distinctHolders = holders.length;

  // Trust-weighted blend of where the smart money actually got in.
  const blendedEntry = weightedMean(
    holders.map((h) => h.avgPrice),
    holders.map((h) => h.trader.trustWeight),
  );

  // Raw score = Σ trustWeight × recency × conviction.
  let rawScore = 0;
  for (const h of holders) {
    const recency = Math.pow(
      0.5,
      hoursSince(h.firstSeen) / cfg.recencyHalfLifeHours,
    );
    const conviction = clamp(0.5 + h.pctOfPortfolio * 2, 0.5, 1.5); // bigger bet = louder
    rawScore += h.trader.trustWeight * recency * conviction;
  }

  const herdingPenalty = detectHerding(holders, cfg);
  rawScore *= herdingPenalty;

  // Slippage / lag check: are you already paying up vs where they got in?
  const slippageCents = Math.round((livePrice - blendedEntry) * 100);
  const alreadyRan = slippageCents > cfg.maxSlippageCents;

  // Display confidence 0..100: blend normalized score and holder count, haircut if ran.
  const scoreComponent = clamp01(rawScore / cfg.scoreTarget);
  const holderComponent = clamp01(distinctHolders / cfg.holderTarget);
  let confidence = 100 * (0.7 * scoreComponent + 0.3 * holderComponent);
  if (alreadyRan) confidence *= 0.5;
  confidence = Math.round(clamp(confidence, 0, 100));

  const fired =
    distinctHolders >= cfg.minDistinctHolders &&
    rawScore >= cfg.consensusScoreMin;

  const rationale =
    `${distinctHolders} vetted traders hold this outcome ` +
    `(blended entry ${(blendedEntry * 100).toFixed(0)}¢, live ${(livePrice * 100).toFixed(0)}¢, ` +
    `slippage ${slippageCents >= 0 ? "+" : ""}${slippageCents}¢). ` +
    `Weighted score ${rawScore.toFixed(2)}` +
    (herdingPenalty < 1 ? ` (herding penalty applied)` : ``) +
    (alreadyRan ? ` — ⚠ price already ran past their entry.` : `.`);

  return {
    fired,
    rawScore,
    confidence,
    distinctHolders,
    blendedEntry,
    slippageCents,
    alreadyRan,
    herdingPenalty,
    rationale,
  };
}

// ---------------------------------------------------------------------------
// EXIT signal: the vetted traders who triggered a BUY have largely closed out.
// Call this against the holders you recorded when the BUY fired vs. who still holds.
// ---------------------------------------------------------------------------
export function shouldSuggestExit(
  originalHolderIds: string[],
  currentHolderIds: Set<string>,
  exitFraction = 0.6, // suggest exit once >=60% of the original holders are gone
): boolean {
  if (originalHolderIds.length === 0) return false;
  const stillIn = originalHolderIds.filter((id) =>
    currentHolderIds.has(id),
  ).length;
  const gone = 1 - stillIn / originalHolderIds.length;
  return gone >= exitFraction;
}
