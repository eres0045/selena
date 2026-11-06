import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import {
  errorEmbed,
  selenaEmbed,
  type Command,
  type CommandContext,
} from "../lib/command.js";
import {
  LINEUP_ROLES,
  TRYOUT_RANKS,
  addSquadMember,
  assignLineup,
  banHero,
  clearDraft,
  createBracket,
  createDraft,
  createSquad,
  decideTryout,
  formatDraft,
  formatLineupCard,
  getBracket,
  getDraft,
  getStaffChannelId,
  getTryout,
  lineupCard,
  listScrims,
  listSquads,
  pickHero,
  applyDraftAction,
  removeSquadMember,
  reportMatch,
  scheduleScrim,
  seasonStandings,
  submitTryout,
  upsertRsvp,
  validateDraftHero,
  type DraftState,
} from "../lib/manage.js";
import { loadHeroNames } from "../lib/gacha.js";

/**
 * Management commands: /squad, /lineup, /scrim, /tryout, /bracket,
 * /report-match, /draft. (/rankrole lives in mlbb.ts — it was a duplicate.)
 *
 * Each execute() is a thin adapter over the pure lib in ../lib/manage.ts.
 * Discord role assignment is attempted at runtime only when the guild role
 * exists; the DB record is always the source of truth.
 *
 * Test note: FakeOptions (testkit) has no getSubcommand(), so subcommand
 * dispatch falls back to a "subcommand" string option, which the tests set.
 * Real discord.js always takes the getSubcommand() path.
 */

function subcommand(interaction: any): string | null {
  const opts = interaction?.options;
  if (opts && typeof opts.getSubcommand === "function") {
    try {
      return opts.getSubcommand() as string;
    } catch {
      // fall through to the string-option fallback
    }
  }
  const fallback = opts?.getString?.("subcommand") as string | null | undefined;
  return fallback ?? null;
}

async function replyEmbed(interaction: any, title: string, description?: string): Promise<void> {
  await interaction.reply({ embeds: [selenaEmbed(title, description).toJSON()] });
}

async function replyError(interaction: any, message: string): Promise<void> {
  await interaction.reply({ embeds: [errorEmbed(message).toJSON()], ephemeral: true });
}

/** Best-effort Discord role assignment. Returns true only if it happened. */
async function tryAssignRole(interaction: any, userId: string, roleName: string): Promise<boolean> {
  try {
    const guild = interaction?.guild;
    if (!guild?.roles?.cache?.find || !guild?.members?.fetch) return false;
    const role = guild.roles.cache.find((r: any) => r.name === roleName);
    if (!role) return false;
    const member = await guild.members.fetch(userId);
    if (!member?.roles?.add) return false;
    await member.roles.add(role);
    return true;
  } catch {
    return false;
  }
}

function hasManageRoles(interaction: any): boolean {
  try {
    return !!interaction?.memberPermissions?.has("ManageRoles");
  } catch {
    return false;
  }
}

function fmtDate(ms: number): string {
  return new Date(ms).toLocaleString("en-GB", {
    timeZone: "UTC",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function bracketEmbedText(
  state: NonNullable<ReturnType<typeof getBracket>>,
): string {
  const lines: string[] = [
    `**${state.name}** — ${state.state} (${state.teams.length} teams)`,
    "",
  ];
  const rounds = [...new Set(state.matches.map((m) => m.round))].sort((a, b) => a - b);
  for (const round of rounds) {
    const label =
      round === state.totalRounds ? "Final" : round === state.totalRounds - 1 ? "Semifinals" : `Round ${round}`;
    lines.push(`**${label}**`);
    for (const m of state.matches.filter((x) => x.round === round)) {
      const score =
        m.winner && m.score_a !== null && m.score_b !== null ? ` — ${m.score_a}:${m.score_b}` : "";
      const winner = m.winner ? ` ✅ ${m.winner}` : "";
      lines.push(
        `• Match #${m.id}: ${m.team_a ?? "?"} vs ${m.team_b ?? "?"}${score}${winner}`,
      );
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

const DRAFT_NOTE = "3 bans then 5 picks per team, alternating";

/** discord.js narrows the builder type once options/subcommands are added; cast back to the scaffold's SlashCommandBuilder. */
function d<T>(builder: T): SlashCommandBuilder {
  return builder as unknown as SlashCommandBuilder;
}

export const commands: Command[] = [
  {
    data: d(new SlashCommandBuilder()
      .setName("squad")
      .setDescription("Manage squads")
      .addSubcommand((s) =>
        s
          .setName("create")
          .setDescription("Create a squad")
          .addStringOption((o) => o.setName("name").setDescription("Squad name").setRequired(true))
          .addUserOption((o) => o.setName("captain").setDescription("Squad captain").setRequired(false)),
      )
      .addSubcommand((s) => s.setName("list").setDescription("List squads with member counts"))
      .addSubcommand((s) =>
        s
          .setName("add")
          .setDescription("Add a member to a squad")
          .addStringOption((o) => o.setName("squad").setDescription("Squad name or id").setRequired(true))
          .addUserOption((o) => o.setName("user").setDescription("Member to add").setRequired(true))
          .addStringOption((o) => o.setName("role").setDescription("Role in the squad").setRequired(true)),
      )
      .addSubcommand((s) =>
        s
          .setName("remove")
          .setDescription("Remove a member from a squad")
          .addStringOption((o) => o.setName("squad").setDescription("Squad name or id").setRequired(true))
          .addUserOption((o) => o.setName("user").setDescription("Member to remove").setRequired(true)),
      )),
    execute: async (interaction, ctx) => {
      const sub = subcommand(interaction);
      const guildId = ctx.guildId;
      if (sub === "create") {
        const name = interaction.options.getString("name") ?? "";
        const captain = interaction.options.getUser("captain");
        const r = createSquad(ctx.db, guildId, name, captain?.id ?? null);
        if (!r.ok) return replyError(interaction, r.error);
        await replyEmbed(
          interaction,
          "Squad created",
          `**${r.squad.name}** (id ${r.squad.id})${captain ? `\nCaptain: <@${captain.id}>` : ""}`,
        );
        return;
      }
      if (sub === "list") {
        const squads = listSquads(ctx.db, guildId);
        if (squads.length === 0) {
          await replyEmbed(interaction, "Squads", "No squads yet — create one with /squad create.");
          return;
        }
        await replyEmbed(
          interaction,
          "Squads",
          squads
            .map(
              (s) =>
                `• **${s.name}** (id ${s.id}) — ${s.memberCount} member(s)${s.captain_id ? ` — captain <@${s.captain_id}>` : ""}`,
            )
            .join("\n"),
        );
        return;
      }
      if (sub === "add") {
        const squadRef = interaction.options.getString("squad") ?? "";
        const user = interaction.options.getUser("user");
        const role = interaction.options.getString("role") ?? "";
        if (!user) return replyError(interaction, "Pick a user to add.");
        const r = addSquadMember(ctx.db, guildId, squadRef, user.id, role);
        if (!r.ok) return replyError(interaction, r.error);
        await replyEmbed(interaction, "Member added", `<@${user.id}> joined **${r.squad.name}** as ${role.trim()}.`);
        return;
      }
      if (sub === "remove") {
        const squadRef = interaction.options.getString("squad") ?? "";
        const user = interaction.options.getUser("user");
        if (!user) return replyError(interaction, "Pick a user to remove.");
        const r = removeSquadMember(ctx.db, guildId, squadRef, user.id);
        if (!r.ok) return replyError(interaction, r.error);
        await replyEmbed(interaction, "Member removed", `<@${user.id}> was removed from **${r.squad.name}**.`);
        return;
      }
      await replyError(interaction, "Unknown /squad subcommand.");
    },
  },
  {
    data: d(new SlashCommandBuilder()
      .setName("lineup")
      .setDescription("Assign a member to a squad lineup")
      .addSubcommand((s) =>
        s
          .setName("assign")
          .setDescription("Assign a member to Main Lineup, Prime, or Tryout")
          .addStringOption((o) => o.setName("squad").setDescription("Squad name or id").setRequired(true))
          .addUserOption((o) => o.setName("user").setDescription("Member").setRequired(true))
          .addStringOption((o) =>
            o
              .setName("lineup")
              .setDescription("Lineup")
              .setRequired(true)
              .addChoices(
                ...LINEUP_ROLES.map((r) => ({ name: r, value: r })),
              ),
          ),
      )),
    execute: async (interaction, ctx) => {
      if (!hasManageRoles(interaction)) {
        await replyError(interaction, "You need the Manage Roles permission to assign lineups.");
        return;
      }
      const squadRef = interaction.options.getString("squad") ?? "";
      const user = interaction.options.getUser("user");
      const lineup = interaction.options.getString("lineup") ?? "";
      if (!user) return replyError(interaction, "Pick a user to assign.");
      const r = assignLineup(ctx.db, ctx.guildId, squadRef, user.id, lineup);
      if (!r.ok) return replyError(interaction, r.error);
      const roleAssigned = await tryAssignRole(interaction, user.id, lineup);
      const embed = selenaEmbed(
        `Lineup — ${r.squad.name}`,
        `${formatLineupCard(r.card)}\n\n<@${user.id}> → **${lineup}**\n${
          roleAssigned
            ? `Discord role "${lineup}" assigned.`
            : `Discord role "${lineup}" not found on this server — recorded in the squad only.`
        }`,
      );
      await interaction.reply({ embeds: [embed.toJSON()] });
    },
  },
  {
    data: d(new SlashCommandBuilder()
      .setName("scrim")
      .setDescription("Schedule scrims and track attendance")
      .addSubcommand((s) =>
        s
          .setName("schedule")
          .setDescription("Schedule a scrim")
          .addStringOption((o) => o.setName("opponent").setDescription("Opponent team").setRequired(true))
          .addStringOption((o) => o.setName("date").setDescription("Date, YYYY-MM-DD").setRequired(true))
          .addStringOption((o) => o.setName("time").setDescription("Time, HH:MM (24-hour, UTC)").setRequired(true)),
      )
      .addSubcommand((s) => s.setName("list").setDescription("List upcoming scrims with RSVP counts"))),
    execute: async (interaction, ctx) => {
      const sub = subcommand(interaction);
      if (sub === "schedule") {
        const opponent = interaction.options.getString("opponent") ?? "";
        const date = interaction.options.getString("date") ?? "";
        const time = interaction.options.getString("time") ?? "";
        const r = scheduleScrim(ctx.db, ctx.guildId, opponent, date, time, interaction.user.id);
        if (!r.ok) return replyError(interaction, r.error);
        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId(`selena:scrim:rsvp:${r.scrimId}:yes`)
            .setLabel("✅ Attending")
            .setStyle(ButtonStyle.Success),
          new ButtonBuilder()
            .setCustomId(`selena:scrim:rsvp:${r.scrimId}:no`)
            .setLabel("❌ Can't make it")
            .setStyle(ButtonStyle.Danger),
        );
        const embed = selenaEmbed(
          "Scrim scheduled",
          `**vs ${opponent.trim()}**\n📅 ${fmtDate(r.scheduledAt)} UTC\nScrim #${r.scrimId} — tap a button below to confirm attendance.`,
        );
        await interaction.reply({ embeds: [embed.toJSON()], components: [row] });
        return;
      }
      if (sub === "list") {
        const scrims = listScrims(ctx.db, ctx.guildId);
        if (scrims.length === 0) {
          await replyEmbed(interaction, "Upcoming scrims", "No scrims scheduled.");
          return;
        }
        await replyEmbed(
          interaction,
          "Upcoming scrims",
          scrims
            .map(
              (s) =>
                `• **#${s.id} vs ${s.opponent}** — ${fmtDate(s.scheduledAt)} UTC (✅ ${s.yes} / ❌ ${s.no})`,
            )
            .join("\n"),
        );
        return;
      }
      await replyError(interaction, "Unknown /scrim subcommand.");
    },
  },
  {
    data: d(new SlashCommandBuilder().setName("tryout").setDescription("Apply for a tryout")),
    execute: async (interaction) => {
      const modal = new ModalBuilder().setCustomId("selena:tryout:submit").setTitle("Tryout Application");
      const fields: Array<{ id: string; label: string; style: TextInputStyle; placeholder: string }> = [
        { id: "ign", label: "IGN", style: TextInputStyle.Short, placeholder: "Your in-game name" },
        { id: "mlbb_id", label: "MLBB ID", style: TextInputStyle.Short, placeholder: "e.g. 123456789" },
        { id: "role", label: "Role", style: TextInputStyle.Short, placeholder: "e.g. Jungler, Roamer, Gold Lane" },
        {
          id: "rank",
          label: "Rank",
          style: TextInputStyle.Short,
          placeholder: "Warrior / Elite / Master / Grandmaster / Epic / Legend / Mythic / Mythical Honor / Mythical Glory",
        },
        { id: "heroes", label: "Main heroes", style: TextInputStyle.Paragraph, placeholder: "e.g. Ling, Selena, Fanny" },
      ];
      for (const f of fields) {
        modal.addComponents(
          new ActionRowBuilder<TextInputBuilder>().addComponents(
            new TextInputBuilder()
              .setCustomId(f.id)
              .setLabel(f.label)
              .setStyle(f.style)
              .setPlaceholder(f.placeholder)
              .setRequired(true),
          ),
        );
      }
      await interaction.showModal(modal);
    },
  },
  {
    data: d(new SlashCommandBuilder()
      .setName("bracket")
      .setDescription("Tournament brackets")
      .addSubcommand((s) =>
        s
          .setName("create")
          .setDescription("Create a single-elimination bracket")
          .addStringOption((o) => o.setName("name").setDescription("Bracket name").setRequired(true))
          .addStringOption((o) =>
            o.setName("teams").setDescription("Comma-separated team names (2, 4, 8 or 16)").setRequired(true),
          ),
      )
      .addSubcommand((s) =>
        s
          .setName("view")
          .setDescription("View a bracket")
          .addIntegerOption((o) => o.setName("id").setDescription("Bracket id").setRequired(true)),
      )
      .addSubcommand((s) =>
        s
          .setName("standings")
          .setDescription("Season standings — wins per team across brackets")
          .addIntegerOption((o) => o.setName("bracket-id").setDescription("Only this bracket (optional)").setRequired(false)),
      )),
    execute: async (interaction, ctx) => {
      const sub = subcommand(interaction);
      if (sub === "create") {
        const name = interaction.options.getString("name") ?? "";
        const teamsRaw = interaction.options.getString("teams") ?? "";
        const teams = teamsRaw.split(",").map((t) => t.trim()).filter(Boolean);
        const r = createBracket(ctx.db, ctx.guildId, name, teams);
        if (!r.ok) return replyError(interaction, r.error);
        const state = getBracket(ctx.db, r.bracketId);
        await replyEmbed(
          interaction,
          "Bracket created",
          state ? bracketEmbedText(state) : `Bracket #${r.bracketId} created with ${teams.length} teams.`,
        );
        return;
      }
      if (sub === "view") {
        const id = interaction.options.getInteger("id");
        if (id === null) return replyError(interaction, "Provide a bracket id.");
        const state = getBracket(ctx.db, id);
        if (!state) return replyError(interaction, `Bracket #${id} not found.`);
        await replyEmbed(interaction, `Bracket #${id}`, bracketEmbedText(state));
        return;
      }
      if (sub === "standings") {
        const bracketId = interaction.options.getInteger("bracket-id") ?? undefined;
        const standings = seasonStandings(ctx.db, ctx.guildId, bracketId ?? undefined);
        if (standings.length === 0) {
          await replyEmbed(interaction, "Season standings", "No decided matches yet.");
          return;
        }
        await replyEmbed(
          interaction,
          "Season standings",
          standings
            .map((s, i) => `${i + 1}. **${s.team}** — ${s.wins}W / ${s.losses}L (${s.played} played)`)
            .join("\n"),
        );
        return;
      }
      await replyError(interaction, "Unknown /bracket subcommand.");
    },
  },
  {
    data: d(new SlashCommandBuilder()
      .setName("report-match")
      .setDescription("Report a bracket match result")
      .addIntegerOption((o) => o.setName("bracket-id").setDescription("Bracket id").setRequired(true))
      .addIntegerOption((o) => o.setName("match-id").setDescription("Match id").setRequired(true))
      .addStringOption((o) => o.setName("winner").setDescription("Winning team").setRequired(true))
      .addIntegerOption((o) => o.setName("score-a").setDescription("Score for team A").setRequired(true))
      .addIntegerOption((o) => o.setName("score-b").setDescription("Score for team B").setRequired(true))),
    execute: async (interaction, ctx) => {
      const bracketId = interaction.options.getInteger("bracket-id");
      const matchId = interaction.options.getInteger("match-id");
      const winner = interaction.options.getString("winner") ?? "";
      const scoreA = interaction.options.getInteger("score-a");
      const scoreB = interaction.options.getInteger("score-b");
      if (bracketId === null || matchId === null || scoreA === null || scoreB === null) {
        await replyError(interaction, "Bracket id, match id, and both scores are required.");
        return;
      }
      const r = reportMatch(ctx.db, ctx.guildId, bracketId, matchId, winner, scoreA, scoreB, interaction.user.id);
      if (!r.ok) return replyError(interaction, r.error);
      const parts = [`**${r.match.winner}** won match #${matchId} (${r.match.score_a}:${r.match.score_b}).`];
      if (r.advancedTo) {
        parts.push(`Advanced to ${r.advancedTo.team_a} vs ${r.advancedTo.team_b} (match #${r.advancedTo.id}).`);
      }
      if (r.bracketComplete) parts.push("🏆 Bracket complete!");
      await replyEmbed(interaction, "Match reported", parts.join("\n"));
    },
  },
  {
    data: d(new SlashCommandBuilder()
      .setName("draft")
      .setDescription("Pick/ban helper for MLBB drafts")
      .addSubcommand((s) =>
        s
          .setName("start")
          .setDescription("Start a draft session in this channel")
          .addStringOption((o) => o.setName("team-a").setDescription("First team").setRequired(true))
          .addStringOption((o) => o.setName("team-b").setDescription("Second team").setRequired(true)),
      )),
    execute: async (interaction) => {
      const sub = subcommand(interaction);
      if (sub !== "start") {
        await replyError(interaction, "Unknown /draft subcommand — use /draft start.");
        return;
      }
      const teamA = interaction.options.getString("team-a") ?? "";
      const teamB = interaction.options.getString("team-b") ?? "";
      const channelId =
        (interaction as any).channelId ?? `guild:${(interaction as any).guildId ?? "unknown"}`;
      const r = createDraft(channelId, teamA, teamB);
      if (!r.ok) return replyError(interaction, r.error);
      const heroes = await loadHeroNames();
      const rows: ActionRowBuilder<ButtonBuilder>[] = [];
      if (heroes.length > 0) {
        // Turn-based hero buttons: each click bans/picks for the team whose
        // turn it is. Cap at 20 buttons so the message stays usable.
        const shown = heroes.slice(0, 20);
        for (let i = 0; i < shown.length; i += 5) {
          const row = new ActionRowBuilder<ButtonBuilder>();
          for (const hero of shown.slice(i, i + 5)) {
            row.addComponents(
              new ButtonBuilder()
                .setCustomId(`selena:draft:hero:${encodeURIComponent(hero)}`)
                .setLabel(hero)
                .setStyle(ButtonStyle.Secondary),
            );
          }
          rows.push(row);
        }
      }
      rows.push(
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId("selena:draft:custom")
            .setLabel("Ban / pick another hero…")
            .setStyle(ButtonStyle.Primary),
        ),
      );
      const embed = selenaEmbed(
        "Draft started",
        `${formatDraft(r.draft)}\n\n${heroes.length === 0 ? "No hero list is loaded — use the button below to enter hero names by hand.\n" : ""}Tap a hero to ban/pick for the team whose turn it is (${DRAFT_NOTE}).`,
      );
      await interaction.reply({ embeds: [embed.toJSON()], components: rows });
    },
  },
];

/** Parse a selena:draft button customId. */
function draftChannelId(interaction: any): string {
  return interaction?.channelId ?? `guild:${interaction?.guildId ?? "unknown"}`;
}

async function refreshDraftMessage(interaction: any, draft: DraftState): Promise<void> {
  const embed = selenaEmbed("Draft", formatDraft(draft));
  const payload = { embeds: [embed.toJSON()] };
  try {
    if (typeof interaction.update === "function") {
      await interaction.update(payload);
    } else {
      await interaction.reply(payload);
    }
  } catch {
    try {
      await interaction.reply(payload);
    } catch {
      // interaction already acknowledged; nothing more we can do
    }
  }
}

export const buttonHandlers: Record<
  string,
  (interaction: any, ctx: CommandContext) => Promise<void>
> = {
  "selena:scrim": async (interaction, ctx) => {
    const parts = String(interaction.customId ?? "").split(":");
    // selena:scrim:rsvp:<id>:yes|no
    const scrimId = Number(parts[3]);
    const choice = parts[4];
    if (!Number.isInteger(scrimId) || (choice !== "yes" && choice !== "no")) {
      await interaction.reply({ content: "That RSVP button is malformed.", ephemeral: true });
      return;
    }
    const r = upsertRsvp(ctx.db, scrimId, interaction.user.id, choice === "yes");
    if (!r.ok) {
      await interaction.reply({ content: r.error, ephemeral: true });
      return;
    }
    await interaction.reply({
      content:
        choice === "yes"
          ? `✅ You're in for scrim #${scrimId}. (✅ ${r.yes} attending / ❌ ${r.no} out)`
          : `❌ Noted — you're out for scrim #${scrimId}. (✅ ${r.yes} attending / ❌ ${r.no} out)`,
      ephemeral: true,
    });
  },

  "selena:tryout": async (interaction, ctx) => {
    const parts = String(interaction.customId ?? "").split(":");
    // selena:tryout:accept:<id> | selena:tryout:reject:<id>
    const action = parts[2];
    const tryoutId = Number(parts[3]);
    if ((action !== "accept" && action !== "reject") || !Number.isInteger(tryoutId)) {
      await interaction.reply({ content: "That tryout button is malformed.", ephemeral: true });
      return;
    }
    const r = decideTryout(ctx.db, ctx.guildId, tryoutId, action === "accept" ? "accepted" : "rejected");
    if (!r.ok) {
      await interaction.reply({ content: r.error, ephemeral: true });
      return;
    }
    await interaction.reply({
      content:
        action === "accept"
          ? `✅ Tryout #${tryoutId} (${r.tryout.ign}) accepted — the "Tryout" role will be assigned at runtime.`
          : `❌ Tryout #${tryoutId} (${r.tryout.ign}) rejected.`,
      ephemeral: true,
    });
  },

  "selena:draft": async (interaction, ctx) => {
    const customId = String(interaction.customId ?? "");
    const channelId = draftChannelId(interaction);
    void ctx;
    if (customId === "selena:draft:custom") {
      if (typeof interaction.showModal !== "function") {
        await interaction.reply({
          content: "Enter a hero with the draft modal — this button needs the live bot to open it.",
          ephemeral: true,
        });
        return;
      }
      const modal = new ModalBuilder().setCustomId("selena:draft:modal").setTitle("Ban / pick a hero");
      const teamInput = new TextInputBuilder()
        .setCustomId("team")
        .setLabel("Team (A or B)")
        .setStyle(TextInputStyle.Short)
        .setPlaceholder("A or B")
        .setRequired(true);
      const actionInput = new TextInputBuilder()
        .setCustomId("action")
        .setLabel("Action (ban or pick)")
        .setStyle(TextInputStyle.Short)
        .setPlaceholder("ban or pick")
        .setRequired(true);
      const heroInput = new TextInputBuilder()
        .setCustomId("hero")
        .setLabel("Hero name")
        .setStyle(TextInputStyle.Short)
        .setPlaceholder("e.g. Selena")
        .setRequired(true);
      for (const input of [teamInput, actionInput, heroInput]) {
        modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
      }
      await interaction.showModal(modal);
      return;
    }
    if (customId.startsWith("selena:draft:hero:")) {
      const hero = decodeURIComponent(customId.slice("selena:draft:hero:".length));
      const heroes = await loadHeroNames();
      const r = applyDraftAction(channelId, hero, heroes);
      if (!r.ok) {
        await interaction.reply({ content: r.error, ephemeral: true });
        return;
      }
      const draft = getDraft(channelId);
      if (draft) await refreshDraftMessage(interaction, draft);
      return;
    }
    await interaction.reply({ content: "Unknown draft button.", ephemeral: true });
  },
};

export const modalHandlers: Record<
  string,
  (interaction: any, ctx: CommandContext) => Promise<void>
> = {
  "selena:tryout": async (interaction, ctx) => {
    const get = (id: string): string => {
      try {
        return interaction.getTextInputValue(id) ?? "";
      } catch {
        return "";
      }
    };
    const r = submitTryout(ctx.db, ctx.guildId, interaction.user.id, {
      ign: get("ign"),
      mlbbId: get("mlbb_id"),
      role: get("role"),
      rank: get("rank"),
      heroes: get("heroes"),
    });
    if (!r.ok) {
      await interaction.reply({ embeds: [errorEmbed(r.error).toJSON()], ephemeral: true });
      return;
    }
    const staffChannelId = getStaffChannelId(ctx.db, ctx.guildId);
    await interaction.reply({
      content:
        `✅ Tryout logged (#${r.tryoutId}) — **${r.tryout.ign}** (${r.tryout.role}, ${r.tryout.rank_name}). Staff will review it.` +
        (staffChannelId ? ` (Staff channel: <#${staffChannelId}>)` : ""),
      ephemeral: true,
    });
  },

  "selena:draft": async (interaction, ctx) => {
    void ctx;
    const get = (id: string): string => {
      try {
        return interaction.getTextInputValue(id) ?? "";
      } catch {
        return "";
      }
    };
    const channelId = draftChannelId(interaction);
    const teamRaw = get("team").trim().toUpperCase();
    const actionRaw = get("action").trim().toLowerCase();
    const hero = get("hero");
    if (teamRaw !== "A" && teamRaw !== "B") {
      await interaction.reply({ content: 'Team must be "A" or "B".', ephemeral: true });
      return;
    }
    if (actionRaw !== "ban" && actionRaw !== "pick") {
      await interaction.reply({ content: 'Action must be "ban" or "pick".', ephemeral: true });
      return;
    }
    const heroes = await loadHeroNames();
    const checked = validateDraftHero(hero, heroes);
    if (!checked.ok) {
      await interaction.reply({ content: checked.error, ephemeral: true });
      return;
    }
    const r = actionRaw === "ban" ? banHero(channelId, teamRaw, checked.hero, heroes) : pickHero(channelId, teamRaw, checked.hero, heroes);
    if (!r.ok) {
      await interaction.reply({ content: r.error, ephemeral: true });
      return;
    }
    await interaction.reply({
      content: `✅ ${actionRaw === "ban" ? "Banned" : "Picked"} **${checked.hero}** for team ${teamRaw}.\n${formatDraft(r.draft)}`,
      ephemeral: true,
    });
  },
};

/** Re-exported for tests / runtime wiring. */
export { clearDraft, getDraft };
