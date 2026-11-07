import {
  errorEmbed,
  fmt,
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
 * effects and profile cards are plain text only (see fun.ts). All
 * replies are plain-text message content, no embed box (OwO-style).
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
        content: `🎱 Magic 8-Ball\nQuestion: ${question.trim()}\nAnswer: ${answer}`,
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
        content: `😂 ${meme.template.name}\n${memeDescription(meme)}`,
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
        content: `💘 Ship Result\n${user1.username} ❤️ ${user2.username}\n\n${hearts}\n${percent}% — ${label}`,
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
        content: `${emoji("star")} Rating\n${thing.trim()} scores ${percent}/100.\n${rateVerdict(percent)}`,
      });
    },
  },
  {
    name: "joke",
    description: "Tell a random joke.",
    aliases: ["jokes"],
    async execute(inv, _ctx) {
      await inv.reply({ content: `😂 Joke\n${randomJoke()}` });
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
        content: `${emoji("fire")} Friendly Roast\n<@${target.id}> — ${randomRoast()}`,
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
        content: `💜 Compliment\n<@${target.id}> — ${randomCompliment()}`,
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
        content: `🤔 Would You Rather…\nA: ${q.a}\n\nB: ${q.b}`,
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
        content: `${picked.kind === "truth" ? "🤫 Truth" : "😈 Dare"}\n${picked.text}`,
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
      await inv.reply({ content: `🥺 uwu\n${uwuify(text)}` });
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
      await inv.reply({
        content:
          `👤 ${target.username}'s Profile\n` +
          `Gold: ${fmt(profile.points)} · XP: ${fmt(profile.xp)} · Level: ${profile.level} · Server Rank: #${profile.rank} of ${profile.totalRanked}`,
      });
    },
  },
];
