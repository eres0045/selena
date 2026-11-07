import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

/**
 * Profile backgrounds — the permanent catalogue (Worker A owns the asset
 * files in assets/profile-bgs/ and the manifest.json that lists them).
 *
 * Manifest shape (assets/profile-bgs/manifest.json): an array of
 *   { id, name, file, price, type, source_url }
 * where `type` is "static" (image) or "animated" (GIF), including a
 * default entry { id: "default", name: "Default",
 * file: "default.png", price: 0, type: "static" }. The default is free
 * and always available; the other 30 entries are the buyable
 * catalogue — 10 static (low price, roughly 10k–20k gold) and 20
 * animated GIFs (high price, roughly 25k–50k gold). Prices come from
 * the manifest, never hardcoded here.
 *
 * The manifest is read from disk ONCE at import, resolved relative to
 * this module file. When it is missing or unreadable (Worker A hasn't
 * landed it yet, or the file is corrupt) the exports degrade to an
 * empty list instead of crashing the bot at boot — commands that need
 * a background then fail with a clear error. Tests may point the loader
 * at a fixture manifest with the SELENA_PROFILE_BGS_MANIFEST env var
 * (absolute path), set before this module is first imported.
 */

export interface ProfileBackground {
  id: string;
  name: string;
  file: string;
  price: number;
  /** "static" = still image, "animated" = GIF. */
  type: "static" | "animated";
  source_url?: string;
}

export const DEFAULT_BG_ID = "default";

function manifestPath(): string {
  const override = process.env.SELENA_PROFILE_BGS_MANIFEST?.trim();
  if (override) return override;
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../assets/profile-bgs/manifest.json");
}

function loadManifest(): ProfileBackground[] {
  try {
    const raw = readFileSync(manifestPath(), "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e): e is ProfileBackground =>
        !!e &&
        typeof e === "object" &&
        typeof (e as ProfileBackground).id === "string" &&
        typeof (e as ProfileBackground).name === "string" &&
        typeof (e as ProfileBackground).file === "string" &&
        typeof (e as ProfileBackground).price === "number" &&
        ((e as ProfileBackground).type === "static" || (e as ProfileBackground).type === "animated"),
    );
  } catch {
    // Missing/unreadable manifest: degrade to an empty catalogue, never
    // crash the bot at boot. Commands fail with a clear error instead.
    return [];
  }
}

const ALL_BGS: ProfileBackground[] = loadManifest();

/** The buyable catalogue — the 30 entries, excluding the free default. */
export const PROFILE_BGS: ProfileBackground[] = ALL_BGS.filter((b) => b.id !== DEFAULT_BG_ID);

/** One entry by id (including the default), or undefined when unknown. */
export function getBackground(id: string): ProfileBackground | undefined {
  return ALL_BGS.find((b) => b.id === id);
}

/** All buyable backgrounds (the 30 catalogue entries). */
export function listBackgrounds(): ProfileBackground[] {
  return [...PROFILE_BGS];
}

/**
 * Absolute path to a background's image file, or undefined when the id
 * is unknown. The file itself is Worker A's asset; this only resolves
 * the path.
 */
export function backgroundPath(id: string): string | undefined {
  const bg = getBackground(id);
  if (!bg) return undefined;
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../assets/profile-bgs", bg.file);
}
