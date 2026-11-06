import { SlashCommandBuilder } from "discord.js";
import {
  errorEmbed,
  fmt,
  selenaEmbed,
  type Command,
} from "../lib/command.js";
import {
  MEME_EFFECTS,
  eightBall,
  generateMeme,
  getProfileData,
  memeDescription,
  randomCompliment,
  randomJoke,
  randomRoast,
  randomTruthOrDare,
  randomWouldYouRather,
  rateThing,
  rateVerdict,
  shipCompatibility,
  uwuify,
} from "../lib/fun.js";

/**
 * Fun slash commands. Each execute() is a thin adapter over the pure
 * functions in ../lib/fun.ts. No Canvas is used anywhere here — meme
 * effects and profile cards are text/embeds only (see fun.ts).
 */

async function replyError(
  interaction: Parameters<Command["execute"]>[0],
  message: string,
): Promise<void> {
  await interaction.reply({ embeds: [errorEmbed(message)], ephemeral: true });
}

/**
 * Build a SlashCommandBuilder with statement-style calls. Chaining
 * .add*Option() narrows the type to SlashCommandOptionsOnlyBuilder, which
 * the scaffold's Command interface (data: SlashCommandBuilder) rejects;
 * calling the adders as statements keeps the wide SlashCommandBuilder type.
 */
function slash(
  name: string,
  description: string,
  configure?: (b: SlashCommandBuilder) => void,
): SlashCommandBuilder {
  const b = new SlashCommandBuilder();
  b.setName(name);
  b.setDescription(description);
  configure?.(b);
  return b;
}

export const commands: Command[] = [
  {
    data: slash("8ball", "Ask the magic 8-ball a question.", (b) => {
      b.addStringOption((o) => o.setName("question").setDescription("Your question").setRequired(true));
    }),
    async execute(interaction, _ctx) {
      const question = interaction.options.getString("question");
      if (!question?.trim()) {
        await replyError(interaction, "Ask me a question first!");
        return;
      }
      const answer = eightBall();
      await interaction.reply({
        embeds: [
          selenaEmbed("🎱 Magic 8-Ball", `**Question:** ${question.trim()}\n**Answer:** ${answer}`),
        ],
      });
    },
  },
  {
    data: slash("meme", "Generate a random meme (text-only — no image rendering in this build).", (b) => {
      b.addStringOption((o) => o.setName("top").setDescription("Custom top text").setRequired(false));
      b.addStringOption((o) => o.setName("bottom").setDescription("Custom bottom text").setRequired(false));
      b.addStringOption((o) =>
        o
          .setName("effect")
          .setDescription("A named image effect (text description only)")
          .setRequired(false)
          .addChoices(
            ...Object.keys(MEME_EFFECTS).map((key) => ({ name: key, value: key })),
          ),
      );
    }),
    async execute(interaction, _ctx) {
      const effect = interaction.options.getString("effect");
      if (effect !== null && !(effect in MEME_EFFECTS)) {
        await replyError(interaction, `Unknown effect "${effect}". Pick one of: ${Object.keys(MEME_EFFECTS).join(", ")}.`);
        return;
      }
      const meme = generateMeme(undefined, {
        topText: interaction.options.getString("top") ?? undefined,
        bottomText: interaction.options.getString("bottom") ?? undefined,
        effect: effect ?? undefined,
      });
      await interaction.reply({
        embeds: [selenaEmbed(`😂 ${meme.template.name}`, memeDescription(meme))],
      });
    },
  },
  {
    data: slash("ship", "Check the compatibility between two members.", (b) => {
      b.addUserOption((o) => o.setName("user1").setDescription("First person").setRequired(true));
      b.addUserOption((o) => o.setName("user2").setDescription("Second person").setRequired(true));
    }),
    async execute(interaction, _ctx) {
      const user1 = interaction.options.getUser("user1");
      const user2 = interaction.options.getUser("user2");
      if (!user1 || !user2) {
        await replyError(interaction, "Pick two members to ship!");
        return;
      }
      const { percent, label } = shipCompatibility(user1.id, user2.id);
      const hearts = "💜".repeat(Math.max(1, Math.round(percent / 20)));
      await interaction.reply({
        embeds: [
          selenaEmbed(
            "💘 Ship Result",
            `**${user1.username}** ❤️ **${user2.username}**\n\n${hearts}\n# ${percent}%\n${label}`,
          ),
        ],
      });
    },
  },
  {
    data: slash("rate", "Rate something from 0 to 100.", (b) => {
      b.addStringOption((o) => o.setName("thing").setDescription("What to rate").setRequired(true));
    }),
    async execute(interaction, _ctx) {
      const thing = interaction.options.getString("thing");
      if (!thing?.trim()) {
        await replyError(interaction, "Tell me what to rate!");
        return;
      }
      const percent = rateThing(thing, interaction.user.id);
      await interaction.reply({
        embeds: [
          selenaEmbed(
            "⭐ Rating",
            `**${thing.trim()}** scores **${percent}/100**.\n${rateVerdict(percent)}`,
          ),
        ],
      });
    },
  },
  {
    data: slash("joke", "Tell a random joke."),
    async execute(interaction, _ctx) {
      await interaction.reply({ embeds: [selenaEmbed("😂 Joke", randomJoke())] });
    },
  },
  {
    data: slash("roast", "Get a friendly roast (keep it light — no slurs, no NSFW).", (b) => {
      b.addUserOption((o) => o.setName("user").setDescription("Who to roast (defaults to you)").setRequired(false));
    }),
    async execute(interaction, _ctx) {
      const target = interaction.options.getUser("user") ?? interaction.user;
      await interaction.reply({
        embeds: [selenaEmbed("🔥 Friendly Roast", `<@${target.id}> — ${randomRoast()}`)],
      });
    },
  },
  {
    data: slash("compliment", "Give someone a genuine compliment.", (b) => {
      b.addUserOption((o) => o.setName("user").setDescription("Who to compliment (defaults to you)").setRequired(false));
    }),
    async execute(interaction, _ctx) {
      const target = interaction.options.getUser("user") ?? interaction.user;
      await interaction.reply({
        embeds: [selenaEmbed("💜 Compliment", `<@${target.id}> — ${randomCompliment()}`)],
      });
    },
  },
  {
    data: slash("wouldyourather", "Get a would-you-rather question."),
    async execute(interaction, _ctx) {
      const q = randomWouldYouRather();
      await interaction.reply({
        embeds: [selenaEmbed("🤔 Would You Rather…", `**A:** ${q.a}\n\n**B:** ${q.b}`)],
      });
    },
  },
  {
    data: slash("truthordare", "Get a truth or a dare.", (b) => {
      b.addStringOption((o) =>
        o
          .setName("kind")
          .setDescription("Truth, dare, or random")
          .setRequired(false)
          .addChoices(
            { name: "Truth", value: "truth" },
            { name: "Dare", value: "dare" },
            { name: "Random", value: "random" },
          ),
      );
    }),
    async execute(interaction, _ctx) {
      const kind = interaction.options.getString("kind");
      if (kind !== null && kind !== "truth" && kind !== "dare" && kind !== "random") {
        await replyError(interaction, 'Kind must be "truth", "dare", or "random".');
        return;
      }
      const picked = randomTruthOrDare((kind as "truth" | "dare" | "random" | null) ?? "random");
      await interaction.reply({
        embeds: [
          selenaEmbed(
            picked.kind === "truth" ? "🤫 Truth" : "😈 Dare",
            picked.text,
          ),
        ],
      });
    },
  },
  {
    data: slash("uwu", "Uwu-ify some text.", (b) => {
      b.addStringOption((o) => o.setName("text").setDescription("Text to uwu-ify").setRequired(true));
    }),
    async execute(interaction, _ctx) {
      const text = interaction.options.getString("text");
      if (!text?.trim()) {
        await replyError(interaction, "Give me some text to uwu-ify!");
        return;
      }
      await interaction.reply({ embeds: [selenaEmbed("🥺 uwu", uwuify(text))] });
    },
  },
  {
    data: slash("profile", "Show a member's profile card (points, XP, level, rank, MLBB info).", (b) => {
      b.addUserOption((o) => o.setName("user").setDescription("Whose profile (defaults to you)").setRequired(false));
    }),
    async execute(interaction, ctx) {
      const target = interaction.options.getUser("user") ?? interaction.user;
      const profile = await getProfileData(ctx.db, ctx.guildId, target.id);
      const embed = selenaEmbed(`👤 ${target.username}'s Profile`)
        .addFields(
          { name: "Points", value: fmt(profile.points), inline: true },
          { name: "XP", value: fmt(profile.xp), inline: true },
          { name: "Level", value: String(profile.level), inline: true },
          { name: "Server Rank", value: `#${profile.rank} of ${profile.totalRanked}`, inline: true },
          { name: "MLBB IGN", value: profile.ign ?? "Not linked", inline: true },
          { name: "MLBB Rank", value: profile.rankName ?? "Not set", inline: true },
          { name: "Favourite Hero", value: profile.favouriteHero ?? "Not set", inline: true },
        )
        .setFooter({ text: "Profile cards are text/embeds only in this build — no Canvas image rendering." });
      await interaction.reply({ embeds: [embed] });
    },
  },
];
