import { RateLimiter } from "./rate-limit.js";

export interface HttpOptions {
  baseUrl: string;
  limiter: RateLimiter;
  userAgent?: string;
  maxRetries?: number;
}

export interface RequestOptions {
  /** Bucket key for the rate limiter, e.g. "data:trades". */
  rateKey?: string;
  /**
   * Query params. For repeated params (e.g. `?condition_ids=a&condition_ids=b`),
   * pass an array as the value.
   */
  query?: Record<string, string | number | boolean | string[] | number[] | undefined | null>;
  signal?: AbortSignal;
}

export interface PostJsonOptions extends RequestOptions {
  body: unknown;
}

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly url: string,
    public readonly body: string,
  ) {
    super(`HTTP ${status} ${url} — ${body.slice(0, 200)}`);
    this.name = "HttpError";
  }
}

/**
 * Minimal JSON HTTP client with rate-limit acquire, retry/backoff, and
 * Retry-After respect on 429s.
 *
 * No external deps — uses Node's native fetch (>=18).
 */
export class HttpClient {
  constructor(private readonly opts: HttpOptions) {}

  async getJson<T>(path: string, req: RequestOptions = {}): Promise<T> {
    return this.request<T>("GET", path, req);
  }

  async postJson<T>(path: string, req: PostJsonOptions): Promise<T> {
    return this.request<T>("POST", path, req, req.body);
  }

  private async request<T>(
    method: "GET" | "POST",
    path: string,
    req: RequestOptions,
    body?: unknown,
  ): Promise<T> {
    const url = this.buildUrl(path, req.query);
    const maxRetries = this.opts.maxRetries ?? 4;
    let attempt = 0;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (req.rateKey) await this.opts.limiter.acquire(req.rateKey);

      let res: Response;
      try {
        res = await fetch(url, {
          method,
          headers: {
            accept: "application/json",
            "user-agent":
              this.opts.userAgent ?? "polymarket-suggest/0.1 (+local)",
            ...(body !== undefined ? { "content-type": "application/json" } : {}),
          },
          body: body !== undefined ? JSON.stringify(body) : undefined,
          signal: req.signal,
        });
      } catch (err) {
        if (attempt++ >= maxRetries) throw err;
        await sleep(backoffMs(attempt));
        continue;
      }

      if (res.status === 429 || res.status >= 500) {
        if (attempt++ >= maxRetries) {
          throw new HttpError(res.status, url, await safeText(res));
        }
        const retryAfterSec = Number(res.headers.get("retry-after"));
        const delay =
          Number.isFinite(retryAfterSec) && retryAfterSec > 0
            ? retryAfterSec * 1000
            : backoffMs(attempt);
        await sleep(delay);
        continue;
      }

      if (!res.ok) {
        throw new HttpError(res.status, url, await safeText(res));
      }
      return res.json() as Promise<T>;
    }
  }

  private buildUrl(path: string, query?: RequestOptions["query"]): string {
    const u = new URL(path, this.opts.baseUrl);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v === undefined || v === null) continue;
        if (Array.isArray(v)) {
          for (const item of v) u.searchParams.append(k, String(item));
        } else {
          u.searchParams.set(k, String(v));
        }
      }
    }
    return u.toString();
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function backoffMs(attempt: number): number {
  const base = Math.min(1000 * 2 ** attempt, 15_000);
  return Math.round(base * (0.5 + Math.random())); // full jitter
}
