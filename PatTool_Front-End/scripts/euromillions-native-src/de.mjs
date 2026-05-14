export default {
  TITLE: 'EuroMillions (FDJ) — Ziehungen',
  INTRO:
    'Die angezeigten Ziehungen liegen in MongoDB auf dem Server. Administratoren verwenden „FDJ-ZIP herunterladen + importieren“: Das Backend lädt von fdj.fr das offizielle FDJ-Ziehungsarchiv-ZIP, entpackt die CSV-Dateien in euromillions.import.directory auf dem Server und führt die Ziehungen mit dem FDJ-Ziehungscode als Schlüssel zusammen. Untere Assistenten-Grenze (einschließlich): {{since}}. Sie können die Tabelle jederzeit neu laden. Die Spalten zu Auszahlungen / Gewinnern der Gewinnklasse 1 werden aus der CSV übernommen, sofern vorhanden.',
  SYNC_BUTTON: 'CSV importieren (Serverordner)',
  REFRESH: 'Tabelle neu laden',
  FILTER_DATE_FROM: 'Von (einschließlich)',
  FILTER_DATE_TO: 'Bis (einschließlich)',
  FILTER_RESET: 'Filter zurücksetzen',
  FILTER_COUNT: '{{shown}} von {{total}} Ziehungen angezeigt',
  FILTER_EMPTY: 'Keine Ziehungen passen zu diesem Datumsbereich.',
  LOADING: 'Wird geladen…',
  LOADING_DRAWS: 'Ziehungen werden geladen…',
  EMPTY:
    'Noch keine Ziehungen gespeichert — ein Administrator muss das CSV-Paket aus dem konfigurierten Verzeichnis importieren.',
  LOAD_ERROR: 'Ziehungen konnten nicht vom Server geladen werden.',
  SYNC_ADMIN_ONLY: 'Der CSV-Import ist auf Konten mit der Rolle Administrator (Admin) beschränkt.',
  SYNC_ADMIN_TOOLTIP: 'Nur Benutzer mit der Admin-Rolle können den Import auslösen.',
  FDJ_ARCHIVE_BUTTON: 'FDJ-ZIP herunterladen + importieren',
  FDJ_ARCHIVE_TOOLTIP:
    'Admin: lädt das offizielle FDJ-ZIP von fdj.fr nach euromillions.import.directory auf dem Server und importiert die CSV-Dateien in MongoDB. Angezeigte untere Assistenten-Grenze: {{since}} (einschließlich).',
  FDJ_HISTORIQUE_SITE_BUTTON: 'FDJ-EuroMillions-Verlauf öffnen',
  FDJ_HISTORIQUE_SITE_TOOLTIP:
    'Öffnet fdj.fr in einem neuen Tab — offizielle Verlaufsseite mit dem Archiv, das PatTool verwendet.',
  SYNC_DONE:
    'Import abgeschlossen: {{files}} CSV-Datei(en) gelesen, {{draws}} Ziehungen in MongoDB gespeichert, {{skipped}} Datenzeile(n) übersprungen.',
  SYNC_FAILED: 'Import fehlgeschlagen: {{detail}}',
  COL_DATE: 'Ziehungsdatum',
  SAVE_DATE: 'Datum speichern',
  DATE_SAVE_ERROR: 'Datum konnte nicht gespeichert werden: {{detail}}',
  DATE_SAVE_FORBIDDEN:
    'Speichern ist Administratoren vorbehalten (oder Ihre Sitzung ist abgelaufen).',
  DATE_EDIT_START: 'Ziehungsdaten bearbeiten',
  DATE_EDIT_DONE: 'Bearbeitung beenden',
  DATE_EDIT_TOOLTIP:
    'Bearbeitung der Ziehungsdaten ein- oder ausschalten (Admin). Daten sind schreibgeschützt, bis Sie die Bearbeitung starten.',
  COL_COMBINATION: 'Kombination',
  STAR_BALL_HINT: 'Glücksstern',
  STARS_LABEL: 'Sterne:',
  EXPORT_JSON: 'JSON exportieren',
  JSON_AI_OPEN: 'JSON (KI)',
  JSON_AI_TOOLTIP:
    'Assistent: `pat-eurom-ai-v2` (Ziehungen seit {{since}}: Aggregationen + vollständige chronologische Liste in `tail`). Export im Modal: gesamter geladener Verlauf.',
  EXPORT_JSON_IA_MODAL_TITLE: 'JSON für KI — geladene Ziehungen',
  JSON_AI_MODAL_HINT:
    'Lesbarer Export: recordCount, draws[] (gesamter geladener Verlauf). Der Assistent sendet jede Ziehung seit **{{since}}** in `tail`, plus Aggregationen `periods` (Servereinstellung `euromillions.ai.min-draw-date`).',
  AI_FAB_LABEL: 'Assistent mit Analyse öffnen (Nachricht 1, Entwurf)',
  AI_WINNING_NEXT_BTN: 'Nächste Gewinnzahlen',
  METHOD_SECTION_TITLE: 'Analyseperspektive für den Assistenten (Ihre Wahl)',
  METHOD_AI_INCLUDE_LABEL: 'Im Assistenten-Entwurf einbeziehen',
  METHOD_AI_INCLUDE_HELP:
    'Angehakte Methoden werden an das JSON angehängt; mindestens eine bleibt aktiv. Das Radio wählt die primäre Perspektive (duplizierte Root-Felder); Haken entfernen für Methoden, die das Modell ignorieren soll.',
  AI_SYNTHESIS_BTN: 'Multi-Methoden-Synthese',
  AI_SYNTHESIS_TOOLTIP:
    'Öffnet den Assistenten mit Synthese-Anweisungen und allen angehakten Methodenspezifikationen.',
  METHOD_RATING_ARIA:
    'PatTool-Nutzungshinweis für diese Analysemethode: {{score}} von {{max}} Sternen (kein statistischer Beweis oder Vorhersage).',
  METHOD_ANALYTICS_LOADING: 'Statistik-Snapshot wird geladen…',
  METHOD_RECOMPUTE: 'Metriken neu berechnen (Admin)',
  METHOD_RECOMPUTE_HINT:
    'Berechnet alle fünf Analyseblöcke in MongoDB für das aktuelle Ziehungsfenster neu.',
  METHOD_SNAPSHOT_META:
    'Snapshot-Bereich **seit {{since}}** — **{{n}}** Ziehung(en); Mongo **computedAt** **{{at}}** (UTC).',
  METHOD_CHI2_GOF_UNIFORM_TITLE: 'χ²-Anpassungstest (naive Gleichverteilung)',
  METHOD_CHI2_GOF_UNIFORM_DESC:
    'Pearson-χ² auf gepoolten Hauptzahl-Häufigkeiten (50 Kategorien, 5×n Plätze) plus Stern-Raster pro FDJ-Ära entsprechend starMax.',
  METHOD_CHI2_GOF_UNIFORM_SUMMARY:
    'Pearson-χ²: beobachtete vs. gleichverteilte Erwartung (Hauptzahlen + Sterne pro FDJ-Regel).',
  METHOD_ENTROPY_NORMALIZED_TITLE: 'Shannon-Entropie (normalisiert)',
  METHOD_ENTROPY_NORMALIZED_DESC:
    'Empirische Entropie H für Hauptzahlen und Sterne geteilt durch log(K) — Streuung relativ zur maximalen Gleichverteilungs-Entropie.',
  METHOD_ENTROPY_NORMALIZED_SUMMARY:
    'Wie stark die empirischen Frequenzen von der Gleichverteilung abweichen (normalisierte Entropie).',
  METHOD_GAP_RECURRENCE_TITLE: 'Abstände zwischen Auftritten (über Ziehungen)',
  METHOD_GAP_RECURRENCE_DESC:
    'Pro Kugel 1–50 der mittlere Abstand zwischen Ziehungsindizes, in denen sie erscheint; Zusammenfassung über heterogene Wiederkehrzeiten.',
  METHOD_GAP_RECURRENCE_SUMMARY:
    'Mittlerer Abstand zwischen zwei aufeinanderfolgenden Erscheinungen derselben Hauptzahl.',
  METHOD_SUM_CORRELATION_TITLE: 'Korrelation Σ Hauptzahlen vs. Σ Sterne',
  METHOD_SUM_CORRELATION_DESC:
    'Pearson-r zwischen Summe der fünf Hauptzahlen und Summe der beiden Sterne bei vollständigen gültigen Scheinen.',
  METHOD_SUM_CORRELATION_SUMMARY:
    'Linearer Zusammenhang zwischen Summe der fünf Hauptzahlen und Summe der zwei Sterne (Pearson).',
  METHOD_MONTE_CARLO_MAXFREQ_TITLE: 'Monte-Carlo-Kalibrierung der Maximalhäufigkeit',
  METHOD_MONTE_CARLO_MAXFREQ_DESC:
    'Vergleicht die beobachtete maximale Hauptzahl-Häufigkeit mit Simulationen unter gleichverteiltem Ziehen ohne Zurücklegen; empirischer p-Wert.',
  METHOD_MONTE_CARLO_MAXFREQ_SUMMARY:
    'Die häufigste Hauptzahl im Vergleich zu Zufallssimulationen (empirischer p-Wert).',
  AI_FAB_TOOLTIP:
    '**EuroMillions**: Prompt + JSON `pat-eurom-ai-v2` (Aggregationen + **alle** Ziehungen seit {{since}} in `tail`). Manuell senden.',
  AI_JSON_BLOCK_INTRO:
    'Kompaktes JSON (weniger Tokens): `c` = maßgebende Anzahl = **`d.length`**. Jedes `d[i]` = `[ \"YYYYMMDD\", [5 Hauptzahlen], [Stern1, Stern2] ]` chronologisch.',
  AI_RECORD_COUNT_LINE:
    'Maßgebende Anzahl: **{{n}}** (= JSON-Feld `c`; sollte **`tail.length`** in diesem Schema entsprechen). Wenn der Modellkontext gekürzt wirkt, darauf hinweisen; sonst stimmen **`c`** und **`tail.length`** überein.',
  EXPORT_JSON_COPY: 'In die Zwischenablage kopieren',
  CHART_BUTTON: 'Trend pro Monat',
  CHART_MODAL_TITLE: 'Monatsmittel — Hauptzahlen & Sterne',
  CHART_MODAL_HELP:
    'Pro Kalendermonat: Mittelwert jedes sortierten Platzes der fünf Hauptzahlen (1–50, linke Achse) und getrennte Mittel für die beiden Glückssterne nach Sortierung (1–12, rechte Achse). Mehrere Ziehungen im Monat fließen in die Mittelwerte ein.',
  CHART_AXIS_X: 'Monat',
  CHART_AXIS_Y_BALLS: 'Mittel Hauptzahl',
  CHART_AXIS_Y_STARS: 'Mittel Glückssterne',
  CHART_SERIES_N: 'Rang {{i}} (aufsteigend sortiert)',
  CHART_SERIES_STAR_1: 'Sortierter Stern Platz 1 (Mittel)',
  CHART_SERIES_STAR_2: 'Sortierter Stern Platz 2 (Mittel)',
  CHART_EMPTY: 'Zu wenige konsistente Daten für das Diagramm.',
  CHART_CLOSE: 'Schließen',
  MONTH_COUNT_BUTTON: 'Ziehungen pro Monat',
  MONTH_COUNT_MODAL_TITLE: 'Ziehungen pro Kalendermonat',
  MONTH_COUNT_MODAL_HELP:
    'Jede Zeile ist ein Kalendermonat (Januar→Dezember, vertikale Achse). Jede Spalte ist ein Jahr ab {{since}} (untere Assistenten-Grenze, einschließlich). Eine Zelle zählt Ziehungen in diesem Monat und Jahr. Horizontal scrollen, um alle Jahre zu sehen.',
  MONTH_COUNT_SUMMARY:
    '{{draws}} Ziehung(en) im Raster seit {{since}} (einschließlich). {{skipped}} Zeile(n) übersprungen (kein yyyy-MM-dd-Präfix). {{beforeBound}} Ziehung(en) vor {{since}} vom Raster ausgeschlossen. {{pairs}} Monat×Jahr-Felder mit mindestens einer Ziehung; {{years}} Jahr-Spalten.',
  MONTH_COUNT_COL_MONTH: 'Monat',
  MONTH_COUNT_COL_DRAWS: 'Ziehungen',
  MONTH_COUNT_ROW_AXIS: 'Monat \\ Jahr',
  MONTH_COUNT_FOOT_YEAR_TOTALS: 'Summen pro Jahr',
  MONTH_COUNT_FOOT_ALL_DRAWS: 'Ziehungen gesamt',
  MONTH_COUNT_TOTAL: 'Summe',
  MONTH_COUNT_EMPTY:
    'Keine Monatsgruppierung möglich bei übersprungenen Zeilen — siehe Zähler (meist unlesbares Datumspräfix).',
  MONTH_COUNT_ALL_BEFORE_BOUND:
    'Alle geladenen Ziehungen liegen strikt vor {{since}} (untere Assistenten-Grenze). Das Raster bleibt leer.',
  AI_MIN_DATE_LABEL: 'Assistent — frühestes Ziehungsdatum (einschließlich)',
  AI_MIN_DATE_SAVE: 'In der Datenbank speichern',
  AI_MIN_DATE_SOURCE_MONGO: 'Aktueller Wert: MongoDB (Admin).',
  AI_MIN_DATE_SOURCE_PROPERTIES:
    'Aktueller Wert: application.properties (noch kein MongoDB-Eintrag).',
  AI_MIN_DATE_SAVED: 'Gespeichert.',
  AI_MIN_DATE_SAVE_ERROR: 'Speichern fehlgeschlagen: {{detail}}',
  AI_MIN_DATE_SAVE_FORBIDDEN: 'Nur Administratoren (oder Sitzung abgelaufen).',
  COL_GAIN: 'Gewinnklasse 1 — Auszahlungen (CSV)',
  COL_DRAW_CODE: 'Ziehungs-ID',
  SOURCE_NOTE:
    'Quelle: CSV-Open-Data-Bündel der FDJ / staatlicher Lotteriestatistik. Aktuelle Ergebnisse immer bei autorisierten FDJ-Stellen prüfen.'
};
