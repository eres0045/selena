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
    data: buildCmd("balance", "Show your uwu points balance (or another member's).", (b) => {
      b.addUserOption((o) => o.setName("user").setDescription("Whose balance to show").setRequired(false));
    }),
    async execute(interaction, ctx) {
      const target = interaction.options.getUser("user") ?? interaction.user;
      const bal = await getBalance(ctx.db, ctx.guildId, target.id);
      // OwO-style: one plain line, no embed box, no emoji — the mention +
      // points with XP/level inline, so nothing is lost.
      await interaction.reply({
        content: `Hey <@${target.id}>, you currently have ${fmt(bal.points)} points! (${fmt(bal.xp)} XP · Level ${bal.level})`,
      });
    },
  },
  {
    data: buildCmd("daily", "Claim your daily 100 points. One claim per 24 hours.", () => {}),
    async execute(interaction, ctx) {
      const result = await claimDaily(ctx.db, ctx.guildId, interaction.user.id, Date.now());
      if (!result.ok) {
        const sec = Math.floor((result.nextAvailableAt ?? Date.now()) / 1000);
        await replyError(
          interaction,
          `You already claimed your daily points. Come back <t:${sec}:R> (next claim <t:${sec}:t>).`,
        );
        return;
      }
      const bal = await getBalance(ctx.db, ctx.guildId, interaction.user.id);
      await interaction.reply({
        embeds: [
          pointsEmbed(
            emoji("gift") + " Daily Reward",
            `${emoji("coin")} You claimed **${fmt(result.amount ?? 100)} points**!\nYour balance is now **${fmt(bal.points)} points**. Come back tomorrow for more.`,
          ).toJSON(),
        ],
      });
    },
  },
  {
    data: buildCmd("give", "Give some of your points to another member.", (b) => {
      b.addUserOption((o) => o.setName("user").setDescription("Who to give points to").setRequired(true));
      b.addIntegerOption((o) =>
        o.setName("amount").setDescription("How many points to give").setRequired(true).setMinValue(1),
      );
    }),
    async execute(interaction, ctx) {
      const target = interaction.options.getUser("user");
      const amount = interaction.options.getInteger("amount");
      if (!target) {
        await replyError(interaction, "Please choose a member to give points to.");
        return;
      }
      if (amount === null || !Number.isInteger(amount) || amount <= 0) {
        await replyError(interaction, "Amount must be a positive whole number.");
        return;
      }
      if (target.id === interaction.user.id) {
        await replyError(interaction, "You cannot give points to yourself.");
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
            "🤝 Points Sent",
            `<@${interaction.user.id}> gave **${fmt(amount)} points** to <@${target.id}>.\n\nYour balance: **${fmt(senderBal.points)}** · ${target.username}'s balance: **${fmt(receiverBal.points)}**`,
          ).toJSON(),
        ],
      });
    },
  },
  {
    data: buildCmd("leaderboard", "Show the top 10 points holders in this server.", () => {}),
    async execute(interaction, ctx) {
      const top = await getLeaderboard(ctx.db, ctx.guildId, 10);
      if (top.length === 0) {
        await interaction.reply({
          embeds: [selenaEmbed(emoji("trophy") + " Leaderboard", "Nobody has any points yet. Claim your `/daily` to get started!").toJSON()],
        });
        return;
      }
      const medals = ["🥇", "🥈", "🥉"];
      const lines = top.map(
        (e, i) => `${medals[i] ?? `${i + 1}.`} <@${e.userId}> — **${fmt(e.points)}** points (Level ${e.level})`,
      );
      await interaction.reply({
        embeds: [selenaEmbed(emoji("trophy") + " Points Leaderboard", lines.join("\n")).toJSON()],
      });
    },
  },
];
