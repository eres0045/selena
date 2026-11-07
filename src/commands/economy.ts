import { SlashCommandBuilder } from "discord.js";
import type { Command } from "../lib/command.js";
import { emoji } from "../lib/emoji.js";
import { errorEmbed, fmt, pointsEmbed, selenaEmbed } from "../lib/command.js";
import { claimDaily, getBalance, getLeaderboard, transferPoints } from "../lib/economy.js";

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

export const commands: Command[] = [
  {
    data: buildCmd("balance", "Show your uwu gold balance (or another member's).", (b) => {
      b.addUserOption((o) => o.setName("user").setDescription("Whose balance to show").setRequired(false));
    }),
    async execute(interaction, ctx) {
      const target = interaction.options.getUser("user") ?? interaction.user;
      const bal = await getBalance(ctx.db, ctx.guildId, target.id);
      // OwO-style: one plain line, no embed box — the mention, then the
      // coin right before the amount like a currency symbol, gold with
      // XP/level inline, so nothing is lost.
      await interaction.reply({
        content: `Hey <@${target.id}>, you currently have ${emoji("coin")} ${fmt(bal.points)} gold! (${fmt(bal.xp)} XP · Level ${bal.level})`,
      });
    },
  },
  {
    data: buildCmd("daily", "Claim your daily 100 gold. One claim per 24 hours.", () => {}),
    async execute(interaction, ctx) {
      const result = await claimDaily(ctx.db, ctx.guildId, interaction.user.id, Date.now());
      if (!result.ok) {
        const sec = Math.floor((result.nextAvailableAt ?? Date.now()) / 1000);
        await replyError(
          interaction,
          `You already claimed your daily gold. Come back <t:${sec}:R> (next claim <t:${sec}:t>).`,
        );
        return;
      }
      const bal = await getBalance(ctx.db, ctx.guildId, interaction.user.id);
      await interaction.reply({
        embeds: [
          pointsEmbed(
            emoji("gift") + " Daily Reward",
            `${emoji("coin")} You claimed **${fmt(result.amount ?? 100)} gold**!\nYour balance is now **${fmt(bal.points)} gold**. Come back tomorrow for more.`,
          ).toJSON(),
        ],
      });
    },
  },
  {
    data: buildCmd("give", "Give some of your gold to another member.", (b) => {
      b.addUserOption((o) => o.setName("user").setDescription("Who to give gold to").setRequired(true));
      b.addIntegerOption((o) =>
        o.setName("amount").setDescription("How many gold to give").setRequired(true).setMinValue(1),
      );
    }),
    async execute(interaction, ctx) {
      const target = interaction.options.getUser("user");
      const amount = interaction.options.getInteger("amount");
      if (!target) {
        await replyError(interaction, "Please choose a member to give gold to.");
        return;
      }
      if (amount === null || !Number.isInteger(amount) || amount <= 0) {
        await replyError(interaction, "Amount must be a positive whole number.");
        return;
      }
      if (target.id === interaction.user.id) {
        await replyError(interaction, "You cannot give gold to yourself.");
        return;
      }
      const result = await transferPoints(ctx.db, ctx.guildId, interaction.user.id, target.id, amount);
      if (!result.ok) {
        await replyError(interaction, result.error ?? "Transfer failed.");
        return;
      }
      const senderBal = await getBalance(ctx.db, ctx.guildId, interaction.user.id);
      const receiverBal = await getBalance(ctx.db, ctx.guildId, target.id);
      await interaction.reply({
        embeds: [
          pointsEmbed(
            "🤝 Gold Sent",
            `<@${interaction.user.id}> gave **${fmt(amount)} gold** to <@${target.id}>.\n\nYour balance: **${fmt(senderBal.points)}** · ${target.username}'s balance: **${fmt(receiverBal.points)}**`,
          ).toJSON(),
        ],
      });
    },
  },
  {
    data: buildCmd("leaderboard", "Show the top 10 gold holders in this server.", () => {}),
    async execute(interaction, ctx) {
      const top = await getLeaderboard(ctx.db, ctx.guildId, 10);
      if (top.length === 0) {
        await interaction.reply({
          embeds: [selenaEmbed(emoji("trophy") + " Leaderboard", "Nobody has any gold yet. Claim your `/daily` to get started!").toJSON()],
        });
        return;
      }
      const medals = ["🥇", "🥈", "🥉"];
      const lines = top.map(
        (e, i) => `${medals[i] ?? `${i + 1}.`} <@${e.userId}> — **${fmt(e.points)}** gold (Level ${e.level})`,
      );
      await interaction.reply({
        embeds: [selenaEmbed(emoji("trophy") + " Gold Leaderboard", lines.join("\n")).toJSON()],
      });
    },
  },
];
