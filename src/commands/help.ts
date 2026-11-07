import { EmbedBuilder } from "discord.js";
import type { Command, CommandInvocation } from "../lib/command.js";
import { errorEmbed, selenaEmbed } from "../lib/command.js";

// HELP_GROUPS lives in the registry (./index.js), which imports this file —
// so it is loaded lazily inside execute() instead of at module top level.
// A static import here would create a circular import and crash with a
// TDZ error whenever help.ts is imported before index.ts.

export const buttonHandlers: Record<string, (...args: never[]) => Promise<void>> = {};
export const modalHandlers: Record<string, (...args: never[]) => Promise<void>> = {};

/** Discord caps an embed's total length (title + description + fields +
 * footer) at 6000 chars. The compact name-only list is ~1.3k chars, well
 * under — but the guard below keeps it honest if the registry grows. */
export const HELP_EMBED_LIMIT = 6000;

/** One emoji per help category, OwO-style headers. */
export const CATEGORY_EMOJI: Record<string, string> = {
  Economy: "💰",
  Casino: "🎰",
  Hunt: "🗺️",
  Games: "🎮",
  Moderation: "🛡️",
  Utility: "🔧",
  Help: "❓",
  World: "🌍",
  Guilds: "👥",
  Battles: "⚔️",
  Announcements: "📢",
  Towers: "🗼",
  Market: "🏪",
};

export interface HelpGroupLike {
  category: string;
  commands: Array<{ name: string; description: string; aliases: string[] }>;
}

/** The embed author block for the help boxes: the requesting user's
 * display name + avatar, OwO-style, so everyone can see who asked.
 * Never throws: a missing display name falls back to the username, and
 * a missing (or throwing) displayAvatarURL just means no icon — a real
 * discord.js User's displayAvatarURL() returns the default-avatar URL
 * when the user has no custom avatar, so the icon is present live. */
export function helpAuthor(user: {
  username: string;
  displayName?: string;
  displayAvatarURL?: () => string;
}): { name: string; iconURL?: string } {
  const name = user.displayName ?? user.username;
  let iconURL: string | undefined;
  try {
    iconURL = user.displayAvatarURL?.();
  } catch {
    iconURL = undefined;
  }
  return iconURL ? { name, iconURL } : { name };
}

/** Build the one-box command list: title + short intro, then one field
 * per category holding ONLY the command names as inline `code` chips —
 * no descriptions, no aliases in the list. That is what keeps it short:
 * all 58 commands fit in a single embed. When `author` is given, the
 * requesting user's name + avatar head the box (OwO-style). */
export function buildHelpEmbed(
  groups: HelpGroupLike[],
  author?: { name: string; iconURL?: string },
): EmbedBuilder {
  const embed = selenaEmbed(
    "Command List",
    "Here is the list of commands!\nFor more info on a specific command, use `uwu help {command}`",
  );
  if (author) embed.setAuthor(author);
  for (const group of groups) {
    const emoji = CATEGORY_EMOJI[group.category] ?? "📌";
    const chips = group.commands.map((c) => `\`${c.name}\``).join(" ");
    embed.addFields({ name: `${emoji} ${group.category}`, value: chips || "—", inline: false });
  }
  return embed;
}

/** Discord's embed total-length accounting (title + description + every
 * field name + value + footer), used by the guard and the tests. */
export function helpEmbedLength(embed: EmbedBuilder): number {
  const json = embed.toJSON();
  let total = (json.title ?? "").length + (json.description ?? "").length;
  total += (json.author?.name ?? "").length;
  total += (json.footer?.text ?? "").length;
  for (const field of json.fields ?? []) {
    total += field.name.length + field.value.length;
  }
  return total;
}

/** Plain-text detail for one command: usage line, description, aliases. */
export function commandDetail(cmd: { name: string; description: string; aliases: string[]; args?: Array<{ name: string; required?: boolean; rest?: boolean }> }): string {
  const usage = (cmd.args ?? [])
    .map((a) => (a.rest ? `<${a.name}...>` : a.required ? `<${a.name}>` : `[${a.name}]`))
    .join(" ");
  const lines = [`\`uwu ${cmd.name}${usage ? ` ${usage}` : ""}\``, "", cmd.description];
  if (cmd.aliases.length > 0) lines.push("", `Aliases: ${cmd.aliases.map((a) => `\`${a}\``).join(", ")}`);
  return lines.join("\n");
}

export const commands: Command[] = [
  {
    name: "help",
    description: "List all commands, grouped by category",
    aliases: ["h", "commands"],
    args: [{ name: "category", type: "string" }],
    async execute(inv) {
      const { HELP_GROUPS, allCommands } = await import("./index.js");
      const topic = inv.options.getString("category");

      // Category first: the "Help" category collides with the `help`
      // command name, so a category match must win over a command match.
      if (topic) {
        const wanted = topic.toLowerCase();
        const groups = HELP_GROUPS.filter((g) => g.category.toLowerCase() === wanted);
        if (groups.length > 0) {
          const embed = buildHelpEmbed(groups, helpAuthor(inv.user));
          await inv.reply({ embeds: [embed.toJSON()], ephemeral: true });
          return;
        }
        // `uwu help <command>` (or an alias): plain-text detail for that
        // one command — usage, description, aliases.
        const cmd = allCommands.find(
          (c) => c.name === wanted || c.aliases.some((a) => a === wanted),
        );
        if (cmd) {
          await inv.reply({ content: commandDetail(cmd), ephemeral: true });
          return;
        }
        const known = HELP_GROUPS.map((g) => g.category).join(", ");
        await inv.reply({
          embeds: [
            errorEmbed(
              `Unknown command or category "${topic}". Categories: ${known}. Try \`uwu help\` for the full list.`,
            ).toJSON(),
          ],
          ephemeral: true,
        });
        return;
      }

      // `uwu help`: ONE compact embed box with every command name, no
      // descriptions, no aliases — OwO-style, short, not three messages.
      // (The old 3-message split is gone: the name-only list is ~1.3k
      // chars, far under Discord's 6000-char embed cap.) The box is
      // headed by the requesting user's name + avatar.
      const embed = buildHelpEmbed(HELP_GROUPS, helpAuthor(inv.user));
      if (helpEmbedLength(embed) <= HELP_EMBED_LIMIT) {
        await inv.reply({ embeds: [embed.toJSON()], ephemeral: true });
        return;
      }
      // Guard, only if the registry ever grows past the embed cap: one
      // embed per category instead of one giant one.
      const author = helpAuthor(inv.user);
      await inv.reply({ embeds: [buildHelpEmbed([HELP_GROUPS[0]!], author).toJSON()], ephemeral: true });
      for (const group of HELP_GROUPS.slice(1)) {
        await inv.followUp({ embeds: [buildHelpEmbed([group], author).toJSON()], ephemeral: true });
      }
    },
  },
];
