// PIVO robot — partite: scarica il calendario delle squadre (config.teams) e scrive matches.json.
// Fonte 1: football-data.org (ufficiale, chiave gratuita in FOOTBALL_DATA_TOKEN): Serie A e Champions League.
// Fonte 2 (senza chiave): dati pubblici ESPN — non ufficiali, possono cambiare senza preavviso.
// Le pagine leggono matches.json e lo uniscono alle partite scritte nella tabella.
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import path from "node:path";

const DIR = process.env.PIVO_DIR || process.cwd();
const FD = process.env.FOOTBALL_DATA_URL || "https://api.football-data.org/v4";
const ESPN = process.env.ESPN_URL || "https://site.api.espn.com/apis/site/v2/sports/soccer";
const EVERY_HOURS = 6;
const ESPN_LEAGUES = { "ita.1": "Serie A", "uefa.champions": "Champions League", "uefa.europa": "Europa League", "ita.coppa_italia": "Coppa Italia" };

async function readJSON(f, d) { try { return JSON.parse(await readFile(path.join(DIR, f), "utf8")); } catch { return d; } }

// UTC -> data e ora di Bergamo
export function romeParts(iso) {
  const d = new Date(iso); if (isNaN(d)) return null;
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Rome", year: "numeric", month: "2-digit",
    day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(d).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}
const shortName = (t) => String(t || "").replace(/\b(BC|FC|AC|SSC|SS|AS|US|Calcio|Bergamasca)\b\.?/g, "").replace(/\s+/g, " ").trim();

export function parseFootballData(j) {
  return (j.matches || []).map(m => {
    const rp = romeParts(m.utcDate); if (!rp) return null;
    if (["FINISHED", "CANCELLED", "POSTPONED", "AWARDED"].includes(m.status)) return null;
    return { home: shortName(m.homeTeam?.shortName || m.homeTeam?.name), away: shortName(m.awayTeam?.shortName || m.awayTeam?.name),
      ...rp, competition: m.competition?.name || "", priority: true };
  }).filter(x => x && x.home && x.away);
}
export function parseEspn(j, league) {
  return (j.events || []).map(e => {
    const c = e.competitions?.[0]; const rp = romeParts(e.date || c?.date); if (!c || !rp) return null;
    if (c.status?.type?.completed) return null;
    const side = (k) => c.competitors?.find(x => x.homeAway === k)?.team;
    const h = side("home"), a = side("away");
    return { home: shortName(h?.shortDisplayName || h?.displayName), away: shortName(a?.shortDisplayName || a?.displayName),
      ...rp, competition: ESPN_LEAGUES[league] || "", priority: true };
  }).filter(x => x && x.home && x.away);
}

async function getJSON(url, headers = {}) {
  const r = await fetch(url, { headers: { accept: "application/json", ...headers } });
  if (!r.ok) throw new Error(`${new URL(url).host} ${r.status}`);
  return r.json();
}
function window14() {
  const from = new Date(Date.now() - 864e5), to = new Date(Date.now() + 21 * 864e5);
  const f = (d) => d.toISOString().slice(0, 10);
  return { from: f(from), to: f(to) };
}

export async function run({ log = console.log, force = false } = {}) {
  const cfg = await readJSON("config.json", {});
  const teams = cfg.teams || [];
  const old = await readJSON("matches.json", null);
  if (!teams.length) { log("Partite: nessuna squadra in config.teams."); return { changed: false }; }
  if (!force && old && old.updated && (Date.now() - Date.parse(old.updated)) < EVERY_HOURS * 36e5) {
    log("Partite: aggiornate da meno di " + EVERY_HOURS + " ore."); return { changed: false };
  }
  const { from, to } = window14(), all = [], used = [];
  for (const t of teams) {
    let got = null;
    if (process.env.FOOTBALL_DATA_TOKEN && t.football_data_id) {
      try {
        got = parseFootballData(await getJSON(`${FD}/teams/${t.football_data_id}/matches?dateFrom=${from}&dateTo=${to}`,
          { "X-Auth-Token": process.env.FOOTBALL_DATA_TOKEN }));
        used.push("football-data.org");
      } catch (e) { log(`Partite ${t.name}: football-data.org non risponde (${e.message}), provo ESPN.`); }
    }
    if (!got && t.espn_id) {
      got = [];
      for (const lg of Object.keys(ESPN_LEAGUES)) {
        try { got.push(...parseEspn(await getJSON(`${ESPN}/${lg}/teams/${t.espn_id}/schedule?fixture=true`), lg)); }
        catch (e) { log(`Partite ${t.name} ${lg}: ${e.message}`); }
      }
      if (got.length) used.push("ESPN"); else got = null;
    }
    if (got) all.push(...got);
  }
  const today = new Date(Date.now() - 864e5).toISOString().slice(0, 10), last = to;
  const list = all.filter(m => m.date >= today && m.date <= last)
    .filter((m, i, a) => a.findIndex(x => x.date === m.date && x.home === m.home && x.away === m.away) === i)
    .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
  if (!used.length) { log("Partite: nessuna fonte ha risposto, tengo il file di prima."); return { changed: false }; }
  const next = { updated: new Date().toISOString(), source: [...new Set(used)].join(" + "), list };
  const changed = JSON.stringify(old && old.list) !== JSON.stringify(list);
  await writeFile(path.join(DIR, "matches.json"), JSON.stringify(next, null, 2) + "\n");
  log(`Partite: ${list.length} nei prossimi giorni (${next.source})` + (list[0] ? `, prossima ${list[0].home}-${list[0].away} ${list[0].date} ${list[0].time}` : ""));
  return { changed, list };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run({ force: process.argv.includes("--force") }).catch(e => { console.error("ERRORE partite:", e.message); process.exit(0); });
}
