import type { Command, CommandInvocation } from "../lib/command.js";
import { emoji } from "../lib/emoji.js";
import { errorEmbed, fmt, pointsEmbed, resolveDisplayNames } from "../lib/command.js";
import { claimDaily, getBalance, getLeaderboard, transferPoints } from "../lib/economy.js";

async function replyError(inv: CommandInvocation, message: string): Promise<void> {
  await inv.reply({ embeds: [errorEmbed(message).toJSON()], ephemeral: true });
}

export const commands: Command[] = [
  {
    name: "balance",
    description: "Show your uwu gold balance (or another member's).",
    aliases: ["bal", "money", "wallet"],
    args: [{ name: "user", type: "user" }],
    async execute(inv, ctx) {
      const target = inv.options.getUser("user") ?? inv.user;
      const bal = await getBalance(ctx.db, ctx.guildId, target.id);
      // OwO-style: one plain line, no embed box — the mention, then the
      // coin right before the amount like a currency symbol, gold with
      // XP/level inline, so nothing is lost.
      await inv.reply({
        content: `Hey <@${target.id}>, you currently have ${emoji("gold")} ${fmt(bal.points)} gold! (${fmt(bal.xp)} XP · Level ${bal.level})`,
      });
    },
  },
  {
    name: "daily",
    description: "Claim your daily 100 gold. One claim per 24 hours.",
    aliases: ["claim"],
    async execute(inv, ctx) {
      const result = await claimDaily(ctx.db, ctx.guildId, inv.user.id, Date.now());
      if (!result.ok) {
        const sec = Math.floor((result.nextAvailableAt ?? Date.now()) / 1000);
        await replyError(
          inv,
          `You already claimed your daily gold. Come back <t:${sec}:R> (next claim <t:${sec}:t>).`,
        );
        return;
      }
      const bal = await getBalance(ctx.db, ctx.guildId, inv.user.id);
      await inv.reply({
        embeds: [
          pointsEmbed(
            emoji("gift") + " Daily Reward",
            `${emoji("gold")} You claimed **${fmt(result.amount ?? 100)} gold**!\nYour balance is now **${fmt(bal.points)} gold**. Come back tomorrow for more.`,
          ).toJSON(),
        ],
      });
    },
  },
  {
    name: "give",
    description: "Give some of your gold to another member.",
    aliases: ["pay", "send", "transfer"],
    args: [{ name: "user", type: "user", required: true }, { name: "amount", type: "integer", required: true }],
    async execute(inv, ctx) {
      const target = inv.options.getUser("user");
      const amount = inv.options.getInteger("amount");
      if (!target) {
        await replyError(inv, "Please choose a member to give gold to.");
        return;
      }
      if (amount === null || !Number.isInteger(amount) || amount <= 0) {
        await replyError(inv, "Amount must be a positive whole number.");
        return;
      }
      if (target.id === inv.user.id) {
        await replyError(inv, "You cannot give gold to yourself.");
        return;
      }
      const result = await transferPoints(ctx.db, ctx.guildId, inv.user.id, target.id, amount);
      if (!result.ok) {
        await replyError(inv, result.error ?? "Transfer failed.");
        return;
      }
      const senderBal = await getBalance(ctx.db, ctx.guildId, inv.user.id);
      const receiverBal = await getBalance(ctx.db, ctx.guildId, target.id);
      // OwO-style plain text, no embed box.
      await inv.reply({
        content:
          `🤝 Gold Sent\n<@${inv.user.id}> gave ${emoji("gold")} ${fmt(amount)} gold to <@${target.id}>.\n` +
          `Your balance: ${fmt(senderBal.points)} gold · ${target.username}'s balance: ${fmt(receiverBal.points)} gold`,
      });
    },
  },
  {
    name: "leaderboard",
    description: "Show the top 10 gold holders in this server.",
    aliases: ["lb", "top", "rich"],
    async execute(inv, ctx) {
      const top = await getLeaderboard(ctx.db, ctx.guildId, 10);
      if (top.length === 0) {
        // OwO-style plain text, no embed box.
        await inv.reply({
          content: `${emoji("trophy")} Leaderboard\nNobody has any gold yet. Claim your \`uwu daily\` to get started!`,
        });
        return;
      }
      const medals = ["🥇", "🥈", "🥉"];
      // Plain display names, never <@id> mentions — a leaderboard anyone can
      // see must not ping the people on it every time it is viewed.
      const names = await resolveDisplayNames(inv, top.map((e) => e.userId));
      const lines = top.map(
        (e, i) => `${medals[i] ?? `${i + 1}.`} ${names[i]} — ${fmt(e.points)} gold (Level ${e.level})`,
      );
      await inv.reply({
        content: `${emoji("trophy")} Gold Leaderboard\n${lines.join("\n")}`,
      });
    },
  },
];
