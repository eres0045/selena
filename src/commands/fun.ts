import {
  errorEmbed,
  fmt,
  selenaEmbed,
  type Command,
  type CommandInvocation,
} from "../lib/command.js";
import { emoji } from "../lib/emoji.js";
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
  inv: CommandInvocation,
  message: string,
): Promise<void> {
  await inv.reply({ embeds: [errorEmbed(message)], ephemeral: true });
}

export const commands: Command[] = [
  {
    name: "8ball",
    description: "Ask the magic 8-ball a question.",
    aliases: ["8b", "eightball", "ask"],
    args: [{ name: "question", type: "string", required: true, rest: true }],
    async execute(inv, _ctx) {
      const question = inv.options.getString("question");
      if (!question?.trim()) {
        await replyError(inv, "Ask me a question first!");
        return;
      }
      const answer = eightBall();
      await inv.reply({
        embeds: [
          selenaEmbed("🎱 Magic 8-Ball", `**Question:** ${question.trim()}\n**Answer:** ${answer}`),
        ],
      });
    },
  },
  {
    name: "meme",
    description: "Generate a random meme (text-only — no image rendering in this build).",
    aliases: ["memes"],
    args: [{ name: "top", type: "string" }, { name: "bottom", type: "string" }, { name: "effect", type: "string" }],
    async execute(inv, _ctx) {
      const effect = inv.options.getString("effect");
      if (effect !== null && !(effect in MEME_EFFECTS)) {
        await replyError(inv, `Unknown effect "${effect}". Pick one of: ${Object.keys(MEME_EFFECTS).join(", ")}.`);
        return;
      }
      const meme = generateMeme(undefined, {
        topText: inv.options.getString("top") ?? undefined,
        bottomText: inv.options.getString("bottom") ?? undefined,
        effect: effect ?? undefined,
      });
      await inv.reply({
        embeds: [selenaEmbed(`😂 ${meme.template.name}`, memeDescription(meme))],
      });
    },
  },
  {
    name: "ship",
    description: "Check the compatibility between two members.",
    aliases: ["love"],
    args: [{ name: "user1", type: "user", required: true }, { name: "user2", type: "user", required: true }],
    async execute(inv, _ctx) {
      const user1 = inv.options.getUser("user1");
      const user2 = inv.options.getUser("user2");
      if (!user1 || !user2) {
        await replyError(inv, "Pick two members to ship!");
        return;
      }
      const { percent, label } = shipCompatibility(user1.id, user2.id);
      const hearts = "💜".repeat(Math.max(1, Math.round(percent / 20)));
      await inv.reply({
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
    name: "rate",
    description: "Rate something from 0 to 100.",
    aliases: ["rating"],
    args: [{ name: "thing", type: "string", required: true, rest: true }],
    async execute(inv, _ctx) {
      const thing = inv.options.getString("thing");
      if (!thing?.trim()) {
        await replyError(inv, "Tell me what to rate!");
        return;
      }
      const percent = rateThing(thing, inv.user.id);
      await inv.reply({
        embeds: [
          selenaEmbed(
            emoji("star") + " Rating",
            `**${thing.trim()}** scores **${percent}/100**.\n${rateVerdict(percent)}`,
          ),
        ],
      });
    },
  },
  {
    name: "joke",
    description: "Tell a random joke.",
    aliases: ["jokes"],
    async execute(inv, _ctx) {
      await inv.reply({ embeds: [selenaEmbed("😂 Joke", randomJoke())] });
    },
  },
  {
    name: "roast",
    description: "Get a friendly roast (keep it light — no slurs, no NSFW).",
    aliases: ["burn"],
    args: [{ name: "user", type: "user" }],
    async execute(inv, _ctx) {
      const target = inv.options.getUser("user") ?? inv.user;
      await inv.reply({
        embeds: [selenaEmbed(emoji("fire") + " Friendly Roast", `<@${target.id}> — ${randomRoast()}`)],
      });
    },
  },
  {
    name: "compliment",
    description: "Give someone a genuine compliment.",
    aliases: ["comp", "praise"],
    args: [{ name: "user", type: "user" }],
    async execute(inv, _ctx) {
      const target = inv.options.getUser("user") ?? inv.user;
      await inv.reply({
        embeds: [selenaEmbed("💜 Compliment", `<@${target.id}> — ${randomCompliment()}`)],
      });
    },
  },
  {
    name: "wouldyourather",
    description: "Get a would-you-rather question.",
    aliases: ["wyr", "rather"],
    async execute(inv, _ctx) {
      const q = randomWouldYouRather();
      await inv.reply({
        embeds: [selenaEmbed("🤔 Would You Rather…", `**A:** ${q.a}\n\n**B:** ${q.b}`)],
      });
    },
  },
  {
    name: "truthordare",
    description: "Get a truth or a dare.",
    aliases: ["tod"],
    args: [{ name: "kind", type: "string" }],
    async execute(inv, _ctx) {
      const kind = inv.options.getString("kind");
      if (kind !== null && kind !== "truth" && kind !== "dare" && kind !== "random") {
        await replyError(inv, 'Kind must be "truth", "dare", or "random".');
        return;
      }
      const picked = randomTruthOrDare((kind as "truth" | "dare" | "random" | null) ?? "random");
      await inv.reply({
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
    name: "uwu",
    description: "Uwu-ify some text.",
    aliases: ["uwuify", "owo"],
    args: [{ name: "text", type: "string", required: true, rest: true }],
    async execute(inv, _ctx) {
      const text = inv.options.getString("text");
      if (!text?.trim()) {
        await replyError(inv, "Give me some text to uwu-ify!");
        return;
      }
      await inv.reply({ embeds: [selenaEmbed("🥺 uwu", uwuify(text))] });
    },
  },
  {
    name: "profile",
    description: "Show a member's profile card (gold, XP, level, rank).",
    aliases: ["prof", "me"],
    args: [{ name: "user", type: "user" }],
    async execute(inv, ctx) {
      const target = inv.options.getUser("user") ?? inv.user;
      const profile = await getProfileData(ctx.db, ctx.guildId, target.id);
      const embed = selenaEmbed(`👤 ${target.username}'s Profile`)
        .addFields(
          { name: "Gold", value: fmt(profile.points), inline: true },
          { name: "XP", value: fmt(profile.xp), inline: true },
          { name: "Level", value: String(profile.level), inline: true },
          { name: "Server Rank", value: `#${profile.rank} of ${profile.totalRanked}`, inline: true },
        )
        .setFooter({ text: "Profile cards are text/embeds only in this build — no Canvas image rendering." });
      await inv.reply({ embeds: [embed] });
    },
  },
];
