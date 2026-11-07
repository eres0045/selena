import type { Command, CommandContext, ReplyPayload } from "../lib/command.js";
import { fmt, resolveDisplayNames } from "../lib/command.js";
import type { SelenaDb } from "../lib/db.js";
import { getBalance } from "../lib/economy.js";
import {
  AUCTION_DURATION_MS,
  AUCTION_MIN_START_PRICE,
  CRATE_TIERS,
  SHOP_QTY_PER_PLAYER,
  auctionFee,
  buyFromShop,
  cancelAuction,
  closeDueAuctions,
  describeAuctionItem,
  generateShopStock,
  getAuction,
  getAuctionBids,
  getGems,
  getTodayStock,
  getUserCrates,
  listAuction,
  listAuctions,
  listMyAuctions,
  minNextBid,
  openCrate,
  placeBid,
  resolveListableItem,
  sellerProceeds,
  type Auction,
} from "../lib/market.js";
import { utcDayString } from "../lib/huntDb.js";
import { buyBackground, findBackground, getOwnedBackgrounds, getUserProfile } from "../lib/profile.js";
import { DEFAULT_BG_ID, getBackground, listBackgrounds } from "../lib/profileBgs.js";
import { compactGold, pageButtons, shopRow } from "../lib/shopFormat.js";

/**
 * Market commands — auction house + daily shop + crates + gems
 * (Phase 2, design docs/hunt-world-phase2-design.md §8–§9).
 *
 *   uwu auction sell <item> <price>   list something for 24h
 *   uwu auction bid <id> <amount>     binding bid (gold escrowed)
 *   uwu auction list                  live listings, all of Discord
 *   uwu auction info <id>             one listing + bid history
 *   uwu auction cancel <id>           seller only, while it has no bids
 *   uwu auction mine                  your open listings
 *   uwu shop                          today's stock (same for everyone)
 *   uwu shop buy <item> [qty]         buy (3 per item per player per day)
 *   uwu crates                        crates you own
 *   uwu open <crate>                  open one crate
 *   uwu gems                          your gem balance
 *
 * Plain-text OwO replies everywhere, no embeds. This module does NOT
 * wire itself into src/commands/index.ts or the 60s due-task sweep —
 * the coordinator adds the module to the registry and calls
 * closeDueAuctions(db, client, Date.now()) from the sweep.
 */

function timeLeft(endsAt: number, nowMs: number): string {
  const ms = Math.max(0, endsAt - nowMs);
  const h = Math.floor(ms / 3_600_000);
  const m = Math.ceil((ms % 3_600_000) / 60_000);
  if (h >= 24) return `${Math.floor(h / 24)}d ${h % 24}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function auctionLine(a: Auction, sellerName: string, bidderName?: string): string {
  const item = describeAuctionItem(a.itemType, a.itemRef);
  const bid =
    a.currentBid !== null
      ? ` · now ${fmt(a.currentBid)} gold by ${bidderName ?? a.currentBidder}`
      : ` · start ${fmt(a.startPrice)} gold · no bids yet`;
  return `#${a.id} · ${item} · seller ${sellerName}${bid} · ends in ${timeLeft(a.endsAt, Date.now())}`;
}

async function replyError(
  inv: { reply: (p: ReplyPayload) => Promise<void> },
  msg: string,
): Promise<void> {
  await inv.reply({ content: msg });
}

async function handleAuctionList(inv: Parameters<Command["execute"]>[0], ctx: CommandContext): Promise<void> {
  const now = Date.now();
  try {
    const auctions = await listAuctions(ctx.db, now);
    if (auctions.length === 0) {
      await inv.reply({
        content:
          "The auction house is empty right now — be the first to list something with `uwu auction sell <item> <price>`.",
      });
      return;
    }
    const ids = [...new Set(auctions.flatMap((a) => [a.sellerId, ...(a.currentBidder ? [a.currentBidder] : [])]))];
    const names = await resolveDisplayNames(inv, ids);
    const nameOf = new Map(ids.map((id, i) => [id, names[i] ?? id]));
    const lines = auctions.map((a) =>
      auctionLine(a, nameOf.get(a.sellerId) ?? a.sellerId, a.currentBidder ? nameOf.get(a.currentBidder) : undefined),
    );
    await inv.reply({
      content:
        `🏛️ Auction house — live listings across Discord (${auctions.length}):\n` +
        `${lines.join("\n")}\n` +
        `Bid with \`uwu auction bid <id> <amount>\` — bids are binding, gold is held until you're outbid.`,
    });
  } catch (e) {
    console.error("uwu: auction list failed:", e instanceof Error ? e.message : e);
    await replyError(inv, "Couldn't load the auction house — try again in a bit.");
  }
}

async function handleAuctionSell(
  inv: Parameters<Command["execute"]>[0],
  ctx: CommandContext,
  target: string,
): Promise<void> {
  const tokens = target.trim().split(/\s+/).filter(Boolean);
  if (tokens.length < 2) {
    await replyError(inv, "Usage: `uwu auction sell <item> <starting price>` — e.g. `uwu auction sell Stone Beetle 500`.");
    return;
  }
  const priceToken = tokens[tokens.length - 1]!;
  const price = Number(priceToken);
  if (!Number.isInteger(price) || price <= 0) {
    await replyError(inv, `"${priceToken}" isn't a price — put a whole number of gold at the end, e.g. \`uwu auction sell Stone Beetle 500\`.`);
    return;
  }
  const itemName = tokens.slice(0, -1).join(" ");
  const item = resolveListableItem(itemName);
  if (!item) {
    await replyError(inv, `I don't know anything called "${itemName}" — check the name in \`uwu zoo\` / \`uwu inv\` and try again.`);
    return;
  }
  try {
    const res = await listAuction(ctx.db, ctx.guildId, inv.user.id, item, price, Date.now());
    if (!res.ok || !res.auction) {
      await replyError(inv, res.error ?? "Couldn't list that item.");
      return;
    }
    const a = res.auction;
    await inv.reply({
      content:
        `🏛️ Listed #${a.id} — ${describeAuctionItem(a.itemType, a.itemRef)} for ${fmt(a.startPrice)} gold.\n` +
        `It runs for 24h (ends <t:${Math.floor(a.endsAt / 1000)}:R>). The item left your zoo/inventory until it sells or comes back unsold.\n` +
        `You can cancel with \`uwu auction cancel ${a.id}\` — only while it has no bids.`,
    });
  } catch (e) {
    console.error("uwu: auction sell failed:", e instanceof Error ? e.message : e);
    await replyError(inv, "Couldn't list that item — try again in a bit.");
  }
}

async function handleAuctionBid(
  inv: Parameters<Command["execute"]>[0],
  ctx: CommandContext,
  target: string,
): Promise<void> {
  const tokens = target.trim().split(/\s+/).filter(Boolean);
  if (tokens.length !== 2) {
    await replyError(inv, "Usage: `uwu auction bid <id> <amount>` — e.g. `uwu auction bid 3 500`.");
    return;
  }
  const auctionId = Number(tokens[0]);
  const amount = Number(tokens[1]);
  if (!Number.isInteger(auctionId) || auctionId <= 0 || !Number.isInteger(amount)) {
    await replyError(inv, "Usage: `uwu auction bid <id> <amount>` — both need to be whole numbers.");
    return;
  }
  try {
    const res = await placeBid(ctx.db, ctx.guildId, auctionId, inv.user.id, amount, Date.now());
    if (!res.ok || !res.auction) {
      await replyError(inv, res.error ?? "Couldn't place that bid.");
      return;
    }
    const a = res.auction;
    const refundNote =
      res.refundedBidder && res.refundedAmount !== undefined
        ? `\nThe previous bidder got their ${fmt(res.refundedAmount)} gold back instantly.`
        : "";
    await inv.reply({
      content:
        `🔨 You're the top bidder on auction #${a.id} — ${describeAuctionItem(a.itemType, a.itemRef)} at ${fmt(a.currentBid ?? amount)} gold.\n` +
        `That gold is held in escrow now: if someone outbids you, it comes straight back. Next bid needs at least ${fmt(minNextBid(a))} gold.${refundNote}`,
    });
  } catch (e) {
    console.error("uwu: auction bid failed:", e instanceof Error ? e.message : e);
    await replyError(inv, "Couldn't place that bid — try again in a bit.");
  }
}

async function handleAuctionInfo(
  inv: Parameters<Command["execute"]>[0],
  ctx: CommandContext,
  target: string,
): Promise<void> {
  const auctionId = Number(target.trim());
  if (!Number.isInteger(auctionId) || auctionId <= 0) {
    await replyError(inv, "Usage: `uwu auction info <id>` — e.g. `uwu auction info 3`.");
    return;
  }
  try {
    const a = await getAuction(ctx.db, auctionId);
    if (!a) {
      await replyError(inv, `No auction #${auctionId}.`);
      return;
    }
    const ids = [a.sellerId, ...(a.currentBidder ? [a.currentBidder] : [])];
    const names = await resolveDisplayNames(inv, ids);
    const nameOf = new Map(ids.map((id, i) => [id, names[i] ?? id]));
    const bids = await getAuctionBids(ctx.db, auctionId, 5);
    const bidNames = await resolveDisplayNames(inv, bids.map((b) => b.bidderId));
    const status =
      a.status === "open"
        ? `open — ends in ${timeLeft(a.endsAt, Date.now())} (<t:${Math.floor(a.endsAt / 1000)}:t>)`
        : a.status;
    const lines = [
      `🏛️ Auction #${a.id} — ${describeAuctionItem(a.itemType, a.itemRef)}`,
      `Seller: ${nameOf.get(a.sellerId) ?? a.sellerId} · Status: ${status}`,
      `Starting price: ${fmt(a.startPrice)} gold`,
      a.currentBid !== null
        ? `Top bid: ${fmt(a.currentBid)} gold by ${nameOf.get(a.currentBidder!) ?? a.currentBidder} · next bid at least ${fmt(minNextBid(a))} gold`
        : "No bids yet — the starting price is the minimum bid.",
      a.status === "open"
        ? `Seller gets the winning bid minus a 5% fee (${a.currentBid !== null ? `would be ${fmt(sellerProceeds(a.currentBid))} gold on ${fmt(a.currentBid)}` : "no bids yet"}). No bids at close → the item goes back to the seller.`
        : "",
    ];
    if (bids.length > 0) {
      lines.push("Recent bids:");
      bids.forEach((b, i) => {
        lines.push(`  ${fmt(b.amount)} gold — ${bidNames[i] ?? b.bidderId}${b.refunded ? " (refunded)" : ""}`);
      });
    }
    await inv.reply({ content: lines.filter(Boolean).join("\n") });
  } catch (e) {
    console.error("uwu: auction info failed:", e instanceof Error ? e.message : e);
    await replyError(inv, "Couldn't load that auction — try again in a bit.");
  }
}

async function handleAuctionCancel(
  inv: Parameters<Command["execute"]>[0],
  ctx: CommandContext,
  target: string,
): Promise<void> {
  const auctionId = Number(target.trim());
  if (!Number.isInteger(auctionId) || auctionId <= 0) {
    await replyError(inv, "Usage: `uwu auction cancel <id>`.");
    return;
  }
  try {
    const res = await cancelAuction(ctx.db, ctx.guildId, auctionId, inv.user.id, Date.now());
    if (!res.ok) {
      await replyError(inv, res.error ?? "Couldn't cancel that listing.");
      return;
    }
    await inv.reply({ content: `Cancelled auction #${auctionId} — your item is back in your zoo/inventory.` });
  } catch (e) {
    console.error("uwu: auction cancel failed:", e instanceof Error ? e.message : e);
    await replyError(inv, "Couldn't cancel that listing — try again in a bit.");
  }
}

async function handleAuctionMine(inv: Parameters<Command["execute"]>[0], ctx: CommandContext): Promise<void> {
  const now = Date.now();
  try {
    const mine = await listMyAuctions(ctx.db, inv.user.id, now);
    if (mine.length === 0) {
      await inv.reply({ content: "You have no open listings — list something with `uwu auction sell <item> <price>`." });
      return;
    }
    const lines = mine.map((a) => auctionLine(a, "you"));
    await inv.reply({ content: `Your open listings:\n${lines.join("\n")}` });
  } catch (e) {
    console.error("uwu: auction mine failed:", e instanceof Error ? e.message : e);
    await replyError(inv, "Couldn't load your listings — try again in a bit.");
  }
}

function shopLine(item: { id: string; name: string; price: number; currency: string; qtyPerPlayer: number; blurb: string }): string {
  const price = item.currency === "gems" ? `${fmt(item.price)} 💎 gems` : `${fmt(item.price)} gold`;
  return `· ${item.name} — ${price} (max ${item.qtyPerPlayer}/day)\n  ${item.blurb}`;
}

async function handleShopShow(inv: Parameters<Command["execute"]>[0], ctx: CommandContext): Promise<void> {
  try {
    const dateStr = utcDayString(Date.now());
    const stock = await getTodayStock(ctx.db, dateStr);
    const gems = await getGems(ctx.db, inv.user.id);
    await inv.reply({
      content:
        `🛒 Today's shop — ${dateStr} (same for everyone, refreshes at midnight UTC)\n` +
        `${stock.map(shopLine).join("\n")}\n` +
        `You have ${fmt(gems)} 💎 gems. Buy with \`uwu shop buy <item> [qty]\` — max ${SHOP_QTY_PER_PLAYER} of each item per day.`,
    });
  } catch (e) {
    console.error("uwu: shop failed:", e instanceof Error ? e.message : e);
    await replyError(inv, "Couldn't load the shop — try again in a bit.");
  }
}

async function handleShopBuy(
  inv: Parameters<Command["execute"]>[0],
  ctx: CommandContext,
  target: string,
): Promise<void> {
  const tokens = target.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) {
    await replyError(inv, "Usage: `uwu shop buy <item> [qty]` — e.g. `uwu shop buy Heal Potion 2`.");
    return;
  }
  // `uwu shop buy bg <name>` — profile backgrounds are a PERMANENT
  // catalogue, not daily stock: they never go through buyFromShop.
  if (tokens[0]!.toLowerCase() === "bg") {
    return handleShopBuyBg(inv, ctx, tokens.slice(1).join(" "));
  }
  let qty = 1;
  let nameTokens = tokens;
  const last = tokens[tokens.length - 1]!;
  if (/^\d+$/.test(last) && tokens.length > 1) {
    qty = Number(last);
    nameTokens = tokens.slice(0, -1);
  }
  const query = nameTokens.join(" ").toLowerCase();
  try {
    const stock = generateShopStock(utcDayString(Date.now()));
    const item =
      stock.find((i) => i.id === query || i.name.toLowerCase() === query) ??
      stock.find((i) => i.name.toLowerCase().startsWith(query));
    if (!item) {
      await replyError(inv, `That isn't in today's shop — check \`uwu shop\` for what's on sale.`);
      return;
    }
    const res = await buyFromShop(ctx.db, ctx.guildId, inv.user.id, item.id, qty, Date.now());
    if (!res.ok || !res.item) {
      await replyError(inv, res.error ?? "Couldn't buy that.");
      return;
    }
    const paid = res.item.currency === "gems" ? `${fmt(res.total ?? 0)} 💎 gems` : `${fmt(res.total ?? 0)} gold`;
    const where =
      res.item.kind === "crate"
        ? "It's in your crates — open it with `uwu open`."
        : res.item.kind === "weapon"
          ? "It's in your inventory — equip it from `uwu inv`."
          : "It's in your inventory.";
    await inv.reply({
      content:
        `🛒 Bought ${qty} × ${res.item.name} for ${paid} (${res.boughtToday}/${res.item.qtyPerPlayer} today).\n${where}`,
    });
  } catch (e) {
    console.error("uwu: shop buy failed:", e instanceof Error ? e.message : e);
    await replyError(inv, "Couldn't buy that — try again in a bit.");
  }
}

const BG_PAGE_SIZE = 10;

/**
 * One page of the background catalogue in the OwO big-list shop
 * format (src/lib/shopFormat.ts): numbered rows 1–30 in manifest
 * order, dotted leader to a compact price, [static]/[GIF] trailing
 * mark, owned ✓ / equipped ★ kept — 10 per page, ◀ N ▶ buttons.
 * The free Default is not numbered (it is never sold); it renders
 * as a header line. Numbers are stable catalogue positions, so
 * `uwu shop buy bg <number>` buys the same entry the list shows.
 */
async function shopBgPageContent(
  ctx: CommandContext,
  userId: string,
  wantedPage: number,
): Promise<{ content: string; page: number; pageCount: number }> {
  const bgs = listBackgrounds();
  const pageCount = Math.max(1, Math.ceil(bgs.length / BG_PAGE_SIZE));
  const page = Math.min(Math.max(0, Math.floor(wantedPage) || 0), pageCount - 1);
  const owned = new Set(await getOwnedBackgrounds(ctx.db, userId));
  const equipped = (await getUserProfile(ctx.db, userId)).equippedBg;
  const bal = await getBalance(ctx.db, ctx.guildId, userId);
  const slice = bgs.slice(page * BG_PAGE_SIZE, (page + 1) * BG_PAGE_SIZE);
  const lines = [
    `🖼️ Profile Backgrounds — ${bgs.length} total, permanent catalogue, never rotates (you have ${fmt(bal.points)} gold):`,
    "• `uwu shop buy bg <number|name>` to buy · `uwu bg <name>` to equip · `uwu profile` to see your card",
    `· Default — free [static]${equipped === DEFAULT_BG_ID ? " ★ equipped" : " ✓ owned"}`,
  ];
  slice.forEach((b, i) => {
    const num = page * BG_PAGE_SIZE + i + 1;
    const marks = `${owned.has(b.id) ? " ✓" : ""}${equipped === b.id ? " ★" : ""}`;
    const kind = b.type === "animated" ? "[GIF]" : "[static]";
    lines.push(shopRow(num, "🖼️", b.name, `${compactGold(b.price)} ${kind}`, marks));
  });
  lines.push(`Page ${page + 1}/${pageCount}`);
  return { content: lines.join("\n"), page, pageCount };
}

async function handleShopBgList(
  inv: Parameters<Command["execute"]>[0],
  ctx: CommandContext,
  pageArg = "",
): Promise<void> {
  try {
    const bgs = listBackgrounds();
    if (bgs.length === 0) {
      await replyError(inv, "Profile backgrounds aren't available yet — the background catalogue hasn't landed. Try again later.");
      return;
    }
    // `uwu shop bg 2` jumps straight to page 2 (OwO's shop takes a page).
    const wanted = /^\d+$/.test(pageArg.trim()) ? Number(pageArg.trim()) - 1 : 0;
    const { content, page, pageCount } = await shopBgPageContent(ctx, inv.user.id, wanted);
    await inv.reply({
      content,
      components: pageCount > 1 ? pageButtons("selena:shopbg:list", page, pageCount) : [],
    });
  } catch (e) {
    console.error("uwu: shop bg failed:", e instanceof Error ? e.message : e);
    await replyError(inv, "Couldn't load the backgrounds — try again in a bit.");
  }
}

async function handleShopBgListButton(inv: any, ctx: CommandContext): Promise<void> {
  const parts = String(inv.customId ?? "").split(":");
  const wanted = Number.parseInt(parts[3] ?? "0", 10);
  const userId = String(inv.user?.id ?? "");
  try {
    const { content, page, pageCount } = await shopBgPageContent(ctx, userId, Number.isNaN(wanted) ? 0 : wanted);
    await inv.update({
      content,
      components: pageCount > 1 ? pageButtons("selena:shopbg:list", page, pageCount) : [],
    });
  } catch (e) {
    try {
      await inv.reply({ content: "Couldn't load that page — try `uwu shop bg` again.", ephemeral: true });
    } catch {
      // The interaction is already answered/expired; nothing more to do.
    }
  }
}

async function handleShopBuyBg(
  inv: Parameters<Command["execute"]>[0],
  ctx: CommandContext,
  query: string,
): Promise<void> {
  const q = query.trim();
  if (!q) {
    await replyError(inv, "Usage: `uwu shop buy bg <number|name>` — see `uwu shop bg` for the full list.");
    return;
  }
  // Buy by list number (`uwu shop buy bg 5`) — the numbers are the
  // stable catalogue positions the list shows; anything else resolves
  // by name/id exactly as before.
  const bgs = listBackgrounds();
  let bg;
  if (/^\d+$/.test(q)) {
    const n = Number(q);
    bg = n >= 1 && n <= bgs.length ? bgs[n - 1] : undefined;
    if (!bg) {
      await replyError(inv, `There's no background #${q} — the list runs 1–${bgs.length}. See \`uwu shop bg\`.`);
      return;
    }
  } else {
    bg = findBackground(q);
    if (!bg) {
      await replyError(inv, `I don't know a background called "${q}" — see \`uwu shop bg\` for the full list.`);
      return;
    }
  }
  try {
    const res = await buyBackground(ctx.db, ctx.guildId, inv.user.id, bg.id, Date.now());
    if (!res.ok) {
      await replyError(inv, res.error ?? "Couldn't buy that background.");
      return;
    }
    await inv.reply({
      content:
        `🖼️ Bought **${res.bgName}** for ${fmt(res.price ?? 0)} gold — you have ${fmt(res.remainingGold ?? 0)} gold left.\n` +
        `Equip it with \`uwu bg ${res.bgName}\` and see it on \`uwu profile\`.`,
    });
  } catch (e) {
    console.error("uwu: shop buy bg failed:", e instanceof Error ? e.message : e);
    await replyError(inv, "Couldn't buy that background — try again in a bit.");
  }
}

async function handleCrates(inv: Parameters<Command["execute"]>[0], ctx: CommandContext): Promise<void> {
  try {
    const crates = await getUserCrates(ctx.db, inv.user.id);
    if (crates.length === 0) {
      await inv.reply({
        content:
          "You don't have any crates yet — they drop from tower floors, hunts, and bosses, and sometimes show up in `uwu shop`.\n" +
          `Tiers: ${CRATE_TIERS.map((c) => c.name).join(" · ")}.`,
      });
      return;
    }
    const lines = crates.map((c) => `· ${c.tier.name} ×${c.qty}`);
    await inv.reply({
      content: `📦 Your crates:\n${lines.join("\n")}\nOpen one with \`uwu open <crate>\` — e.g. \`uwu open wooden crate\`.`,
    });
  } catch (e) {
    console.error("uwu: crates failed:", e instanceof Error ? e.message : e);
    await replyError(inv, "Couldn't load your crates — try again in a bit.");
  }
}

async function handleOpen(inv: Parameters<Command["execute"]>[0], ctx: CommandContext, target: string): Promise<void> {
  const q = target.trim().toLowerCase().replace(/\s+/g, " ");
  const tier =
    CRATE_TIERS.find((c) => c.slug === q || c.name.toLowerCase() === q || `crate ${c.slug}` === q) ??
    CRATE_TIERS.find((c) => q.includes(c.slug));
  if (!tier) {
    await replyError(
      inv,
      `Which crate? Try \`uwu open wooden crate\` — tiers: ${CRATE_TIERS.map((c) => c.slug).join(", ")}.`,
    );
    return;
  }
  try {
    const res = await openCrate(ctx.db, ctx.guildId, inv.user.id, tier.slug, Date.now());
    if (!res.ok || !res.drops) {
      await replyError(inv, res.error ?? "Couldn't open that crate.");
      return;
    }
    const article = /^[AEIOU]/i.test(tier.name) ? "an" : "a";
    await inv.reply({
      content: `📦 You opened ${article} ${tier.name}!\nInside: ${res.drops.map((d) => d.label).join(" · ")}`,
    });
  } catch (e) {
    console.error("uwu: open crate failed:", e instanceof Error ? e.message : e);
    await replyError(inv, "Couldn't open that crate — try again in a bit.");
  }
}

async function handleGems(inv: Parameters<Command["execute"]>[0], ctx: CommandContext): Promise<void> {
  try {
    const gems = await getGems(ctx.db, inv.user.id);
    const bal = await getBalance(ctx.db, ctx.guildId, inv.user.id);
    await inv.reply({
      content:
        `💎 You have ${fmt(gems)} gems (and ${fmt(bal.points)} gold).\n` +
        `Earn gems from crates, tower bosses, and sacrificing monsters — spend them on rare shop items like Evolution Stones.`,
    });
  } catch (e) {
    console.error("uwu: gems failed:", e instanceof Error ? e.message : e);
    await replyError(inv, "Couldn't load your gems — try again in a bit.");
  }
}

export const commands: Command[] = [
  {
    name: "auction",
    description: "Auction house — sell, bid, browse, and check listings across Discord.",
    aliases: ["auctions"],
    args: [
      { name: "action", type: "string" },
      { name: "target", type: "string", rest: true },
    ],
    async execute(inv, ctx) {
      const action = (inv.options.getString("action") ?? "").trim().toLowerCase();
      const target = inv.options.getString("target") ?? "";
      if (!action || action === "list" || action === "browse") return handleAuctionList(inv, ctx);
      if (action === "sell") return handleAuctionSell(inv, ctx, target);
      if (action === "bid") return handleAuctionBid(inv, ctx, target);
      if (action === "info") return handleAuctionInfo(inv, ctx, target);
      if (action === "cancel") return handleAuctionCancel(inv, ctx, target);
      if (action === "mine" || action === "my") return handleAuctionMine(inv, ctx);
      await inv.reply({
        content:
          "Auction house — `uwu auction sell <item> <price>` · `uwu auction bid <id> <amount>` · `uwu auction list` · `uwu auction info <id>` · `uwu auction cancel <id>` · `uwu auction mine`.\n" +
          `Listings run 24h, bids are binding with gold held in escrow, and the seller pays a 5% fee on a sale.`,
      });
    },
  },
  {
    name: "shop",
    description: "Today's shop — same stock for everyone, refreshes at midnight UTC.",
    aliases: ["store"],
    args: [
      { name: "action", type: "string" },
      { name: "item", type: "string", rest: true },
    ],
    async execute(inv, ctx) {
      const action = (inv.options.getString("action") ?? "").trim().toLowerCase();
      const target = inv.options.getString("item") ?? "";
      if (action === "buy") return handleShopBuy(inv, ctx, target);
      if (action === "bg") return handleShopBgList(inv, ctx, target);
      if (!action) return handleShopShow(inv, ctx);
      await inv.reply({ content: "Shop — `uwu shop` to browse, `uwu shop buy <item> [qty]` to buy, `uwu shop bg` for profile backgrounds." });
    },
  },
  {
    name: "crates",
    description: "List the crates you own.",
    aliases: ["crate"],
    async execute(inv, ctx) {
      return handleCrates(inv, ctx);
    },
  },
  {
    name: "open",
    description: "Open one crate and reveal its loot.",
    aliases: ["opencrate"],
    args: [{ name: "crate", type: "string", rest: true }],
    async execute(inv, ctx) {
      return handleOpen(inv, ctx, inv.options.getString("crate") ?? "");
    },
  },
  {
    name: "gems",
    description: "Show your gem balance and how to earn gems.",
    aliases: ["gem"],
    async execute(inv, ctx) {
      return handleGems(inv, ctx);
    },
  },
];

export const buttonHandlers: Record<string, (...args: never[]) => Promise<void>> = {
  "selena:shopbg": handleShopBgListButton as (...args: never[]) => Promise<void>,
};

export const modalHandlers: Record<string, (...args: never[]) => Promise<void>> = {};

// Re-export the close sweep for the coordinator's 60s due-task sweep
// (src/index.ts): closeDueAuctions(db, client, Date.now()).
export { closeDueAuctions };
export { AUCTION_DURATION_MS, auctionFee, sellerProceeds };
