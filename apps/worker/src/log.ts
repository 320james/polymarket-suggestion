import pino from "pino";

const isTty = process.stdout.isTTY === true;

export const log = pino({
  level: process.env.LOG_LEVEL ?? "info",
  ...(isTty
    ? {
        transport: {
          target: "pino-pretty",
          options: {
            colorize: true,
            translateTime: "HH:MM:ss.l",
            ignore: "pid,hostname",
          },
        },
      }
    : {}),
});
