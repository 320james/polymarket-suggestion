/**
 * `pnpm markets` — sanity-check the Gamma market cache + CLOB prices.
 *
 * Pulls a sample trader's current positions, derives the conditionIds and
 * tokenIds, hits the market cache (first run = miss, second = hit), and
 * fetches midpoints + bid/ask. Prints a table so we can eyeball that:
 *   - Gamma decoding is correct (outcomes/tokens line up with the position)
 *   - Cache TTL behaves (second run prints "0 fetched" or close to it)
 *   - CLOB prices are reasonable (midpoint between bid & ask, 0..1)
 *
 * Usage:
 *   pnpm markets                 # default sample address
 *   USER=0x...  pnpm markets     # override trader
 *   FORCE=1     pnpm markets     # ignore cache and refetch
 */

import {
  ClobApiClient,
  DataApiClient,
  GammaApiClient,
  RateLimiter,
  DEFAULT_BUCKETS,
  type Position,
} from "@poly/polymarket-api";
import { getOrFetchMarkets } from "../pipeline/market-cache.js";
import { getPrisma, disconnectPrisma } from "../db.js";
import { log } from "../log.js";

// swisstony from our vet run — known to have many open positions
const DEFAULT_USER = "0x204f72f35326db932158cba6adff0b9a1da95e14";

const USER = (process.env.USER && process.env.USER.startsWith("0x"))
  ? process.env.USER
  : DEFAULT_USER;
const FORCE = process.env.FORCE === "1";
const LIMIT = Number(process.env.LIMIT ?? 15);

async function main(): Promise<void> {
  const limiter = new RateLimiter(DEFAULT_BUCKETS);
  const data = new DataApiClient({ limiter });
  const gamma = new GammaApiClient({ limiter });
  const clob = new ClobApiClient({ limiter });
  const prisma = getPrisma();

  log.info({ user: USER, force: FORCE, limit: LIMIT }, "fetching positions");
  const positions = await data.getPositions({
    user: USER,
    sizeThreshold: 1,
    limit: LIMIT,
  });
  log.info({ count: positions.length }, "positions fetched");
  if (positions.length === 0) {
    log.warn("no positions — try a different USER address");
    await disconnectPrisma();
    return;
  }

  const conditionIds = [...new Set(positions.map((p) => p.conditionId))];
  const tokenIds = [...new Set(positions.map((p) => p.asset))];

  const t1 = Date.now();
  const cache = await getOrFetchMarkets(prisma, gamma, conditionIds, {
    forceRefresh: FORCE,
  });
  log.info(
    {
      ms: Date.now() - t1,
      wanted: conditionIds.length,
      cached: conditionIds.length - cache.fetched,
      fetched: cache.fetched,
      missing: cache.missing.length,
    },
    "market cache result",
  );

  const t2 = Date.now();
  const midpoints = await clob.getMidpoints(tokenIds);
  log.info({ ms: Date.now() - t2, n: midpoints.size }, "midpoints fetched");

  const t3 = Date.now();
  const prices = await clob.getPrices(
    tokenIds.flatMap((id) => [
      { token_id: id, side: "BUY" as const },
      { token_id: id, side: "SELL" as const },
    ]),
  );
  log.info({ ms: Date.now() - t3, n: prices.size }, "prices fetched");

  printTable(positions, cache.markets, midpoints, prices);

  await disconnectPrisma();
}

function printTable(
  positions: Position[],
  markets: Map<string, ReturnType<typeof Object>>,
  midpoints: Map<string, number | null>,
  prices: Map<string, { BUY: number | null; SELL: number | null }>,
): void {
  const header = ["question", "outcome", "size", "avg", "bid", "mid", "ask", "spd¢", "match"];
  const data = positions.map((p) => {
    const m = markets.get(p.conditionId);
    const mid = midpoints.get(p.asset) ?? null;
    const ba = prices.get(p.asset) ?? { BUY: null, SELL: null };
    const spreadC = ba.BUY != null && ba.SELL != null
      ? Math.round((ba.SELL - ba.BUY) * 100)
      : null;
    // Confirm Gamma's tokens line up with the position's asset id.
    const tokenMatch = m
      ? (m as any).tokens?.some(
          (t: { tokenId: string; outcome: string }) =>
            t.tokenId === p.asset && t.outcome === p.outcome,
        )
      : false;
    return [
      truncate((m as any)?.question ?? p.title, 38),
      String(p.outcome).slice(0, 6),
      fmt(p.size, 0),
      pct(p.avgPrice),
      ba.BUY != null ? pct(ba.BUY) : "–",
      mid != null ? pct(mid) : "–",
      ba.SELL != null ? pct(ba.SELL) : "–",
      spreadC != null ? String(spreadC) : "–",
      tokenMatch ? "✓" : "·",
    ];
  });

  const widths = header.map((h, i) =>
    Math.max(h.length, ...data.map((r) => r[i]!.length)),
  );
  const sep = "  ";
  const fmtRow = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i]!)).join(sep);

  const out = [
    "",
    "─── MARKET CACHE + CLOB ──────────────────────────────────────────",
    fmtRow(header),
    fmtRow(widths.map((w) => "─".repeat(w))),
    ...data.map(fmtRow),
    "",
  ].join("\n");
  process.stdout.write(out);
}

function fmt(n: number | undefined, dp = 2): string {
  if (n == null || !Number.isFinite(n)) return "–";
  return n.toFixed(dp);
}
function pct(n: number | undefined | null): string {
  if (n == null || !Number.isFinite(n)) return "–";
  return (n * 100).toFixed(1);
}
function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

main().catch((err) => {
  log.error({ err: (err as Error).message, stack: (err as Error).stack }, "fatal");
  process.exit(1);
});
