/**
 * Minimal fakes for discord.js interactions, so command execute() adapters
 * can be exercised in vitest without a live Discord connection.
 * Only the methods/fields commands actually use are stubbed; add more as
 * needed, keeping the shape close to the real discord.js API.
 */

export interface FakeReply {
  kind: "reply" | "editReply" | "followUp" | "deferReply" | "showModal";
  payload: unknown;
}

export class FakeOptions {
  constructor(private values: Record<string, unknown> = {}) {}
  getString(name: string): string | null {
    const v = this.values[name];
    return typeof v === "string" ? v : null;
  }
  getInteger(name: string): number | null {
    const v = this.values[name];
    return typeof v === "number" ? Math.trunc(v) : null;
  }
  getNumber(name: string): number | null {
    const v = this.values[name];
    return typeof v === "number" ? v : null;
  }
  getBoolean(name: string): boolean | null {
    const v = this.values[name];
    return typeof v === "boolean" ? v : null;
  }
  getUser(name: string): { id: string; username: string } | null {
    const v = this.values[name];
    return v && typeof v === "object" ? (v as { id: string; username: string }) : null;
  }
  getChannel(name: string): { id: string; name?: string } | null {
    const v = this.values[name];
    return v && typeof v === "object" ? (v as { id: string; name?: string }) : null;
  }
  getRole(name: string): { id: string; name: string } | null {
    const v = this.values[name];
    return v && typeof v === "object" ? (v as { id: string; name: string }) : null;
  }
}

export interface FakeMemberOpts {
  permissions?: string[];
  roles?: string[];
}

export class FakeChatInput {
  readonly commandName: string;
  readonly options: FakeOptions;
  readonly user: { id: string; username: string };
  readonly guildId: string;
  /** Guild the command ran in (discord.js exposes interaction.guild with ownerId). */
  readonly guild: { ownerId: string } | null;
  readonly memberPermissions: Set<string>;
  readonly memberRoleIds: string[];
  readonly replies: FakeReply[] = [];
  deferred = false;
  ephemeral = false;

  constructor(opts: {
    commandName: string;
    options?: Record<string, unknown>;
    userId?: string;
    username?: string;
    guildId?: string;
    /** Server owner id — sets `guild.ownerId` like the real interaction. */
    guildOwnerId?: string;
    permissions?: string[];
    roles?: string[];
  }) {
    this.commandName = opts.commandName;
    this.options = new FakeOptions(opts.options ?? {});
    this.user = { id: opts.userId ?? "user-1", username: opts.username ?? "tester" };
    this.guildId = opts.guildId ?? "guild-1";
    this.guild = opts.guildOwnerId ? { ownerId: opts.guildOwnerId } : null;
    this.memberPermissions = new Set(opts.permissions ?? []);
    this.memberRoleIds = opts.roles ?? [];
  }

  async deferReply(opts?: { ephemeral?: boolean }): Promise<void> {
    this.deferred = true;
    this.ephemeral = !!opts?.ephemeral;
    this.replies.push({ kind: "deferReply", payload: opts ?? {} });
  }

  async reply(payload: unknown): Promise<void> {
    this.replies.push({ kind: "reply", payload });
  }

  async editReply(payload: unknown): Promise<{ id: string }> {
    this.replies.push({ kind: "editReply", payload });
    return { id: "msg-1" };
  }

  async followUp(payload: unknown): Promise<void> {
    this.replies.push({ kind: "followUp", payload });
  }

  async showModal(payload: unknown): Promise<void> {
    this.replies.push({ kind: "showModal", payload });
  }

  /** First reply payload (convenience for assertions). */
  firstReplyPayload(): unknown {
    const r = this.replies.find((x) => x.kind === "reply" || x.kind === "editReply" || x.kind === "followUp");
    return r?.payload;
  }

  /** Concatenated text of embeds/content in all replies. */
  allText(): string {
    const parts: string[] = [];
    for (const r of this.replies) {
      const p = r.payload as Record<string, unknown>;
      if (typeof p?.content === "string") parts.push(p.content);
      const embeds = p?.embeds as Array<Record<string, unknown>> | undefined;
      if (Array.isArray(embeds)) {
        for (const e of embeds) {
          if (typeof e.title === "string") parts.push(e.title);
          if (typeof e.description === "string") parts.push(e.description);
          const fields = e.fields as Array<{ name: string; value: string }> | undefined;
          if (Array.isArray(fields)) for (const f of fields) parts.push(`${f.name}: ${f.value}`);
        }
      }
    }
    return parts.join("\n");
  }
}

export class FakeButton {
  readonly customId: string;
  readonly user: { id: string; username: string };
  readonly guildId: string;
  readonly replies: FakeReply[] = [];
  message: { id: string } = { id: "msg-1" };

  constructor(opts: { customId: string; userId?: string; username?: string; guildId?: string }) {
    this.customId = opts.customId;
    this.user = { id: opts.userId ?? "user-1", username: opts.username ?? "tester" };
    this.guildId = opts.guildId ?? "guild-1";
  }

  async reply(payload: unknown): Promise<void> {
    this.replies.push({ kind: "reply", payload });
  }

  async deferUpdate(): Promise<void> {
    this.replies.push({ kind: "deferReply", payload: { update: true } });
  }

  async update(payload: unknown): Promise<void> {
    this.replies.push({ kind: "editReply", payload });
  }

  async editReply(payload: unknown): Promise<void> {
    this.replies.push({ kind: "editReply", payload });
  }
}

export class FakeModalSubmit {
  readonly customId: string;
  readonly user: { id: string; username: string };
  readonly guildId: string;
  readonly replies: FakeReply[] = [];
  private fields: Record<string, string>;

  constructor(opts: { customId: string; fields?: Record<string, string>; userId?: string; username?: string; guildId?: string }) {
    this.customId = opts.customId;
    this.fields = opts.fields ?? {};
    this.user = { id: opts.userId ?? "user-1", username: opts.username ?? "tester" };
    this.guildId = opts.guildId ?? "guild-1";
  }

  getTextInputValue(id: string): string {
    return this.fields[id] ?? "";
  }

  async reply(payload: unknown): Promise<void> {
    this.replies.push({ kind: "reply", payload });
  }

  async deferReply(opts?: { ephemeral?: boolean }): Promise<void> {
    this.replies.push({ kind: "deferReply", payload: opts ?? {} });
  }

  async editReply(payload: unknown): Promise<void> {
    this.replies.push({ kind: "editReply", payload });
  }
}
