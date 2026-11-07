import { randomInt } from "node:crypto";

/** Crypto-backed random integer in [min, max). Use for all gambling. */
export function secureInt(min: number, max: number): number {
  return randomInt(min, max);
}

/** Crypto-backed random float in [0, 1). */
export function secureFloat(): number {
  // 48 bits of randomness -> float
  const buf = new Uint32Array(2);
  crypto.getRandomValues(buf);
  return (buf[0] * 2 ** 32 + buf[1]) / 2 ** 64;
}

/** Pick a random element from a non-empty array. */
export function securePick<T>(arr: readonly T[]): T {
  if (arr.length === 0) throw new Error("securePick: empty array");
  return arr[secureInt(0, arr.length)] as T;
}

/**
 * Deterministic PRNG (mulberry32) for tests and for reproducible simulations.
 * NEVER use for real gambling outcomes — those must use secureInt.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Weighted random pick. entries: [value, weight]. Weights must be > 0. */
export function weightedPick<T>(entries: readonly (readonly [T, number])[], rand: () => number = secureFloat): T {
  const total = entries.reduce((s, [, w]) => s + w, 0);
  if (total <= 0) throw new Error("weightedPick: total weight must be > 0");
  let roll = rand() * total;
  for (const [value, weight] of entries) {
    roll -= weight;
    if (roll <= 0) return value;
  }
  return entries[entries.length - 1]![0];
}
