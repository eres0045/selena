import { SlashCommandBuilder } from "discord.js";
import type { Command } from "../lib/command.js";
import { errorEmbed, selenaEmbed } from "../lib/command.js";

/** Build a slash-command definition without the discord.js chained-builder
 * narrowing (chaining .addXOption() narrows SlashCommandBuilder to
 * SlashCommandOptionsOnlyBuilder, which Command.data rejects). */
function build(name: string, description: string, add: (b: SlashCommandBuilder) => void): SlashCommandBuilder {
  const b = new SlashCommandBuilder().setName(name).setDescription(description);
  add(b);
  return b;
}

// HELP_GROUPS lives in the registry (./index.js), which imports this file —
// so it is loaded lazily inside execute() instead of at module top level.
// A static import here would create a circular import and crash with a
// TDZ error whenever help.ts is imported before index.ts.

export const buttonHandlers: Record<string, (...args: never[]) => Promise<void>> = {};
export const modalHandlers: Record<string, (...args: never[]) => Promise<void>> = {};

export const commands: Command[] = [
  {
    data: build("help", "List all commands, grouped by category", (b) => {
      b.addStringOption((o) => o.setName("category").setDescription("Show only one category"));
    }),
    async execute(interaction) {
      const { HELP_GROUPS } = await import("./index.js");
      const category = interaction.options.getString("category");
      const groups = category
        ? HELP_GROUPS.filter((g) => g.category.toLowerCase() === category.toLowerCase())
        : HELP_GROUPS;
      if (category && groups.length === 0) {
        const known = HELP_GROUPS.map((g) => g.category).join(", ");
        await interaction.reply({
          embeds: [errorEmbed(`Unknown category "${category}". Categories: ${known}`).toJSON()],
          ephemeral: true,
        });
        return;
      }
      const embed = selenaEmbed(category ? `Help — ${groups[0]!.category}` : "uwu — all commands");
      for (const group of groups) {
        embed.addFields({
          name: group.category,
          value: group.commands.map((c) => `\`/${c.name}\` — ${c.description}`).join("\n"),
          inline: false,
        });
      }
      await interaction.reply({ embeds: [embed.toJSON()], ephemeral: true });
    },
  },
];
