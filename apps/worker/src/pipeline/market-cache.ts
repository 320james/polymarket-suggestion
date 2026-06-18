/**
 * Market cache — single source of truth for Gamma metadata.
 *
 * Each poll asks for a set of conditionIds (drawn from holdings + new
 * suggestions). We:
 *   1. Read existing rows from the Market table.
 *   2. Identify which need refresh: missing, or older than TTL, or open
 *      markets past their endDate (likely just settled).
 *   3. Fetch them via Gamma in batches (the client handles open+closed in
 *      one logical call).
 *   4. Upsert and return the merged Map.
 *
 * Anything missing from Gamma after a fetch is *not* removed — the caller
 * decides whether to treat that as "unknown market" (e.g. archived).
 */

import type { PrismaClient, Market } from "@prisma/client";
import type { GammaApiClient, GammaMarket } from "@poly/polymarket-api";

const DEFAULT_TTL_MS = 30 * 60 * 1000; // 30 min for open markets

export interface MarketCacheOptions {
  /** How stale an open-market cache row can be before we refresh. */
  ttlMs?: number;
  /** Force a refresh of every conditionId regardless of cache state. */
  forceRefresh?: boolean;
}

export interface MarketCacheResult {
  /** All resolved markets, keyed by conditionId. */
  markets: Map<string, GammaMarket>;
  /** ConditionIds Gamma had no record for (likely archived / negRisk leaf). */
  missing: string[];
  /** How many we ended up fetching this call (the rest were cache hits). */
  fetched: number;
}

export async function getOrFetchMarkets(
  prisma: PrismaClient,
  gamma: GammaApiClient,
  conditionIds: string[],
  opts: MarketCacheOptions = {},
): Promise<MarketCacheResult> {
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  const wanted = [...new Set(conditionIds)].filter(Boolean);
  if (wanted.length === 0) {
    return { markets: new Map(), missing: [], fetched: 0 };
  }

  const existing = opts.forceRefresh
    ? []
    : await prisma.market.findMany({ where: { conditionId: { in: wanted } } });

  const byId = new Map(existing.map((m) => [m.conditionId, m]));
  const now = Date.now();
  const stale: string[] = [];
  const fresh = new Map<string, GammaMarket>();

  for (const id of wanted) {
    const row = byId.get(id);
    if (!row) {
      stale.push(id);
      continue;
    }
    if (isStale(row, now, ttlMs)) {
      stale.push(id);
      // Keep the old data as a fallback in case Gamma misses it.
      fresh.set(id, fromRow(row));
    } else {
      fresh.set(id, fromRow(row));
    }
  }

  let fetchedRows = new Map<string, GammaMarket>();
  if (stale.length > 0) {
    fetchedRows = await gamma.getMarketsByConditionIds(stale);
    await upsertMany(prisma, [...fetchedRows.values()]);
    for (const [id, m] of fetchedRows) fresh.set(id, m);
  }

  const missing = wanted.filter((id) => !fresh.has(id));
  return { markets: fresh, missing, fetched: fetchedRows.size };
}

function isStale(row: Market, now: number, ttlMs: number): boolean {
  // Closed markets effectively never change — once we've recorded the
  // resolution, the row is good forever.
  if (row.closed) return false;
  return now - row.updatedAt.getTime() > ttlMs;
}

async function upsertMany(
  prisma: PrismaClient,
  markets: GammaMarket[],
): Promise<void> {
  // SQLite + Prisma: no batch upsert. Sequential keeps it simple and the
  // worst case (~50 per poll) is fine.
  for (const m of markets) {
    const tokenJson = JSON.stringify(m.tokens);
    const outcomeJson = JSON.stringify(m.outcomes);
    await prisma.market.upsert({
      where: { conditionId: m.conditionId },
      create: {
        conditionId: m.conditionId,
        slug: m.slug,
        question: m.question,
        endDate: m.endDate,
        resolutionSource: m.resolutionSource,
        outcomes: outcomeJson,
        tokens: tokenJson,
        closed: m.closed,
        active: m.active,
        negativeRisk: m.negativeRisk,
      },
      update: {
        slug: m.slug,
        question: m.question,
        endDate: m.endDate,
        resolutionSource: m.resolutionSource,
        outcomes: outcomeJson,
        tokens: tokenJson,
        closed: m.closed,
        active: m.active,
        negativeRisk: m.negativeRisk,
      },
    });
  }
}

function fromRow(row: Market): GammaMarket {
  return {
    conditionId: row.conditionId,
    question: row.question,
    slug: row.slug,
    endDate: row.endDate,
    outcomes: safeJsonArray<string>(row.outcomes),
    tokens: safeJsonArray<GammaMarket["tokens"][number]>(row.tokens),
    active: row.active,
    closed: row.closed,
    negativeRisk: row.negativeRisk,
    resolutionSource: row.resolutionSource,
  };
}

function safeJsonArray<T>(s: string | null | undefined): T[] {
  if (!s) return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? (v as T[]) : [];
  } catch {
    return [];
  }
}
