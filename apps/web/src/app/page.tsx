import Link from "next/link";
import { prisma } from "@/lib/db";
import {
  fmtCents,
  fmtSignedCents,
  fmtRelative,
  statusBadgeClass,
  typeBadgeClass,
} from "@/lib/format";

// Don't cache — we want every refresh to read fresh DB state.
export const dynamic = "force-dynamic";

export default async function HomePage() {
  // Two queries in parallel — both are cheap.
  const [lastRun, openSuggestions, config] = await Promise.all([
    prisma.workerRun.findFirst({ orderBy: { id: "desc" } }),
    prisma.suggestion.findMany({
      where: { status: { in: ["NEW", "NOTIFIED"] } },
      orderBy: [{ status: "asc" }, { confidence: "desc" }, { createdAt: "desc" }],
      take: 50,
    }),
    prisma.config.findUnique({ where: { id: 1 } }),
  ]);

  return (
    <div className="space-y-6">
      <StatusTile lastRun={lastRun} killSwitch={config?.killSwitch ?? false} pollSec={config?.pollIntervalSec ?? 120} />
      <section>
        <header className="mb-3 flex items-baseline justify-between">
          <h2 className="text-lg font-semibold">Open suggestions</h2>
          <p className="text-sm text-zinc-500">
            {openSuggestions.length} active {openSuggestions.length === 1 ? "row" : "rows"}
          </p>
        </header>
        {openSuggestions.length === 0 ? (
          <EmptyState />
        ) : (
          <SuggestionsTable rows={openSuggestions} />
        )}
      </section>
    </div>
  );
}

function StatusTile({
  lastRun,
  killSwitch,
  pollSec,
}: {
  lastRun: Awaited<ReturnType<typeof prisma.workerRun.findFirst>>;
  killSwitch: boolean;
  pollSec: number;
}) {
  const startedAt = lastRun?.startedAt ?? null;
  const finishedAt = lastRun?.finishedAt ?? null;
  const ok = lastRun?.ok ?? false;
  const durMs =
    startedAt && finishedAt ? finishedAt.getTime() - startedAt.getTime() : null;

  return (
    <section className="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div className="flex items-center gap-3">
          <h2 className="text-lg font-semibold">Worker</h2>
          {killSwitch ? (
            <span className="rounded-md border border-red-200 bg-red-100 px-2 py-0.5 text-xs font-semibold uppercase text-red-900">
              Kill switch ON
            </span>
          ) : (
            <span className="rounded-md border border-emerald-200 bg-emerald-100 px-2 py-0.5 text-xs font-semibold uppercase text-emerald-900">
              Running
            </span>
          )}
        </div>
        <p className="text-sm text-zinc-500">Poll interval: {pollSec}s</p>
      </div>
      {lastRun ? (
        <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-4 lg:grid-cols-7">
          <StatusStat label="Last poll" value={fmtRelative(startedAt)} title={startedAt?.toISOString()} />
          <StatusStat
            label="Status"
            value={ok ? "ok" : `errors (${lastRun.errorCount})`}
            valueClass={ok ? "text-emerald-700" : "text-red-700"}
          />
          <StatusStat label="Duration" value={durMs != null ? `${(durMs / 1000).toFixed(1)}s` : "–"} />
          <StatusStat label="Vetted" value={`${lastRun.vetted}/${lastRun.candidates}`} />
          <StatusStat label="Positions" value={lastRun.positionsSeen.toLocaleString()} />
          <StatusStat label="Firings" value={String(lastRun.firings)} />
          <StatusStat label="Sent" value={String(lastRun.notifications)} />
        </dl>
      ) : (
        <p className="mt-2 text-sm text-zinc-500">No polls recorded yet — start the worker with <code className="font-mono">pnpm dev:worker</code>.</p>
      )}
    </section>
  );
}

function StatusStat({
  label,
  value,
  valueClass,
  title,
}: {
  label: string;
  value: string;
  valueClass?: string;
  title?: string;
}) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-zinc-500">{label}</dt>
      <dd
        className={`mt-0.5 font-mono text-sm ${valueClass ?? "text-zinc-900 dark:text-zinc-100"}`}
        title={title}
      >
        {value}
      </dd>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="rounded-lg border border-dashed border-zinc-300 bg-white p-8 text-center text-sm text-zinc-500 dark:border-zinc-700 dark:bg-zinc-900">
      No open suggestions. The worker will surface fires here as they happen.
    </div>
  );
}

function SuggestionsTable({
  rows,
}: {
  rows: Awaited<ReturnType<typeof prisma.suggestion.findMany>>;
}) {
  return (
    <div className="overflow-x-auto rounded-lg border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
      <table className="min-w-full text-sm">
        <thead className="bg-zinc-50 text-xs uppercase tracking-wide text-zinc-500 dark:bg-zinc-800/50">
          <tr>
            <th className="px-3 py-2 text-left">Type</th>
            <th className="px-3 py-2 text-left">Status</th>
            <th className="px-3 py-2 text-left">Market</th>
            <th className="px-3 py-2 text-left">Outcome</th>
            <th className="px-3 py-2 text-right">Conf</th>
            <th className="px-3 py-2 text-right">N</th>
            <th className="px-3 py-2 text-right">Blend</th>
            <th className="px-3 py-2 text-right">Live</th>
            <th className="px-3 py-2 text-right">Slip</th>
            <th className="px-3 py-2 text-left">Flags</th>
            <th className="px-3 py-2 text-left">Updated</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
          {rows.map((r) => (
            <tr key={r.id} className="hover:bg-zinc-50 dark:hover:bg-zinc-800/50">
              <td className="px-3 py-2">
                <span className={`inline-block rounded border px-1.5 py-0.5 text-xs font-semibold uppercase ${typeBadgeClass(r.type)}`}>
                  {r.type}
                </span>
              </td>
              <td className="px-3 py-2">
                <span className={`inline-block rounded border px-1.5 py-0.5 text-xs font-semibold uppercase ${statusBadgeClass(r.status)}`}>
                  {r.status}
                </span>
              </td>
              <td className="max-w-xs px-3 py-2">
                <Link
                  href={`/suggestions/${r.id}`}
                  className="line-clamp-2 text-zinc-900 hover:underline dark:text-zinc-100"
                  title={r.marketQuestion}
                >
                  {r.marketQuestion}
                </Link>
              </td>
              <td className="px-3 py-2 text-zinc-700 dark:text-zinc-300">{r.outcome}</td>
              <td className="px-3 py-2 text-right font-mono">{r.confidence}</td>
              <td className="px-3 py-2 text-right font-mono">{r.distinctHolders}</td>
              <td className="px-3 py-2 text-right font-mono">{fmtCents(r.blendedEntry)}</td>
              <td className="px-3 py-2 text-right font-mono">{fmtCents(r.priceAtSignal)}</td>
              <td className="px-3 py-2 text-right font-mono">{fmtSignedCents(r.slippageCents)}</td>
              <td className="px-3 py-2">
                {r.alreadyRan && (
                  <span className="mr-1 inline-block rounded border border-amber-300 bg-amber-100 px-1.5 py-0.5 text-xs font-semibold uppercase text-amber-900">
                    ran
                  </span>
                )}
                {r.herdingPenalty < 1 && (
                  <span className="inline-block rounded border border-rose-300 bg-rose-100 px-1.5 py-0.5 text-xs font-semibold uppercase text-rose-900">
                    herd
                  </span>
                )}
              </td>
              <td className="px-3 py-2 text-zinc-500" title={r.updatedAt.toISOString()}>
                {fmtRelative(r.updatedAt)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
