// Pure command parser for Telegram bot messages.

export type Command = "arm" | "disarm" | "status" | "siren_off" | "unknown";

export interface ParsedCommand {
  cmd: Command;
}

export function parseCommand(text: string): ParsedCommand {
  const trimmed = text.trim().toLowerCase();

  if (trimmed === "/arm") return { cmd: "arm" };
  if (trimmed === "/disarm") return { cmd: "disarm" };
  if (trimmed === "/status") return { cmd: "status" };
  if (trimmed === "/siren off") return { cmd: "siren_off" };

  return { cmd: "unknown" };
}
