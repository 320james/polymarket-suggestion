import { HttpClient } from "./http.js";
import { DEFAULT_BUCKETS, RateLimiter } from "./rate-limit.js";
import type {
  ClobMidpointResponse,
  ClobMidpointsResponse,
  ClobPriceResponse,
  ClobPricesItem,
  ClobPricesResponse,
} from "./types.js";

const BASE = "https://clob.polymarket.com";

export interface ClobApiOptions {
  baseUrl?: string;
  limiter?: RateLimiter;
  userAgent?: string;
}

/**
 * Polymarket CLOB price client.
 *
 * Quirks (verified live 2026-06-17):
 *   - All numeric prices come back as STRINGS — callers must `Number(x)`.
 *   - Batch endpoints (`POST /midpoints`, `POST /prices`) take a JSON array
 *     of `{token_id}` / `{token_id, side}` items and return a flat object
 *     keyed by token_id.
 *   - Tokens without an active orderbook 404 ("No orderbook exists for the
 *     requested token id"); the batch endpoints simply omit them from the
 *     response — convert that to `null` in the returned Map.
 */
export class ClobApiClient {
  private readonly http: HttpClient;

  constructor(opts: ClobApiOptions = {}) {
    const limiter = opts.limiter ?? new RateLimiter(DEFAULT_BUCKETS);
    this.http = new HttpClient({
      baseUrl: opts.baseUrl ?? BASE,
      limiter,
      userAgent: opts.userAgent,
      maxRetries: 4,
    });
  }

  // ── Singles (handy for tests / ad-hoc) ────────────────────────────────────

  /** Returns midpoint as a number, or null if no orderbook. */
  async getMidpoint(tokenId: string): Promise<number | null> {
    try {
      const r = await this.http.getJson<ClobMidpointResponse>("/midpoint", {
        rateKey: "clob:midpoint",
        query: { token_id: tokenId },
      });
      const n = Number(r.mid);
      return Number.isFinite(n) ? n : null;
    } catch (e) {
      if (isNoOrderbook(e)) return null;
      throw e;
    }
  }

  /** Best bid (`BUY`) or ask (`SELL`) price as a number, or null. */
  async getPrice(
    tokenId: string,
    side: "BUY" | "SELL",
  ): Promise<number | null> {
    try {
      const r = await this.http.getJson<ClobPriceResponse>("/price", {
        rateKey: "clob:price",
        query: { token_id: tokenId, side },
      });
      const n = Number(r.price);
      return Number.isFinite(n) ? n : null;
    } catch (e) {
      if (isNoOrderbook(e)) return null;
      throw e;
    }
  }

  // ── Batches (use these from the worker) ───────────────────────────────────

  /**
   * Batch midpoint lookup. Returns a Map keyed by tokenId; tokens without a
   * usable orderbook are mapped to `null`.
   */
  async getMidpoints(tokenIds: string[]): Promise<Map<string, number | null>> {
    const out = new Map<string, number | null>();
    if (tokenIds.length === 0) return out;
    const unique = [...new Set(tokenIds)];

    // CLOB batch endpoints have no documented size cap; chunk at 100 to be
    // friendly to URLs/load and to keep failures localized.
    const chunkSize = 100;
    for (let i = 0; i < unique.length; i += chunkSize) {
      const chunk = unique.slice(i, i + chunkSize);
      const body = chunk.map((token_id) => ({ token_id }));
      const r = await this.http.postJson<ClobMidpointsResponse>("/midpoints", {
        rateKey: "clob:midpoints",
        body,
      });
      for (const id of chunk) {
        const raw = r[id];
        const n = raw != null ? Number(raw) : NaN;
        out.set(id, Number.isFinite(n) ? n : null);
      }
    }
    return out;
  }

  /**
   * Batch best-bid/best-ask lookup. Pass `{tokenId, side}` pairs; result
   * preserves `null` for missing entries.
   */
  async getPrices(
    items: ClobPricesItem[],
  ): Promise<Map<string, { BUY: number | null; SELL: number | null }>> {
    const out = new Map<string, { BUY: number | null; SELL: number | null }>();
    if (items.length === 0) return out;

    // Group by token so we always return both sides if asked.
    const byToken = new Map<string, Set<"BUY" | "SELL">>();
    for (const it of items) {
      const sides = byToken.get(it.token_id) ?? new Set();
      sides.add(it.side);
      byToken.set(it.token_id, sides);
    }

    const flat: ClobPricesItem[] = [];
    for (const [token_id, sides] of byToken) {
      for (const side of sides) flat.push({ token_id, side });
    }

    const chunkSize = 100;
    for (let i = 0; i < flat.length; i += chunkSize) {
      const chunk = flat.slice(i, i + chunkSize);
      const r = await this.http.postJson<ClobPricesResponse>("/prices", {
        rateKey: "clob:prices",
        body: chunk,
      });
      for (const it of chunk) {
        const entry = out.get(it.token_id) ?? { BUY: null, SELL: null };
        const raw = r[it.token_id]?.[it.side];
        const n = raw != null ? Number(raw) : NaN;
        entry[it.side] = Number.isFinite(n) ? n : null;
        out.set(it.token_id, entry);
      }
    }
    return out;
  }
}

function isNoOrderbook(e: unknown): boolean {
  return (
    typeof e === "object" &&
    e !== null &&
    "status" in e &&
    (e as { status: number }).status === 404
  );
}
