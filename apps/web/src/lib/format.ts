/**
 * Shared display helpers — keep all formatting logic here so the same
 * "27¢" or "WR 67%" string renders identically across every page.
 */

/** Price 0..1 → "27¢". */
export function fmtCents(p: number | null | undefined): string {
  if (p == null || !Number.isFinite(p)) return "–";
  return `${Math.round(p * 100)}¢`;
}

/** Signed cents value (already in cents) → "+2.5¢" / "-6.0¢". */
export function fmtSignedCents(c: number | null | undefined): string {
  if (c == null || !Number.isFinite(c)) return "–";
  return `${c >= 0 ? "+" : ""}${c.toFixed(1)}¢`;
}

/** Fraction 0..1 → "67%". */
export function fmtPct(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "–";
  return `${Math.round(v * 100)}%`;
}

/** Number with N decimals, or "–" if null. */
export function fmtNum(v: number | null | undefined, decimals = 2): string {
  if (v == null || !Number.isFinite(v)) return "–";
  return v.toFixed(decimals);
}

/** "12s ago", "4m ago", "2h ago", "yesterday", "Jun 17". */
export function fmtRelative(d: Date | null | undefined): string {
  if (!d) return "–";
  const diffMs = Date.now() - d.getTime();
  const s = Math.floor(diffMs / 1000);
  if (s < 0) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.floor(h / 24);
  if (days === 1) return "yesterday";
  if (days < 7) return `${days}d ago`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** Truncate proxy address `0xabcd1234…ef56` for compact display. */
export function fmtAddress(addr: string | null | undefined): string {
  if (!addr) return "–";
  if (addr.length <= 12) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

/** Parse the JSON-string proxy address list stored on Suggestion rows. */
export function parseIdsJson(json: string | null | undefined): string[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** Tailwind class for a status badge background + text. */
export function statusBadgeClass(status: string): string {
  switch (status) {
    case "NEW":
      return "bg-blue-100 text-blue-900 border-blue-200";
    case "NOTIFIED":
      return "bg-emerald-100 text-emerald-900 border-emerald-200";
    case "TAKEN":
      return "bg-violet-100 text-violet-900 border-violet-200";
    case "DISMISSED":
      return "bg-zinc-100 text-zinc-700 border-zinc-200";
    case "EXITED":
      return "bg-amber-100 text-amber-900 border-amber-200";
    case "EXPIRED":
      return "bg-zinc-100 text-zinc-500 border-zinc-200";
    default:
      return "bg-zinc-100 text-zinc-700 border-zinc-200";
  }
}

/** Tailwind class for a BUY/EXIT type badge. */
export function typeBadgeClass(t: string): string {
  return t === "EXIT"
    ? "bg-rose-100 text-rose-900 border-rose-200"
    : "bg-green-100 text-green-900 border-green-200";
}

/** Polymarket UI URL for a market. */
export function marketUrl(conditionId: string, slug: string | null | undefined): string {
  if (slug) return `https://polymarket.com/event/${slug}`;
  return `https://polymarket.com/market/${conditionId}`;
}
