// ---------------------------------------------------------------------------
// TEMPORARY COMMAND (added 2026-11-07) — REMOVE AFTER THE CASINO VISUAL TEST.
// Owner-only test-points grant so Ronit (the server owner) can fund test
// play (999999 points) while the reverted small casino visuals are being
// verified live. There is no admin grant otherwise — points normally come
// from /daily, /give, or game wins, and Ronit's balance hit 0 during
// testing. Removal: delete this file, its registry entries in
// src/commands/index.ts (import, CATEGORY_LABELS, MODULES), and
// test/grantpoints.test.ts, then re-run the suite and redeploy.
// ---------------------------------------------------------------------------
import { SlashCommandBuilder } from "discord.js";
import type { Command } from "../lib/command.js";
import { errorEmbed, fmt, pointsEmbed } from "../lib/command.js";
import { addPoints } from "../lib/economy.js";

async function replyError(interaction: Parameters<Command["execute"]>[0], message: string): Promise<void> {
  await interaction.reply({ embeds: [errorEmbed(message).toJSON()], ephemeral: true });
}

/**
 * Build a SlashCommandBuilder without chaining add*Option calls onto the
 * `data:` expression: chaining narrows the type to
 * SlashCommandOptionsOnlyBuilder, which is not assignable to the
 * SlashCommandBuilder type the Command interface requires.
 */
function buildCmd(name: string, description: string, configure: (b: SlashCommandBuilder) => void): SlashCommandBuilder {
  const b = new SlashCommandBuilder().setName(name).setDescription(description);
  configure(b);
  return b;
}

/**
 * Resolve the server owner id for the owner-only guard. Prefers the
 * cached guild on the interaction; falls back to a fetch when the cache
 * misses. Returns null when the owner cannot be determined — the guard
 * fails CLOSED in that case (no points move).
 */
async function resolveOwnerId(interaction: Parameters<Command["execute"]>[0]): Promise<string | null> {
  if (interaction.guild?.ownerId) return interaction.guild.ownerId;
  if (!interaction.guildId) return null;
  try {
    const fetched = await interaction.client.guilds.fetch(interaction.guildId);
    return fetched?.ownerId ?? null;
  } catch {
    return null;
  }
}

export const commands: Command[] = [
  {
    data: buildCmd("grantpoints", "TEMPORARY owner-only: grant test points.", (b) => {
      b.addIntegerOption((o) =>
        o.setName("amount").setDescription("How many points to grant").setRequired(true).setMinValue(1),
      );
      b.addUserOption((o) => o.setName("user").setDescription("Who gets the points (default: you)").setRequired(false));
    }),
    async execute(interaction, ctx) {
      const ownerId = await resolveOwnerId(interaction);
      if (!ownerId || interaction.user.id !== ownerId) {
        await replyError(interaction, "This command is owner-only.");
        return;
      }
      const amount = interaction.options.getInteger("amount");
      const target = interaction.options.getUser("user") ?? interaction.user;
      if (amount === null || !Number.isInteger(amount) || amount <= 0) {
        await replyError(interaction, "Amount must be a positive whole number.");
        return;
      }
      const newBalance = await addPoints(ctx.db, ctx.guildId, target.id, amount, "grant-test");
      await interaction.reply({
        embeds: [
          pointsEmbed(
            "🎁 Test Points Granted",
            `<@${target.id}> received **${fmt(amount)} points**.\n\nNew balance: **${fmt(newBalance)} points**.`,
          ).toJSON(),
        ],
      });
    },
  },
];
