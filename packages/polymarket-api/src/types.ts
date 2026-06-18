/**
 * Polymarket Data API response types — only the fields we consume.
 *
 * Source of truth: https://docs.polymarket.com/api-reference/core/ and the
 * data-openapi spec referenced from llms.txt.
 *
 * NOTES from real-data verification:
 *   - `timestamp` is unix SECONDS (int64).
 *   - REDEEM rows are settlement events; their `asset`/`side`/`outcome` are
 *     empty and `outcomeIndex` is the sentinel `999`. Only `conditionId`,
 *     `size`, and `usdcSize` are reliable. Match REDEEMs to outcomes by
 *     comparing `size` against the trader's open inventory.
 */

export interface LeaderboardEntry {
  rank: string; // API returns this as a string
  proxyWallet: string;
  userName: string;
  vol: number;
  pnl: number;
  profileImage?: string;
  xUsername?: string;
  verifiedBadge?: boolean;
}

export interface Trade {
  proxyWallet: string;
  side: "BUY" | "SELL";
  /** CLOB token id for the outcome token. */
  asset: string;
  conditionId: string;
  size: number;
  price: number; // 0..1
  timestamp: number; // unix SECONDS
  title: string;
  slug: string;
  eventSlug: string;
  outcome: string;
  outcomeIndex: number;
  transactionHash: string;
  name?: string;
  pseudonym?: string;
}

export type ActivityType =
  | "TRADE"
  | "SPLIT"
  | "MERGE"
  | "REDEEM"
  | "REWARD"
  | "CONVERSION"
  | "MAKER_REBATE"
  | "TAKER_REBATE"
  | "REFERRAL_REWARD";

export interface Activity {
  proxyWallet: string;
  timestamp: number; // unix SECONDS
  conditionId: string;
  type: ActivityType;
  size: number;
  /** USDC value of the event. For REDEEM rows: dollar payout (winner). */
  usdcSize: number;
  transactionHash: string;
  price: number;
  /** Empty string on REDEEM rows. */
  asset: string;
  /** Empty string on REDEEM rows. */
  side?: "BUY" | "SELL" | "";
  /** `999` sentinel on REDEEM rows; real index otherwise. */
  outcomeIndex?: number;
  title: string;
  outcome: string;
  isCombo?: boolean;
}

export interface Position {
  proxyWallet: string;
  asset: string;
  conditionId: string;
  size: number;
  avgPrice: number;
  initialValue: number;
  currentValue: number;
  cashPnl: number;
  percentPnl: number;
  totalBought: number;
  realizedPnl: number;
  percentRealizedPnl: number;
  curPrice: number;
  redeemable: boolean;
  mergeable: boolean;
  title: string;
  slug: string;
  outcome: string;
  outcomeIndex: number;
  oppositeOutcome: string;
  oppositeAsset: string;
  endDate?: string;
  negativeRisk?: boolean;
}

export type LeaderboardWindow = "DAY" | "WEEK" | "MONTH" | "ALL";
export type LeaderboardCategory =
  | "OVERALL"
  | "POLITICS"
  | "SPORTS"
  | "ESPORTS"
  | "CRYPTO"
  | "CULTURE"
  | "MENTIONS"
  | "WEATHER"
  | "ECONOMICS"
  | "TECH"
  | "FINANCE";

// ─── Gamma ────────────────────────────────────────────────────────────────
// Raw `/markets` response. Polymarket returns several fields as
// JSON-encoded STRINGS rather than arrays/numbers. The client decodes
// these into the normalized `GammaMarket` shape below.
export interface GammaMarketRaw {
  id: string;
  conditionId: string;
  question: string;
  slug?: string;
  endDate?: string; // ISO
  startDate?: string;
  resolutionSource?: string;
  /** JSON string: `'["Yes","No"]'` */
  outcomes?: string;
  /** JSON string: `'["0.52","0.48"]'` */
  outcomePrices?: string;
  /** JSON string: `'["12345...","67890..."]'` */
  clobTokenIds?: string;
  active?: boolean;
  closed?: boolean;
  archived?: boolean;
  negRisk?: boolean;
  liquidityNum?: number;
  volumeNum?: number;
  updatedAt?: string;
}

/** Parsed/normalized form used by callers and the Market cache. */
export interface GammaMarket {
  conditionId: string;
  question: string;
  slug: string | null;
  endDate: Date | null;
  outcomes: string[]; // e.g. ["Yes","No"]
  tokens: GammaTokenInfo[]; // aligned with outcomes (same index)
  active: boolean;
  closed: boolean;
  negativeRisk: boolean;
  resolutionSource: string | null;
}

export interface GammaTokenInfo {
  tokenId: string;
  outcome: string;
  outcomeIndex: number;
}

// ─── CLOB ─────────────────────────────────────────────────────────────────
/** GET `/midpoint?token_id=...` → `{ mid: "0.52" }` */
export interface ClobMidpointResponse {
  mid: string;
}

/** GET `/price?token_id=...&side=BUY` → `{ price: "0.51" }` */
export interface ClobPriceResponse {
  price: string;
}

/** POST `/midpoints` body item. */
export interface ClobMidpointsItem {
  token_id: string;
}

/** POST `/midpoints` response → `{ "<token_id>": "0.52" }`. */
export type ClobMidpointsResponse = Record<string, string>;

/** POST `/prices` body item. */
export interface ClobPricesItem {
  token_id: string;
  side: "BUY" | "SELL";
}

/** POST `/prices` response → `{ "<token_id>": { "BUY": "0.51", "SELL": "0.53" } }`. */
export type ClobPricesResponse = Record<
  string,
  Partial<Record<"BUY" | "SELL", string>>
>;
