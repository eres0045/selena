import {
  ChatInputCommandInteraction,
  EmbedBuilder,
  type SlashCommandBuilder,
} from "discord.js";
import type { SelenaDb } from "./db.js";

export interface CommandContext {
  db: SelenaDb;
  /** Guild the command ran in (always present for guild slash commands). */
  guildId: string;
}

/** A slash command: discord.js builder + thin execute adapter. */
export interface Command {
  data: SlashCommandBuilder;
  execute: (interaction: ChatInputCommandInteraction, ctx: CommandContext) => Promise<void>;
}

export const SELENA_COLOR = 0x8b5cf6; // violet, Selena's theme

export function selenaEmbed(title: string, description?: string): EmbedBuilder {
  const e = new EmbedBuilder().setColor(SELENA_COLOR).setTitle(title);
  if (description) e.setDescription(description);
  return e;
}

export function errorEmbed(message: string): EmbedBuilder {
  return new EmbedBuilder().setColor(0xef4444).setTitle("Something went wrong").setDescription(message);
}

export function pointsEmbed(title: string, description: string): EmbedBuilder {
  return selenaEmbed(title, description).setFooter({ text: "uwu points are fun-only — no real money." });
}

/** Format an integer with thousands separators. */
export function fmt(n: number): string {
  return Math.trunc(n).toLocaleString("en-US");
}
