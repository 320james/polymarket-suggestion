import { HttpClient } from "./http.js";
import { DEFAULT_BUCKETS, RateLimiter } from "./rate-limit.js";
import type {
  Activity,
  ActivityType,
  LeaderboardCategory,
  LeaderboardEntry,
  LeaderboardWindow,
  Position,
  Trade,
} from "./types.js";

const BASE = "https://data-api.polymarket.com";

export interface DataApiOptions {
  baseUrl?: string;
  /** Pass your own RateLimiter (e.g. shared across multiple clients), or one is created. */
  limiter?: RateLimiter;
  userAgent?: string;
}

/**
 * Public, unauthenticated Polymarket Data API client.
 * All addresses are PROXY (Gnosis Safe) addresses — positions and trade
 * history on the EOA will appear empty.
 */
export class DataApiClient {
  private readonly http: HttpClient;

  constructor(opts: DataApiOptions = {}) {
    const limiter = opts.limiter ?? new RateLimiter(DEFAULT_BUCKETS);
    this.http = new HttpClient({
      baseUrl: opts.baseUrl ?? BASE,
      limiter,
      userAgent: opts.userAgent,
      maxRetries: 4,
    });
  }

  // ── Leaderboard ────────────────────────────────────────────────────────────

  async getLeaderboard(
    params: {
      category?: LeaderboardCategory;
      timePeriod?: LeaderboardWindow;
      orderBy?: "PNL" | "VOL";
      /** Max 50 per API. */
      limit?: number;
      offset?: number;
    } = {},
  ): Promise<LeaderboardEntry[]> {
    return this.http.getJson<LeaderboardEntry[]>("/v1/leaderboard", {
      rateKey: "data:leaderboard",
      query: {
        category: params.category,
        timePeriod: params.timePeriod,
        orderBy: params.orderBy,
        limit: params.limit,
        offset: params.offset,
      },
    });
  }

  // ── Trades ─────────────────────────────────────────────────────────────────

  /** Single page. Most callers want `getAllTrades`. */
  async getTrades(
    params: {
      user?: string;
      /** CSV joined internally. */
      market?: string[];
      side?: "BUY" | "SELL";
      /** Default `false` here — we want both taker and maker fills for accurate P&L. */
      takerOnly?: boolean;
      /** Max 10000. */
      limit?: number;
      offset?: number;
    } = {},
  ): Promise<Trade[]> {
    return this.http.getJson<Trade[]>("/trades", {
      rateKey: "data:trades",
      query: {
        user: params.user,
        market: params.market?.join(","),
        side: params.side,
        takerOnly: params.takerOnly ?? false,
        limit: params.limit,
        offset: params.offset,
      },
    });
  }

  /** Paginates until `maxTotal` (default 1000) or the source runs out. */
  async getAllTrades(
    user: string,
    opts: {
      pageSize?: number;
      maxTotal?: number;
      takerOnly?: boolean;
    } = {},
  ): Promise<Trade[]> {
    const pageSize = Math.min(opts.pageSize ?? 500, 500);
    const maxTotal = opts.maxTotal ?? 1000;
    const takerOnly = opts.takerOnly ?? false;
    const out: Trade[] = [];
    let offset = 0;
    while (out.length < maxTotal) {
      const want = Math.min(pageSize, maxTotal - out.length);
      const page = await this.getTrades({ user, limit: want, offset, takerOnly });
      out.push(...page);
      if (page.length < want) break;
      offset += page.length;
    }
    return out;
  }

  /**
   * Fetch every trade a user made across a set of markets, in CSV chunks.
   *
   * The `/trades` endpoint accepts `market=<csv>` but a single response is
   * capped at 10000 rows. We chunk the conditionId list and paginate within
   * each chunk. ~30 IDs per chunk keeps the URL well under typical limits
   * (a single conditionId is 66 chars).
   */
  async getTradesForMarkets(
    user: string,
    conditionIds: string[],
    opts: {
      chunkSize?: number;
      /** Max page size from the API is 10000. */
      perChunkLimit?: number;
      takerOnly?: boolean;
    } = {},
  ): Promise<Trade[]> {
    if (conditionIds.length === 0) return [];
    const chunkSize = Math.max(1, Math.min(opts.chunkSize ?? 30, 50));
    const perChunkLimit = Math.min(opts.perChunkLimit ?? 10000, 10000);
    const takerOnly = opts.takerOnly ?? false;
    const out: Trade[] = [];
    for (let i = 0; i < conditionIds.length; i += chunkSize) {
      const chunk = conditionIds.slice(i, i + chunkSize);
      let offset = 0;
      while (true) {
        const page = await this.getTrades({
          user,
          market: chunk,
          takerOnly,
          limit: perChunkLimit,
          offset,
        });
        out.push(...page);
        if (page.length < perChunkLimit) break;
        offset += page.length;
      }
    }
    return out;
  }

  // ── Activity ───────────────────────────────────────────────────────────────

  async getActivity(params: {
    user: string;
    type?: ActivityType[];
    market?: string[];
    /** Unix seconds. */
    start?: number;
    /** Unix seconds. */
    end?: number;
    /** Max 500. */
    limit?: number;
    offset?: number;
    sortBy?: "TIMESTAMP" | "TOKENS" | "CASH";
    sortDirection?: "ASC" | "DESC";
  }): Promise<Activity[]> {
    return this.http.getJson<Activity[]>("/activity", {
      rateKey: "data:activity",
      query: {
        user: params.user,
        type: params.type?.join(","),
        market: params.market?.join(","),
        start: params.start,
        end: params.end,
        limit: params.limit,
        offset: params.offset,
        sortBy: params.sortBy,
        sortDirection: params.sortDirection,
      },
    });
  }

  async getAllActivity(
    user: string,
    opts: {
      type?: ActivityType[];
      pageSize?: number;
      maxTotal?: number;
    } = {},
  ): Promise<Activity[]> {
    const pageSize = Math.min(opts.pageSize ?? 500, 500);
    const maxTotal = opts.maxTotal ?? 5000;
    const out: Activity[] = [];
    let offset = 0;
    while (out.length < maxTotal) {
      const want = Math.min(pageSize, maxTotal - out.length);
      const page = await this.getActivity({
        user,
        type: opts.type,
        limit: want,
        offset,
      });
      out.push(...page);
      if (page.length < want) break;
      offset += page.length;
    }
    return out;
  }

  // ── Positions ──────────────────────────────────────────────────────────────

  async getPositions(params: {
    user: string;
    sizeThreshold?: number;
    market?: string[];
    /** Max 500. */
    limit?: number;
    offset?: number;
  }): Promise<Position[]> {
    return this.http.getJson<Position[]>("/positions", {
      rateKey: "data:positions",
      query: {
        user: params.user,
        sizeThreshold: params.sizeThreshold,
        market: params.market?.join(","),
        limit: params.limit,
        offset: params.offset,
      },
    });
  }
}
