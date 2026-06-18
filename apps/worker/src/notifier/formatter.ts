/**
 * Markdown formatter for notifier payloads.
 *
 * Telegram (MarkdownV2) escaping is the strictest of the supported channels;
 * other channels use the plain-text variant. The escape set below matches
 * Telegram's official list of reserved chars:
 *   _ * [ ] ( ) ~ ` > # + - = | { } . !
 *
 * KEEP THIS PURE — no I/O, no globals, just string assembly.
 */

import type { NotifierPayload, NotifierTraderLine } from "./types.js";

/** Escape a string for Telegram MarkdownV2 body text. */
export function md2Escape(s: string): string {
  return s.replace(/([_*[\]()~`>#+\-=|{}.!\\])/g, "\\$1");
}

/** Format price (0..1) as `27¢`. */
function cents(p: number): string {
  return `${Math.round(p * 100)}¢`;
}

/** Signed cents string e.g. `-6.0¢`, `+2.5¢`. */
function signedCents(c: number): string {
  return `${c >= 0 ? "+" : ""}${c.toFixed(1)}¢`;
}

/** Trader identity: prefer username, fall back to truncated proxy address. */
function traderId(t: NotifierTraderLine): string {
  return t.username || `${t.proxyAddress.slice(0, 6)}…${t.proxyAddress.slice(-4)}`;
}

function fmtTraderMd(t: NotifierTraderLine): string {
  const id = traderId(t);
  const wr = t.winRate != null ? `${Math.round(t.winRate * 100)}%` : "–";
  const pf = t.profitFactor != null ? t.profitFactor.toFixed(2) : "–";
  const trust = t.trustWeight.toFixed(2);
  return `${md2Escape(id)}: WR ${md2Escape(wr)}, PF ${md2Escape(pf)}, trust ${md2Escape(trust)} \\(${t.resolvedTrades} resolved\\)`;
}

function fmtTraderPlain(t: NotifierTraderLine): string {
  const id = traderId(t);
  const wr = t.winRate != null ? `${Math.round(t.winRate * 100)}%` : "–";
  const pf = t.profitFactor != null ? t.profitFactor.toFixed(2) : "–";
  return `  • ${id}: WR ${wr}, PF ${pf}, trust ${t.trustWeight.toFixed(2)} (${t.resolvedTrades} resolved)`;
}

/** Render Telegram MarkdownV2 body. */
export function formatTelegramBody(p: NotifierPayload): string {
  const s = p.suggestion;
  const isBuy = s.type === "BUY";
  const titleEmoji = isBuy ? (p.reason === "CONFIDENCE_RISE" ? "📈" : "🟢") : "🔴";
  const titleLabel = isBuy
    ? p.reason === "CONFIDENCE_RISE"
      ? "BUY \\(stronger\\)"
      : "BUY"
    : "EXIT";

  const slip = md2Escape(signedCents(s.slippageCents));
  const alreadyRanLine = s.alreadyRan
    ? `\n⚠ *ALREADY RAN* — slippage ${slip} exceeds gate\\.`
    : "";
  const herdingLine = s.herdingPenalty < 1
    ? `\n⚠ *Herding penalty applied* \\(x${md2Escape(s.herdingPenalty.toFixed(2))}\\)`
    : "";

  const tradersBlock = p.traders.length === 0
    ? "_no current vetted holders_"
    : p.traders.map((t) => `• ${fmtTraderMd(t)}`).join("\n");

  const lines = [
    `${titleEmoji} *${titleLabel}* — ${md2Escape(s.outcome)}`,
    `_${md2Escape(s.marketQuestion)}_`,
    "",
    `*Confidence:* ${s.confidence}/100   *Score:* ${md2Escape(s.consensusScore.toFixed(2))}   *Holders:* ${s.distinctHolders}`,
    `*Entry blend:* ${md2Escape(cents(s.blendedEntry))}   *Live:* ${md2Escape(cents(s.priceAtSignal))}   *Slippage:* ${slip}`,
    alreadyRanLine,
    herdingLine,
    "",
    "*Rationale*",
    md2Escape(s.rationale),
    "",
    "*Supporting traders*",
    tradersBlock,
    "",
    `[Open market on Polymarket](${p.marketUrl})`,
  ];

  return lines.join("\n");
}

/** Plain-text body for non-Markdown channels. */
export function formatPlainBody(p: NotifierPayload): string {
  const s = p.suggestion;
  const isBuy = s.type === "BUY";
  const label = isBuy
    ? p.reason === "CONFIDENCE_RISE" ? "BUY (stronger)" : "BUY"
    : "EXIT";

  const alreadyRan = s.alreadyRan ? "\n⚠ ALREADY RAN — slippage exceeds gate." : "";
  const herding = s.herdingPenalty < 1
    ? `\n⚠ Herding penalty applied (x${s.herdingPenalty.toFixed(2)})`
    : "";

  const tradersBlock = p.traders.length === 0
    ? "  (no current vetted holders)"
    : p.traders.map(fmtTraderPlain).join("\n");

  return [
    `${label} — ${s.outcome}`,
    s.marketQuestion,
    "",
    `Confidence: ${s.confidence}/100   Score: ${s.consensusScore.toFixed(2)}   Holders: ${s.distinctHolders}`,
    `Entry blend: ${cents(s.blendedEntry)}   Live: ${cents(s.priceAtSignal)}   Slippage: ${signedCents(s.slippageCents)}`,
    alreadyRan,
    herding,
    "",
    "Rationale:",
    s.rationale,
    "",
    "Supporting traders:",
    tradersBlock,
    "",
    p.marketUrl,
  ].join("\n");
}
