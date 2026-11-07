import { describe, expect, it } from "vitest";
import { compactGold, dotted, pageButtons, shopRow } from "../src/lib/shopFormat.js";

/**
 * The OwO big-list shop format (Ron's order, 2026-11-07): numbered
 * rows, dotted leader to a compact price/value, trailing icon —
 * paginated 10 per page with ◀ N ▶ buttons.
 */

describe("compactGold — OwO-style compact prices", () => {
  it("compacts like OwO (10, 100, 1K, 10K, 100K, 1M, 10M)", () => {
    expect(compactGold(0)).toBe("0");
    expect(compactGold(10)).toBe("10");
    expect(compactGold(100)).toBe("100");
    expect(compactGold(999)).toBe("999");
    expect(compactGold(1000)).toBe("1K");
    expect(compactGold(1500)).toBe("1.5K");
    expect(compactGold(12000)).toBe("12K");
    expect(compactGold(48000)).toBe("48K");
    expect(compactGold(100000)).toBe("100K");
    expect(compactGold(1000000)).toBe("1M");
    expect(compactGold(2500000)).toBe("2.5M");
    expect(compactGold(10000000)).toBe("10M");
  });
});

describe("dotted leader", () => {
  it("pads a name to 30 chars with dots, minimum 3", () => {
    expect(dotted("Neon Street")).toBe(`Neon Street${".".repeat(19)}`);
    expect(dotted("???")).toBe(`???${".".repeat(27)}`);
    expect(dotted("A".repeat(40))).toBe(`${"A".repeat(40)}...`);
  });
});

describe("shopRow — one OwO-shop row", () => {
  it("builds a numbered row with dotted leader, value and marks", () => {
    const row = shopRow(1, "🖼️", "Neon Street", "20K [static]", " ✓");
    expect(row.startsWith("1  🖼️ Neon Street")).toBe(true);
    expect(row).toContain("...................");
    expect(row.endsWith("20K [static] ✓")).toBe(true);
  });

  it("works without an emoji (the ??? tower rows)", () => {
    expect(shopRow(2, "", "???", "undiscovered")).toBe(`2  ${dotted("???")} undiscovered`);
  });
});

describe("pageButtons — OwO ◀ N ▶ buttons", () => {
  function labels(page: number, pageCount: number): { label: string; customId: string; disabled?: boolean }[] {
    const row = pageButtons("selena:shopbg:list", page, pageCount)[0]!;
    const json = row.toJSON() as unknown as {
      components: { label?: string; custom_id?: string; disabled?: boolean }[];
    };
    return json.components.map((b) => ({ label: b.label ?? "", customId: b.custom_id ?? "", disabled: b.disabled }));
  }

  it("is ◀, current page number, ▶ with the right disabled states", () => {
    const first = labels(0, 3);
    expect(first.map((b) => b.label)).toEqual(["◀", "1", "▶"]);
    expect(first[0]!.disabled).toBe(true);
    expect(first[1]!.disabled).toBe(true);
    expect(first[2]!.disabled).toBe(false);
    expect(first[2]!.customId).toBe("selena:shopbg:list:1");
    const last = labels(2, 3);
    expect(last.map((b) => b.label)).toEqual(["◀", "3", "▶"]);
    expect(last[0]!.disabled).toBe(false);
    expect(last[2]!.disabled).toBe(true);
    expect(last[0]!.customId).toBe("selena:shopbg:list:1");
  });
});
