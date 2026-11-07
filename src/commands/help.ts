import type { Command, CommandInvocation } from "../lib/command.js";
import { errorEmbed } from "../lib/command.js";

// HELP_GROUPS lives in the registry (./index.js), which imports this file —
// so it is loaded lazily inside execute() instead of at module top level.
// A static import here would create a circular import and crash with a
// TDZ error whenever help.ts is imported before index.ts.

export const buttonHandlers: Record<string, (...args: never[]) => Promise<void>> = {};
export const modalHandlers: Record<string, (...args: never[]) => Promise<void>> = {};

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
      // commands + aliases as before, just as text lines.
      const lines: string[] = [category ? `Help — ${groups[0]!.category}` : "uwu — all commands", ""];
      for (const group of groups) {
        lines.push(group.category);
        for (const c of group.commands) {
          const aliasText = c.aliases.length > 0 ? ` (${c.aliases.join(", ")})` : "";
          lines.push(`\`uwu ${c.name}\`${aliasText} — ${c.description}`);
        }
        lines.push("");
      }
      await inv.reply({ content: lines.join("\n").trimEnd(), ephemeral: true });
    },
  },
];
