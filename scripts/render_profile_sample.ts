/**
 * Sample profile-card render: generates a local animated gradient GIF
 * background + a test avatar (no Worker A assets needed), renders a
 * card with renderProfileCard, and writes it to sample-profile-card.gif
 * in the repo root. Run: npx tsx scripts/render_profile_sample.ts
 */
import { writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import GIFEncoder from "gif-encoder-2";
import { renderProfileCard } from "../src/lib/profileCard.js";

const W = 800;
const H = 500;

async function makeAnimatedBg(): Promise<string> {
  const hues: Array<[string, string]> = [
    ["#1a2a6c", "#b21f1f"],
    ["#134e5e", "#71b280"],
    ["#41295a", "#2f0743"],
    ["#0f2027", "#2c5364"],
    ["#42275a", "#734b6d"],
    ["#141e30", "#243b55"],
  ];
  const frames: Buffer[] = [];
  for (const [c1, c2] of hues) {
    const svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
      <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/>
      </linearGradient></defs>
      <rect width="${W}" height="${H}" fill="url(#g)"/>
      <circle cx="650" cy="90" r="120" fill="#ffffff" fill-opacity="0.08"/>
      <circle cx="120" cy="420" r="160" fill="#ffffff" fill-opacity="0.06"/>
    </svg>`;
    const { data } = await sharp(Buffer.from(svg)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    frames.push(data);
  }
  const gif = await new Promise<Buffer>((resolve, reject) => {
    const enc = new GIFEncoder(W, H);
    const chunks: Buffer[] = [];
    const stream = enc.createReadStream();
    stream.on("data", (c: Buffer) => chunks.push(c));
    stream.on("error", reject);
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    enc.start();
    enc.setRepeat(0);
    enc.setDispose(2);
    enc.setQuality(10);
    for (const f of frames) {
      enc.setDelay(120);
      enc.addFrame(f);
    }
    enc.finish();
  });
  const out = path.join(await mkdtemp(path.join(tmpdir(), "profile-bg-")), "bg.gif");
  await writeFile(out, gif);
  return out;
}

async function makeAvatar(): Promise<Buffer> {
  const svg = `<svg width="256" height="256" xmlns="http://www.w3.org/2000/svg">
    <rect width="256" height="256" fill="#7c3aed"/>
    <circle cx="128" cy="100" r="52" fill="#c4b5fd"/>
    <rect x="48" y="168" width="160" height="88" rx="40" fill="#c4b5fd"/>
    <text x="128" y="118" text-anchor="middle" font-family="DejaVu Sans" font-size="56" font-weight="bold" fill="#4c1d95">RS</text>
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

async function main(): Promise<void> {
  const bgPath = await makeAnimatedBg();
  const avatar = await makeAvatar();
  const buf = await renderProfileCard({
    backgroundPath: bgPath,
    avatarBuffer: avatar,
    displayName: "Ronit Shrimankar",
    level: 27,
    rank: 3,
    xpIntoLevel: 1250,
    xpForNextLevel: 5000,
    gold: 12500,
    gems: 42,
    about: "Full-stack dev, hackathon enjoyer, and uwu hunter. Building things on Solana and Discord.",
    monstersCaught: 37,
    guildName: "FORTEC",
  });
  const out = path.resolve("sample-profile-card.gif");
  await writeFile(out, buf);
  console.log(`wrote ${out} (${buf.length} bytes, magic=${buf.subarray(0, 6).toString("ascii")})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
