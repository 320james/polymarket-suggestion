# Claude Code Build Prompt — Polymarket Suggestion Engine

Paste the block below into Claude Code. Add `scoring.ts` and your Prisma schema draft
to the repo first so it can reference them directly.

---

```
I'm building a personal Polymarket SUGGESTION engine + dashboard. It does NOT place
trades — it reads public data, computes high-quality trade suggestions from top
leaderboard traders, and pushes alerts to my iPhone via Telegram. I place trades
myself in the Polymarket app. Single user (me), always-on DigitalOcean droplet.
Full TypeScript. I'm an experienced developer — be concise, surface decisions, and
build incrementally.

WHY SUGGESTION-ONLY: no private key on the server, no order-signing, no execution
risk. The server only ever reads the public Gamma + Data APIs and public CLOB prices.

ARCHITECTURE:
- /worker: long-running Node process (the analysis engine + scheduler).
- /web: Next.js (App Router) dashboard, read-mostly, over a shared SQLite DB.
- Prisma + SQLite. A shared types package consumed by both.
- Docker Compose for both services; also provide a systemd alternative.
- Access control: the droplet is on Tailscale and the dashboard binds to the private
  interface — no public auth needed. Note this in the README.

DATA SOURCES (all public, NO authentication anywhere):
- Gamma API (https://gamma-api.polymarket.com): market metadata, questions,
  resolution descriptions.
- Data API (https://data-api.polymarket.com): leaderboard, user positions, trades,
  activity. IMPORTANT: traders use a PROXY wallet (Gnosis Safe) — key positions and
  trade history on the PROXY address, not the EOA, or you'll see zero trades. The
  positions endpoint rate limit is 150 req / 10s — throttle and cache. Use the
  activity endpoint to capture redemptions so win-rate/P&L is accurate.
- CLOB API (https://clob.polymarket.com): PUBLIC price/orderbook endpoints only, to
  read the current live price for the slippage check. Do not authenticate.
- Confirm exact endpoint paths and field names from
  https://docs.polymarket.com/api-reference/introduction and the docs index at
  https://docs.polymarket.com/llms.txt before coding the clients.

SCORING (use the provided scoring.ts as the canonical spec — do not reinvent it):
- scoring.ts contains pure, deterministic functions: deriveTraderStats(),
  passesVetting(), computeTrustWeight(), detectHerding(), scoreConsensus(), and
  shouldSuggestExit(), plus a ScoringConfig with DEFAULT_CONFIG.
- The worker's job is to feed these functions real data and persist the results.
  Keep all scoring deterministic and side-effect-free; the worker handles I/O.
- Surface every ScoringConfig field in the editable dashboard Config.

WORKER PIPELINE (runs every Config.pollIntervalSec, default 120s):
1. SELECT candidates: pull leaderboards by PnL across WEEK, MONTH, ALL windows, take
   the top `candidatePoolSize` (default 50), dedup by proxy address, and record how
   many of the 3 windows each appears in (windowsAppeared).
2. VET: for each candidate, fetch trade history (proxy address), build ResolvedTrade[]
   (use the activity endpoint for redemptions), call deriveTraderStats() then
   passesVetting(). Persist stats. Compute computeTrustWeight() for those that pass.
3. POSITIONS: fetch current open positions for vetted traders. Record size, avgPrice,
   pctOfPortfolio (conviction), and firstSeen (first time we observed the position —
   needed for recency and herding).
4. CONSENSUS: group holders by (conditionId, tokenId, outcome); for each group call
   scoreConsensus() with the live CLOB price. If result.fired, create/UPDATE a
   Suggestion row.
5. EXIT: for standing BUY suggestions, compare original vs current holders via
   shouldSuggestExit(); if true, emit a type=EXIT Suggestion.
6. DEDUP: never re-alert an unchanged standing signal. Alert on NEW signals, material
   confidence increases (configurable step), and exits only.
7. SAFETY: respect Config.killSwitch (when true, compute nothing/notify nothing).
   Never crash the loop on a single bad trader/market — isolate and log errors.

NOTIFICATIONS:
- Build a Notifier abstraction: send(suggestion) with pluggable channels —
  TELEGRAM (default), PUSHOVER, NTFY, EMAIL — selected via Config.notifyChannel.
- TELEGRAM: POST to https://api.telegram.org/bot<TOKEN>/sendMessage using
  TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID from env. Message includes: market question,
  outcome, type (BUY/EXIT), confidence, blended entry vs current price, slippage, the
  supporting traders + key stats (win rate, profit factor, trust weight), and the
  rationale. Show a clear "⚠ already ran" warning when alreadyRan is true.
- Log every send to NotificationLog. Retry transient failures with backoff; NEVER
  crash the worker on a notification error.
- All channel credentials via env vars only; document Telegram bot creation
  (@BotFather) and chat-id retrieval in the README.

DASHBOARD:
- Suggestions feed (newest first): confidence, type, rationale, slippage/"already ran"
  flag, status. Per suggestion: mark TAKEN (log my actual fill price + size) or DISMISS.
- Performance view: suggested entry vs my actual fills (TakenTrade) vs outcomes, so I
  can see whether following these traders is actually profitable over time.
- Vetted trader pool with derived stats (win rate, profit factor, avg ROI, avg entry
  odds, windows appeared) and trust weights.
- Editable Config for every ScoringConfig field + poll interval + notify channel, and
  a prominent kill switch.

SECURITY / SCOPE:
- No wallet private key anywhere. No trade execution. Read-only public data only.
- Secrets (Telegram creds, etc.) in env vars; never logged or committed.
- Don't put analysis logic in Next.js route handlers — it's a stateful 24/7 loop in
  the worker.

START BY proposing the repo structure and confirming the DB schema (I'll paste my
draft). Then implement the Data API client + the vetting step first, so I can eyeball
the derived trader stats before we wire up consensus, notifications, and the
dashboard. Don't write everything at once.
```
