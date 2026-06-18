# Polymarket Suggestion Engine

A personal, read-only Polymarket research assistant.

It watches top traders on the public Polymarket leaderboards, detects when several of them have built up the **same position in the same market**, and pings your phone with a "**BUY** _outcome X_ in _market Y_" suggestion — along with the reasoning behind it. When most of those traders later close out, it sends an **EXIT** alert. **You place the trade yourself in the Polymarket app**; the server never holds a private key and never sends orders.

You get a small local dashboard for tuning, reviewing the trader pool, and logging the fills you actually took.

> **This is not financial advice.** It's a personal research tool. You are responsible for every trade you place.

---

## Contents

1. [How it works at a glance](#1-how-it-works-at-a-glance)
2. [Anatomy of a Telegram alert](#2-anatomy-of-a-telegram-alert)
3. [Reading the dashboard](#3-reading-the-dashboard)
4. [The Config page — every knob, explained](#4-the-config-page--every-knob-explained)
5. [The math: scoring, trust, consensus, exits](#5-the-math-scoring-trust-consensus-exits)
6. [Glossary](#6-glossary)
7. [Daily workflow](#7-daily-workflow)
8. [Running the stack](#8-running-the-stack)
9. [Tuning playbook](#9-tuning-playbook)
10. [Troubleshooting](#10-troubleshooting)
11. [What's deliberately NOT here](#11-whats-deliberately-not-here)

For server provisioning (DigitalOcean droplet, Tailscale, Docker install), see [SETUP.md](SETUP.md).

---

## 1. How it works at a glance

Every `pollIntervalSec` (default 120s), the worker does this:

```
                                 ┌──────────────────────┐
 Polymarket public APIs ─────►   │  WORKER (every 120s) │
 (Gamma, Data, CLOB)             ├──────────────────────┤
                                 │ 1. Pick candidates    │ ← top-N leaderboard traders
                                 │ 2. Vet each one       │ ← 4 quality gates
                                 │ 3. Pull positions     │ ← what they currently hold
                                 │ 4. Group by outcome   │ ← who holds the same thing?
                                 │ 5. Score consensus    │ ← trust-weighted vote
                                 │ 6. Detect herding     │ ← penalize copy-trader clusters
                                 │ 7. Check slippage     │ ← did price already run?
                                 │ 8. Fire BUY / EXIT    │ ← write Suggestion row
                                 │ 9. Notify             │ ← Telegram push
                                 └──────────┬───────────┘
                                            │
                                            ▼
                                 ┌──────────────────────┐
                                 │ SQLite (./data)      │
                                 └──────────┬───────────┘
                                            │
                                            ▼
                                 ┌──────────────────────┐
                                 │ Next.js dashboard    │ ← review, tune, log fills
                                 └──────────────────────┘
```

The dashboard reads (and edits) the same SQLite file. They're independent containers; if the web app dies, the worker keeps working.

### A "suggestion" is a row in the database

When enough vetted traders agree, the worker writes a row to the `Suggestion` table. That row has a **status**:

| Status      | Meaning                                                              |
| ----------- | -------------------------------------------------------------------- |
| `NEW`       | Just fired, notification not yet sent.                               |
| `NOTIFIED`  | Telegram alert sent successfully.                                    |
| `TAKEN`     | You logged a fill against it on the dashboard.                       |
| `DISMISSED` | You manually marked it "not interested."                             |
| `EXITED`    | Original holders mostly closed out — the worker fired an EXIT alert. |
| `EXPIRED`   | You manually marked it stale.                                        |

The worker only ever writes `NEW`, `NOTIFIED`, or `EXITED`. The other three are yours to set from the dashboard.

---

## 2. Anatomy of a Telegram alert

A real BUY alert looks like this:

```
🟢 BUY — Yes
Will Bitcoin close above $120,000 by end of Q3 2026?

Confidence: 67/100   Score: 2.41   Holders: 4
Entry blend: 32¢   Live: 35¢   Slippage: +3.0¢

Rationale
4 vetted top-leaderboard traders have built positions in
"Yes" with combined weight 2.41. Entry blend 32¢; live 35¢.

Supporting traders
• alice_eth: WR 71%, PF 2.10, trust 0.62 (47 resolved)
• 0x9c3a…f1b2: WR 64%, PF 1.55, trust 0.48 (89 resolved)
• bobsmart: WR 68%, PF 1.78, trust 0.55 (33 resolved)
• 0x1f44…a290: WR 62%, PF 1.42, trust 0.41 (61 resolved)

[Open market on Polymarket]
```

### Header

| Field                           | What it means                                                                                                                            |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| 🟢 `BUY`                        | A fresh signal. The first time this market/outcome triggered.                                                                            |
| 📈 `BUY (stronger)`             | Same market — confidence has risen by at least `alertConfidenceStep` since the last alert (more traders piled in, or trust weight grew). |
| 🔴 `EXIT`                       | Most of the original supporters of an earlier BUY have closed their positions.                                                           |
| `Yes` / `No` / _candidate name_ | The **outcome** the consensus is on. **`BUY Yes` and `BUY No` are different signals on the same market.** Don't confuse them.            |
| _market question_               | The full market question text from Polymarket.                                                                                           |

### The three-number summary line

`Confidence: 67/100   Score: 2.41   Holders: 4`

- **Confidence (0–100)** — a _display_ score. This is the number you should glance at to size up an alert. It blends raw consensus score (70%) and holder count (30%), and gets **halved** if `alreadyRan` is true. See [§4 Confidence display](#confidence-display) for the mapping.
- **Score** — the raw, unbounded consensus score. See [§5 Consensus](#consensus-score). Useful for comparing two suggestions, less useful as an absolute number.
- **Holders** — number of distinct **vetted** traders currently holding this outcome. More holders = more independent confirmation.

### The price line

`Entry blend: 32¢   Live: 35¢   Slippage: +3.0¢`

- **Entry blend** — the _trust-weighted average_ of where the supporting traders got in. Think: "the smart money paid about 32¢ for this."
- **Live** — the current CLOB midpoint when the alert fired. This is what you'd roughly pay right now.
- **Slippage** — `Live − Entry blend`, in cents.
  - **Positive (`+3.0¢`)** — price has already moved up since smart money entered. You're paying a premium. Bigger numbers = worse entry.
  - **Negative (`−2.0¢`)** — you'd actually be buying _below_ the smart-money average. Rare and good.
  - **Zero** — you'd be entering at the blended average.

Polymarket prices are in **cents from 0 to 100**, representing the implied probability of the outcome. `27¢` means the market thinks there's a 27% chance. If "Yes" resolves true, every `Yes` token pays $1 — so buying at 27¢ has a 73¢ payoff ratio.

### Warning banners

If shown, take seriously:

| Banner                                        | What it means                                                                                                                                                                                                                                                 |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `⚠ ALREADY RAN — slippage +6.0¢ exceeds gate` | Price has already moved more than `maxSlippageCents` past the blended entry. The signal has been triggered (confidence is also auto-halved), but the easy entry is gone. Decide whether the remaining edge is still worth it.                                 |
| `⚠ Herding penalty applied (x0.50)`           | The worker detected suspicious uniformity (many holders entered within the same short window with near-identical position sizes — looks like copy-trading). The consensus score has been multiplied by `herdingPenalty` (default 0.5). Treat with skepticism. |

### Supporting traders block

One line per current vetted holder of this outcome:

```
• alice_eth: WR 71%, PF 2.10, trust 0.62 (47 resolved)
```

- **alice_eth** — Polymarket username, or a truncated proxy address `0xabcd…ef56` if no username exists.
- **WR** — _Win rate_. Fraction of their closed-out trades that turned a profit. `71%` means 71 of every 100 resolved trades made money.
- **PF** — _Profit factor_. Total $ won ÷ total $ lost across all their resolved trades. `2.10` means they make $2.10 for every $1 they lose. **PF > 1.3** is the default minimum to be considered vetted.
- **trust** — Their **trust weight**, a 0–1 score that controls how much their vote contributes to consensus. See [§5 Trust weight](#trust-weight).
- **47 resolved** — Number of closed-out trade cycles in the last 90 days (configurable via `recencyDays`, currently a code default). More cycles = more reliable stats.

### EXIT alerts

```
🔴 EXIT — Yes
Will Bitcoin close above $120,000 by end of Q3 2026?

Confidence: 80/100   Score: 0.80   Holders: 1
Entry blend: 32¢   Live: 41¢   Slippage: +9.0¢

Rationale
4 of 5 original vetted holders have exited this position.
Live 41¢ vs blended entry 32¢.
```

- **`Holders: 1`** on an EXIT means **only 1 of the original 5 vetted traders still holds**. Most have closed.
- **Confidence on EXIT** = % of original holders who have left (here 80%).
- **`relatedSuggestion`** field in the database links this EXIT row back to the BUY row it's exiting from.
- The original BUY's status flips from `NOTIFIED` → `EXITED`.

EXIT fires once `gone_fraction ≥ exitFraction` (default 0.6, i.e., 60% of original holders have closed).

---

## 3. Reading the dashboard

Default URL: `http://localhost:3000` locally, or `http://100.x.y.z:3000` over Tailscale. Four pages:

### `/` — Suggestions list (home)

Top of page: **worker status tile** (last poll time, duration, kill-switch on/off). If the worker has been silent for more than two poll intervals, something's wrong.

Below it: every open suggestion (`NEW` + `NOTIFIED`), sorted by confidence descending. Click any row to drill in.

### `/suggestions/[id]` — Suggestion detail

The most important page. Sections, top to bottom:

- **Header** — BUY/EXIT badge, status badge, outcome, market question.
- **Actions card** — `Dismiss` / `Mark taken` buttons, plus a **Log fill** form. Submitting the log form auto-flips status to `TAKEN`.
- **Metrics card** — every number from the Telegram alert, in a grid: Confidence, Score, Holders, Entry blend, Live price, Slippage, notification count, plus the same `⚠ Already ran` / `⚠ Herding penalty` banners if applicable.
- **Rationale** — the full prose explanation.
- **Supporting traders table** — current holders with full per-trader stats: Trust, WR, PF, Avg ROI, Resolved, Windows.
- **Exited traders table** — for BUY rows: who was _originally_ in the `originalHolderIds` set but no longer holds. Tinted amber.
- **Related suggestions** — for EXIT rows, a link back to the triggering BUY (and vice versa).
- **Notifications log** — every send attempt: timestamp, channel, success/fail, error text, attempt number.
- **Trades you took** — every row you've logged via the action form: when, side, size, fill price, closed at, realized P&L. Open trades get an inline "Close" form where you enter the close price.

### `/traders` — The vetted pool

A table of every trader the worker has ever evaluated. Vetted traders are listed first (sorted by trust weight descending), then non-vetted ones (gray, sorted by best leaderboard rank).

Columns:

| Column            | Meaning                                                                              |
| ----------------- | ------------------------------------------------------------------------------------ |
| `Vetted`          | Green "yes" badge if they passed all four gates this poll.                           |
| `User`            | Polymarket username, or `—`.                                                         |
| `Proxy`           | Truncated proxy wallet (`0xabcd…ef56`). This is the canonical trader ID.             |
| `Best rank`       | Best rank achieved across any tracked leaderboard window.                            |
| `Win %`           | Fraction of resolved trades with positive P&L.                                       |
| `PF`              | Profit factor.                                                                       |
| `Avg ROI`         | Mean per-trade ROI: `(exit − entry) / entry`.                                        |
| `Avg odds`        | Mean entry price. > `favoriteOddsThreshold` (0.8) triggers a favorite-buyer penalty. |
| `Resolved`        | Count of closed-out cycles.                                                          |
| `Windows`         | e.g. `2/3` — appears in 2 of {WEEK, MONTH, ALL} leaderboards.                        |
| `Trust`           | The 0–1 trust weight applied when this trader contributes to consensus.              |
| `Stats refreshed` | Relative time since last vetting pass.                                               |

Capped at 200 rows.

### `/config` — All the knobs

Edit any field, hit Save, the worker picks up the change on its next poll. See [§4](#4-the-config-page--every-knob-explained).

### `/runs` — Worker heartbeat

Last 50 poll executions. Use this to verify the worker is alive and to spot regressions:

| Column       | Meaning                                                        |
| ------------ | -------------------------------------------------------------- |
| `ID`         | Sequential run number.                                         |
| `Started`    | When the poll began.                                           |
| `Duration`   | How long it took (typically 30s–10min depending on pool size). |
| `Status`     | `running` / `ok` / `errors`.                                   |
| `Candidates` | Top-N leaderboard traders pulled this poll.                    |
| `Vetted`     | How many passed all four gates.                                |
| `Positions`  | Total position rows observed.                                  |
| `Firings`    | BUY suggestions created or updated.                            |
| `Exits`      | EXIT suggestions fired.                                        |
| `Sent`       | Notifications successfully dispatched.                         |
| `Errors`     | Errors logged during the poll.                                 |
| `Notes`      | Free-form note (rate-limit hits, etc.).                        |

A healthy steady-state run typically has `errors: 0` and a non-empty `vetted` count.

---

## 4. The Config page — every knob, explained

Every knob has a default, a valid range, and a real impact. Loosen carefully — bad alerts waste your attention and erode trust in the system.

### Operations

| Field                 | Default          | Range                                  | What it does                                                                                                                                                                                                                                                                           |
| --------------------- | ---------------- | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `killSwitch`          | `false`          | bool                                   | When **on**, worker does no analysis and sends no notifications. Use during maintenance. The dashboard shows a red banner when it's on.                                                                                                                                                |
| `pollIntervalSec`     | `120`            | ≥ 10                                   | Seconds between polls. Lower = fresher data + more API load. Polymarket's positions endpoint allows ~150 req / 10s; with a pool of 50 traders, 120s is comfortable.                                                                                                                    |
| `candidatePoolSize`   | `50`             | ≥ 1                                    | How many top traders to pull from the leaderboard each poll. Larger pool = more potential consensus but slower vetting (≈6s per candidate on cold cache).                                                                                                                              |
| `leaderboardWindows`  | `WEEK,MONTH,ALL` | CSV of `DAY/WEEK/MONTH/ALL`            | Which time windows count toward the `windowsAppeared` consistency gate.                                                                                                                                                                                                                |
| `category`            | `OVERALL`        | enum                                   | Leaderboard category filter (`OVERALL`, `POLITICS`, `SPORTS`, `CRYPTO`, …).                                                                                                                                                                                                            |
| `notifyChannel`       | `TELEGRAM`       | `TELEGRAM/PUSHOVER/NTFY/EMAIL/CONSOLE` | Which notifier to use. `CONSOLE` writes the alert to the worker log instead of sending — useful for testing without spamming your phone.                                                                                                                                               |
| `alertConfidenceStep` | `10`             | ≥ 0                                    | Once a suggestion is `NOTIFIED`, only re-alert if confidence has risen by at least this many points. Default of 10 prevents alert spam from small fluctuations.                                                                                                                        |
| `exitFraction`        | `0.6`            | 0–1                                    | Fraction of _original_ vetted holders who must have closed their position for an EXIT alert to fire. `0.6` = "fire when ≥ 60% have left."                                                                                                                                              |
| `vetCacheTtlSec`      | `21600` (6 h)    | ≥ 0                                    | Skip API re-vetting of a trader whose stats were computed within this many seconds. Cached stats are still re-scored against current gates each poll (so config edits apply live). Set to `0` to disable caching. Lower = fresher career stats. Higher = faster polls + less API load. |

### Vetting gates

A trader must pass **all four** of these to be considered "vetted." If a vetted trader holds a market, their vote counts toward consensus. If they're not vetted, they're invisible to the consensus engine.

| Field                | Default      | What it does                                                                                                                             |
| -------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `minResolvedTrades`  | `20`         | Minimum closed-out trade cycles required. Lower = more candidates pass but stats are noisier. 15–25 is the sweet spot.                   |
| `winRateFloor`       | `0.55` (0–1) | Minimum fraction of trades that were profitable. `0.55` = 55%. Goes to 0.60+ for stricter pools.                                         |
| `minProfitFactor`    | `1.3`        | Minimum (gross profit ÷ gross loss). `1.3` means "for every $1 lost, made at least $1.30."                                               |
| `minWindowsAppeared` | `2` (1–3)    | Must rank in this many of {WEEK, MONTH, ALL}. `2` filters out flash-in-the-pan accounts. `3` requires consistent multi-window dominance. |

### Trust weight shaping

These shape the `trustWeight` formula applied to each vetted trader (see [§5 Trust weight](#trust-weight)). Changing them won't add or remove traders from the pool — it only changes how loud each one's vote is.

| Field                   | Default     | What it does                                                                                                                                                                              |
| ----------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pfTarget`              | `2.0`       | Profit factor that maps to a full pfScore of 1.0. Formula: `clamp01((pf - 1) / (pfTarget - 1))`. With `pfTarget=2`, a trader with `pf=1.5` scores 0.5.                                    |
| `confidenceK`           | `50`        | Shrinkage constant for sample-size confidence. Formula: `n / (n + k)`. With `k=50`: 50 trades → 0.5 confidence, 200 trades → 0.8. Higher `k` = stricter (need more trades to be trusted). |
| `favoriteOddsThreshold` | `0.8` (0–1) | If a trader's average entry price exceeds this, apply a penalty (caps at 0.5x). Stops accounts that only buy 95¢ favorites from looking elite.                                            |

### Consensus

| Field                  | Default | What it does                                                                                                                                                                                               |
| ---------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `minDistinctHolders`   | `3`     | Minimum distinct vetted traders required for a signal to fire. `2` is loose, `4–5` is strict.                                                                                                              |
| `consensusScoreMin`    | `1.5`   | Minimum raw consensus score for a signal to fire (after herding penalty if any).                                                                                                                           |
| `recencyHalfLifeHours` | `48`    | Holder positions decay over time. After 48 hours, a holder's contribution is halved. Encourages alerting on _current_ activity, not stale positions.                                                       |
| `maxSlippageCents`     | `4`     | If live price has moved more than this many cents past blended entry, mark `alreadyRan=true` and halve confidence. The signal still fires (so you can see how the consensus is evolving) but it's flagged. |

### Herding guard

Detects clusters of traders entering identical-sized positions within a tight window — the fingerprint of copy-trading bots.

| Field                  | Default     | What it does                                                                                                         |
| ---------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------- |
| `herdingWindowMinutes` | `30`        | Look back this many minutes for cluster detection.                                                                   |
| `herdingClusterFrac`   | `0.6` (0–1) | If ≥ this fraction of holders entered within `herdingWindowMinutes`, suspect herding.                                |
| `herdingSizeCv`        | `0.2`       | Coefficient of variation of position sizes within the cluster. If sizes are too uniform (CV ≤ 0.2), confirm herding. |
| `herdingPenalty`       | `0.5` (0–1) | Multiply consensus score by this when herding is detected. `0.5` halves the signal; `0.0` would kill it entirely.    |

### Confidence display

The display confidence (0–100) blends raw consensus score and holder count. These two knobs control the mapping.

| Field          | Default | What it does                                                               |
| -------------- | ------- | -------------------------------------------------------------------------- |
| `scoreTarget`  | `4.0`   | Raw consensus score that maps to a score-component of 1.0 (i.e., "elite"). |
| `holderTarget` | `6`     | Holder count that maps to a holder-component of 1.0.                       |

Formula: `confidence = 100 × (0.7 × clamp(score/scoreTarget) + 0.3 × clamp(holders/holderTarget))`. Halved if `alreadyRan`.

---

## 5. The math: scoring, trust, consensus, exits

Source of truth: [packages/shared/src/scoring.ts](packages/shared/src/scoring.ts). It's pure, deterministic, ~200 lines. Read it if you want exact semantics.

### Trust weight

Each vetted trader gets a `trustWeight` in [0, ~1.0]:

```
trustWeight = pfScore × confidence × consistency × favoritePenalty
```

| Factor            | Formula                                                               | At a glance                                        |
| ----------------- | --------------------------------------------------------------------- | -------------------------------------------------- |
| `pfScore`         | `clamp01((pf − 1) / (pfTarget − 1))`                                  | 1.0 (breakeven) → 0; `pfTarget` (2.0) → 1.0        |
| `confidence`      | `n / (n + k)` where `n=resolvedTrades, k=confidenceK`                 | 50 trades → 0.5; 200 trades → 0.8                  |
| `consistency`     | `0.5 + 0.25 × clamp(windowsAppeared, 1, 3)`                           | 1 window → 0.75; 2 → 1.0; 3 → 1.25 (capped at 1.0) |
| `favoritePenalty` | `1.0` if `avgEntryOdds ≤ favoriteOddsThreshold`, else tapers to `0.5` | Punishes "buys 95¢ favorites" accounts             |

A trader with PF 2.5, 100 resolved trades, all 3 windows, avg odds 0.6 → `1.0 × 0.67 × 1.0 × 1.0 ≈ 0.67`.

### Consensus score

For each (market, outcome) pair, the raw score is:

```
rawScore = Σ (trustWeight × recency × conviction) for each vetted holder

recency   = 0.5 ^ (hoursSinceEntry / recencyHalfLifeHours)
conviction = clamp(0.5 + pctOfPortfolio × 2, 0.5, 1.5)
```

Recency means a fresh holder counts more than someone who entered last week. Conviction means a holder with a large fraction of their portfolio in this position counts more than someone with a tiny dabble.

If herding is detected, `rawScore *= herdingPenalty`.

A signal fires when both:

- `distinctHolders ≥ minDistinctHolders`
- `rawScore ≥ consensusScoreMin`

### Confidence display

```
scoreComp  = clamp01(rawScore / scoreTarget)        # 0..1
holderComp = clamp01(distinctHolders / holderTarget) # 0..1
confidence = round(100 × (0.7 × scoreComp + 0.3 × holderComp))
if alreadyRan: confidence *= 0.5
```

So with defaults, a score of 4.0 + 6 holders + clean entry → 100. Slippage gate trips it → 50.

### Entry blend

When the BUY fires:

```
blendedEntry = weightedMean(
  [holder.avgEntryPrice for h in holders],
  [holder.trustWeight   for h in holders]
)
```

This is the "smart money paid X" number on every alert.

### Exit trigger

Once a BUY suggestion fires, its `originalHolderIds` array is **frozen** (the set of proxy addresses that triggered the signal). Every subsequent poll, the worker checks how many of those original IDs are still holding the outcome:

```
gone = 1 − (stillHolding / originalHolders)
if gone ≥ exitFraction:
    fire EXIT signal
    BUY.status = EXITED
```

EXIT confidence = `gone × 100`. EXIT score = `gone`.

---

## 6. Glossary

### Trader-level metrics

| Term                   | Meaning                                                                                                                                                                                            |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Resolved trade**     | A closed-out trade cycle: BUY then SELL on the CLOB, or BUY then REDEEM at market settlement. Open positions are not resolved trades.                                                              |
| **WR** (Win rate)      | Fraction of resolved trades where `exitValue > entryPrice`. Range 0–100%.                                                                                                                          |
| **PF** (Profit factor) | Gross $ won across all winning trades, divided by gross $ lost across all losing trades. Capped at 5 if the trader has no losses. PF > 1 = profitable; PF > 2 = strong; PF > 3 = elite (or fluky). |
| **Avg ROI**            | Mean per-trade ROI: average of `(exit − entry) / entry` across all resolved trades.                                                                                                                |
| **Avg odds**           | Mean entry price across all resolved trades. High avg odds = "I only buy favorites."                                                                                                               |
| **Windows**            | How many of {WEEK, MONTH, ALL} leaderboards they currently appear on. Out of 3.                                                                                                                    |
| **Trust**              | The 0–1 trust weight, see [§5](#trust-weight).                                                                                                                                                     |

### Suggestion-level metrics

| Term                | Meaning                                                                                   |
| ------------------- | ----------------------------------------------------------------------------------------- |
| **Confidence**      | The display 0–100 score on every alert. See [§5 Confidence display](#confidence-display). |
| **Score**           | Raw, unbounded consensus score. See [§5 Consensus](#consensus-score).                     |
| **Holders**         | Count of distinct _currently vetted_ traders holding this outcome.                        |
| **Entry blend**     | Trust-weighted average entry price across the current holders. In cents (0–100).          |
| **Live**            | Current CLOB midpoint, in cents.                                                          |
| **Slippage**        | Signed cents: `Live − Entry blend`. Positive = price ran up, negative = discount.         |
| **Already ran**     | Flag set when slippage exceeds `maxSlippageCents`. Halves confidence.                     |
| **Herding penalty** | Multiplier (default 0.5) applied to score when copy-trader cluster detected.              |
| **Rationale**       | Auto-generated prose explanation included in every alert.                                 |

### Polymarket-specific

| Term                  | Meaning                                                                                                                                                               |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Proxy wallet**      | The trader's Gnosis Safe address. This is the canonical trader ID (not the EOA).                                                                                      |
| **conditionId**       | Unique ID for a market's resolution logic. All outcomes of one market share a conditionId.                                                                            |
| **outcomeIndex**      | Integer index for outcomes (0, 1, 2…). REDEEM activity rows use `999` as a sentinel.                                                                                  |
| **tokenId**           | CLOB asset ID for one (outcome × conditionId) pair. Used to fetch prices and match positions.                                                                         |
| **CLOB**              | Polymarket's central limit order book exchange.                                                                                                                       |
| **Gamma**             | Polymarket's market metadata API.                                                                                                                                     |
| **REDEEM**            | Settlement event. When a market resolves, winning tokens are redeemed for $1 each.                                                                                    |
| **SPLIT / MERGE**     | Liquidity-pool operations (outcome tokens split from or merge into base token).                                                                                       |
| **BUY YES vs BUY NO** | Each market has 2+ outcomes, each with its own token. "BUY Yes" buys the Yes token (pays $1 if Yes resolves); "BUY No" buys the No token. They are different signals. |

### Status badges

| Status      | Color  | Meaning                                           |
| ----------- | ------ | ------------------------------------------------- |
| `NEW`       | Blue   | Created, not yet notified.                        |
| `NOTIFIED`  | Green  | Telegram alert sent.                              |
| `TAKEN`     | Violet | You logged a fill.                                |
| `DISMISSED` | Gray   | You marked it dismissed.                          |
| `EXITED`    | Amber  | Original holders mostly closed; EXIT alert fired. |
| `EXPIRED`   | Gray   | You manually marked it stale.                     |

### Notification reasons

Visible in the Notifications log on each suggestion detail:

| Reason            | Trigger                                                         |
| ----------------- | --------------------------------------------------------------- |
| `NEW`             | First time this suggestion was notified.                        |
| `CONFIDENCE_RISE` | Confidence has risen ≥ `alertConfidenceStep` since last notify. |
| `EXIT`            | Linked EXIT suggestion fired.                                   |

### Notification log fields

| Field                              | Meaning                                                                                     |
| ---------------------------------- | ------------------------------------------------------------------------------------------- |
| `success: true`                    | Sent successfully.                                                                          |
| `success: false, retryable: true`  | Transient failure (network, 429, 5xx). Worker will retry next poll.                         |
| `success: false, retryable: false` | Permanent failure (400, 401/403). Requires manual fix (token rotation, unblocking the bot). |

---

## 7. Daily workflow

A typical day with the tool:

1. **Phone buzzes.** "🟢 BUY — Yes" with confidence 72.
2. **Glance at the slippage.** If it's `+1.0¢` you're roughly at the smart-money price; if it's `+6.0¢` with `⚠ ALREADY RAN` you missed it.
3. **Tap the dashboard link** for the full picture: supporting traders, exited traders, the related EXIT history, recent fills you've taken in similar markets.
4. **Decide.** Either:
   - **Take it** → trade in the Polymarket app at your own size, then come back to the dashboard, click **Mark taken**, and **Log fill** with side/size/price. The detail page now tracks the open position.
   - **Skip it** → click **Dismiss**. Keeps your active list clean.
5. **Later, when EXIT fires** (or you change your mind), close in the Polymarket app and then enter the closed price in the inline **Close** form on the suggestion detail page. The dashboard computes realized P&L.
6. **Weekly,** browse `/traders` to sanity-check the pool. Anyone whose stats look weird? Maybe the gates need tightening.

---

## 8. Running the stack

For first-time provisioning (DigitalOcean + Tailscale + UFW + Docker install + Telegram bot), see [SETUP.md](SETUP.md). Once that's done, this is what you actually need day-to-day.

### Required environment

Copy `.env.example` to `.env` and fill in:

```bash
DATABASE_URL=file:../data/app.db
WEB_PORT=3000
POLL_INTERVAL_SEC=120
LOG_LEVEL=info
TELEGRAM_BOT_TOKEN=123456789:ABC-DEF...
TELEGRAM_CHAT_ID=987654321
```

> Never commit `.env`. Never put a wallet private key in it. This system reads public data only.

### Production (Docker Compose, recommended)

```bash
docker compose up -d --build       # build + start
docker compose ps                  # check both containers are Up
docker compose logs -f worker      # tail worker logs
docker compose logs -f web         # tail web logs
docker compose restart worker      # apply a code change
docker compose down                # stop everything
```

Both containers share the `./data` directory (bind-mounted) so they read/write the same SQLite file. Migrations run automatically on worker startup. The web port is bound to all interfaces — keep it private with UFW + Tailscale (see SETUP.md §3).

### Local development

```bash
# install deps + generate Prisma client
pnpm install
pnpm prisma:generate
pnpm prisma:migrate          # creates ./data/app.db

# two terminals:
pnpm dev:worker              # tsx watch-mode worker
pnpm dev:web                 # next dev on :3000
```

Useful one-shot scripts (run from repo root):

| Script           | What it does                                                                          |
| ---------------- | ------------------------------------------------------------------------------------- |
| `pnpm vet`       | Vet a small pool of traders and print results. Fast feedback loop while tuning gates. |
| `pnpm consensus` | Run the full consensus engine against a small pool.                                   |
| `pnpm markets`   | Sample-fetch market metadata.                                                         |
| `pnpm positions` | Inspect raw position payloads for a few traders.                                      |
| `pnpm poll`      | Run exactly one full poll (`RUN_ONCE=1`), then exit.                                  |

### Database snapshots

SQLite is one `rm` away from gone. Set up a daily backup:

```bash
sqlite3 data/app.db ".backup data/backups/app-$(date +%F).db"
```

(Add to cron on the droplet; keep maybe 14 days of backups.)

### Database growth & manual cleanup

The schema has no automatic pruning. Most tables are bounded (`Config`, `TrackedTrader`, `TraderPosition`, `Market` — positions are actively deleted when a trader exits, the rest upsert), but four grow forever:

| Table             | Growth rate (at 4-min polls)      | 1 year estimate   |
| ----------------- | --------------------------------- | ----------------- |
| `WorkerRun`       | ~360 rows/day (1 per poll)        | ~130k rows        |
| `Suggestion`      | ~5–25 rows/day (per fired signal) | ~3k–9k rows       |
| `NotificationLog` | 1 row per send attempt            | ~10k rows         |
| `Market`          | Slow — new markets only           | Tens of thousands |

You won't hit a disk problem for years (SQLite handles multi-GB without issue), but the `/runs` and `/suggestions` dashboard pages get slower without pruning.

**Run this quarterly** (safe — only deletes old heartbeats, expired/dismissed signals, and closed markets that are well past resolution):

```bash
# Adjust the cutoff windows to taste.
sqlite3 data/app.db <<'SQL'
-- WorkerRun heartbeats older than 30 days
DELETE FROM WorkerRun WHERE startedAt < datetime('now', '-30 days');

-- NotificationLog older than 90 days
DELETE FROM NotificationLog WHERE sentAt < datetime('now', '-90 days');

-- Suggestions that were never acted on and are older than 180 days.
-- Keep TAKEN forever (they link to your TakenTrade records).
DELETE FROM Suggestion
 WHERE status IN ('EXPIRED', 'DISMISSED')
   AND createdAt < datetime('now', '-180 days');

-- Closed Markets whose end date is older than 180 days.
-- These can't appear in new consensus signals.
DELETE FROM Market
 WHERE closed = 1
   AND endDate IS NOT NULL
   AND endDate < datetime('now', '-180 days');

-- Reclaim freed pages back to the OS.
VACUUM;
SQL
```

**Important:** stop the worker first (`docker compose stop worker`) so the `VACUUM` doesn't fight a live writer. Restart with `docker compose start worker` when done.

**Check sizes any time:**

```bash
sqlite3 data/app.db "
SELECT 'WorkerRun', COUNT(*) FROM WorkerRun
UNION ALL SELECT 'Suggestion', COUNT(*) FROM Suggestion
UNION ALL SELECT 'NotificationLog', COUNT(*) FROM NotificationLog
UNION ALL SELECT 'TrackedTrader', COUNT(*) FROM TrackedTrader
UNION ALL SELECT 'TraderPosition', COUNT(*) FROM TraderPosition
UNION ALL SELECT 'Market', COUNT(*) FROM Market
UNION ALL SELECT 'TakenTrade', COUNT(*) FROM TakenTrade;
"
ls -lh data/app.db
```

---

## 9. Tuning playbook

The tool is opinionated about defaults, but the right thresholds depend on how noisy your alerts are vs. how many you're missing. Some common situations:

### "I'm getting too many alerts"

In rough order of impact:

- Raise `consensusScoreMin` from 1.5 → 2.0.
- Raise `minDistinctHolders` from 3 → 4.
- Raise `alertConfidenceStep` from 10 → 20 (fewer re-alerts on the same signal).
- Raise `winRateFloor` from 0.55 → 0.60.

### "I'm getting no alerts"

- Lower `minDistinctHolders` to 2 (riskier — single coincidence can fire).
- Raise `candidatePoolSize` to 100 or 200 (more traders to find consensus among, but slower polls).
- Lower `minResolvedTrades` to 15.
- Lower `winRateFloor` to 0.50 (PF still gates quality).

### "The alerts fire but the price has already moved"

- Lower `maxSlippageCents` from 4 → 2 (more signals marked `alreadyRan`, easier to filter).
- Lower `pollIntervalSec` from 120 → 60 (fresher data, more API load).

### "Stats look wrong on `/traders`"

- The `recencyDays` code default is 90 (clip stats to last 90d to keep them relevant). If you want lifetime stats again, change the default in [apps/worker/src/pipeline/vet.ts](apps/worker/src/pipeline/vet.ts) or surface it as a Config field.

### "I think two traders are copy-trading"

- Tighten `herdingClusterFrac` from 0.6 → 0.5.
- Tighten `herdingSizeCv` from 0.2 → 0.3.
- Lower `herdingPenalty` from 0.5 → 0.25 (or 0 to kill the signal entirely).

---

## 10. Troubleshooting

### Worker says "candidates selected: 0"

The leaderboard call failed or returned empty. Check:

- Worker logs for HTTP errors from `data-api.polymarket.com`.
- `category` in Config — does that category actually have a leaderboard?

### Worker runs but `vetted: 0`

Vetting gates may be too strict for the recency clip. Check `/traders` — if `Resolved` numbers are very low across the board, the 90-day clip is filtering too aggressively. Loosen `minResolvedTrades` or raise the default `recencyDays`.

### Telegram alert says "Connection closed" or never arrives

- Check the Notifications log on the suggestion detail page.
- `success: false, retryable: false` with an HTTP 401/403 = the bot token is wrong, or you've blocked the bot. Re-run the BotFather test (SETUP.md §5).
- `retryable: true` errors will auto-retry next poll.
- Try `notifyChannel: CONSOLE` to verify the message format is being generated correctly, without involving Telegram at all.

### Dashboard loads but `/config` is blank

The `Config` row hasn't been created. Open `/config` once with the worker running — the page upserts the row on first load.

### Server Action returns 500

Look at the web container logs. The most common cause is a validation rejection (e.g., `winRateFloor` outside 0–1). The error message will say which field.

### `docker compose build` is slow

First build pulls Node, installs deps, generates Prisma client. ~3 minutes is normal. Subsequent builds with no manifest changes should be ≤ 30s thanks to BuildKit cache.

---

## 11. What's deliberately NOT here

The shape of this system was a deliberate design choice. To save you from asking:

- **No private keys, no trading.** Every order goes through the official Polymarket app on your phone. The server never holds a key.
- **No auth on the dashboard.** Per SETUP.md, it lives on Tailscale behind UFW. No public exposure → no need for login.
- **No DRSP, no PnL leaderboard for _you_.** This is a research tool, not a portfolio tracker. The "Trades you took" log on each suggestion is the only place we record your fills, and only to compute realized P&L per suggestion.
- **No multi-user.** Single-user, single-tenant by design. The `Config` table is one row.
- **No backtesting.** The pipeline reads live data only. To backtest you'd need historical leaderboard snapshots, which the public APIs don't expose.
- **No automatic position sizing.** The alert tells you who's in, at what price, with what conviction. _How much you put in is up to you._

---

## Architecture quick-reference

```
polymarket-suggestion/
├── apps/
│   ├── worker/             # the polling engine
│   │   └── src/
│   │       ├── main.ts             # poll loop + scheduler
│   │       ├── pipeline/           # candidate selection, vetting, consensus, exits
│   │       ├── notifier/           # telegram + dispatch + formatter
│   │       └── scripts/            # eyeball-*.ts (manual one-shot tools)
│   └── web/                # the Next.js dashboard
│       └── src/
│           ├── app/                # / suggestions/[id] traders config runs
│           └── lib/
│               ├── actions.ts      # server actions (updateConfig, setStatus, ...)
│               └── db.ts           # shared Prisma client
├── packages/
│   ├── shared/             # ScoringConfig + pure scoring functions
│   └── polymarket-api/     # typed clients for Gamma/Data/CLOB APIs
├── prisma/
│   └── schema.prisma       # Suggestion, Config, TrackedTrader, ... (SQLite)
├── data/                   # ./app.db lives here (bind-mounted in Docker)
├── apps/worker/Dockerfile
├── apps/web/Dockerfile
├── docker-compose.yml
├── SETUP.md                # server provisioning
└── README.md               # you are here
```
