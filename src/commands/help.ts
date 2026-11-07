import type { Command, CommandInvocation } from "../lib/command.js";
import { errorEmbed } from "../lib/command.js";

// HELP_GROUPS lives in the registry (./index.js), which imports this file —
// so it is loaded lazily inside execute() instead of at module top level.
// A static import here would create a circular import and crash with a
// TDZ error whenever help.ts is imported before index.ts.

export const buttonHandlers: Record<string, (...args: never[]) => Promise<void>> = {};
export const modalHandlers: Record<string, (...args: never[]) => Promise<void>> = {};

/** Discord caps plain-text message content at 2000 chars. The full
 * grouped help list renders at ~3.8k chars, so a single reply throws
 * inside discord.js and surfaces as the generic "Couldn't run that"
 * error — keep every chunk under the limit with margin. */
export const HELP_MESSAGE_LIMIT = 1900;

/** Split rendered help text into messages that each fit Discord's
 * 2000-char content limit, breaking only on line boundaries (a single
 * over-long line is hard-sliced as a last resort). */
export function splitHelpMessage(text: string, limit: number = HELP_MESSAGE_LIMIT): string[] {
  const messages: string[] = [];
  let current = "";
  const flush = () => {
    if (current) {
      messages.push(current);
      current = "";
    }
  };
  for (const line of text.split("\n")) {
    if (line.length > limit) {
      flush();
      for (let i = 0; i < line.length; i += limit) messages.push(line.slice(i, i + limit));
      continue;
    }
    if (current && current.length + 1 + line.length > limit) flush();
    current = current ? `${current}\n${line}` : line;
  }
  flush();
  return messages;
}

export const commands: Command[] = [
  {
    name: "help",
    description: "List all commands, grouped by category",
    aliases: ["h", "commands"],
    args: [{ name: "category", type: "string" }],
    async execute(inv) {
      const { HELP_GROUPS } = await import("./index.js");
      const category = inv.options.getString("category");
      const groups = category
        ? HELP_GROUPS.filter((g) => g.category.toLowerCase() === category.toLowerCase())
        : HELP_GROUPS;
      if (category && groups.length === 0) {
        const known = HELP_GROUPS.map((g) => g.category).join(", ");
        await inv.reply({
          embeds: [errorEmbed(`Unknown category "${category}". Categories: ${known}`).toJSON()],
          ephemeral: true,
        });
        return;
      }
      // OwO-style plain text, no embed box: one grouped list, same
      // commands + aliases as before, just as text lines — split across
      // messages so no single reply exceeds Discord's 2000-char cap.
      const lines: string[] = [category ? `Help — ${groups[0]!.category}` : "uwu — all commands", ""];
      for (const group of groups) {
        lines.push(group.category);
        for (const c of group.commands) {
          const aliasText = c.aliases.length > 0 ? ` (${c.aliases.join(", ")})` : "";
          lines.push(`\`uwu ${c.name}\`${aliasText} — ${c.description}`);
        }
        lines.push("");
      }
      const messages = splitHelpMessage(lines.join("\n").trimEnd());
      await inv.reply({ content: messages[0], ephemeral: true });
      for (const rest of messages.slice(1)) {
        await inv.followUp({ content: rest, ephemeral: true });
      }
    },
  },
];
