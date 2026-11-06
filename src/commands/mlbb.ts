/**
 * MLBB commands for Selena. Each execute() is a thin adapter over the
 * pure functions in ../lib/mlbb.js — no business logic lives here.
 *
 * Embeds are sent as plain APIEmbed JSON (embed.toJSON()) so both real
 * discord.js and the FakeChatInput test harness can read them.
 *
 * /rankrole note: role lookup is by name in the guild and assignment uses
 * the real GuildMember API when available. The FakeChatInput harness has
 * no guild/member mocks, so in tests the role is reported as not found;
 * the code guards every guild/member access with optional chaining.
 */
import { SlashCommandBuilder } from "discord.js";
import {
  errorEmbed,
  selenaEmbed,
  type Command,
} from "../lib/command.js";
import {
  MLBB_RANKS,
  SNAPSHOT_NOTE,
  VERIFICATION_NOTE,
  confirmVerification,
  counterLookup,
  getProfile,
  getTopHeroCards,
  heroLookup,
  registerProfile,
  startVerification,
} from "../lib/mlbb.js";

function rate(value: number | undefined): string {
  return typeof value === "number" ? `${value.toFixed(1)}%` : "—";
}

function listOrDash(values: string[] | undefined): string {
  return values && values.length > 0 ? values.join(", ") : "—";
}

const heroData = new SlashCommandBuilder()
  .setName("hero")
  .setDescription("Look up an MLBB hero (static snapshot, not live data).");
heroData.addStringOption((o) =>
  o.setName("name").setDescription("Hero name (e.g. Miya)").setRequired(true),
);

const heroCommand: Command = {
  data: heroData,
  async execute(interaction, _ctx) {
    const query = interaction.options.getString("name");
    if (!query || !query.trim()) {
      await interaction.reply({
        embeds: [errorEmbed("Give a hero name, e.g. `/hero Miya`.").toJSON()],
      });
      return;
    }
    const hero = heroLookup(query);
    if (!hero) {
      await interaction.reply({
        embeds: [
          errorEmbed(
            `Unknown hero "${query}". Check the spelling — Selena only knows the heroes in her static snapshot.`,
          ).toJSON(),
        ],
      });
      return;
    }
    const embed = selenaEmbed(`${hero.name} — ${hero.role}`, hero.description)
      .addFields(
        { name: "Role", value: hero.role, inline: true },
        { name: "Lane", value: hero.lane, inline: true },
        { name: "Tier", value: hero.tier ?? "—", inline: true },
        { name: "Win rate", value: rate(hero.winRate), inline: true },
        { name: "Pick rate", value: rate(hero.pickRate), inline: true },
        { name: "Ban rate", value: rate(hero.banRate), inline: true },
        { name: "Strong against", value: listOrDash(hero.counters) },
        { name: "Countered by", value: listOrDash(hero.counteredBy) },
        { name: "Suggested build", value: listOrDash(hero.build) },
      )
      .setFooter({
        text: `${SNAPSHOT_NOTE} Counters and builds are community knowledge, not official data.`,
      });
    await interaction.reply({ embeds: [embed.toJSON()] });
  },
};

const counterData = new SlashCommandBuilder()
  .setName("counter")
  .setDescription("See who counters an MLBB hero, and who they counter.");
counterData.addStringOption((o) =>
  o.setName("hero").setDescription("Hero name (e.g. Fanny)").setRequired(true),
);

const counterCommand: Command = {
  data: counterData,
  async execute(interaction, _ctx) {
    const query = interaction.options.getString("hero");
    if (!query || !query.trim()) {
      await interaction.reply({
        embeds: [errorEmbed("Give a hero name, e.g. `/counter Fanny`.").toJSON()],
      });
      return;
    }
    const result = counterLookup(query);
    if (!result) {
      await interaction.reply({
        embeds: [
          errorEmbed(
            `Unknown hero "${query}". Check the spelling — Selena only knows the heroes in her static snapshot.`,
          ).toJSON(),
        ],
      });
      return;
    }
    const embed = selenaEmbed(
      `${result.hero.name} — Counters`,
      `${result.hero.name} is a ${result.hero.role} (${result.hero.lane}).`,
    )
      .addFields(
        {
          name: `Counters ${result.hero.name}`,
          value:
            result.counteredBy.length > 0
              ? result.counteredBy.map((h) => h.name).join(", ")
              : "—",
        },
        {
          name: `${result.hero.name} counters`,
          value:
            result.counters.length > 0 ? result.counters.map((h) => h.name).join(", ") : "—",
        },
      )
      .setFooter({
        text: `${SNAPSHOT_NOTE} Matchups are community knowledge, not official data.`,
      });
    await interaction.reply({ embeds: [embed.toJSON()] });
  },
};

const registerData = new SlashCommandBuilder()
  .setName("register-mlbb")
  .setDescription("Register your MLBB account with Selena (unverified until you verify).");
registerData.addStringOption((o) =>
  o.setName("mlbb-id").setDescription("Your MLBB ID (numbers)").setRequired(true),
);
registerData.addStringOption((o) =>
  o.setName("ign").setDescription("Your in-game name").setRequired(true),
);

const registerCommand: Command = {
  data: registerData,
  async execute(interaction, ctx) {
    const mlbbId = interaction.options.getString("mlbb-id");
    const ign = interaction.options.getString("ign");
    if (!mlbbId?.trim() || !ign?.trim()) {
      await interaction.reply({
        embeds: [errorEmbed("Both an MLBB ID and an IGN are required.").toJSON()],
      });
      return;
    }
    try {
      registerProfile(ctx.db, ctx.guildId, interaction.user.id, mlbbId, ign);
      const { code, expiresAt } = startVerification(ctx.db, ctx.guildId, interaction.user.id);
      const embed = selenaEmbed(
        "MLBB profile registered",
        `**IGN:** ${ign.trim()}\n**MLBB ID:** ${mlbbId.trim()}\n\n` +
          `Your verification code is **${code}** — it expires <t:${Math.floor(expiresAt / 1000)}:R> (10 minutes).\n` +
          `Confirm it with \`/verify-mlbb ${code}\`.\n\n` +
          `Verification here is a local code check, not a Moonton-backed check: Selena issued this code in this reply and you confirm it back. ` +
          `Note that even MLBB's own app reviews report verify codes often not arriving — if a code doesn't work, just re-register for a fresh one.`,
      ).setFooter({ text: VERIFICATION_NOTE });
      await interaction.reply({ embeds: [embed.toJSON()], ephemeral: true });
    } catch (err) {
      await interaction.reply({
        embeds: [
          errorEmbed(err instanceof Error ? err.message : "Could not register your profile.").toJSON(),
        ],
      });
    }
  },
};

const verifyData = new SlashCommandBuilder()
  .setName("verify-mlbb")
  .setDescription("Verify your MLBB profile with the code from /register-mlbb.");
verifyData.addStringOption((o) =>
  o.setName("code").setDescription("The 6-digit verification code").setRequired(true),
);

const verifyCommand: Command = {
  data: verifyData,
  async execute(interaction, ctx) {
    const code = interaction.options.getString("code");
    if (!code?.trim()) {
      await interaction.reply({
        embeds: [errorEmbed("Give the 6-digit code from /register-mlbb.").toJSON()],
      });
      return;
    }
    const result = confirmVerification(
      ctx.db,
      ctx.guildId,
      interaction.user.id,
      code.trim(),
      Date.now(),
    );
    if (!result.ok) {
      await interaction.reply({
        embeds: [errorEmbed(result.error ?? "Verification failed.").toJSON()],
      });
      return;
    }
    await interaction.reply({
      embeds: [
        selenaEmbed(
          "Verified!",
          "Your MLBB profile is now marked verified. This is a local code check only — Moonton did not validate anything.",
        ).toJSON(),
      ],
    });
  },
};

const profileData = new SlashCommandBuilder()
  .setName("mlbbprofile")
  .setDescription("Show an MLBB profile: IGN, MLBB ID, verification, rank, top heroes.");
profileData.addUserOption((o) =>
  o.setName("user").setDescription("Whose profile to show (default: you)"),
);

const profileCommand: Command = {
  data: profileData,
  async execute(interaction, ctx) {
    const target = interaction.options.getUser("user") ?? interaction.user;
    const profile = getProfile(ctx.db, ctx.guildId, target.id);
    if (!profile) {
      await interaction.reply({
        embeds: [
          errorEmbed(
            `${target.username} has no MLBB profile yet. Use /register-mlbb to create one.`,
          ).toJSON(),
        ],
      });
      return;
    }
    const top = getTopHeroCards(ctx.db, ctx.guildId, target.id);
    const embed = selenaEmbed(
      `${target.username}'s MLBB profile`,
      profile.ign ? `Playing as **${profile.ign}**` : undefined,
    ).addFields(
      { name: "IGN", value: profile.ign ?? "—", inline: true },
      { name: "MLBB ID", value: profile.mlbbId, inline: true },
      {
        name: "Status",
        value: profile.verified ? "✅ Verified" : "⚠️ Not verified",
        inline: true,
      },
      { name: "Rank", value: profile.rankName ?? "— (not set)", inline: true },
    );
    // Win rate is shown only if stored — no win-rate column exists, so it
    // is never invented here.
    if (top.length > 0) {
      embed.addFields({
        name: "Top heroes (gacha collection)",
        value: top
          .map((t) => `${t.card.name} (${t.card.rarity}) ×${t.count}`)
          .join("\n"),
      });
    }
    await interaction.reply({ embeds: [embed.toJSON()] });
  },
};

const rankroleCommand: Command = {
  data: new SlashCommandBuilder()
    .setName("rankrole")
    .setDescription("Give yourself the Discord role matching your registered MLBB rank."),
  async execute(interaction, ctx) {
    if (!interaction.memberPermissions?.has("ManageRoles")) {
      await interaction.reply({
        embeds: [
          errorEmbed(
            "You need the Manage Roles permission to use /rankrole. Ask a moderator to run it for you.",
          ).toJSON(),
        ],
      });
      return;
    }
    const profile = getProfile(ctx.db, ctx.guildId, interaction.user.id);
    if (!profile) {
      await interaction.reply({
        embeds: [
          errorEmbed("You have no MLBB profile yet. Register with /register-mlbb first.").toJSON(),
        ],
      });
      return;
    }
    if (!profile.rankName) {
      await interaction.reply({
        embeds: [
          errorEmbed(
            `Your profile has no rank set yet (valid ranks: ${MLBB_RANKS.join(", ")}). Ask a moderator to set your rank first.`,
          ).toJSON(),
        ],
      });
      return;
    }
    const rank = profile.rankName;
    // Role lookup by NAME in the guild. interaction.guild is undefined in
    // the test harness, so a missing guild also lands in the not-found
    // branch rather than crashing.
    const role = interaction.guild?.roles.cache.find((r) => r.name === rank);
    if (!role) {
      await interaction.reply({
        embeds: [
          selenaEmbed(
            `Role "${rank}" not found`,
            `No role named **${rank}** exists in this server yet. Ask an admin to create a role named exactly "${rank}" — Selena never creates roles herself — then run /rankrole again.`,
          ).toJSON(),
        ],
      });
      return;
    }
    const member = interaction.member as unknown as {
      roles?: { add?: (role: unknown) => Promise<unknown> };
    } | null;
    if (typeof member?.roles?.add === "function") {
      await member.roles.add(role);
      await interaction.reply({
        embeds: [
          selenaEmbed("Rank role assigned", `You now have the **${rank}** role.`).toJSON(),
        ],
      });
      return;
    }
    await interaction.reply({
      embeds: [
        selenaEmbed(
          `Role "${rank}" found`,
          `The role **${rank}** exists, but Selena couldn't assign it in this context. Make sure Selena has the Manage Roles permission and her role sits above "${rank}" in the role list.`,
        ).toJSON(),
      ],
    });
  },
};

export const commands: Command[] = [
  heroCommand,
  counterCommand,
  registerCommand,
  verifyCommand,
  profileCommand,
  rankroleCommand,
];
