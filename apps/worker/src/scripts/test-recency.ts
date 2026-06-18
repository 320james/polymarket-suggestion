/**
 * Quick sanity-check of buildResolvedTrades' recency clip.
 * Synthetic data, no network. Verifies:
 *   1. Without closedSince, all cycles are emitted.
 *   2. With a 90d closedSince, only cycles closed in the last 90d are emitted.
 *   3. Old BUY → new SELL still emits one cycle (BUY inventory survives the clip).
 *   4. Old BUY → old REDEEM is suppressed entirely.
 */
import { buildResolvedTrades } from "../pipeline/resolved-trades.js";
import type { Trade, Activity } from "@poly/polymarket-api";

const nowSec = Math.floor(Date.now() / 1000);
const day = 86_400;

function trade(
  p: Partial<Trade> & {
    ts: number;
    side: "BUY" | "SELL";
    cond: string;
    oi?: number;
  },
): Trade {
  return {
    transactionHash: `0x${Math.random().toString(16).slice(2)}`,
    timestamp: p.ts,
    side: p.side,
    asset: `tok-${p.cond}-${p.oi ?? 0}`,
    conditionId: p.cond,
    outcome: p.oi === 1 ? "No" : "Yes",
    outcomeIndex: p.oi ?? 0,
    size: p.size ?? 100,
    price: p.price ?? 0.5,
    proxyWallet: "0xtest",
  } as Trade;
}

function redeem(cond: string, ts: number, size = 100): Activity {
  return {
    type: "REDEEM",
    timestamp: ts,
    conditionId: cond,
    asset: "",
    outcomeIndex: 999,
    size,
    price: 0,
    side: "BUY",
    proxyWallet: "0xtest",
    transactionHash: `0x${Math.random().toString(16).slice(2)}`,
  } as Activity;
}

function expect(label: string, actual: number, expected: number): void {
  const ok = actual === expected;
  console.log(
    `${ok ? "✓" : "✗"} ${label}: got ${actual}, expected ${expected}`,
  );
  if (!ok) process.exit(1);
}

// Setup: 3 cycles
// A: BUY 200d ago, SELL 150d ago (OLD cycle)
// B: BUY 100d ago, SELL 30d ago    (BUY old, SELL recent → cycle is recent)
// C: BUY 10d ago,  REDEEM 5d ago   (fully recent)
const trades: Trade[] = [
  trade({ cond: "A", side: "BUY", ts: nowSec - 200 * day, price: 0.3 }),
  trade({ cond: "A", side: "SELL", ts: nowSec - 150 * day, price: 0.5 }),
  trade({ cond: "B", side: "BUY", ts: nowSec - 100 * day, price: 0.4 }),
  trade({ cond: "B", side: "SELL", ts: nowSec - 30 * day, price: 0.7 }),
  trade({ cond: "C", side: "BUY", ts: nowSec - 10 * day, price: 0.25 }),
];
const redeems: Activity[] = [redeem("C", nowSec - 5 * day, 100)];

// Case 1: unbounded — should produce 3 cycles (A SELL, B SELL, C REDEEM win)
const all = buildResolvedTrades(trades, redeems);
expect("[1] unbounded total cycles", all.length, 3);

// Case 2: 90d window — should produce only B (SELL@30d) + C (REDEEM@5d) = 2
const w90 = new Date(Date.now() - 90 * day * 1000);
const recent = buildResolvedTrades(trades, redeems, w90);
expect("[2] 90d window cycles", recent.length, 2);

// Case 3: B was a BUY 100d ago + SELL 30d ago. With 90d clip, BUY is "old" but
//         the cycle is counted as long as SELL is in window. Verify B's entryPrice
//         is preserved (0.40 from the 100d-old BUY).
const b = recent.find((r) => Math.abs(r.entryPrice - 0.4) < 1e-9);
expect("[3] B inventory survives clip (entryPrice=0.40 found)", b ? 1 : 0, 1);

// Case 4: A's old cycle should be entirely missing — its SELL at 150d falls outside.
const a = recent.find((r) => Math.abs(r.entryPrice - 0.3) < 1e-9);
expect("[4] A old cycle suppressed", a ? 1 : 0, 0);

// Case 5: 1-day window — only C (REDEEM 5d ago) is within… actually no, 5d > 1d → 0
const w1 = new Date(Date.now() - 1 * day * 1000);
const veryRecent = buildResolvedTrades(trades, redeems, w1);
expect("[5] 1d window suppresses everything", veryRecent.length, 0);

console.log("\n✓ recency clip works correctly (sec/ms units aligned)");
