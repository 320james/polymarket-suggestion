import Link from "next/link";
import { notFound } from "next/navigation";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import {
  setSuggestionStatus,
  logTakenTrade,
  closeTakenTrade,
} from "@/lib/actions";
import {
  fmtCents,
  fmtSignedCents,
  fmtPct,
  fmtNum,
  fmtRelative,
  fmtAddress,
  parseIdsJson,
  statusBadgeClass,
  typeBadgeClass,
  marketUrl,
} from "@/lib/format";

export const dynamic = "force-dynamic";

type SuggestionWithRelations = Prisma.SuggestionGetPayload<{
  include: {
    notifications: true;
    relatedSuggestion: true;
    exits: true;
    takenTrades: true;
  };
}>;

export default async function SuggestionDetail({
  params,
}: {
  params: { id: string };
}) {
  const id = Number(params.id);
  if (!Number.isFinite(id)) notFound();

  const suggestion = await prisma.suggestion.findUnique({
    where: { id },
    include: {
      notifications: { orderBy: { id: "desc" } },
      relatedSuggestion: true,
      exits: { orderBy: { id: "desc" } },
      takenTrades: { orderBy: { id: "desc" } },
    },
  });
  if (!suggestion) notFound();

  const supportingIds = parseIdsJson(suggestion.supportingIds);
  const originalIds = parseIdsJson(suggestion.originalHolderIds);
  const allIds = [...new Set([...supportingIds, ...originalIds])];

  // Fetch all referenced traders + the market cache row in parallel.
  const [traders, market] = await Promise.all([
    prisma.trackedTrader.findMany({ where: { id: { in: allIds } } }),
    prisma.market.findUnique({ where: { conditionId: suggestion.conditionId } }),
  ]);
  const traderById = new Map(traders.map((t) => [t.id, t]));

  const supporting = supportingIds
    .map((id) => traderById.get(id))
    .filter((t): t is NonNullable<typeof t> => t != null);
  const original = originalIds
    .map((id) => traderById.get(id))
    .filter((t): t is NonNullable<typeof t> => t != null);
  const exited = originalIds
    .filter((id) => !supportingIds.includes(id))
    .map((id) => traderById.get(id))
    .filter((t): t is NonNullable<typeof t> => t != null);

  return (
    <div className="space-y-6">
      <Header suggestion={suggestion} market={market} />
      <ActionsCard suggestion={suggestion} />
      <MetricsCard suggestion={suggestion} />
      <RationaleCard suggestion={suggestion} />

      <TradersSection
        title={`Supporting traders (${supporting.length})`}
        subtitle="Currently hold this outcome — refreshed each poll."
        traders={supporting}
        emptyMsg="No vetted traders currently hold this outcome."
      />

      {exited.length > 0 && (
        <TradersSection
          title={`Exited since fire (${exited.length} of ${original.length})`}
          subtitle="Were in the original set when the BUY first fired but no longer hold."
          traders={exited}
          emptyMsg=""
          tone="warning"
        />
      )}

      <RelatedSection suggestion={suggestion} />
      <NotificationsTable notifications={suggestion.notifications} />
      <TakenTradesSection takenTrades={suggestion.takenTrades} />
    </div>
  );
}

function Header({
  suggestion,
  market,
}: {
  suggestion: SuggestionWithRelations;
  market: Awaited<ReturnType<typeof prisma.market.findUnique>>;
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2 text-sm">
        <Link href="/" className="text-zinc-500 hover:underline">
          ← Suggestions
        </Link>
      </div>
      <div className="flex flex-wrap items-baseline gap-3">
        <span className={`inline-block rounded border px-2 py-0.5 text-xs font-semibold uppercase ${typeBadgeClass(suggestion.type)}`}>
          {suggestion.type}
        </span>
        <span className={`inline-block rounded border px-2 py-0.5 text-xs font-semibold uppercase ${statusBadgeClass(suggestion.status)}`}>
          {suggestion.status}
        </span>
        <h1 className="text-xl font-semibold tracking-tight">{suggestion.outcome}</h1>
      </div>
      <p className="text-zinc-700 dark:text-zinc-300">{suggestion.marketQuestion}</p>
      <p className="text-xs text-zinc-500">
        Created {fmtRelative(suggestion.createdAt)} · Updated {fmtRelative(suggestion.updatedAt)}
        {" · "}
        <a
          href={marketUrl(suggestion.conditionId, market?.slug)}
          target="_blank"
          rel="noopener noreferrer"
          className="hover:underline"
        >
          Open on Polymarket ↗
        </a>
      </p>
    </div>
  );
}

function MetricsCard({
  suggestion,
}: {
  suggestion: SuggestionWithRelations;
}) {
  return (
    <section className="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm sm:grid-cols-4 lg:grid-cols-7">
        <Metric label="Confidence" value={`${suggestion.confidence}/100`} />
        <Metric label="Raw score" value={fmtNum(suggestion.consensusScore)} />
        <Metric label="Holders" value={String(suggestion.distinctHolders)} />
        <Metric label="Blended entry" value={fmtCents(suggestion.blendedEntry)} />
        <Metric label="Live price" value={fmtCents(suggestion.priceAtSignal)} />
        <Metric label="Slippage" value={fmtSignedCents(suggestion.slippageCents)} />
        <Metric
          label="Notifications"
          value={`${suggestion.notifyCount}${suggestion.lastNotifiedConfidence != null ? ` (last @${Math.round(suggestion.lastNotifiedConfidence)})` : ""}`}
        />
      </dl>
      {(suggestion.alreadyRan || suggestion.herdingPenalty < 1) && (
        <div className="mt-3 flex flex-wrap gap-2 text-xs">
          {suggestion.alreadyRan && (
            <span className="rounded border border-amber-300 bg-amber-100 px-2 py-1 font-semibold uppercase text-amber-900">
              ⚠ Already ran — slippage exceeds gate
            </span>
          )}
          {suggestion.herdingPenalty < 1 && (
            <span className="rounded border border-rose-300 bg-rose-100 px-2 py-1 font-semibold uppercase text-rose-900">
              ⚠ Herding penalty x{fmtNum(suggestion.herdingPenalty)}
            </span>
          )}
        </div>
      )}
    </section>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-zinc-500">{label}</dt>
      <dd className="mt-0.5 font-mono text-sm">{value}</dd>
    </div>
  );
}

function RationaleCard({
  suggestion,
}: {
  suggestion: SuggestionWithRelations;
}) {
  return (
    <section className="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
      <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-zinc-500">
        Rationale
      </h2>
      <p className="text-sm text-zinc-800 dark:text-zinc-200">{suggestion.rationale}</p>
    </section>
  );
}

function TradersSection({
  title,
  subtitle,
  traders,
  emptyMsg,
  tone = "neutral",
}: {
  title: string;
  subtitle: string;
  traders: Awaited<ReturnType<typeof prisma.trackedTrader.findMany>>;
  emptyMsg: string;
  tone?: "neutral" | "warning";
}) {
  const headerClass =
    tone === "warning"
      ? "text-amber-900 dark:text-amber-200"
      : "text-zinc-900 dark:text-zinc-100";
  return (
    <section className="rounded-lg border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
      <header className="border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
        <h2 className={`text-base font-semibold ${headerClass}`}>{title}</h2>
        <p className="mt-0.5 text-xs text-zinc-500">{subtitle}</p>
      </header>
      {traders.length === 0 ? (
        emptyMsg ? (
          <p className="px-4 py-6 text-sm text-zinc-500">{emptyMsg}</p>
        ) : null
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-zinc-50 text-xs uppercase tracking-wide text-zinc-500 dark:bg-zinc-800/50">
              <tr>
                <th className="px-3 py-2 text-left">User</th>
                <th className="px-3 py-2 text-left">Proxy</th>
                <th className="px-3 py-2 text-right">Trust</th>
                <th className="px-3 py-2 text-right">Win %</th>
                <th className="px-3 py-2 text-right">PF</th>
                <th className="px-3 py-2 text-right">Avg ROI</th>
                <th className="px-3 py-2 text-right">Resolved</th>
                <th className="px-3 py-2 text-right">Windows</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {traders.map((t) => (
                <tr key={t.id}>
                  <td className="px-3 py-2">{t.username || "—"}</td>
                  <td className="px-3 py-2 font-mono text-xs text-zinc-500" title={t.id}>
                    {fmtAddress(t.id)}
                  </td>
                  <td className="px-3 py-2 text-right font-mono">{fmtNum(t.trustWeight)}</td>
                  <td className="px-3 py-2 text-right font-mono">{fmtPct(t.winRate)}</td>
                  <td className="px-3 py-2 text-right font-mono">{fmtNum(t.profitFactor)}</td>
                  <td className="px-3 py-2 text-right font-mono">{fmtPct(t.avgRoi)}</td>
                  <td className="px-3 py-2 text-right font-mono">{t.resolvedTrades}</td>
                  <td className="px-3 py-2 text-right font-mono">{t.windowsAppeared}/3</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function RelatedSection({
  suggestion,
}: {
  suggestion: SuggestionWithRelations;
}) {
  const items: Array<{ label: string; row: SuggestionWithRelations["relatedSuggestion"] }> = [];
  if (suggestion.relatedSuggestion) {
    items.push({ label: "Triggering BUY", row: suggestion.relatedSuggestion });
  }
  for (const exit of suggestion.exits ?? []) {
    items.push({ label: "Linked EXIT", row: exit });
  }
  if (items.length === 0) return null;
  return (
    <section className="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
      <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-zinc-500">
        Related suggestions
      </h2>
      <ul className="space-y-1 text-sm">
        {items.map((it) =>
          it.row ? (
            <li key={`${it.label}-${it.row.id}`}>
              <Link href={`/suggestions/${it.row.id}`} className="hover:underline">
                <span className="text-zinc-500">{it.label}:</span>{" "}
                <span className={`inline-block rounded border px-1.5 py-0.5 text-xs font-semibold uppercase ${typeBadgeClass(it.row.type)}`}>
                  {it.row.type}
                </span>{" "}
                <span className={`inline-block rounded border px-1.5 py-0.5 text-xs font-semibold uppercase ${statusBadgeClass(it.row.status)}`}>
                  {it.row.status}
                </span>{" "}
                #{it.row.id} — {it.row.outcome}
              </Link>
            </li>
          ) : null,
        )}
      </ul>
    </section>
  );
}

function NotificationsTable({
  notifications,
}: {
  notifications: SuggestionWithRelations["notifications"];
}) {
  return (
    <section className="rounded-lg border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
      <header className="border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
        <h2 className="text-base font-semibold">Notifications</h2>
        <p className="text-xs text-zinc-500">{notifications.length} attempt{notifications.length === 1 ? "" : "s"}</p>
      </header>
      {notifications.length === 0 ? (
        <p className="px-4 py-6 text-sm text-zinc-500">No notification attempts yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-zinc-50 text-xs uppercase tracking-wide text-zinc-500 dark:bg-zinc-800/50">
              <tr>
                <th className="px-3 py-2 text-left">When</th>
                <th className="px-3 py-2 text-left">Channel</th>
                <th className="px-3 py-2 text-right">Attempt</th>
                <th className="px-3 py-2 text-left">Result</th>
                <th className="px-3 py-2 text-left">Error</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {notifications.map((n) => (
                <tr key={n.id}>
                  <td className="px-3 py-2 text-zinc-500" title={n.sentAt.toISOString()}>
                    {fmtRelative(n.sentAt)}
                  </td>
                  <td className="px-3 py-2">{n.channel}</td>
                  <td className="px-3 py-2 text-right font-mono">{n.attempt}</td>
                  <td className="px-3 py-2">
                    {n.success ? (
                      <span className="text-emerald-700">ok</span>
                    ) : (
                      <span className="text-red-700">failed</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-xs text-zinc-600 dark:text-zinc-400">
                    {n.error ?? ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function TakenTradesSection({
  takenTrades,
}: {
  takenTrades: SuggestionWithRelations["takenTrades"];
}) {
  if (takenTrades.length === 0) return null;
  return (
    <section className="rounded-lg border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
      <header className="border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
        <h2 className="text-base font-semibold">Trades you took</h2>
      </header>
      <div className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead className="bg-zinc-50 text-xs uppercase tracking-wide text-zinc-500 dark:bg-zinc-800/50">
            <tr>
              <th className="px-3 py-2 text-left">When</th>
              <th className="px-3 py-2 text-left">Side</th>
              <th className="px-3 py-2 text-right">Size</th>
              <th className="px-3 py-2 text-right">Fill</th>
              <th className="px-3 py-2 text-right">Closed @</th>
              <th className="px-3 py-2 text-right">P&L</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {takenTrades.map((t) => (
              <tr key={t.id}>
                <td className="px-3 py-2 text-zinc-500">{fmtRelative(t.takenAt)}</td>
                <td className="px-3 py-2">{t.side}</td>
                <td className="px-3 py-2 text-right font-mono">{t.size.toLocaleString()}</td>
                <td className="px-3 py-2 text-right font-mono">{fmtCents(t.fillPrice)}</td>
                <td className="px-3 py-2 text-right font-mono">{fmtCents(t.closedPrice)}</td>
                <td className="px-3 py-2 text-right font-mono">
                  {t.realizedPnl != null ? `$${t.realizedPnl.toFixed(2)}` : "–"}
                </td>
                <td className="px-3 py-2 text-right">
                  {t.closedAt == null && (
                    <form action={closeTakenTrade} className="flex items-center justify-end gap-1">
                      <input type="hidden" name="tradeId" value={t.id} />
                      <input
                        type="number"
                        name="closedPrice"
                        step={0.001}
                        min={0}
                        max={1}
                        required
                        placeholder="close px"
                        className="w-20 rounded border border-zinc-300 bg-white px-1 py-0.5 text-right font-mono text-xs shadow-sm dark:border-zinc-700 dark:bg-zinc-950"
                      />
                      <button
                        type="submit"
                        className="rounded bg-zinc-700 px-2 py-0.5 text-xs font-semibold text-white hover:bg-zinc-800"
                      >
                        Close
                      </button>
                    </form>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function ActionsCard({
  suggestion,
}: {
  suggestion: SuggestionWithRelations;
}) {
  const isTerminal = !(["NEW", "NOTIFIED"] as string[]).includes(suggestion.status);
  return (
    <section className="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">
            Actions
          </h2>
          <p className="mt-1 text-xs text-zinc-500">
            {isTerminal
              ? `Already ${suggestion.status.toLowerCase()}. Logging a fill below will re-mark it TAKEN.`
              : "Mark this suggestion as taken or dismissed once you've decided."}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {!isTerminal && (
            <>
              <form action={setSuggestionStatus}>
                <input type="hidden" name="id" value={suggestion.id} />
                <input type="hidden" name="status" value="DISMISSED" />
                <button
                  type="submit"
                  className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm font-semibold text-zinc-800 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-zinc-800"
                >
                  Dismiss
                </button>
              </form>
              <form action={setSuggestionStatus}>
                <input type="hidden" name="id" value={suggestion.id} />
                <input type="hidden" name="status" value="TAKEN" />
                <button
                  type="submit"
                  className="rounded-md bg-violet-600 px-3 py-1.5 text-sm font-semibold text-white shadow-sm hover:bg-violet-700"
                >
                  Mark taken
                </button>
              </form>
            </>
          )}
        </div>
      </div>
      <form
        action={logTakenTrade}
        className="mt-4 grid grid-cols-1 gap-3 border-t border-zinc-200 pt-4 sm:grid-cols-5 dark:border-zinc-800"
      >
        <input type="hidden" name="suggestionId" value={suggestion.id} />
        <FormSelect
          label="Side"
          name="side"
          defaultValue={suggestion.type === "EXIT" ? "SELL" : "BUY"}
          options={["BUY", "SELL"]}
        />
        <FormNumeric label="Size" name="size" step={1} min={1} placeholder="shares" />
        <FormNumeric
          label="Fill price"
          name="fillPrice"
          step={0.001}
          min={0}
          max={1}
          defaultValue={suggestion.priceAtSignal}
        />
        <div className="sm:col-span-2 flex items-end">
          <button
            type="submit"
            className="w-full rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-semibold text-white shadow-sm hover:bg-emerald-700"
          >
            Log fill
          </button>
        </div>
      </form>
    </section>
  );
}

function FormSelect({
  label,
  name,
  defaultValue,
  options,
}: {
  label: string;
  name: string;
  defaultValue: string;
  options: string[];
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs uppercase tracking-wide text-zinc-500">{label}</span>
      <select
        name={name}
        defaultValue={defaultValue}
        className="rounded-md border border-zinc-300 bg-white px-2 py-1.5 font-mono text-sm shadow-sm dark:border-zinc-700 dark:bg-zinc-950"
      >
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </label>
  );
}

function FormNumeric({
  label,
  name,
  defaultValue,
  step,
  min,
  max,
  placeholder,
}: {
  label: string;
  name: string;
  defaultValue?: number;
  step?: number;
  min?: number;
  max?: number;
  placeholder?: string;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs uppercase tracking-wide text-zinc-500">{label}</span>
      <input
        type="number"
        name={name}
        defaultValue={defaultValue}
        step={step ?? "any"}
        min={min}
        max={max}
        required
        placeholder={placeholder}
        className="rounded-md border border-zinc-300 bg-white px-2 py-1.5 font-mono text-sm shadow-sm dark:border-zinc-700 dark:bg-zinc-950"
      />
    </label>
  );
}
