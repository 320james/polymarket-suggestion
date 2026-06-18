import { PrismaClient } from "@prisma/client";

let prisma: PrismaClient | null = null;

/** Lazily-instantiated singleton Prisma client for the worker. */
export function getPrisma(): PrismaClient {
  if (!prisma) {
    prisma = new PrismaClient({
      log:
        process.env.PRISMA_LOG === "1"
          ? ["query", "info", "warn", "error"]
          : ["warn", "error"],
    });
  }
  return prisma;
}

/** For scripts/tests that want to ensure the connection closes cleanly. */
export async function disconnectPrisma(): Promise<void> {
  if (prisma) {
    await prisma.$disconnect();
    prisma = null;
  }
}
