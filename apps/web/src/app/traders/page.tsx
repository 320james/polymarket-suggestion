import { prisma } from "@/lib/db";
import { fmtPct, fmtNum, fmtRelative, fmtAddress } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function TradersPage() {
  // Vetted traders first, then the rest (for diagnostic visibility).
  const traders = await prisma.trackedTrader.findMany({
    orderBy: [{ vetted: "desc" }, { trustWeight: "desc" }, { bestRank: "asc" }],
    take: 200,
  });

  const vettedCount = traders.filter((t) => t.vetted).length;

  return (
    <div className="space-y-4">
      <header className="flex items-baseline justify-between">
        <h1 className="text-lg font-semibold">Tracked traders</h1>
        <p className="text-sm text-zinc-500">
          {vettedCount} vetted / {traders.length} total
        </p>
      </header>

      <div className="overflow-x-auto rounded-lg border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
        <table className="min-w-full text-sm">
          <thead className="bg-zinc-50 text-xs uppercase tracking-wide text-zinc-500 dark:bg-zinc-800/50">
            <tr>
              <th className="px-3 py-2 text-left">Vetted</th>
              <th className="px-3 py-2 text-left">User</th>
              <th className="px-3 py-2 text-left">Proxy</th>
              <th className="px-3 py-2 text-right">Best rank</th>
              <th className="px-3 py-2 text-right">Win %</th>
              <th className="px-3 py-2 text-right">PF</th>
              <th className="px-3 py-2 text-right">Avg ROI</th>
              <th className="px-3 py-2 text-right">Avg odds</th>
              <th className="px-3 py-2 text-right">Resolved</th>
              <th className="px-3 py-2 text-right">Windows</th>
              <th className="px-3 py-2 text-right">Trust</th>
              <th className="px-3 py-2 text-left">Stats refreshed</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {traders.map((t) => (
              <tr key={t.id} className={t.vetted ? "" : "opacity-50"}>
                <td className="px-3 py-2">
                  {t.vetted ? (
                    <span className="inline-block rounded border border-emerald-300 bg-emerald-100 px-1.5 py-0.5 text-xs font-semibold uppercase text-emerald-900">
                      yes
                    </span>
                  ) : (
                    <span className="inline-block rounded border border-zinc-300 bg-zinc-100 px-1.5 py-0.5 text-xs font-semibold uppercase text-zinc-600">
                      no
                    </span>
                  )}
                </td>
                <td className="px-3 py-2">{t.username || "—"}</td>
                <td
                  className="px-3 py-2 font-mono text-xs text-zinc-500"
                  title={t.id}
                >
                  {fmtAddress(t.id)}
                </td>
                <td className="px-3 py-2 text-right font-mono">{t.bestRank}</td>
                <td className="px-3 py-2 text-right font-mono">
                  {fmtPct(t.winRate)}
                </td>
                <td className="px-3 py-2 text-right font-mono">
                  {fmtNum(t.profitFactor)}
                </td>
                <td className="px-3 py-2 text-right font-mono">
                  {fmtPct(t.avgRoi)}
                </td>
                <td className="px-3 py-2 text-right font-mono">
                  {fmtPct(t.avgEntryOdds)}
                </td>
                <td className="px-3 py-2 text-right font-mono">
                  {t.resolvedTrades}
                </td>
                <td className="px-3 py-2 text-right font-mono">
                  {t.windowsAppeared}/3
                </td>
                <td className="px-3 py-2 text-right font-mono">
                  {fmtNum(t.trustWeight)}
                </td>
                <td
                  className="px-3 py-2 text-zinc-500"
                  title={t.lastStatsComputedAt?.toISOString()}
                >
                  {fmtRelative(t.lastStatsComputedAt)}
                </td>
              </tr>
            ))}
            {traders.length === 0 && (
              <tr>
                <td
                  colSpan={12}
                  className="px-3 py-6 text-center text-sm text-zinc-500"
                >
                  No traders tracked yet — run{" "}
                  <code className="font-mono">pnpm poll</code> to populate.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
