/**
 * Shared Prisma client for the Next.js app.
 *
 * Next.js dev hot-reload re-instantiates module-level singletons every
 * change, so we stash the client on `globalThis` to survive HMR. In prod
 * we get a single client per Node process.
 */
import { PrismaClient } from "@prisma/client";

declare global {
  // eslint-disable-next-line no-var
  var __prisma: PrismaClient | undefined;
}

export const prisma: PrismaClient =
  globalThis.__prisma ??
  new PrismaClient({
    log:
      process.env.PRISMA_LOG === "1"
        ? ["query", "info", "warn", "error"]
        : ["warn", "error"],
  });

if (process.env.NODE_ENV !== "production") {
  globalThis.__prisma = prisma;
}
