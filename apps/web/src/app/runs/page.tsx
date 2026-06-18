import { prisma } from "@/lib/db";
import { fmtRelative } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function RunsPage() {
  const runs = await prisma.workerRun.findMany({
    orderBy: { id: "desc" },
    take: 50,
  });

  return (
    <div className="space-y-4">
      <header className="flex items-baseline justify-between">
        <h1 className="text-lg font-semibold">Worker runs</h1>
        <p className="text-sm text-zinc-500">
          showing {runs.length} most recent
        </p>
      </header>

      <div className="overflow-x-auto rounded-lg border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
        <table className="min-w-full text-sm">
          <thead className="bg-zinc-50 text-xs uppercase tracking-wide text-zinc-500 dark:bg-zinc-800/50">
            <tr>
              <th className="px-3 py-2 text-right">ID</th>
              <th className="px-3 py-2 text-left">Started</th>
              <th className="px-3 py-2 text-right">Duration</th>
              <th className="px-3 py-2 text-left">Status</th>
              <th className="px-3 py-2 text-right">Candidates</th>
              <th className="px-3 py-2 text-right">Vetted</th>
              <th className="px-3 py-2 text-right">Positions</th>
              <th className="px-3 py-2 text-right">Firings</th>
              <th className="px-3 py-2 text-right">Exits</th>
              <th className="px-3 py-2 text-right">Sent</th>
              <th className="px-3 py-2 text-right">Errors</th>
              <th className="px-3 py-2 text-left">Notes</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {runs.map((r) => {
              const durMs =
                r.startedAt && r.finishedAt
                  ? r.finishedAt.getTime() - r.startedAt.getTime()
                  : null;
              return (
                <tr key={r.id}>
                  <td className="px-3 py-2 text-right font-mono">{r.id}</td>
                  <td
                    className="px-3 py-2 text-zinc-500"
                    title={r.startedAt.toISOString()}
                  >
                    {fmtRelative(r.startedAt)}
                  </td>
                  <td className="px-3 py-2 text-right font-mono">
                    {durMs != null ? `${(durMs / 1000).toFixed(1)}s` : "–"}
                  </td>
                  <td className="px-3 py-2">
                    {r.finishedAt == null ? (
                      <span className="text-amber-700">in-flight</span>
                    ) : r.ok ? (
                      <span className="text-emerald-700">ok</span>
                    ) : (
                      <span className="text-red-700">errors</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right font-mono">
                    {r.candidates}
                  </td>
                  <td className="px-3 py-2 text-right font-mono">{r.vetted}</td>
                  <td className="px-3 py-2 text-right font-mono">
                    {r.positionsSeen.toLocaleString()}
                  </td>
                  <td className="px-3 py-2 text-right font-mono">
                    {r.firings}
                  </td>
                  <td className="px-3 py-2 text-right font-mono">{r.exits}</td>
                  <td className="px-3 py-2 text-right font-mono">
                    {r.notifications}
                  </td>
                  <td className="px-3 py-2 text-right font-mono">
                    {r.errorCount > 0 ? (
                      <span className="text-red-700">{r.errorCount}</span>
                    ) : (
                      0
                    )}
                  </td>
                  <td className="px-3 py-2 text-xs text-zinc-600 dark:text-zinc-400">
                    {r.notes ?? ""}
                  </td>
                </tr>
              );
            })}
            {runs.length === 0 && (
              <tr>
                <td
                  colSpan={12}
                  className="px-3 py-6 text-center text-sm text-zinc-500"
                >
                  No runs yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
