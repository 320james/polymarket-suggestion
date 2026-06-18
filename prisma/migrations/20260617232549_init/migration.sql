-- CreateTable
CREATE TABLE "Config" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT DEFAULT 1,
    "killSwitch" BOOLEAN NOT NULL DEFAULT false,
    "candidatePoolSize" INTEGER NOT NULL DEFAULT 50,
    "leaderboardWindows" TEXT NOT NULL DEFAULT 'WEEK,MONTH,ALL',
    "category" TEXT NOT NULL DEFAULT 'OVERALL',
    "pollIntervalSec" INTEGER NOT NULL DEFAULT 120,
    "notifyChannel" TEXT NOT NULL DEFAULT 'TELEGRAM',
    "alertConfidenceStep" REAL NOT NULL DEFAULT 10,
    "exitFraction" REAL NOT NULL DEFAULT 0.6,
    "minResolvedTrades" INTEGER NOT NULL DEFAULT 50,
    "winRateFloor" REAL NOT NULL DEFAULT 0.55,
    "minProfitFactor" REAL NOT NULL DEFAULT 1.3,
    "minWindowsAppeared" INTEGER NOT NULL DEFAULT 2,
    "pfTarget" REAL NOT NULL DEFAULT 2.0,
    "confidenceK" REAL NOT NULL DEFAULT 50,
    "favoriteOddsThreshold" REAL NOT NULL DEFAULT 0.8,
    "minDistinctHolders" INTEGER NOT NULL DEFAULT 3,
    "consensusScoreMin" REAL NOT NULL DEFAULT 1.5,
    "recencyHalfLifeHours" REAL NOT NULL DEFAULT 48,
    "maxSlippageCents" REAL NOT NULL DEFAULT 4,
    "herdingWindowMinutes" REAL NOT NULL DEFAULT 30,
    "herdingClusterFrac" REAL NOT NULL DEFAULT 0.6,
    "herdingSizeCv" REAL NOT NULL DEFAULT 0.2,
    "herdingPenalty" REAL NOT NULL DEFAULT 0.5,
    "scoreTarget" REAL NOT NULL DEFAULT 4.0,
    "holderTarget" REAL NOT NULL DEFAULT 6,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "TrackedTrader" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "username" TEXT,
    "bestRank" INTEGER NOT NULL,
    "pnl" REAL NOT NULL,
    "volume" REAL NOT NULL,
    "winRate" REAL,
    "profitFactor" REAL,
    "avgRoi" REAL,
    "avgEntryOdds" REAL,
    "resolvedTrades" INTEGER NOT NULL DEFAULT 0,
    "windowsAppeared" INTEGER NOT NULL DEFAULT 1,
    "trustWeight" REAL NOT NULL DEFAULT 0,
    "vetted" BOOLEAN NOT NULL DEFAULT false,
    "lastSeenOnLeaderboardAt" DATETIME,
    "lastStatsComputedAt" DATETIME,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "TraderPosition" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "traderId" TEXT NOT NULL,
    "conditionId" TEXT NOT NULL,
    "tokenId" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "outcomeIndex" INTEGER NOT NULL,
    "size" REAL NOT NULL,
    "avgPrice" REAL NOT NULL,
    "pctOfPortfolio" REAL,
    "enteredAt" DATETIME NOT NULL,
    "firstObservedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastObservedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TraderPosition_traderId_fkey" FOREIGN KEY ("traderId") REFERENCES "TrackedTrader" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Market" (
    "conditionId" TEXT NOT NULL PRIMARY KEY,
    "slug" TEXT,
    "question" TEXT NOT NULL,
    "endDate" DATETIME,
    "resolutionSource" TEXT,
    "outcomes" TEXT NOT NULL,
    "tokens" TEXT NOT NULL,
    "closed" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "negativeRisk" BOOLEAN NOT NULL DEFAULT false,
    "fetchedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Suggestion" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "type" TEXT NOT NULL,
    "conditionId" TEXT NOT NULL,
    "marketQuestion" TEXT NOT NULL,
    "tokenId" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "outcomeIndex" INTEGER NOT NULL,
    "confidence" REAL NOT NULL,
    "consensusScore" REAL NOT NULL,
    "distinctHolders" INTEGER NOT NULL,
    "blendedEntry" REAL NOT NULL,
    "priceAtSignal" REAL NOT NULL,
    "slippageCents" REAL NOT NULL,
    "alreadyRan" BOOLEAN NOT NULL DEFAULT false,
    "herdingPenalty" REAL NOT NULL DEFAULT 1,
    "rationale" TEXT NOT NULL,
    "originalHolderIds" TEXT NOT NULL,
    "supportingIds" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'NEW',
    "lastNotifiedConfidence" REAL,
    "lastNotifiedAt" DATETIME,
    "notifyCount" INTEGER NOT NULL DEFAULT 0,
    "relatedSuggestionId" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Suggestion_relatedSuggestionId_fkey" FOREIGN KEY ("relatedSuggestionId") REFERENCES "Suggestion" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "TakenTrade" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "suggestionId" INTEGER,
    "conditionId" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "size" REAL NOT NULL,
    "fillPrice" REAL NOT NULL,
    "takenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedPrice" REAL,
    "realizedPnl" REAL,
    "closedAt" DATETIME,
    CONSTRAINT "TakenTrade_suggestionId_fkey" FOREIGN KEY ("suggestionId") REFERENCES "Suggestion" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "NotificationLog" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "suggestionId" INTEGER NOT NULL,
    "channel" TEXT NOT NULL,
    "success" BOOLEAN NOT NULL,
    "error" TEXT,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "sentAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "NotificationLog_suggestionId_fkey" FOREIGN KEY ("suggestionId") REFERENCES "Suggestion" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "WorkerRun" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" DATETIME,
    "ok" BOOLEAN NOT NULL DEFAULT false,
    "candidates" INTEGER NOT NULL DEFAULT 0,
    "vetted" INTEGER NOT NULL DEFAULT 0,
    "positionsSeen" INTEGER NOT NULL DEFAULT 0,
    "firings" INTEGER NOT NULL DEFAULT 0,
    "exits" INTEGER NOT NULL DEFAULT 0,
    "notifications" INTEGER NOT NULL DEFAULT 0,
    "errorCount" INTEGER NOT NULL DEFAULT 0,
    "notes" TEXT
);

-- CreateIndex
CREATE INDEX "TrackedTrader_vetted_idx" ON "TrackedTrader"("vetted");

-- CreateIndex
CREATE INDEX "TraderPosition_conditionId_tokenId_idx" ON "TraderPosition"("conditionId", "tokenId");

-- CreateIndex
CREATE INDEX "TraderPosition_traderId_idx" ON "TraderPosition"("traderId");

-- CreateIndex
CREATE UNIQUE INDEX "TraderPosition_traderId_tokenId_key" ON "TraderPosition"("traderId", "tokenId");

-- CreateIndex
CREATE INDEX "Market_endDate_idx" ON "Market"("endDate");

-- CreateIndex
CREATE INDEX "Market_active_closed_idx" ON "Market"("active", "closed");

-- CreateIndex
CREATE INDEX "Suggestion_createdAt_idx" ON "Suggestion"("createdAt");

-- CreateIndex
CREATE INDEX "Suggestion_status_idx" ON "Suggestion"("status");

-- CreateIndex
CREATE INDEX "Suggestion_conditionId_tokenId_type_status_idx" ON "Suggestion"("conditionId", "tokenId", "type", "status");

-- CreateIndex
CREATE INDEX "TakenTrade_suggestionId_idx" ON "TakenTrade"("suggestionId");

-- CreateIndex
CREATE INDEX "TakenTrade_takenAt_idx" ON "TakenTrade"("takenAt");

-- CreateIndex
CREATE INDEX "NotificationLog_sentAt_idx" ON "NotificationLog"("sentAt");

-- CreateIndex
CREATE INDEX "NotificationLog_suggestionId_idx" ON "NotificationLog"("suggestionId");

-- CreateIndex
CREATE INDEX "WorkerRun_startedAt_idx" ON "WorkerRun"("startedAt");
