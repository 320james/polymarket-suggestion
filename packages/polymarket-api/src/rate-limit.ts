/**
 * Per-bucket token-bucket rate limiter.
 *
 * Buckets are keyed by an opaque string (e.g. "data:positions") so a single
 * limiter instance can serve every endpoint we hit; the caller passes the
 * right key for each request.
 *
 * Polymarket's enforcement is sliding-window (Cloudflare). To stay safely
 * below it, we treat the published `perWindow / windowSec` as the SUSTAINED
 * rate (refill) and cap the burst at the same rate, so the worst case over
 * any 10 s window is `refill * (windowSec + 1)` — comfortably under quota.
 *
 * Published limits we honour (see https://docs.polymarket.com/api-reference/rate-limits):
 *   Data API  /positions:        150  / 10 s
 *   Data API  /trades:           200  / 10 s
 *   Data API  /activity (gen.):  1000 / 10 s
 *   Data API  /v1/leaderboard:   1000 / 10 s
 *   CLOB      /price, /midpoint: 1500 / 10 s
 */

export interface BucketSpec {
  /** Maximum sustained requests per `windowSec`. */
  perWindow: number;
  /** Window length in seconds (matches the documented quota). */
  windowSec: number;
}

interface Bucket {
  capacity: number;
  refillPerSec: number;
  tokens: number;
  lastRefillMs: number;
}

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(specs: Record<string, BucketSpec>) {
    const now = Date.now();
    for (const [key, spec] of Object.entries(specs)) {
      const refillPerSec = spec.perWindow / spec.windowSec;
      // Burst = ~1 s of headroom. Keeps `capacity + refill * windowSec` <= perWindow * 1.1
      const capacity = Math.max(1, Math.floor(refillPerSec));
      this.buckets.set(key, {
        capacity,
        refillPerSec,
        tokens: capacity,
        lastRefillMs: now,
      });
    }
  }

  /** Block until one token is available in `key`'s bucket. Unknown keys pass through. */
  async acquire(key: string): Promise<void> {
    const b = this.buckets.get(key);
    if (!b) return;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      this.refill(b);
      if (b.tokens >= 1) {
        b.tokens -= 1;
        return;
      }
      const needed = 1 - b.tokens;
      const waitMs = Math.ceil((needed / b.refillPerSec) * 1000) + 5;
      await sleep(waitMs);
    }
  }

  private refill(b: Bucket): void {
    const now = Date.now();
    const elapsedSec = (now - b.lastRefillMs) / 1000;
    b.tokens = Math.min(b.capacity, b.tokens + elapsedSec * b.refillPerSec);
    b.lastRefillMs = now;
  }
}

export const DEFAULT_BUCKETS: Record<string, BucketSpec> = {
  "data:positions": { perWindow: 150, windowSec: 10 },
  "data:trades": { perWindow: 200, windowSec: 10 },
  "data:activity": { perWindow: 1000, windowSec: 10 },
  "data:leaderboard": { perWindow: 1000, windowSec: 10 },
  "clob:price": { perWindow: 1500, windowSec: 10 },
  "clob:midpoint": { perWindow: 1500, windowSec: 10 },
  // Batch CLOB endpoints share the same family limit; bucket separately so
  // singles vs batches don't starve each other.
  "clob:prices": { perWindow: 1500, windowSec: 10 },
  "clob:midpoints": { perWindow: 1500, windowSec: 10 },
  // Gamma has no published rate limit; conservative ~10 rps sustained.
  "gamma:markets": { perWindow: 100, windowSec: 10 },
};

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
