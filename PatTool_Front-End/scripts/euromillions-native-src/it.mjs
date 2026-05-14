export default {
  TITLE: 'EuroMillions (FDJ) — estrazioni',
  INTRO:
    'Le estrazioni mostrate sono in MongoDB sul server. Gli amministratori usano «Scarica ZIP FDJ + importa»: il backend scarica da fdj.fr l’archivio ZIP ufficiale delle estrazioni, estrae i CSV in euromillions.import.directory sul server e unisce le estrazioni in database con il codice estrazione FDJ come chiave. Limite inferiore dell’assistente (incluso): {{since}}. Aggiornare la tabella in qualsiasi momento. Le colonne su premi / vincitori di categoria 1 provengono dal CSV quando disponibili.',
  SYNC_BUTTON: 'Importa CSV (cartella server)',
  REFRESH: 'Aggiorna tabella',
  FILTER_DATE_FROM: 'Da (incluso)',
  FILTER_DATE_TO: 'A (incluso)',
  FILTER_RESET: 'Cancella filtri',
  FILTER_COUNT: '{{shown}} di {{total}} estrazioni mostrate',
  FILTER_EMPTY: 'Nessuna estrazione corrisponde a questo intervallo di date.',
  LOADING: 'Caricamento…',
  LOADING_DRAWS: 'Caricamento estrazioni…',
  EMPTY:
    'Nessuna estrazione in archivio: un amministratore deve importare il pacchetto CSV dalla directory configurata.',
  LOAD_ERROR: 'Impossibile caricare le estrazioni dal server.',
  SYNC_ADMIN_ONLY: 'L’importazione CSV è riservata agli account con ruolo Amministratore (Admin).',
  SYNC_ADMIN_TOOLTIP: 'Solo gli utenti Admin possono avviare l’importazione.',
  FDJ_ARCHIVE_BUTTON: 'Scarica ZIP FDJ + importa',
  FDJ_ARCHIVE_TOOLTIP:
    'Admin: scarica il ZIP ufficiale FDJ da fdj.fr in euromillions.import.directory sul server e importa i CSV in MongoDB. Limite inferiore dell’assistente mostrato: {{since}} (incluso).',
  FDJ_HISTORIQUE_SITE_BUTTON: 'Sito FDJ — storico EuroMillions',
  FDJ_HISTORIQUE_SITE_TOOLTIP:
    'Apre fdj.fr in una nuova scheda: pagina storico ufficiale con lo stesso archivio usato da PatTool.',
  SYNC_DONE:
    'Importazione completata: {{files}} file CSV letti, {{draws}} estrazioni salvate in MongoDB, {{skipped}} righe saltate.',
  SYNC_FAILED: 'Importazione fallita: {{detail}}',
  COL_DATE: 'Data estrazione',
  SAVE_DATE: 'Salva data',
  DATE_SAVE_ERROR: 'Impossibile salvare la data: {{detail}}',
  DATE_SAVE_FORBIDDEN:
    'Salvataggio riservato agli amministratori (o sessione scaduta).',
  DATE_EDIT_START: 'Modifica date',
  DATE_EDIT_DONE: 'Termina modifica',
  DATE_EDIT_TOOLTIP:
    'Attiva/disattiva la modifica delle date di estrazione (admin). Le date sono in sola lettura finché non si avvia la modifica.',
  COL_COMBINATION: 'Combinazione',
  STAR_BALL_HINT: 'Stella',
  STARS_LABEL: 'Stelle:',
  EXPORT_JSON: 'Esporta JSON',
  JSON_AI_OPEN: 'JSON (IA)',
  JSON_AI_TOOLTIP:
    'Assistente: `pat-eurom-ai-v2` (estrazioni da {{since}}: aggregati + elenco completo in `tail`). Modale esportazione: tutta la cronologia caricata.',
  EXPORT_JSON_IA_MODAL_TITLE: 'JSON per IA — estrazioni caricate',
  JSON_AI_MODAL_HINT:
    'Esportazione leggibile: recordCount, draws[] (cronologia caricata completa). L’assistente invia ogni estrazione da **{{since}}** in `tail`, più gli aggregati `periods` (impostazione `euromillions.ai.min-draw-date`).',
  AI_FAB_LABEL: 'Apri l’assistente con l’analisi (messaggio 1, bozza)',
  AI_WINNING_NEXT_BTN: 'Prossimi numeri vincenti',
  METHOD_SECTION_TITLE: 'Angolo di analisi per l’assistente (scelta dell’utente)',
  METHOD_AI_INCLUDE_LABEL: 'Includi nella bozza dell’assistente',
  METHOD_AI_INCLUDE_HELP:
    'I metodi selezionati sono allegati al JSON; almeno uno deve restare selezionato. Il radio sceglie l’angolo principale PatTool (campi radice duplicati); deseleziona gli angoli da non applicare.',
  AI_SYNTHESIS_BTN: 'Sintesi multi-metodo',
  AI_SYNTHESIS_TOOLTIP:
    'Apre l’assistente con istruzioni di sintesi e la specifica di ogni metodo selezionato nel JSON.',
  METHOD_RATING_ARIA:
    "Indicazione PatTool sull'utilità di questo approccio: {{score}} su {{max}} stelle (né prova statistica né previsione).",
  METHOD_ANALYTICS_LOADING: 'Caricamento snapshot statistico…',
  METHOD_RECOMPUTE: 'Ricalcola metriche (admin)',
  METHOD_RECOMPUTE_HINT:
    'Ricalcola tutti e cinque i blocchi analitici in MongoDB per la finestra corrente di estrazioni.',
  METHOD_SNAPSHOT_META:
    'Ambito snapshot **da {{since}}** — **{{n}}** estrazione/i; Mongo **computedAt** **{{at}}** (UTC).',
  METHOD_CHI2_GOF_UNIFORM_TITLE: 'χ² di adattamento (uniforme ingenua)',
  METHOD_CHI2_GOF_UNIFORM_DESC:
    'χ² di Pearson su conteggi aggregati delle palline (50 caselle, 5×n slot) più griglie stelle per era FDJ (starMax).',
  METHOD_CHI2_GOF_UNIFORM_SUMMARY:
    'χ² di Pearson: osservati vs attesi uniformi (palle principali + stelle per era FDJ).',
  METHOD_ENTROPY_NORMALIZED_TITLE: 'Entropia di Shannon (normalizzata)',
  METHOD_ENTROPY_NORMALIZED_DESC:
    'Entropia empirica H per palle e stelle divisa per log(K) — dispersione rispetto all’uniforme massima.',
  METHOD_ENTROPY_NORMALIZED_SUMMARY:
    'Quanto le frequenze empiriche divergono dall’uniforme (entropia normalizzata).',
  METHOD_GAP_RECURRENCE_TITLE: 'Intervalli di ricorrenza tra estrazioni',
  METHOD_GAP_RECURRENCE_DESC:
    'Per ogni pallina 1–50, distanza media tra indici di estrazioni in cui compare; sintesi sulle palline ricorrenti.',
  METHOD_GAP_RECURRENCE_SUMMARY:
    'Distanza media tra due comparse consecutive della stessa pallina.',
  METHOD_SUM_CORRELATION_TITLE: 'Correlazione Σ palle / Σ stelle',
  METHOD_SUM_CORRELATION_DESC:
    'Pearson r tra somma delle 5 palle e somma delle 2 stelle su estrazioni con griglia valida completa.',
  METHOD_SUM_CORRELATION_SUMMARY:
    'Legame lineare tra somma delle palle e somma delle stelle (correlazione di Pearson).',
  METHOD_MONTE_CARLO_MAXFREQ_TITLE: 'Calibrazione Monte Carlo della frequenza massima',
  METHOD_MONTE_CARLO_MAXFREQ_DESC:
    'Confronta la frequenza massima osservata sulle palle con simulazioni uniformi senza reinserimento; p-value empirico.',
  METHOD_MONTE_CARLO_MAXFREQ_SUMMARY:
    'La pallina più frequente rispetto a simulazioni casuali (p-value empirico).',
  AI_FAB_TOOLTIP:
    '**EuroMillions**: prompt + JSON `pat-eurom-ai-v2` (aggregati + **tutte** le estrazioni da {{since}} in `tail`). Invio manuale.',
  AI_JSON_BLOCK_INTRO:
    'JSON compatto (meno token): `c` = conteggio **autorevole** = **`d.length`**. Ogni `d[i]` = `[ \"YYYYMMDD\", [5 palle], [stella1, stella2] ]` cronologico.',
  AI_RECORD_COUNT_LINE:
    'Conteggio **autorevole**: **{{n}}** (= campo JSON `c`; deve eguagliare **`tail.length`** in questo schema). Se il contesto sembra troncato, segnalarlo; altrimenti **`c`** e **`tail.length`** coincidono.',
  EXPORT_JSON_COPY: 'Copia negli appunti',
  CHART_BUTTON: 'Andamento mensile',
  CHART_MODAL_TITLE: 'Medie mensili — palle e stelle',
  CHART_MODAL_HELP:
    'Per ogni mese solare: media di ogni posizione ordinata delle 5 palle (asse sinistro 1–50) e medie separate delle due Lucky Stars ordinate tra loro (asse destro 1–12). Più estrazioni nello stesso mese sono raggruppate nelle medie.',
  CHART_AXIS_X: 'Mese',
  CHART_AXIS_Y_BALLS: 'Media palla principale',
  CHART_AXIS_Y_STARS: 'Media stelle',
  CHART_SERIES_N: 'Rango {{i}} (ordinamento crescente)',
  CHART_SERIES_STAR_1: 'Stella ordinata posizione 1 (media)',
  CHART_SERIES_STAR_2: 'Stella ordinata posizione 2 (media)',
  CHART_EMPTY: 'Dati insufficienti per il grafico.',
  CHART_CLOSE: 'Chiudi',
  MONTH_COUNT_BUTTON: 'Estrazioni per mese',
  MONTH_COUNT_MODAL_TITLE: 'Estrazioni per mese solare',
  MONTH_COUNT_MODAL_HELP:
    'Ogni riga è un mese (gennaio→dicembre). Ogni colonna è un anno da {{since}} (limite inferiore assistente, inclusivo). Una cella conta le estrazioni in quel mese e anno. Scorri orizzontalmente per tutti gli anni.',
  MONTH_COUNT_SUMMARY:
    '{{draws}} estrazione/i nella griglia da {{since}} (inclusivo). {{skipped}} riga/e saltate (nessun prefisso yyyy-MM-dd). {{beforeBound}} estrazione/i prima di {{since}} escluse dalla griglia. {{pairs}} celle mese×anno con almeno un’estrazione; {{years}} colonne anno.',
  MONTH_COUNT_COL_MONTH: 'Mese',
  MONTH_COUNT_COL_DRAWS: 'Estrazioni',
  MONTH_COUNT_ROW_AXIS: 'Mese \\ anno',
  MONTH_COUNT_FOOT_YEAR_TOTALS: 'Totali per anno',
  MONTH_COUNT_FOOT_ALL_DRAWS: 'Estrazioni totali',
  MONTH_COUNT_TOTAL: 'Totale',
  MONTH_COUNT_EMPTY:
    'Impossibile raggruppare per mese tra righe saltate — vedi conteggi (prefisso data illeggibile).',
  MONTH_COUNT_ALL_BEFORE_BOUND:
    'Tutte le estrazioni caricate sono prima di {{since}} (limite assistente). La griglia è vuota.',
  AI_MIN_DATE_LABEL: 'Assistente — data minima estrazione (inclusiva)',
  AI_MIN_DATE_SAVE: 'Salva nel database',
  AI_MIN_DATE_SOURCE_MONGO: 'Valore effettivo: MongoDB (admin).',
  AI_MIN_DATE_SOURCE_PROPERTIES:
    'Valore effettivo: application.properties (nessuna riga Mongo ancora).',
  AI_MIN_DATE_SAVED: 'Salvato.',
  AI_MIN_DATE_SAVE_ERROR: 'Salvataggio fallito: {{detail}}',
  AI_MIN_DATE_SAVE_FORBIDDEN: 'Solo amministratori (o sessione scaduta).',
  COL_GAIN: 'Cat. 1 — premi (CSV)',
  COL_DRAW_CODE: 'ID estrazione',
  SOURCE_NOTE:
    'Fonte: pacchetto CSV open data FDJ / statistiche ufficiali. Verificare sempre sui canali FDJ autorizzati.'
};
