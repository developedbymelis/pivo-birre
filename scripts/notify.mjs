// PIVO robot — invia gli avvisi in outbox.json al telefono (ntfy), con le story allegate. Poi svuota l'outbox.
import { readFile, rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import path from "node:path";

const DIR = process.env.PIVO_DIR || process.cwd();
const readJSON = async (f, d) => { try { return JSON.parse(await readFile(path.join(DIR, f), "utf8")); } catch { return d; } };
const TXT = { tr: { title: "PIVO · musluk değişikliği", story: "Story hazır", hint: "Kaydet ve Instagram'da story olarak paylaş." },
              it: { title: "PIVO · cambio spine", story: "Story pronta", hint: "Salvala e pubblicala come story su Instagram." } };

export async function run({ log = console.log } = {}) {
  const out = await readJSON("outbox.json", null);
  if (!out) return 0;
  const cfg = await readJSON("config.json", {});
  const L = TXT[cfg.notify_lang] || TXT.tr;
  const topic = process.env.NTFY_TOPIC, base = process.env.NTFY_URL || "https://ntfy.sh";
  const repo = process.env.GITHUB_REPOSITORY, branch = process.env.GITHUB_REF_NAME || "main";
  const click = cfg.menu_url || "https://pivobirreria.netlify.app/menu";
  if (!topic) { log("Avvisi non inviati: NTFY_TOPIC non impostato."); await rm(path.join(DIR, "outbox.json"), { force: true }); return 0; }
  const msgs = [];
  if ((out.lines || []).length) msgs.push({ topic, title: L.title, message: out.lines.join("\n"), tags: ["beer"], click });
  for (const im of out.images || []) {
    const m = { topic, title: `${L.story} · ${im.name}`, message: L.hint, tags: ["camera"], filename: path.basename(im.path) };
    if (repo) m.attach = `https://raw.githubusercontent.com/${repo}/${branch}/${im.path}`;
    msgs.push(m);
  }
  let sent = 0;
  for (const m of msgs) {
    const r = await fetch(base, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(m) }).catch(e => ({ ok: false, status: e.message }));
    if (r.ok) sent++; else log(`Avviso NON inviato: ntfy ${r.status}`);
  }
  log(`Avvisi inviati: ${sent}/${msgs.length}`);
  await rm(path.join(DIR, "outbox.json"), { force: true });
  return sent;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch(e => { console.error("ERRORE avvisi:", e.message); process.exit(0); });
}
