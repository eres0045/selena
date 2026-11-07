import type { SelenaDb } from "./db.js";
import { secureFloat } from "./rng.js";

/**
 * Fun commands: pure logic + curated text lists.
 * No Canvas is available in this environment, so meme effects and profile
 * cards are text/embeds only — that limitation is stated honestly in the
 * embeds themselves, never hidden.
 */

// ---------------------------------------------------------------------------
// Deterministic hashing (FNV-1a) — ship/rate must be stable across calls.
// ---------------------------------------------------------------------------

export function hashString(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// ---------------------------------------------------------------------------
// /8ball
// ---------------------------------------------------------------------------

export const EIGHTBALL_ANSWERS: readonly string[] = [
  "It is certain.",
  "It is decidedly so.",
  "Without a doubt.",
  "Yes, definitely.",
  "You may rely on it.",
  "As I see it, yes.",
  "Most likely.",
  "Outlook good.",
  "Yes.",
  "Signs point to yes.",
  "Reply hazy, try again.",
  "Ask again later.",
  "Better not tell you now.",
  "Cannot predict now.",
  "Concentrate and ask again.",
  "Don't count on it.",
  "My reply is no.",
  "My sources say no.",
  "Outlook not so good.",
  "Very doubtful.",
];

export function eightBall(rand: () => number = secureFloat): string {
  return EIGHTBALL_ANSWERS[Math.floor(rand() * EIGHTBALL_ANSWERS.length)]!;
}

// ---------------------------------------------------------------------------
// /ship and /rate — deterministic, stable per input.
// ---------------------------------------------------------------------------

export function shipCompatibility(userIdA: string, userIdB: string): { percent: number; label: string } {
  // Sort the pair so the result is the same whichever order they are given.
  const [a, b] = [userIdA, userIdB].sort();
  const percent = hashString(`${a}|${b}`) % 101;
  let label: string;
  if (percent >= 90) label = "A legendary duo — the Land of Dawn ships it. 💜";
  else if (percent >= 70) label = "Great match! Queue up together. 💕";
  else if (percent >= 50) label = "Solid synergy — worth a few games. 💫";
  else if (percent >= 30) label = "It could work… with a lot of comms. 🤔";
  else label = "Maybe stick to different lanes. 😅";
  return { percent, label };
}

export function rateThing(thing: string, userId: string): number {
  return hashString(`${userId}:${thing.trim().toLowerCase()}`) % 101;
}

export function rateVerdict(percent: number): string {
  if (percent >= 90) return "Absolute peak. Certified banger.";
  if (percent >= 70) return "Pretty great, honestly.";
  if (percent >= 50) return "Decent. Not bad at all.";
  if (percent >= 30) return "Mid. It has its moments.";
  return "Yeah… let's not talk about it.";
}

// ---------------------------------------------------------------------------
// Curated text lists — clean and friendly, no slurs, no NSFW.
// ---------------------------------------------------------------------------

export const JOKES: readonly string[] = [
  "Why don't programmers like nature? It has too many bugs.",
  "I told my computer I needed a break, and now it won't stop sending me KitKat ads.",
  "Why did the scarecrow win an award? Because he was outstanding in his field.",
  "I would tell you a UDP joke, but you might not get it.",
  "Why do cows have hooves instead of feet? Because they lactose.",
  "What do you call a fish without eyes? A fsh.",
  "Why did the math book look sad? It had too many problems.",
  "How does a penguin build its house? Igloos it together.",
  "Why did the coffee file a police report? It got mugged.",
  "What do you call a sleeping bull? A bulldozer.",
  "Why don't skeletons fight each other? They don't have the guts.",
  "I used to be a banker, but I lost interest.",
  "Why did the golfer bring two pairs of pants? In case he got a hole in one.",
  "What do you call cheese that isn't yours? Nacho cheese.",
  "Why did the tomato turn red? Because it saw the salad dressing.",
  "How do you make a tissue dance? Put a little boogie in it.",
];

export const ROASTS: readonly string[] = [
  "You're like a cloud — when you disappear, it's a beautiful day.",
  "Your gameplay is so peaceful, the enemies send you thank-you notes.",
  "You bring a lot of joy to the team… whenever you leave the voice channel.",
  "Your aim is so generous, you share your shots with the whole map.",
  "You're the human equivalent of a loading screen — always almost there.",
  "Your ranked history reads like a tragedy in five acts.",
  "You have the map awareness of a goldfish in a maze.",
  "Your wifi is faster than your reaction time, and that's saying something.",
  "You're proof that practice doesn't always make perfect — but it does make persistent.",
  "Your last game was so quiet, the enemy team thought you were AFK. You weren't.",
  "You're like a tutorial level: everyone has beaten you at least once.",
  "Your KDA is a protected species — rarely seen in the wild.",
];

export const COMPLIMENTS: readonly string[] = [
  "Your map awareness is genuinely impressive — nothing gets past you.",
  "You shotcall like a pro and the whole team plays better around you.",
  "Your mechanics are clean, your timing is sharp, and it shows every game.",
  "You're the teammate everyone hopes to queue with.",
  "Your clutch plays belong in a highlight reel.",
  "You stay calm under pressure when everyone else is panicking — that's rare.",
  "Your hero pool is deep and your drafts are always smart.",
  "You make the hard plays look easy.",
  "Your positivity lifts the whole squad, win or lose.",
  "You're a fast learner — every week you come back visibly better.",
  "Your rotations are textbook. Coaches would be proud.",
  "You never tilt, never flame, and always show up. That's a real teammate.",
];

export const WOULD_YOU_RATHER: readonly { a: string; b: string }[] = [
  { a: "Always be 10 minutes late", b: "Always be 20 minutes early" },
  { a: "Have the ability to fly", b: "Have the ability to turn invisible" },
  { a: "Never play your main hero again", b: "Only play your main hero forever" },
  { a: "Win every ranked game but never get MVP", b: "Get MVP every game but lose half of them" },
  { a: "Have unlimited Battle Points", b: "Have unlimited Diamonds" },
  { a: "Talk to animals", b: "Speak every human language" },
  { a: "Live without the internet", b: "Live without your phone" },
  { a: "Always know the enemy's position", b: "Always land your skillshots" },
  { a: "Be famous for a day", b: "Be rich for a day" },
  { a: "Fight one Lord-sized turtle", b: "Fight a hundred turtle-sized Lords" },
  { a: "Have a personal chef", b: "Have a personal chauffeur" },
  { a: "Never need sleep", b: "Never need to eat" },
  { a: "Time travel to the past", b: "Time travel to the future" },
  { a: "Play your favourite game on a phone with 1% battery forever", b: "Play it on a 10-year-old tablet" },
];

export const TRUTHS: readonly string[] = [
  "What is your most-played hero, and why do you love them?",
  "What is the most embarrassing thing that has happened to you in a ranked game?",
  "If you could only play one role for a month, which would it be and why?",
  "What is a game you are secretly really bad at?",
  "Who in this server would you pick as your duo partner, and why?",
  "What is the funniest username you have ever seen in a game?",
  "Have you ever pretended to lag to avoid blame for a bad play? Be honest!",
  "What is your dream rank, and how close are you to it?",
  "What is one thing you would change about your main hero?",
  "What is the best compliment you have ever received about your gameplay?",
];

export const DARES: readonly string[] = [
  "Type your next three messages using only emojis.",
  "Change your nickname to 'Lord Turtle' for the next hour.",
  "Send a voice message doing your best impression of a game announcer.",
  "Play your next match with a hero you have never played before.",
  "Compliment the next three people who speak in chat.",
  "Draw your main hero using only text characters and post it.",
  "Say 'I love Selena' in chat in your best dramatic voice (text or voice).",
  "Play a full game with your screen brightness at minimum. (Only if you dare — and can still see!)",
  "Let the server pick your hero for your next match.",
  "Post your most recent match result screenshot — wins and losses both count.",
];

export function randomJoke(rand: () => number = secureFloat): string {
  return securePickWithRand(JOKES, rand);
}
export function randomRoast(rand: () => number = secureFloat): string {
  return securePickWithRand(ROASTS, rand);
}
export function randomCompliment(rand: () => number = secureFloat): string {
  return securePickWithRand(COMPLIMENTS, rand);
}
export function randomWouldYouRather(rand: () => number = secureFloat): { a: string; b: string } {
  return securePickWithRand(WOULD_YOU_RATHER, rand);
}
export function randomTruthOrDare(
  kind: "truth" | "dare" | "random" = "random",
  rand: () => number = secureFloat,
): { kind: "truth" | "dare"; text: string } {
  const picked = kind === "random" ? (rand() < 0.5 ? "truth" : "dare") : kind;
  return picked === "truth"
    ? { kind: "truth", text: securePickWithRand(TRUTHS, rand) }
    : { kind: "dare", text: securePickWithRand(DARES, rand) };
}

function securePickWithRand<T>(arr: readonly T[], rand: () => number): T {
  if (arr.length === 0) throw new Error("pick: empty array");
  return arr[Math.floor(rand() * arr.length)]!;
}

// ---------------------------------------------------------------------------
// /uwu — uwu-ify text.
// ---------------------------------------------------------------------------

const UWU_SUFFIXES: readonly string[] = [" uwu", " owo", " :3", " nya~", " uwu~"];

export function uwuify(text: string): string {
  let out = text
    .replace(/ove/g, "uv")
    .replace(/Ove/g, "Uv")
    .replace(/OVE/g, "UV")
    .replace(/[rl]/g, "w")
    .replace(/[RL]/g, "W");
  out += UWU_SUFFIXES[hashString(text) % UWU_SUFFIXES.length]!;
  return out;
}

// ---------------------------------------------------------------------------
// /meme — text-only meme generator.
// Canvas is NOT available in this environment (native build fails), so meme
// effects are named text descriptions, not rendered images. The embed says
// so honestly instead of pretending an image was produced.
// ---------------------------------------------------------------------------

export interface MemeTemplate {
  name: string;
  top: string;
  bottom: string;
}

export const MEME_TEMPLATES: readonly MemeTemplate[] = [
  { name: "Distracted Boyfriend", top: "My main hero", bottom: "A shiny new hero release" },
  { name: "Drake Hotline Bling", top: "Pushing solo into 5 enemies", bottom: "Waiting for the team, then teamfighting" },
  { name: "Two Buttons", top: "Button 1: Play one more ranked game", bottom: "Button 2: Go to sleep" },
  { name: "Change My Mind", top: "The Turtle is more important than first blood", bottom: "Change my mind" },
  { name: "Woman Yelling at a Cat", top: "You stole my buff!", bottom: "I am the jungler" },
  { name: "Success Kid", top: "Landed the perfect ultimate", bottom: "Won the teamfight" },
  { name: "Grumpy Cat", top: "Had a great ranked session", bottom: "No. Never happened." },
  { name: "Expanding Brain", top: "Picking meta heroes", bottom: "Picking your comfort hero and winning anyway" },
  { name: "One Does Not Simply", top: "One does not simply", bottom: "Win a 4v5 ranked game" },
  { name: "This Is Fine", top: "Down 10 kills, two inhibitors gone", bottom: "This is fine." },
];

/** Named avatar-caption / image effects. Text descriptions only — no Canvas. */
export const MEME_EFFECTS: Readonly<Record<string, string>> = {
  none: "No effect — clean meme text.",
  wanted: "WANTED poster: your avatar on an old-western wanted poster, reward in Battle Points.",
  jail: "Jail bars: your avatar behind cartoon prison bars, looking very guilty.",
  wasted: "WASTED: the classic black-and-white overlay with a big 'WASTED' stamp.",
  deepfry: "Deep-fried: oversaturated colours, heavy contrast, extra crispy pixels.",
  pixelate: "Pixelated: your avatar reduced to chunky retro pixels, identity safely hidden.",
};

export interface GeneratedMeme {
  template: MemeTemplate;
  topText: string;
  bottomText: string;
  effect: string;
}

export function generateMeme(
  rand: () => number = secureFloat,
  overrides?: { topText?: string; bottomText?: string; effect?: string },
): GeneratedMeme {
  const template = securePickWithRand(MEME_TEMPLATES, rand);
  const effectKeys = Object.keys(MEME_EFFECTS);
  const effect = overrides?.effect && overrides.effect in MEME_EFFECTS
    ? overrides.effect
    : securePickWithRand(effectKeys, rand);
  return {
    template,
    topText: overrides?.topText?.trim() ? overrides.topText.trim() : template.top,
    bottomText: overrides?.bottomText?.trim() ? overrides.bottomText.trim() : template.bottom,
    effect,
  };
}

/** Plain-text rendering of a meme, for the embed description. */
export function memeDescription(meme: GeneratedMeme): string {
  const effectText = MEME_EFFECTS[meme.effect] ?? MEME_EFFECTS.none;
  return (
    `**Template:** ${meme.template.name}\n` +
    `🔝 **Top:** ${meme.topText}\n` +
    `🔻 **Bottom:** ${meme.bottomText}\n` +
    `✨ **Effect:** ${effectText}\n\n` +
    `⚠️ *Image rendering is unavailable in this build — Selena has no Canvas here, ` +
    `so this meme is text-only. No image was generated.*`
  );
}

// ---------------------------------------------------------------------------
// /profile — reads the users table (points, XP, level, server rank).
// ---------------------------------------------------------------------------

export interface ProfileData {
  userId: string;
  points: number;
  xp: number;
  level: number;
  rank: number;
  totalRanked: number;
}

export async function getProfileData(db: SelenaDb, guildId: string, userId: string): Promise<ProfileData> {
  const user = await db
    .prepare("SELECT points, xp, level FROM users WHERE guild_id = ? AND user_id = ?")
    .get(guildId, userId) as { points: number; xp: number; level: number } | undefined;
  const points = Number(user?.points ?? 0);
  const xp = Number(user?.xp ?? 0);
  const level = Number(user?.level ?? 0);

  const rankRow = await db
    .prepare("SELECT COUNT(*) AS c FROM users WHERE guild_id = ? AND points > ?")
    .get(guildId, points) as { c: number } | undefined;
  const rank = Number(rankRow?.c ?? 0) + 1;
  const totalRow = await db
    .prepare("SELECT COUNT(*) AS c FROM users WHERE guild_id = ?")
    .get(guildId) as { c: number } | undefined;
  const totalRanked = Math.max(Number(totalRow?.c ?? 0), 1);

  return {
    userId,
    points,
    xp,
    level,
    rank,
    totalRanked,
  };
}
