// PIVO robot — story Instagram animata (MP4 1080x1920, 8 s) per ogni birra nuova in outbox.json.
// Usa story/template.html (stesse schede, colori e bicchieri del menu): ogni fotogramma viene disegnato
// con storyFrame(t), catturato con Chromium e unito con ffmpeg. Se ffmpeg manca, resta l'immagine PNG.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import path from "node:path";

const DIR = process.env.PIVO_DIR || process.cwd();
const FPS = 30;
const readJSON = async (f, d) => { try { return JSON.parse(await readFile(path.join(DIR, f), "utf8")); } catch { return d; } };
const slug = (t) => String(t || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
const hasFfmpeg = () => spawnSync("ffmpeg", ["-version"]).status === 0;

async function video(page, file, dur) {
  const ff = spawn("ffmpeg", ["-v", "error", "-y", "-f", "image2pipe", "-framerate", String(FPS), "-i", "-",
    "-c:v", "libx264", "-preset", "medium", "-crf", "19", "-pix_fmt", "yuv420p", "-movflags", "+faststart", file], { stdio: ["pipe", "inherit", "inherit"] });
  const done = new Promise((ok, ko) => ff.on("close", c => c === 0 ? ok() : ko(new Error("ffmpeg " + c))));
  const n = Math.round(dur * FPS);
  for (let k = 0; k < n; k++) {
    await page.evaluate((t) => window.storyFrame(t), k / FPS);
    const buf = await page.screenshot({ type: "jpeg", quality: 92 });
    if (!ff.stdin.write(buf)) await new Promise(r => ff.stdin.once("drain", r));
  }
  ff.stdin.end();
  await done;
}

export async function run({ log = console.log } = {}) {
  const out = await readJSON("outbox.json", null);
  if (!out || !(out.newTaps || []).length) { log("Story: nessuna birra nuova."); return []; }
  const { chromium } = await import("playwright");
  const ai = await readJSON("profiles.json", {});
  const ff = hasFfmpeg(); if (!ff) log("Story: ffmpeg non trovato, solo immagini PNG.");
  const browser = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
  const page = await browser.newPage({ viewport: { width: 1080, height: 1920 }, deviceScaleFactor: 1 });
  await page.goto(pathToFileURL(path.join(DIR, "story", "template.html")).href);
  await page.evaluate(() => document.fonts.ready);
  await mkdir(path.join(DIR, "stories"), { recursive: true });
  const day = new Date().toISOString().slice(0, 10), images = [];
  for (const n of out.newTaps) {
    try {
      const info = await page.evaluate(([d, a]) => window.renderStory(d, a, "NUOVA SPINA"), [n.draft, ai]);
      await page.evaluate(() => document.fonts.ready);
      const dur = await page.evaluate(() => window.STORY_DURATION);
      const base = `stories/${day}-spina-${slug(n.tap)}-${slug(info.name)}`;
      await page.evaluate((t) => window.storyFrame(t), dur);
      await page.screenshot({ path: path.join(DIR, base + ".png") });
      let file = base + ".png";
      if (ff) {
        try { await video(page, path.join(DIR, base + ".mp4"), dur); file = base + ".mp4"; }
        catch (e) { log(`Story spina ${n.tap}: video non riuscito (${e.message}), mando l'immagine.`); }
      }
      images.push({ tap: n.tap, name: info.name, path: file });
      log(`Story: ${file}`);
    } catch (e) { log(`Story spina ${n.tap}: ERRORE ${e.message}`); }
  }
  await browser.close();
  out.images = images;
  await writeFile(path.join(DIR, "outbox.json"), JSON.stringify(out, null, 2));
  return images;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch(e => { console.error("ERRORE story:", e.message); process.exit(0); });
}
