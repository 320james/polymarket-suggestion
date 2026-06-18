import { prisma } from "@/lib/db";
import { updateConfig } from "@/lib/actions";

export const dynamic = "force-dynamic";

const CHANNELS = ["TELEGRAM", "PUSHOVER", "NTFY", "EMAIL", "CONSOLE"];
const CATEGORIES = ["OVERALL", "POLITICS", "SPORTS", "CRYPTO"];

export default async function ConfigPage() {
  const cfg = await prisma.config.upsert({
    where: { id: 1 },
    create: { id: 1 },
    update: {},
  });

  return (
    <form action={updateConfig} className="space-y-6">
      <header className="flex items-baseline justify-between">
        <h1 className="text-lg font-semibold">Config</h1>
        <p className="text-xs text-zinc-500">
          Updated {cfg.updatedAt.toLocaleString()}
        </p>
      </header>

      <KillSwitch on={cfg.killSwitch} />

      <Section
        title="Operations"
        subtitle="Cadence, candidate pool, notification channel."
      >
        <Field
          name="pollIntervalSec"
          label="Poll interval (sec)"
          defaultValue={cfg.pollIntervalSec}
          step={5}
          min={10}
        />
        <Field
          name="candidatePoolSize"
          label="Candidate pool size"
          defaultValue={cfg.candidatePoolSize}
          step={1}
          min={1}
        />
        <SelectField
          name="leaderboardWindows"
          label="Leaderboard windows"
          defaultValue={cfg.leaderboardWindows}
          options={[
            "WEEK,MONTH,ALL",
            "WEEK",
            "MONTH",
            "ALL",
            "WEEK,MONTH",
            "MONTH,ALL",
          ]}
        />
        <SelectField
          name="category"
          label="Category"
          defaultValue={cfg.category}
          options={CATEGORIES}
        />
        <SelectField
          name="notifyChannel"
          label="Notify channel"
          defaultValue={cfg.notifyChannel}
          options={CHANNELS}
        />
        <Field
          name="alertConfidenceStep"
          label="Re-alert step (Δ confidence)"
          defaultValue={cfg.alertConfidenceStep}
          step={1}
        />
        <Field
          name="exitFraction"
          label="Exit fraction (0..1)"
          defaultValue={cfg.exitFraction}
          step={0.05}
          min={0}
          max={1}
        />
      </Section>

      <Section
        title="Vetting gates"
        subtitle="A trader must clear ALL of these to enter the pool."
      >
        <Field
          name="minResolvedTrades"
          label="Min resolved trades"
          defaultValue={cfg.minResolvedTrades}
          step={1}
          min={0}
        />
        <Field
          name="winRateFloor"
          label="Win rate floor (0..1)"
          defaultValue={cfg.winRateFloor}
          step={0.01}
          min={0}
          max={1}
        />
        <Field
          name="minProfitFactor"
          label="Min profit factor"
          defaultValue={cfg.minProfitFactor}
          step={0.1}
          min={0}
        />
        <Field
          name="minWindowsAppeared"
          label="Min windows appeared (1..3)"
          defaultValue={cfg.minWindowsAppeared}
          step={1}
          min={1}
          max={3}
        />
      </Section>

      <Section
        title="Trust weight shaping"
        subtitle="Maps stats into the per-trader weight used in consensus scoring."
      >
        <Field
          name="pfTarget"
          label="Profit factor target"
          defaultValue={cfg.pfTarget}
          step={0.1}
          min={0}
        />
        <Field
          name="confidenceK"
          label="Confidence K (smoothing)"
          defaultValue={cfg.confidenceK}
          step={1}
          min={0}
        />
        <Field
          name="favoriteOddsThreshold"
          label="Favorite odds threshold"
          defaultValue={cfg.favoriteOddsThreshold}
          step={0.05}
          min={0}
          max={1}
        />
      </Section>

      <Section
        title="Consensus"
        subtitle="Gates a candidate signal must clear to become a Suggestion."
      >
        <Field
          name="minDistinctHolders"
          label="Min distinct holders"
          defaultValue={cfg.minDistinctHolders}
          step={1}
          min={1}
        />
        <Field
          name="consensusScoreMin"
          label="Min raw score"
          defaultValue={cfg.consensusScoreMin}
          step={0.1}
          min={0}
        />
        <Field
          name="recencyHalfLifeHours"
          label="Recency half-life (hours)"
          defaultValue={cfg.recencyHalfLifeHours}
          step={1}
          min={0}
        />
        <Field
          name="maxSlippageCents"
          label="Max slippage (¢)"
          defaultValue={cfg.maxSlippageCents}
          step={0.5}
          min={0}
        />
      </Section>

      <Section
        title="Herding guard"
        subtitle="Penalizes clustered, similarly-sized entries from copy-traders."
      >
        <Field
          name="herdingWindowMinutes"
          label="Window (minutes)"
          defaultValue={cfg.herdingWindowMinutes}
          step={5}
          min={0}
        />
        <Field
          name="herdingClusterFrac"
          label="Cluster fraction (0..1)"
          defaultValue={cfg.herdingClusterFrac}
          step={0.05}
          min={0}
          max={1}
        />
        <Field
          name="herdingSizeCv"
          label="Size CV threshold"
          defaultValue={cfg.herdingSizeCv}
          step={0.05}
          min={0}
        />
        <Field
          name="herdingPenalty"
          label="Penalty multiplier"
          defaultValue={cfg.herdingPenalty}
          step={0.05}
          min={0}
          max={1}
        />
      </Section>

      <Section
        title="Confidence display"
        subtitle="How raw score + holder count map to the 0..100 confidence shown in alerts."
      >
        <Field
          name="scoreTarget"
          label="Score target"
          defaultValue={cfg.scoreTarget}
          step={0.5}
          min={0}
        />
        <Field
          name="holderTarget"
          label="Holder target"
          defaultValue={cfg.holderTarget}
          step={1}
          min={1}
        />
      </Section>

      <div className="sticky bottom-4 flex items-center justify-end gap-3 rounded-lg border border-zinc-200 bg-white/80 p-3 backdrop-blur dark:border-zinc-800 dark:bg-zinc-900/80">
        <p className="text-xs text-zinc-500">
          Worker picks up changes on the next poll (≤ {cfg.pollIntervalSec}s).
        </p>
        <button
          type="submit"
          className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-emerald-700 focus:outline-none focus:ring-2 focus:ring-emerald-500"
        >
          Save
        </button>
      </div>
    </form>
  );
}

function KillSwitch({ on }: { on: boolean }) {
  return (
    <section
      className={`rounded-lg border p-4 shadow-sm ${
        on
          ? "border-red-300 bg-red-50 dark:border-red-900 dark:bg-red-950/40"
          : "border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900"
      }`}
    >
      <label className="flex items-center justify-between gap-4">
        <div>
          <p className="text-base font-semibold">Kill switch</p>
          <p className="text-xs text-zinc-500">
            When ON, the worker performs no analysis and sends no notifications.
          </p>
        </div>
        <input
          type="checkbox"
          name="killSwitch"
          defaultChecked={on}
          className="h-6 w-6 cursor-pointer rounded border-zinc-300 text-red-600 focus:ring-red-500"
        />
      </label>
    </section>
  );
}

function Section({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
      <header className="mb-3">
        <h2 className="text-base font-semibold">{title}</h2>
        {subtitle && <p className="text-xs text-zinc-500">{subtitle}</p>}
      </header>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {children}
      </div>
    </section>
  );
}

function Field({
  name,
  label,
  defaultValue,
  step,
  min,
  max,
}: {
  name: string;
  label: string;
  defaultValue: number;
  step?: number;
  min?: number;
  max?: number;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs uppercase tracking-wide text-zinc-500">
        {label}
      </span>
      <input
        type="number"
        name={name}
        defaultValue={defaultValue}
        step={step ?? "any"}
        min={min}
        max={max}
        className="rounded-md border border-zinc-300 bg-white px-2 py-1.5 font-mono text-sm shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500 dark:border-zinc-700 dark:bg-zinc-950"
      />
    </label>
  );
}

function SelectField({
  name,
  label,
  defaultValue,
  options,
}: {
  name: string;
  label: string;
  defaultValue: string;
  options: string[];
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs uppercase tracking-wide text-zinc-500">
        {label}
      </span>
      <select
        name={name}
        defaultValue={defaultValue}
        className="rounded-md border border-zinc-300 bg-white px-2 py-1.5 font-mono text-sm shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500 dark:border-zinc-700 dark:bg-zinc-950"
      >
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
        {!options.includes(defaultValue) && (
          <option value={defaultValue}>{defaultValue} (current)</option>
        )}
      </select>
    </label>
  );
}
