import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import {
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
} from "discord.js";
import { getDb, type SelenaDb } from "./lib/db.js";
import { emoji } from "./lib/emoji.js";
import { secureInt } from "./lib/rng.js";
import { errorEmbed, selenaEmbed } from "./lib/command.js";
import { awardXp } from "./lib/levels.js";
import { checkMessage, checkStarboard, DEFAULT_BANNED_WORDS } from "./lib/automod.js";
import { getReactionRole } from "./commands/mod.js";
import { allButtonHandlers, allCommands, allModalHandlers } from "./commands/index.js";

/**
 * Selena entrypoint. Routing + timers live here; the actual logic lives in
 * src/lib/* and src/commands/*. No canvas anywhere — all output is
 * text/embeds.
 */

// ---------------------------------------------------------------------------
// Env / boot helpers (exported so tests can exercise them without side
// effects — importing this module never logs in on its own).
// ---------------------------------------------------------------------------

/** Tiny .env reader (KEY=VALUE, # comments ignored); never overrides real env. */
export function loadEnvFile(path = ".env"): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

/** True when a login should be attempted (a token is configured). */
export function shouldLogin(env: NodeJS.ProcessEnv = process.env): boolean {
  return !!env.DISCORD_TOKEN?.trim();
}

/**
 * Tiny HTTP health endpoint for Render's free web-service tier: Render
 * requires the process to bind $PORT and answer health checks, so when
 * PORT is set Selena serves a plain 200 on every path. No Discord logic
 * lives here. Returns true when a server was started, false otherwise
 * (no PORT set — local runs and tests).
 */
export function startHealthServer(env: NodeJS.ProcessEnv = process.env): boolean {
  const port = Number(env.PORT);
  if (!port || Number.isNaN(port)) return false;
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("Selena is running.\n");
  });
  server.listen(port, () => console.log(`Selena: health endpoint on :${port}`));
  server.unref?.();
  return true;
}

export function buildClient(): Client {
  return new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Message, Partials.Reaction, Partials.User, Partials.Channel, Partials.GuildMember],
  });
}

// ---------------------------------------------------------------------------
// Due-task sweep (60s timer): deliver due reminders, end due giveaways.
// Exported for tests; safe to call with client === null (DB-only mode).
// ---------------------------------------------------------------------------

export async function runDueTasks(db: SelenaDb, client: Client | null): Promise<void> {
  const now = Date.now();

  // Reminders
  const dueReminders = await db
    .prepare("SELECT id, user_id, channel_id, text FROM reminders WHERE delivered = 0 AND due_at <= ?")
    .all(now) as { id: number; user_id: string; channel_id: string; text: string }[];
  for (const r of dueReminders) {
    if (!client) continue; // no way to deliver without a client; leave pending
    try {
      const channel = await client.channels.fetch(r.channel_id);
      if (channel && "send" in channel && typeof (channel as { send: unknown }).send === "function") {
        await (channel as { send: (msg: unknown) => Promise<unknown> }).send({
          content: `<@${r.user_id}> ⏰ Reminder: ${r.text}`,
        });
        await db.prepare("UPDATE reminders SET delivered = 1 WHERE id = ?").run(r.id);
      }
    } catch (e) {
      console.error(`Selena: failed to deliver reminder #${r.id}:`, e instanceof Error ? e.message : e);
    }
  }

  // Giveaways
  const dueGiveaways = await db
    .prepare("SELECT id, guild_id, channel_id, prize, winners_count FROM giveaways WHERE ended = 0 AND ends_at <= ?")
    .all(now) as { id: number; guild_id: string; channel_id: string; prize: string; winners_count: number }[];
  for (const g of dueGiveaways) {
    await db.prepare("UPDATE giveaways SET ended = 1 WHERE id = ?").run(g.id);
    let winners: string[] = [];
    try {
      // pickWinners lives in the games lib: pickWinners(entries, count).
      const { pickWinners } = (await import("./lib/games.js")) as {
        pickWinners: (entries: readonly string[], count: number) => string[];
      };
      const entries = await db
        .prepare("SELECT user_id FROM giveaway_entries WHERE giveaway_id = ?")
        .all(g.id) as { user_id: string }[];
      winners = entries.length > 0 ? pickWinners(entries.map((e) => e.user_id), g.winners_count) : [];
      if (entries.length === 0) console.log(`Selena: giveaway #${g.id} ended with no entries.`);
    } catch (e) {
      console.log(`Selena: giveaway #${g.id} ended without winners (pickWinners unavailable: ${e instanceof Error ? e.message : e}).`);
    }
    if (client && winners.length > 0) {
      try {
        const channel = await client.channels.fetch(g.channel_id);
        if (channel && "send" in channel && typeof (channel as { send: unknown }).send === "function") {
          await (channel as { send: (msg: unknown) => Promise<unknown> }).send({
            content: `${emoji("party")} Giveaway ended! **${g.prize}** — winners: ${winners.map((w) => `<@${w}>`).join(", ")}`,
          });
        }
      } catch (e) {
        console.error(`Selena: failed to announce giveaway #${g.id}:`, e instanceof Error ? e.message : e);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

export async function start(): Promise<void> {
  loadEnvFile();
  startHealthServer();
  if (!shouldLogin()) {
    console.log("Selena: no DISCORD_TOKEN set — skipping login (commands validated only)");
    return;
  }
  const token = process.env.DISCORD_TOKEN!;
  const db = getDb();
  // Fail fast when the database is unreachable, before logging in.
  await db.ensureSchema();
  console.log("Selena: database connected (schema ready).");
  const client = buildClient();

  // --- slash command registration (guild-scoped when GUILD_ID is set,
  // else global). The application id is only known after login, so the
  // registration runs in the ready handler. ---
  client.once(Events.ClientReady, async (readyClient) => {
    console.log(`Selena: logged in as ${readyClient.user.tag}.`);
    try {
      const rest = new REST({ version: "10" }).setToken(token);
      const body = allCommands.map((c) => c.data.toJSON());
      const guildId = process.env.GUILD_ID;
      if (guildId) {
        await rest.put(Routes.applicationGuildCommands(readyClient.user.id, guildId), { body });
        console.log(`Selena: registered ${body.length} guild slash commands.`);
      } else {
        await rest.put(Routes.applicationCommands(readyClient.user.id), { body });
        console.log(`Selena: registered ${body.length} global slash commands.`);
      }
    } catch (e) {
      console.error("Selena: command registration failed:", e instanceof Error ? e.message : e);
    }
  });

  // --- interaction routing ---
  client.on(Events.InteractionCreate, async (interaction) => {
    const ctx = { db, guildId: interaction.guildId ?? process.env.GUILD_ID ?? "unknown" };
    try {
      if (interaction.isChatInputCommand()) {
        const command = allCommands.find((c) => c.data.name === interaction.commandName);
        if (!command) {
          await interaction.reply({ embeds: [errorEmbed(`Unknown command: ${interaction.commandName}`)], ephemeral: true });
          return;
        }
        await command.execute(interaction, ctx);
        return;
      }
      if (interaction.isButton()) {
        // customIds are `selena:<feature>:<action>:...` — route on the
        // first TWO segments, e.g. "selena:bj".
        const key = interaction.customId.split(":").slice(0, 2).join(":");
        const handler = allButtonHandlers[key] ?? allButtonHandlers[interaction.customId];
        if (handler) await (handler as (i: typeof interaction, c: typeof ctx) => Promise<void>)(interaction, ctx);
        return;
      }
      if (interaction.isModalSubmit()) {
        const key = interaction.customId.split(":").slice(0, 2).join(":");
        const handler = allModalHandlers[key] ?? allModalHandlers[interaction.customId];
        if (handler) await (handler as (i: typeof interaction, c: typeof ctx) => Promise<void>)(interaction, ctx);
        return;
      }
    } catch (e) {
      console.error("Selena: interaction error:", e instanceof Error ? e.message : e);
      try {
        if (interaction.isRepliable()) {
          await interaction.reply({ embeds: [errorEmbed("Something went wrong running that.")], ephemeral: true });
        }
      } catch {
        /* already replied */
      }
    }
  });

  // --- messageCreate: XP + auto-mod ---
  const recentByUser = new Map<string, number[]>();
  client.on(Events.MessageCreate, async (message) => {
    try {
      if (message.author.bot || !message.guildId) return;
      const guildId = message.guildId;
      const now = Date.now();
      const key = `${guildId}:${message.author.id}`;
      const history = recentByUser.get(key) ?? [];
      history.push(now);
      recentByUser.set(key, history.filter((t) => now - t <= 60_000).slice(-20));

      if (message.content) {
        const verdict = checkMessage(message.content, history, {
          bannedWords: DEFAULT_BANNED_WORDS,
          spamWindowMs: 5000,
          spamThreshold: 5,
          allowLinks: false,
          allowedDomains: ["discord.gg", "discord.com"],
        });
        if (verdict.action === "delete") {
          try {
            await message.delete();
          } catch {
            /* missing perms — nothing to do */
          }
          return;
        }
        if (verdict.action === "warn") {
          try {
            await message.reply(`⚠️ Please watch your language, <@${message.author.id}> (${verdict.reasons.join(", ")}).`);
          } catch {
            /* ignore */
          }
          return;
        }
        // XP: 5–15 per message, 60s per-user cooldown (enforced in awardXp).
        const result = await awardXp(db, guildId, message.author.id, secureInt(5, 16), now);
        if (result.leveledUp) {
          try {
            await message.channel.send(`${emoji("party")} <@${message.author.id}> leveled up to **level ${result.newLevel}**!`);
          } catch {
            /* ignore */
          }
        }
      }
    } catch (e) {
      console.error("Selena: messageCreate error:", e instanceof Error ? e.message : e);
    }
  });

  // --- reaction roles (add / remove) ---
  const applyReactionRole = async (
    reaction: { emoji: { id?: string | null; name?: string | null }; message: { guildId?: string | null; id: string } },
    userId: string,
    add: boolean,
  ) => {
    try {
      const guildId = reaction.message.guildId;
      if (!guildId) return;
      const emojiKey = reaction.emoji.id ?? reaction.emoji.name ?? "";
      const roleId = await getReactionRole(db, guildId, reaction.message.id, emojiKey);
      if (!roleId) return;
      const guild = await client.guilds.fetch(guildId);
      const member = await guild.members.fetch(userId);
      if (add) await member.roles.add(roleId);
      else await member.roles.remove(roleId);
    } catch (e) {
      console.error("Selena: reaction-role error:", e instanceof Error ? e.message : e);
    }
  };
  client.on(Events.MessageReactionAdd, async (reaction, user) => {
    try {
      if (reaction.partial) await reaction.fetch();
      if (user.bot) return;
      await applyReactionRole(reaction, user.id, true);
      // Starboard
      const guildId = reaction.message.guildId;
      if (guildId) {
        const stars = reaction.count ?? 1;
        const check = await checkStarboard(db, guildId, reaction.message.id, stars);
        if (check.shouldPost) {
          const settings = await db.prepare("SELECT starboard_channel_id FROM guild_settings WHERE guild_id = ?").get(guildId) as
            | { starboard_channel_id: string | null }
            | undefined;
          if (settings?.starboard_channel_id) {
            try {
              const channel = await client.channels.fetch(settings.starboard_channel_id);
              const msg = reaction.message;
              const embed = selenaEmbed(`${emoji("star")} ${stars} — starboard`)
                .setDescription(msg.content?.slice(0, 2000) || "(no text)")
                .setFooter({ text: `by ${msg.author?.username ?? "unknown"} in #${(msg.channel as { name?: string }).name ?? "?"}` });
              if (channel && "send" in channel && typeof (channel as { send: unknown }).send === "function") {
                const sent = (await (channel as { send: (msg: unknown) => Promise<{ id: string }> }).send({
                  embeds: [embed],
                  content: `https://discord.com/channels/${guildId}/${msg.channelId}/${msg.id}`,
                })) as { id: string };
                await db.prepare("UPDATE starboard_posts SET starboard_message_id = ? WHERE guild_id = ? AND message_id = ?").run(
                  sent.id,
                  guildId,
                  msg.id,
                );
              }
            } catch (e) {
              console.error("Selena: starboard post failed:", e instanceof Error ? e.message : e);
            }
          }
        }
      }
    } catch (e) {
      console.error("Selena: reaction add error:", e instanceof Error ? e.message : e);
    }
  });
  client.on(Events.MessageReactionRemove, async (reaction, user) => {
    try {
      if (reaction.partial) await reaction.fetch();
      if (user.bot) return;
      await applyReactionRole(reaction, user.id, false);
    } catch (e) {
      console.error("Selena: reaction remove error:", e instanceof Error ? e.message : e);
    }
  });

  // --- timers ---
  const timer = setInterval(() => {
    void runDueTasks(db, client).catch((e) => console.error("Selena: due-task sweep failed:", e));
  }, 60_000);
  timer.unref?.();

  await client.login(token);
}

// Auto-run only when this file is the entrypoint (not when imported by tests).
if (process.argv[1]?.endsWith("index.js") || process.argv[1]?.endsWith("index.ts")) {
  void start();
}
