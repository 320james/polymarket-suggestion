import { HttpClient } from "./http.js";
import { DEFAULT_BUCKETS, RateLimiter } from "./rate-limit.js";
import type { GammaMarket, GammaMarketRaw, GammaTokenInfo } from "./types.js";

const BASE = "https://gamma-api.polymarket.com";

export interface GammaApiOptions {
  baseUrl?: string;
  limiter?: RateLimiter;
  userAgent?: string;
}

/**
 * Polymarket Gamma metadata client.
 *
 * Verified quirks (probed against live API 2026-06-17):
 *   - `condition_ids` is a REPEATED query param, not CSV.
 *   - By default `/markets` returns OPEN markets only (`closed=false`).
 *     To include closed/resolved markets, the request must set `closed=true`.
 *     There is no "any" — to cover both we fire two parallel requests per batch.
 *   - Several fields ship as JSON-encoded strings (`outcomes`,
 *     `clobTokenIds`); we decode them once into a normalized `GammaMarket`.
 */
export class GammaApiClient {
  private readonly http: HttpClient;

  constructor(opts: GammaApiOptions = {}) {
    const limiter = opts.limiter ?? new RateLimiter(DEFAULT_BUCKETS);
    this.http = new HttpClient({
      baseUrl: opts.baseUrl ?? BASE,
      limiter,
      userAgent: opts.userAgent,
      maxRetries: 4,
    });
  }

  /**
   * Fetch markets matching any of the given conditionIds, regardless of
   * open/closed state. Chunked to keep URL length reasonable
   * (~30 ids/batch ≈ 2.5 KB).
   *
   * Missing conditionIds are simply absent from the returned map (callers
   * must handle that — e.g. unknown market, archived, or already pruned).
   */
  async getMarketsByConditionIds(
    conditionIds: string[],
    opts: { chunkSize?: number } = {},
  ): Promise<Map<string, GammaMarket>> {
    const out = new Map<string, GammaMarket>();
    if (conditionIds.length === 0) return out;

    // Dedup just in case the caller passed repeats.
    const unique = [...new Set(conditionIds)];
    const chunkSize = Math.max(1, Math.min(opts.chunkSize ?? 30, 50));

    for (let i = 0; i < unique.length; i += chunkSize) {
      const chunk = unique.slice(i, i + chunkSize);
      // Open + closed in parallel — independent rate-limit bucket fine.
      const [openRows, closedRows] = await Promise.all([
        this.fetchChunk(chunk, false),
        this.fetchChunk(chunk, true),
      ]);
      for (const m of [...openRows, ...closedRows]) {
        const norm = normalizeMarket(m);
        if (norm) out.set(norm.conditionId, norm);
      }
    }
    return out;
  }

  /** Single chunk, single state. */
  private async fetchChunk(
    conditionIds: string[],
    closed: boolean,
  ): Promise<GammaMarketRaw[]> {
    return this.http.getJson<GammaMarketRaw[]>("/markets", {
      rateKey: "gamma:markets",
      query: {
        condition_ids: conditionIds, // repeated param via array
        closed: closed,
        limit: conditionIds.length,
      },
    });
  }
}

/** Decode JSON-encoded fields and zip outcomes ↔ tokenIds. */
export function normalizeMarket(raw: GammaMarketRaw): GammaMarket | null {
  if (!raw.conditionId) return null;
  const outcomes = parseJsonArray<string>(raw.outcomes);
  const tokenIds = parseJsonArray<string>(raw.clobTokenIds);

  // Zip aligned arrays. If lengths disagree, take the min and log nothing
  // (worker logs the count delta if it needs to know).
  const n = Math.min(outcomes.length, tokenIds.length);
  const tokens: GammaTokenInfo[] = [];
  for (let i = 0; i < n; i++) {
    tokens.push({
      tokenId: tokenIds[i]!,
      outcome: outcomes[i]!,
      outcomeIndex: i,
    });
  }

  return {
    conditionId: raw.conditionId,
    question: raw.question ?? "",
    slug: raw.slug ?? null,
    endDate: raw.endDate ? new Date(raw.endDate) : null,
    outcomes,
    tokens,
    active: raw.active ?? false,
    closed: raw.closed ?? false,
    negativeRisk: raw.negRisk ?? false,
    resolutionSource: raw.resolutionSource || null,
  };
}

function parseJsonArray<T>(s: string | undefined): T[] {
  if (!s) return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? (v as T[]) : [];
  } catch {
    return [];
  }
}
