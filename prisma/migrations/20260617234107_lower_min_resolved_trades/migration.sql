-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Config" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT DEFAULT 1,
    "killSwitch" BOOLEAN NOT NULL DEFAULT false,
    "candidatePoolSize" INTEGER NOT NULL DEFAULT 50,
    "leaderboardWindows" TEXT NOT NULL DEFAULT 'WEEK,MONTH,ALL',
    "category" TEXT NOT NULL DEFAULT 'OVERALL',
    "pollIntervalSec" INTEGER NOT NULL DEFAULT 120,
    "notifyChannel" TEXT NOT NULL DEFAULT 'TELEGRAM',
    "alertConfidenceStep" REAL NOT NULL DEFAULT 10,
    "exitFraction" REAL NOT NULL DEFAULT 0.6,
    "minResolvedTrades" INTEGER NOT NULL DEFAULT 20,
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
INSERT INTO "new_Config" ("alertConfidenceStep", "candidatePoolSize", "category", "confidenceK", "consensusScoreMin", "exitFraction", "favoriteOddsThreshold", "herdingClusterFrac", "herdingPenalty", "herdingSizeCv", "herdingWindowMinutes", "holderTarget", "id", "killSwitch", "leaderboardWindows", "maxSlippageCents", "minDistinctHolders", "minProfitFactor", "minResolvedTrades", "minWindowsAppeared", "notifyChannel", "pfTarget", "pollIntervalSec", "recencyHalfLifeHours", "scoreTarget", "updatedAt", "winRateFloor") SELECT "alertConfidenceStep", "candidatePoolSize", "category", "confidenceK", "consensusScoreMin", "exitFraction", "favoriteOddsThreshold", "herdingClusterFrac", "herdingPenalty", "herdingSizeCv", "herdingWindowMinutes", "holderTarget", "id", "killSwitch", "leaderboardWindows", "maxSlippageCents", "minDistinctHolders", "minProfitFactor", "minResolvedTrades", "minWindowsAppeared", "notifyChannel", "pfTarget", "pollIntervalSec", "recencyHalfLifeHours", "scoreTarget", "updatedAt", "winRateFloor" FROM "Config";
DROP TABLE "Config";
ALTER TABLE "new_Config" RENAME TO "Config";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
