import type {
  LeaderboardCategory,
  LeaderboardEntry,
  LeaderboardWindow,
} from "@poly/polymarket-api";
import { DataApiClient } from "@poly/polymarket-api";

/** A candidate plus per-window provenance (used to compute windowsAppeared). */
export interface Candidate {
  proxyWallet: string;
  username: string;
  /** Best (lowest) rank seen across the windows we pulled. */
  bestRank: number;
  pnl: number;
  volume: number;
  /** Number of distinct windows this trader appeared in (1..N). */
  windowsAppeared: number;
}

/**
 * Pull leaderboards across several time windows, dedup by proxyWallet, and
 * compute windowsAppeared.
 *
 * The API caps `limit` at 50, so for poolSize > 50 we paginate per window.
 */
export async function selectCandidates(
  api: DataApiClient,
  opts: {
    windows: LeaderboardWindow[];
    category: LeaderboardCategory;
    poolSize: number;
    orderBy?: "PNL" | "VOL";
  },
): Promise<Candidate[]> {
  const { windows, category, poolSize, orderBy = "PNL" } = opts;
  /** proxyWallet -> aggregate */
  const merged = new Map<
    string,
    {
      proxyWallet: string;
      username: string;
      bestRank: number;
      pnl: number;
      volume: number;
      windows: Set<LeaderboardWindow>;
    }
  >();

  for (const window of windows) {
    const rows = await fetchWindow(api, {
      window,
      category,
      orderBy,
      total: poolSize,
    });
    for (const r of rows) {
      const rankNum = Number(r.rank);
      const existing = merged.get(r.proxyWallet);
      if (existing) {
        existing.bestRank = Math.min(existing.bestRank, rankNum);
        existing.windows.add(window);
        // Prefer the highest pnl/vol seen across windows for display only.
        existing.pnl = Math.max(existing.pnl, r.pnl);
        existing.volume = Math.max(existing.volume, r.vol);
      } else {
        merged.set(r.proxyWallet, {
          proxyWallet: r.proxyWallet,
          username: r.userName,
          bestRank: rankNum,
          pnl: r.pnl,
          volume: r.vol,
          windows: new Set([window]),
        });
      }
    }
  }

  return [...merged.values()]
    .map((m) => ({
      proxyWallet: m.proxyWallet,
      username: m.username,
      bestRank: m.bestRank,
      pnl: m.pnl,
      volume: m.volume,
      windowsAppeared: m.windows.size,
    }))
    .sort((a, b) => a.bestRank - b.bestRank);
}

async function fetchWindow(
  api: DataApiClient,
  opts: {
    window: LeaderboardWindow;
    category: LeaderboardCategory;
    orderBy: "PNL" | "VOL";
    total: number;
  },
): Promise<LeaderboardEntry[]> {
  const PAGE = 50; // API max
  const out: LeaderboardEntry[] = [];
  let offset = 0;
  while (out.length < opts.total) {
    const want = Math.min(PAGE, opts.total - out.length);
    const page = await api.getLeaderboard({
      category: opts.category,
      timePeriod: opts.window,
      orderBy: opts.orderBy,
      limit: want,
      offset,
    });
    out.push(...page);
    if (page.length < want) break;
    offset += page.length;
  }
  return out;
}
