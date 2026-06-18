/**
 * Channel factory — pick a `NotifierChannel` based on Config.notifyChannel.
 *
 * Missing channel impls (PUSHOVER, NTFY, EMAIL) currently fall back to
 * CONSOLE so the dashboard can still select them and the worker won't
 * silently drop notifications. We can drop the stub later by throwing,
 * but right now CONSOLE-fallback is the safer default for a personal tool.
 */

import type { ChannelName, NotifierChannel } from "./types.js";
import { TelegramChannel } from "./telegram.js";
import { ConsoleChannel } from "./console.js";
import { log } from "../log.js";

export function createChannel(name: string): NotifierChannel {
  const wanted = name.toUpperCase() as ChannelName;
  switch (wanted) {
    case "TELEGRAM": {
      const ch = TelegramChannel.fromEnv();
      if (ch) return ch;
      log.warn(
        "TELEGRAM channel selected but TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID missing — falling back to CONSOLE",
      );
      return new ConsoleChannel();
    }
    case "CONSOLE":
      return new ConsoleChannel();
    case "PUSHOVER":
    case "NTFY":
    case "EMAIL":
      log.warn(
        { channel: wanted },
        "channel not implemented yet — falling back to CONSOLE",
      );
      return new ConsoleChannel();
    default:
      log.warn({ channel: name }, "unknown channel — falling back to CONSOLE");
      return new ConsoleChannel();
  }
}
