import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  SlashCommandBuilder,
} from "discord.js";
import {
  errorEmbed,
  selenaEmbed,
  type Command,
  type CommandContext,
} from "../lib/command.js";
import {
  RARITY_WEIGHTS,
  collectionSummary,
  doRoll,
  gachaLeaderboard,
  getGachaState,
  loadGachaCards,
  ownsCard,
  swapCards,
  type GachaCard,
  type Rarity,
} from "../lib/gacha.js";

/**
 * Gacha commands: /roll, /collection, /trade, /gacha-leaderboard.
 *
 * Odds (shown in /roll): Common 60 / Rare 25 / Epic 11 / Legendary 4.
 * Rolls are free, 1-hour cooldown per user, pity guarantees Epic+ after
 * 10 rolls without Epic or better. Trades are immediate two-way swaps
 * performed only when the other user confirms via button.
 */

const RARITY_EMOJI: Record<Rarity | "Unknown", string> = {
  Common: "⚪",
  Rare: "🔵",
  Epic: "🟣",
  Legendary: "🟡",
  Unknown: "❔",
};

const RARITY_ORDER: Array<Rarity | "Unknown"> = ["Legendary", "Epic", "Rare", "Common", "Unknown"];

function oddsText(): string {
  return `Odds — ${RARITY_WEIGHTS.map(([r, w]) => `${r} ${w}`).join(" / ")} (out of 100). Pity: Epic+ guaranteed after 10 rolls without Epic or better. Cooldown: 1 hour.`;
}

function cardLabel(card: GachaCard): string {
  return card.skin ? `${card.name} — ${card.skin}` : card.name;
}

/** discord.js narrows the builder type once options/subcommands are added; cast back to the scaffold's SlashCommandBuilder. */
function d<T>(builder: T): SlashCommandBuilder {
  return builder as unknown as SlashCommandBuilder;
}

export const commands: Command[] = [
  {
    data: d(new SlashCommandBuilder()
      .setName("roll")
      .setDescription("Roll for a hero/skin card (free, 1-hour cooldown)")),
    execute: async (interaction, ctx) => {
      const cards = await loadGachaCards();
      if (cards.length === 0) {
        await interaction.reply({
          embeds: [
            errorEmbed("Gacha cards aren't configured yet — no hero cards are loaded. Ask staff to add the card catalogue.").toJSON(),
          ],
          ephemeral: true,
        });
        return;
      }
      const state = await getGachaState(ctx.db, ctx.guildId, interaction.user.id);
      const r = await doRoll(ctx.db, ctx.guildId, interaction.user.id, cards);
      if (!r.ok) {
        await interaction.reply({ embeds: [errorEmbed(r.error).toJSON()], ephemeral: true });
        return;
      }
      void state;
      const embed = selenaEmbed(
        `${RARITY_EMOJI[r.rarity]} ${cardLabel(r.card)}`,
        `**${r.rarity}** card!\n${r.card.skin ? `Skin: ${r.card.skin}\n` : ""}Rolls: ${r.totalRolls} • Pity counter: ${r.pity}/10`,
      ).addFields({ name: "Odds", value: oddsText() });
      await interaction.reply({ embeds: [embed.toJSON()] });
    },
  },
  {
    data: d(new SlashCommandBuilder()
      .setName("collection")
      .setDescription("Show a card collection, grouped by rarity")
      .addUserOption((o) => o.setName("user").setDescription("Whose collection (defaults to you)").setRequired(false))),
    execute: async (interaction, ctx) => {
      const target = interaction.options.getUser("user") ?? interaction.user;
      const cards = await loadGachaCards();
      const summary = await collectionSummary(ctx.db, ctx.guildId, target.id, cards);
      if (summary.totalDistinct === 0) {
        await interaction.reply({
          embeds: [
            selenaEmbed(
              `Collection — ${target.username}`,
              "No cards yet. Use /roll to pull your first card!",
            ).toJSON(),
          ],
        });
        return;
      }
      const lines: string[] = [
        `${summary.totalDistinct} distinct card(s) • ${summary.totalCards} total`,
        "",
      ];
      for (const rarity of RARITY_ORDER) {
        const entries = summary.byRarity[rarity];
        if (!entries || entries.length === 0) continue;
        lines.push(
          `**${RARITY_EMOJI[rarity]} ${rarity}** (${entries.length})`,
          ...entries.map((e) => `• ${e.name} ×${e.count}`),
          "",
        );
      }
      await interaction.reply({
        embeds: [selenaEmbed(`Collection — ${target.username}`, lines.join("\n").trimEnd()).toJSON()],
      });
    },
  },
  {
    data: d(new SlashCommandBuilder()
      .setName("trade")
      .setDescription("Propose a card trade with another user")
      .addUserOption((o) => o.setName("user").setDescription("Who to trade with").setRequired(true))
      .addStringOption((o) => o.setName("card-id").setDescription("Your card's id").setRequired(true))
      .addStringOption((o) => o.setName("their-card-id").setDescription("Their card's id").setRequired(true))),
    execute: async (interaction, ctx) => {
      const target = interaction.options.getUser("user");
      const cardA = (interaction.options.getString("card-id") ?? "").trim();
      const cardB = (interaction.options.getString("their-card-id") ?? "").trim();
      if (!target) {
        await interaction.reply({ embeds: [errorEmbed("Pick a user to trade with.").toJSON()], ephemeral: true });
        return;
      }
      if (target.id === interaction.user.id) {
        await interaction.reply({ embeds: [errorEmbed("You can't trade with yourself.").toJSON()], ephemeral: true });
        return;
      }
      if (!cardA || !cardB) {
        await interaction.reply({ embeds: [errorEmbed("Both card ids are required.").toJSON()], ephemeral: true });
        return;
      }
      if (!await ownsCard(ctx.db, ctx.guildId, interaction.user.id, cardA)) {
        await interaction.reply({
          embeds: [errorEmbed(`You don't own card \`${cardA}\` — check /collection for your card ids.`).toJSON()],
          ephemeral: true,
        });
        return;
      }
      if (!await ownsCard(ctx.db, ctx.guildId, target.id, cardB)) {
        await interaction.reply({
          embeds: [errorEmbed(`<@${target.id}> doesn't own card \`${cardB}\`.`).toJSON()],
          ephemeral: true,
        });
        return;
      }
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(
            `selena:trade:accept:${interaction.user.id}:${target.id}:${encodeURIComponent(cardA)}:${encodeURIComponent(cardB)}`,
          )
          .setLabel("✅ Accept trade")
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(
            `selena:trade:decline:${interaction.user.id}:${target.id}:${encodeURIComponent(cardA)}:${encodeURIComponent(cardB)}`,
          )
          .setLabel("❌ Decline")
          .setStyle(ButtonStyle.Danger),
      );
      const embed = selenaEmbed(
        "Trade proposal",
        `<@${interaction.user.id}> offers \`${cardA}\` for <@${target.id}>'s \`${cardB}\`.\n\n<@${target.id}>, tap **Accept trade** to swap, or **Decline** to pass.`,
      );
      await interaction.reply({ embeds: [embed.toJSON()], components: [row] });
    },
  },
  {
    data: d(new SlashCommandBuilder()
      .setName("gacha-leaderboard")
      .setDescription("Top card collectors in this server")),
    execute: async (interaction, ctx) => {
      const board = await gachaLeaderboard(ctx.db, ctx.guildId, 10);
      if (board.length === 0) {
        await interaction.reply({
          embeds: [selenaEmbed("Gacha leaderboard", "Nobody owns any cards yet — be the first with /roll!").toJSON()],
        });
        return;
      }
      await interaction.reply({
        embeds: [
          selenaEmbed(
            "🏆 Gacha leaderboard",
            board
              .map((e, i) => `${i + 1}. <@${e.userId}> — ${e.distinctCards} distinct • ${e.totalCards} total`)
              .join("\n"),
          ).toJSON(),
        ],
      });
    },
  },
];

export const buttonHandlers: Record<
  string,
  (interaction: any, ctx: CommandContext) => Promise<void>
> = {
  "selena:trade": async (interaction, ctx) => {
    const parts = String(interaction.customId ?? "").split(":");
    // selena:trade:accept|decline:<offererId>:<targetId>:<cardA>:<cardB>
    const action = parts[2];
    const offererId = parts[3];
    const targetId = parts[4];
    const cardA = parts[5] ? decodeURIComponent(parts[5]) : "";
    const cardB = parts[6] ? decodeURIComponent(parts[6]) : "";
    if ((action !== "accept" && action !== "decline") || !offererId || !targetId || !cardA || !cardB) {
      await interaction.reply({ content: "That trade button is malformed.", ephemeral: true });
      return;
    }
    if (interaction.user.id !== targetId) {
      await interaction.reply({
        content: `Only <@${targetId}> can answer this trade.`,
        ephemeral: true,
      });
      return;
    }
    if (action === "decline") {
      await interaction.reply({
        content: `❌ <@${targetId}> declined the trade (${cardA} ↔ ${cardB}). Nothing changed.`,
        ephemeral: true,
      });
      return;
    }
    const r = await swapCards(ctx.db, ctx.guildId, offererId, cardA, targetId, cardB);
    if (!r.ok) {
      await interaction.reply({ content: `Trade failed: ${r.error}`, ephemeral: true });
      return;
    }
    await interaction.reply({
      content: `✅ Trade complete! <@${offererId}> gave \`${cardA}\` and received \`${cardB}\`; <@${targetId}> gave \`${cardB}\` and received \`${cardA}\`.`,
      ephemeral: true,
    });
  },
};

export const modalHandlers: Record<
  string,
  (interaction: any, ctx: CommandContext) => Promise<void>
> = {};
