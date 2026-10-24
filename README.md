# PIVO · robot

Ogni 15 minuti, gratis, su GitHub:

1. **Spine (YHOP)** — confronta la taplist con l'ultima vista e manda un avviso sul telefono (app ntfy) per ogni cambio: birra nuova, spina tolta, prezzo o gradazione cambiati.
2. **Story Instagram** — per ogni birra nuova crea una story animata (video 1080×1920, 8 secondi: il bicchiere si riempie) nello stile PIVO (cartella `stories/`) e la manda insieme all'avviso: basta salvarla e pubblicarla.
3. **Partite** — ogni 6 ore scarica il calendario dell'Atalanta (`matches.json`); menu e TV mostrano la partita del giorno da soli.
4. **Schede AI (facoltativo)** — se c'è la chiave `ANTHROPIC_API_KEY`, ricerca sul web le birre nuove e scrive note e valori in `profiles.json`.

Segreti (Settings → Secrets and variables → Actions):
- `NTFY_TOPIC` — nome del canale ntfy (obbligatorio per gli avvisi)
- `FOOTBALL_DATA_TOKEN` — facoltativo: chiave gratuita di football-data.org (più affidabile per le partite)
- `ANTHROPIC_API_KEY` — facoltativo: ricerca AI delle birre nuove

**Lanciarlo subito:** Actions → PIVO robot birre → Run workflow.
**Fermarlo:** Actions → PIVO robot birre → ⋯ → Disable workflow.
**Correggere una scheda AI:** modifica `profiles.json`; per rifarla cancella la voce della birra.
**Lingua degli avvisi:** `notify_lang` in `config.json` (`tr` o `it`).
