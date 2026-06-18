import type { Activity, Trade } from "@poly/polymarket-api";
import type { ResolvedTrade } from "@poly/shared";

/**
 * Reconstruct ResolvedTrade[] from a single trader's raw history.
 *
 * "Resolved" = one position cycle that has been fully closed, either by
 * SELLs (early exit) or by market settlement (REDEEM). Open positions are
 * ignored because they don't yet have an exitValue.
 *
 * Algorithm per (conditionId, outcomeIndex):
 *   Walk events chronologically, maintaining (size, costUsd) where
 *   avgEntry = costUsd / size.
 *
 *   BUY  →  size += t.size; costUsd += t.size * t.price.
 *   SELL →  closed = min(size, t.size).
 *            emit { entryPrice: avgEntry, exitValue: t.price,
 *                   sizeUsd: closed * avgEntry }
 *            size -= closed; costUsd -= closed * avgEntry.
 *
 *   REDEEM for the conditionId (settlement event):
 *     The Activity row for REDEEM has empty asset/outcomeIndex (sentinel 999)
 *     in the public API, but its `size` matches the redeemed outcome's open
 *     inventory. We:
 *       1. Pick the outcomeIndex whose open size is closest to REDEEM.size
 *          (within tolerance) as the WINNER. Emit
 *          { entryPrice: avgEntry, exitValue: 1, sizeUsd: costUsd }.
 *       2. Any other outcomeIndex with open size on this conditionId is
 *          implicitly a LOSER (losing tokens pay $0 and are typically not
 *          redeemed). Emit { entryPrice: avgEntry, exitValue: 0,
 *          sizeUsd: costUsd }.
 *       3. Reset positions on the conditionId to closed.
 *
 * Heuristic notes:
 *   - Polymarket markets resolve once, so any BUYs after a REDEEM on the
 *     same conditionId would be unusual; we treat them as a fresh cycle.
 *   - We process multiple REDEEMs on the same conditionId by treating only
 *     the FIRST as the settlement (later ones are typically the same trader
 *     redeeming dust). This keeps the win count correct.
 *   - Positions left open at the end are skipped (not resolved).
 */
export function buildResolvedTrades(
  trades: Trade[],
  redeems: Activity[],
): ResolvedTrade[] {
  type Pos = { size: number; cost: number };
  type Evt =
    | { kind: "trade"; ts: number; t: Trade }
    | { kind: "redeem"; ts: number; r: Activity };

  // Group all events by conditionId so each cycle is processed in isolation.
  const byCondition = new Map<string, Evt[]>();
  for (const t of trades) {
    const arr = byCondition.get(t.conditionId) ?? [];
    arr.push({ kind: "trade", ts: t.timestamp, t });
    byCondition.set(t.conditionId, arr);
  }
  for (const r of redeems) {
    if (r.type !== "REDEEM") continue;
    const arr = byCondition.get(r.conditionId) ?? [];
    arr.push({ kind: "redeem", ts: r.timestamp, r });
    byCondition.set(r.conditionId, arr);
  }

  const resolved: ResolvedTrade[] = [];

  for (const events of byCondition.values()) {
    events.sort((a, b) => a.ts - b.ts);
    const positions = new Map<number, Pos>(); // outcomeIndex -> running pos
    let conditionSettled = false; // first REDEEM on a conditionId is the settlement

    for (const ev of events) {
      if (ev.kind === "trade") {
        const t = ev.t;
        const oi = t.outcomeIndex;
        const pos = positions.get(oi) ?? { size: 0, cost: 0 };
        if (t.side === "BUY") {
          pos.size += t.size;
          pos.cost += t.size * t.price;
          positions.set(oi, pos);
        } else {
          // SELL
          if (pos.size <= 0) continue; // no inventory to close
          const closed = Math.min(pos.size, t.size);
          const avgEntry = pos.cost / pos.size;
          if (avgEntry > 0) {
            resolved.push({
              entryPrice: avgEntry,
              exitValue: t.price,
              sizeUsd: closed * avgEntry,
            });
          }
          pos.size -= closed;
          pos.cost = Math.max(0, pos.cost - closed * avgEntry);
          if (pos.size <= 1e-9) {
            pos.size = 0;
            pos.cost = 0;
          }
          positions.set(oi, pos);
        }
      } else {
        // REDEEM — only the first acts as settlement
        if (conditionSettled) continue;
        conditionSettled = true;
        const winnerOi = pickWinner(positions, ev.r.size);
        for (const [oi, pos] of positions) {
          if (pos.size <= 0) continue;
          const avgEntry = pos.cost / pos.size;
          if (avgEntry <= 0) continue;
          resolved.push({
            entryPrice: avgEntry,
            exitValue: oi === winnerOi ? 1 : 0,
            sizeUsd: pos.cost,
          });
          pos.size = 0;
          pos.cost = 0;
        }
      }
    }
  }

  return resolved;
}

/**
 * Pick the outcomeIndex whose open size best matches the REDEEM size.
 * Tolerance is 1% of the larger of the two; falls back to the index with the
 * single largest open size when nothing is close.
 */
function pickWinner(
  positions: Map<number, { size: number; cost: number }>,
  redeemSize: number,
): number | null {
  let best: { oi: number; diff: number } | null = null;
  let largest: { oi: number; size: number } | null = null;
  for (const [oi, pos] of positions) {
    if (pos.size <= 0) continue;
    if (!largest || pos.size > largest.size) largest = { oi, size: pos.size };
    const diff = Math.abs(pos.size - redeemSize);
    const tol = Math.max(redeemSize, pos.size) * 0.01;
    if (diff <= tol && (!best || diff < best.diff)) best = { oi, diff };
  }
  if (best) return best.oi;
  return largest?.oi ?? null;
}
