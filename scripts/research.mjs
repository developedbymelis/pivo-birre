// PIVO robot — trova le birre nuove su YHOP e chiede a Claude di ricercarle.
// Scrive SOLO note, valori 1-5, bicchiere, colori e gruppo di abbinamento in profiles.json.
// Nome, birrificio, stile, ABV e prezzi restano di YHOP: il robot non li tocca mai.
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import path from "node:path";

const DIR = process.env.PIVO_DIR || process.cwd();
const API = (process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com") + "/v1/messages";

export const GLASSES = ["pilsner", "nonic", "tulip", "snifter", "weizen"];
export const ACCENTS = ["#FF9E1B", "#FFC24B", "#2FBFA8", "#F5263A", "#182124", "#5A3520"];
const HEX = /^#[0-9A-Fa-f]{6}$/;
const HEARTBEAT_DAYS = 6; // GitHub ferma i robot dei repository pubblici dopo 60 giorni senza attività

async function readJSON(file, fallback) {
  try { return JSON.parse(await readFile(path.join(DIR, file), "utf8")); } catch { return fallback; }
}
async function writeJSON(file, data) {
  await writeFile(path.join(DIR, file), JSON.stringify(data, null, 2) + "\n");
}

export function buildPrompt(beer, cfg) {
  const groups = cfg.pairing_groups.map(g => `${g.chip} = ${g.name} (${g.foods.join(", ")})`).join("\n");
  return `Sei il sommelier di PIVO, birreria a Bergamo. Ricerca questa birra alla spina e prepara la sua scheda per il menu.

BIRRA (dati ufficiali da YHOP, non modificarli):
- Nome: ${beer.name}
- Birrificio: ${beer.brewery}
- Stile: ${beer.style}
- ABV: ${beer.abv}%

COSA FARE
1. Cerca sul web informazioni su QUESTA birra precisa (sito del birrificio, Untappd, RateBeer, negozi specializzati): luppoli, malti, frutta o ingredienti speciali, colore, profilo aromatico.
2. Se trovi poco o nulla, basati sullo stile e metti "confidence": "low". Non inventare ingredienti specifici che non hai trovato.

RISPONDI SOLO con un oggetto JSON, senza testo prima o dopo:
{
  "note_it": "nota di degustazione in italiano, 70-120 caratteri, stile: 'West Coast IPA secca e luppolata: resina, pino e agrumi, amaro deciso e finale pulito.'",
  "note_en": "la stessa nota in inglese, 50-100 caratteri",
  "key_it": "tre parole di gusto separate da ' · ', es. 'resina · pino · agrumi'",
  "key_en": "le stesse tre parole in inglese, es. 'resin · pine · citrus'",
  "bitterness": 1-5,
  "body": 1-5,
  "aroma": 1-5,
  "glass": uno tra ${GLASSES.join(" | ")} (pilsner=calice alto e stretto per pils e lager; nonic=pinta per IPA, pale ale, porter; tulip=tulipano per belghe, saison, ambrate; snifter=balloon per stout e birre forti; weizen=bicchiere alto per frumento, gose e sour),
  "beer_color": "#RRGGBB, colore reale della birra nel bicchiere",
  "foam_color": "#RRGGBB, colore della schiuma",
  "accent": uno tra ${ACCENTS.join(" | ")} (colore della scheda: scegli quello che richiama meglio la birra),
  "pairing_group": numero del gruppo di abbinamento più adatto, scelto SOLO tra questi:
${groups}
  "confidence": "high" se hai trovato informazioni sulla birra precisa, "medium" se parziali, "low" se solo lo stile,
  "sources": ["url delle fonti usate"]
}`;
}

export function extractJSON(text) {
  const end = text.lastIndexOf("}");
  for (let start = text.lastIndexOf("{", end); start >= 0; start = text.lastIndexOf("{", start - 1)) {
    try { return JSON.parse(text.slice(start, end + 1)); } catch { /* prova un'apertura precedente */ }
  }
  return null;
}

const clampInt = (v) => Number.isInteger(v) && v >= 1 && v <= 5;
const short = (t, max) => typeof t === "string" && t.trim().length >= 10 && t.trim().length <= max;

// risposta di Claude -> scheda pulita, oppure un errore leggibile
export function validate(r, cfg) {
  if (!r || typeof r !== "object") return { error: "nessun JSON" };
  const chips = cfg.pairing_groups.map(g => g.chip);
  const bad = [];
  if (!short(r.note_it, 220)) bad.push("note_it");
  if (!short(r.note_en, 200)) bad.push("note_en");
  if (typeof r.key_it !== "string" || r.key_it.length > 60) bad.push("key_it");
  if (!clampInt(r.bitterness) || !clampInt(r.body) || !clampInt(r.aroma)) bad.push("valori 1-5");
  if (!GLASSES.includes(r.glass)) bad.push("glass");
  if (!HEX.test(r.beer_color || "")) bad.push("beer_color");
  if (!HEX.test(r.foam_color || "")) bad.push("foam_color");
  if (!ACCENTS.includes(String(r.accent || "").toUpperCase())) bad.push("accent");
  if (!chips.includes(r.pairing_group)) bad.push("pairing_group");
  if (bad.length) return { error: "campi non validi: " + bad.join(", ") };
  return {
    profile: {
      note: r.note_it.trim(), noteEn: r.note_en.trim(), key: r.key_it.trim(),
      keyEn: typeof r.key_en === "string" && r.key_en.length <= 60 ? r.key_en.trim() : "",
      meters: [r.bitterness, r.body, r.aroma],
      glass: r.glass, liq: r.beer_color.toUpperCase(), foam: r.foam_color.toUpperCase(),
      acc: r.accent.toUpperCase(), chip: r.pairing_group,
      confidence: ["high", "medium", "low"].includes(r.confidence) ? r.confidence : "low",
      sources: Array.isArray(r.sources) ? r.sources.filter(u => typeof u === "string" && /^https?:\/\//.test(u)).slice(0, 5) : []
    }
  };
}

async function askClaude(beer, cfg, key) {
  const messages = [{ role: "user", content: buildPrompt(beer, cfg) }];
  const body = (msgs) => JSON.stringify({
    model: cfg.model, max_tokens: 1500, messages: msgs,
    tools: [{ type: cfg.web_search_tool, name: "web_search", max_uses: cfg.max_searches_per_beer }]
  });
  for (let turn = 0; turn < 3; turn++) {
    const res = await fetch(API, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: body(messages)
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`API ${res.status}: ${j.error && j.error.message || "errore"}`);
    if (j.stop_reason === "pause_turn") { messages.push({ role: "assistant", content: j.content }); continue; }
    const text = (j.content || []).filter(b => b.type === "text").map(b => b.text).join("\n");
    return { json: extractJSON(text), usage: j.usage };
  }
  throw new Error("risposta incompleta");
}

const clean = (t) => String(t == null ? "" : t).replace(/\s+/g, " ").trim();

// ------------------------------------------------------------------ avvisi sul telefono (ntfy)
const fmtAbv = (a) => (a == null || a === "" ? "" : String(a).replace(".", ",") + "%");
const fmtPrices = (g) => (g || []).filter(x => x && x.price != null)
  .sort((a, b) => a.volume - b.volume)
  .map(x => `${Math.round(x.volume / 10)} cl €${String(x.price).replace(".", ",")}`).join(" · ");
export function snapTaps(drafts) {
  const o = {};
  for (const d of drafts) {
    if (!d || d.identifier == null) continue;
    o[clean(d.identifier)] = { id: d.beer_id, name: clean(d.name), brewery: clean(d.brewery), style: clean(d.style),
      abv: d.abv, prices: fmtPrices(d.glasses) };
  }
  return o;
}
const T = {
  tr: { title: "PIVO · musluk değişikliği", newTap: (t, b) => `Musluk ${t}: ${b}`, changed: (t, a, b) => `Musluk ${t}: ${a} → ${b}`,
        removed: (t, a) => `Musluk ${t}: ${a} kaldırıldı`, price: (t, n, a, b) => `Musluk ${t} ${n}: fiyat ${a} → ${b}`,
        info: (t, n, w) => `Musluk ${t} ${n}: ${w}`, words: { name: "isim", brewery: "bira fabrikası", style: "stil", abv: "alkol oranı" },
        hello: "PIVO bildirimleri açık. Musluklarda bir şey değişince burada göreceksin." },
  it: { title: "PIVO · cambio spine", newTap: (t, b) => `Spina ${t}: ${b}`, changed: (t, a, b) => `Spina ${t}: ${a} → ${b}`,
        removed: (t, a) => `Spina ${t}: ${a} tolta`, price: (t, n, a, b) => `Spina ${t} ${n}: prezzo ${a} → ${b}`,
        info: (t, n, w) => `Spina ${t} ${n}: ${w}`, words: { name: "nome", brewery: "birrificio", style: "stile", abv: "gradazione" },
        hello: "Avvisi PIVO attivi. Quando cambia qualcosa alle spine lo vedrai qui." },
};
const full = (b) => [b.name, b.brewery, b.style, fmtAbv(b.abv)].filter(Boolean).join(" · ") + (b.prices ? `\n   ${b.prices}` : "");
export function diffTaps(before, after, lang = "tr", fresh = []) {
  const L = T[lang] || T.tr, out = [];
  const taps = [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .sort((a, b) => (parseFloat(a) - parseFloat(b)) || a.localeCompare(b));
  for (const t of taps) {
    const a = before[t], b = after[t];
    if (!a && b) { out.push(L.newTap(t, full(b))); fresh.push(t); }
    else if (a && !b) out.push(L.removed(t, a.name));
    else if (String(a.id) !== String(b.id)) { out.push(L.changed(t, a.name, full(b))); fresh.push(t); }
    else {
      const fv = (k, v) => (k === "abv" ? fmtAbv(v) : v) || "—";
      const w = ["name", "brewery", "style", "abv"].filter(k => String(a[k]) !== String(b[k]))
        .map(k => `${L.words[k]} ${fv(k, a[k])} → ${fv(k, b[k])}`);
      if (w.length) out.push(L.info(t, a.name, w.join(", ")));
      if (a.prices !== b.prices) out.push(L.price(t, b.name, a.prices || "—", b.prices || "—"));
    }
  }
  return out;
}

export async function run({ log = console.log } = {}) {
  const cfg = await readJSON("config.json", null);
  if (!cfg) throw new Error("config.json mancante");
  const profiles = await readJSON("profiles.json", {});
  const status = await readJSON("status.json", {});
  const failed = { ...(status.failed || {}) };
  const failedBefore = JSON.stringify(failed);
  const now = new Date();
  let changed = false;

  const res = await fetch(process.env.YHOP_URL_OVERRIDE || cfg.yhop_url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error("YHOP " + res.status);
  const drafts = (await res.json()).drafts || [];
  log(`YHOP: ${drafts.length} spine`);

  // avvisi: confronta con l'ultima lista vista
  const tapsNow = snapTaps(drafts);
  const tapsBefore = await readJSON("taps.json", null);
  if (!drafts.length) {
    log("YHOP ha risposto con una lista vuota: nessun confronto (probabile errore temporaneo).");
  } else if (!tapsBefore) {
    await writeJSON("taps.json", tapsNow);
    await writeJSON("outbox.json", { lines: [(T[cfg.notify_lang] || T.tr).hello], newTaps: [] });
  } else {
    const fresh = [], lines = diffTaps(tapsBefore, tapsNow, cfg.notify_lang, fresh);
    if (lines.length) {
      log("Cambi:\n  " + lines.join("\n  "));
      await writeJSON("taps.json", tapsNow);
      const newTaps = fresh.map(t => ({ tap: t, draft: drafts.find(d => clean(d.identifier) === t) })).filter(x => x.draft);
      await writeJSON("outbox.json", { lines, newTaps });   // inviato da notify.mjs dopo story e salvataggio
    }
  }

  const skip = new Set(cfg.skip_ids.map(String));
  const todo = drafts.filter(d => d && d.beer_id != null && clean(d.name))
    .filter(d => !skip.has(String(d.beer_id)) && !profiles[String(d.beer_id)])
    .filter(d => (failed[String(d.beer_id)] || 0) < cfg.max_attempts)
    .slice(0, cfg.max_new_per_run);
  if (!todo.length) log("Nessuna birra nuova da ricercare.");

  const key = process.env.ANTHROPIC_API_KEY;
  if (todo.length && !key) log("Ricerca AI saltata: ANTHROPIC_API_KEY non impostata (gli avvisi funzionano lo stesso).");

  for (const d of key ? todo : []) {
    const id = String(d.beer_id);
    const beer = { name: clean(d.name), brewery: clean(d.brewery), style: clean(d.style), abv: d.abv };
    log(`→ Ricerca: ${beer.name} · ${beer.brewery} (${beer.style})`);
    try {
      const { json, usage } = await askClaude(beer, cfg, key);
      const v = validate(json, cfg);
      if (v.error) throw new Error(v.error);
      profiles[id] = { ...v.profile, _beer: `${beer.name} · ${beer.brewery} · ${beer.style}`, _by: cfg.model, _at: now.toISOString() };
      delete failed[id];
      changed = true;
      log(`  ok (affidabilità ${v.profile.confidence}${usage ? `, token ${usage.input_tokens}+${usage.output_tokens}` : ""})`);
    } catch (e) {
      failed[id] = (failed[id] || 0) + 1;
      log(`  ERRORE (${failed[id]}/${cfg.max_attempts}): ${e.message}`);
    }
  }

  const beat = status.heartbeat ? (now - new Date(status.heartbeat)) / 864e5 : Infinity;
  const failedChanged = JSON.stringify(failed) !== failedBefore;
  if (changed) await writeJSON("profiles.json", profiles);
  if (changed || failedChanged || beat >= HEARTBEAT_DAYS) {
    await writeJSON("status.json", { heartbeat: now.toISOString(), taps: drafts.length, failed });
  }
  return { researched: todo.length, changed };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch(e => { console.error("ERRORE:", e.message); process.exit(1); });
}
