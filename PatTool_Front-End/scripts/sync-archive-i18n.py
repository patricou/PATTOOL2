#!/usr/bin/env python3
"""Sync ARCHIVE i18n keys across all language files (ARCHIVE block only)."""
from __future__ import annotations

import json
import re
from pathlib import Path

I18N = Path(__file__).resolve().parents[1] / "src" / "assets" / "i18n"

TRANSLATIONS: dict[str, dict[str, str]] = {
    "en": {
        "CACHE_REFRESH": "Refresh catalog",
        "CACHE_REFRESH_TITLE": "Rebuild the small browse warm from archive.org (text search stays live). Also every day at 05:00.",
        "CACHE_REFRESH_STARTED": "Catalog refresh started…",
        "CACHE_REFRESH_PROGRESS": "Catalog: {{phase}} ({{count}} items)…",
        "CACHE_REFRESH_DONE": "Catalog refreshed.",
        "CACHE_REFRESH_DONE_SEC": "Catalog refreshed ({{seconds}} s).",
        "CACHE_REFRESH_ERROR": "Catalog refresh failed.",
        "CACHE_STATS": "Catalog stats",
        "CACHE_STATS_TITLE": "Cached items by type",
        "CACHE_STATS_TOTAL": "Total: {{count}} item(s)",
        "CACHE_STATS_EMPTY": "Catalog is empty — run a refresh.",
        "CACHE_STATS_ERROR": "Could not load catalog statistics.",
        "CACHE_STATS_CLOSE": "Close",
        "PLAYLIST_PLAY_ALL": "Play all",
        "SEC_RECENT": "Recent additions",
        "SEC_MOST_DOWNLOADED": "Most downloaded",
        "SEC_TOP_RATED": "Top rated",
        "SEC_FEATURE_FILMS": "Feature films",
        "SEC_CLASSIC_FILMS": "Classics",
        "SEC_FILM_NOIR": "Film noir",
        "SEC_SCIFI_HORROR": "Sci-fi & horror",
        "SEC_SILENT": "Silent films",
        "SEC_GUTENBERG": "Project Gutenberg",
        "SEC_OPENLIBRARY": "Open Library",
        "SEC_AMERICANA": "Americana",
        "SEC_MAGAZINES": "Magazines",
        "SEC_OLD_TIME_RADIO": "Old Time Radio",
        "SEC_AUDIOBOOKS": "Audiobooks",
        "SEC_NETLABELS": "Netlabels",
        "SEC_PODCASTS": "Podcasts",
        "SEC_CLASSIC_PC": "Classic PCs",
        "SEC_INTERNET_ARCADE": "Internet Arcade",
        "SEC_CONSOLE": "Consoles",
        "SEC_NASA": "NASA",
        "SEC_MET": "Metropolitan Museum",
    },
    "fr": {
        "CACHE_REFRESH": "Rafraîchir le catalogue",
        "CACHE_REFRESH_TITLE": "Reconstruire le petit cache de navigation depuis archive.org (la recherche texte reste en live). Aussi chaque jour à 05:00.",
        "CACHE_REFRESH_STARTED": "Rafraîchissement du catalogue lancé…",
        "CACHE_REFRESH_PROGRESS": "Catalogue : {{phase}} ({{count}} items)…",
        "CACHE_REFRESH_DONE": "Catalogue rafraîchi.",
        "CACHE_REFRESH_DONE_SEC": "Catalogue rafraîchi ({{seconds}} s).",
        "CACHE_REFRESH_ERROR": "Échec du rafraîchissement du catalogue.",
        "CACHE_STATS": "Stats catalogue",
        "CACHE_STATS_TITLE": "Items en cache par type",
        "CACHE_STATS_TOTAL": "Total : {{count}} item(s)",
        "CACHE_STATS_EMPTY": "Catalogue vide — lancez un rafraîchissement.",
        "CACHE_STATS_ERROR": "Impossible de charger les statistiques du catalogue.",
        "CACHE_STATS_CLOSE": "Fermer",
        "PLAYLIST_PLAY_ALL": "Tout lire",
        "SEC_RECENT": "Ajouts récents",
        "SEC_MOST_DOWNLOADED": "Les plus téléchargés",
        "SEC_TOP_RATED": "Mieux notés",
        "SEC_FEATURE_FILMS": "Feature films",
        "SEC_CLASSIC_FILMS": "Classiques",
        "SEC_FILM_NOIR": "Film noir",
        "SEC_SCIFI_HORROR": "SF & horreur",
        "SEC_SILENT": "Films muets",
        "SEC_GUTENBERG": "Project Gutenberg",
        "SEC_OPENLIBRARY": "Open Library",
        "SEC_AMERICANA": "Americana",
        "SEC_MAGAZINES": "Magazines",
        "SEC_OLD_TIME_RADIO": "Old Time Radio",
        "SEC_AUDIOBOOKS": "Livres audio",
        "SEC_NETLABELS": "Netlabels",
        "SEC_PODCASTS": "Podcasts",
        "SEC_CLASSIC_PC": "PC classiques",
        "SEC_INTERNET_ARCADE": "Internet Arcade",
        "SEC_CONSOLE": "Consoles",
        "SEC_NASA": "NASA",
        "SEC_MET": "Metropolitan Museum",
    },
    "de": {
        "CACHE_REFRESH": "Katalog aktualisieren",
        "CACHE_REFRESH_TITLE": "Kleinen Browse-Cache von archive.org neu aufbauen (Textsuche bleibt live). Auch täglich um 05:00.",
        "CACHE_REFRESH_STARTED": "Katalog-Aktualisierung gestartet…",
        "CACHE_REFRESH_PROGRESS": "Katalog: {{phase}} ({{count}} Einträge)…",
        "CACHE_REFRESH_DONE": "Katalog aktualisiert.",
        "CACHE_REFRESH_DONE_SEC": "Katalog aktualisiert ({{seconds}} s).",
        "CACHE_REFRESH_ERROR": "Katalog-Aktualisierung fehlgeschlagen.",
        "CACHE_STATS": "Katalog-Statistik",
        "CACHE_STATS_TITLE": "Zwischengespeicherte Einträge nach Typ",
        "CACHE_STATS_TOTAL": "Gesamt: {{count}} Eintrag/Einträge",
        "CACHE_STATS_EMPTY": "Katalog ist leer — bitte aktualisieren.",
        "CACHE_STATS_ERROR": "Katalogstatistik konnte nicht geladen werden.",
        "CACHE_STATS_CLOSE": "Schließen",
        "PLAYLIST_PLAY_ALL": "Alle abspielen",
        "SEC_RECENT": "Neu hinzugefügt",
        "SEC_MOST_DOWNLOADED": "Meist heruntergeladen",
        "SEC_TOP_RATED": "Bestbewertet",
        "SEC_FEATURE_FILMS": "Spielfilme",
        "SEC_CLASSIC_FILMS": "Klassiker",
        "SEC_FILM_NOIR": "Film noir",
        "SEC_SCIFI_HORROR": "Sci-Fi & Horror",
        "SEC_SILENT": "Stummfilme",
        "SEC_GUTENBERG": "Project Gutenberg",
        "SEC_OPENLIBRARY": "Open Library",
        "SEC_AMERICANA": "Americana",
        "SEC_MAGAZINES": "Magazine",
        "SEC_OLD_TIME_RADIO": "Old Time Radio",
        "SEC_AUDIOBOOKS": "Hörbücher",
        "SEC_NETLABELS": "Netlabels",
        "SEC_PODCASTS": "Podcasts",
        "SEC_CLASSIC_PC": "Klassische PCs",
        "SEC_INTERNET_ARCADE": "Internet Arcade",
        "SEC_CONSOLE": "Konsolen",
        "SEC_NASA": "NASA",
        "SEC_MET": "Metropolitan Museum",
    },
    "es": {
        "CACHE_REFRESH": "Actualizar catálogo",
        "CACHE_REFRESH_TITLE": "Reconstruir la caché de navegación desde archive.org (la búsqueda de texto sigue en vivo). También cada día a las 05:00.",
        "CACHE_REFRESH_STARTED": "Actualización del catálogo iniciada…",
        "CACHE_REFRESH_PROGRESS": "Catálogo: {{phase}} ({{count}} ítems)…",
        "CACHE_REFRESH_DONE": "Catálogo actualizado.",
        "CACHE_REFRESH_DONE_SEC": "Catálogo actualizado ({{seconds}} s).",
        "CACHE_REFRESH_ERROR": "Error al actualizar el catálogo.",
        "CACHE_STATS": "Estadísticas del catálogo",
        "CACHE_STATS_TITLE": "Ítems en caché por tipo",
        "CACHE_STATS_TOTAL": "Total: {{count}} ítem(s)",
        "CACHE_STATS_EMPTY": "Catálogo vacío — ejecute una actualización.",
        "CACHE_STATS_ERROR": "No se pudieron cargar las estadísticas del catálogo.",
        "CACHE_STATS_CLOSE": "Cerrar",
        "PLAYLIST_PLAY_ALL": "Reproducir todo",
        "SEC_RECENT": "Añadidos recientes",
        "SEC_MOST_DOWNLOADED": "Más descargados",
        "SEC_TOP_RATED": "Mejor valorados",
        "SEC_FEATURE_FILMS": "Largometrajes",
        "SEC_CLASSIC_FILMS": "Clásicos",
        "SEC_FILM_NOIR": "Cine negro",
        "SEC_SCIFI_HORROR": "Ciencia ficción y terror",
        "SEC_SILENT": "Cine mudo",
        "SEC_GUTENBERG": "Project Gutenberg",
        "SEC_OPENLIBRARY": "Open Library",
        "SEC_AMERICANA": "Americana",
        "SEC_MAGAZINES": "Revistas",
        "SEC_OLD_TIME_RADIO": "Old Time Radio",
        "SEC_AUDIOBOOKS": "Audiolibros",
        "SEC_NETLABELS": "Netlabels",
        "SEC_PODCASTS": "Podcasts",
        "SEC_CLASSIC_PC": "PCs clásicos",
        "SEC_INTERNET_ARCADE": "Internet Arcade",
        "SEC_CONSOLE": "Consolas",
        "SEC_NASA": "NASA",
        "SEC_MET": "Metropolitan Museum",
    },
    "it": {
        "CACHE_REFRESH": "Aggiorna catalogo",
        "CACHE_REFRESH_TITLE": "Ricostruisci la piccola cache di navigazione da archive.org (la ricerca testuale resta live). Anche ogni giorno alle 05:00.",
        "CACHE_REFRESH_STARTED": "Aggiornamento del catalogo avviato…",
        "CACHE_REFRESH_PROGRESS": "Catalogo: {{phase}} ({{count}} elementi)…",
        "CACHE_REFRESH_DONE": "Catalogo aggiornato.",
        "CACHE_REFRESH_DONE_SEC": "Catalogo aggiornato ({{seconds}} s).",
        "CACHE_REFRESH_ERROR": "Aggiornamento del catalogo non riuscito.",
        "CACHE_STATS": "Statistiche catalogo",
        "CACHE_STATS_TITLE": "Elementi in cache per tipo",
        "CACHE_STATS_TOTAL": "Totale: {{count}} elemento/i",
        "CACHE_STATS_EMPTY": "Catalogo vuoto — avvia un aggiornamento.",
        "CACHE_STATS_ERROR": "Impossibile caricare le statistiche del catalogo.",
        "CACHE_STATS_CLOSE": "Chiudi",
        "PLAYLIST_PLAY_ALL": "Riproduci tutto",
        "SEC_RECENT": "Aggiunte recenti",
        "SEC_MOST_DOWNLOADED": "Più scaricati",
        "SEC_TOP_RATED": "Più votati",
        "SEC_FEATURE_FILMS": "Film lungometraggio",
        "SEC_CLASSIC_FILMS": "Classici",
        "SEC_FILM_NOIR": "Film noir",
        "SEC_SCIFI_HORROR": "Fantascienza e horror",
        "SEC_SILENT": "Film muti",
        "SEC_GUTENBERG": "Project Gutenberg",
        "SEC_OPENLIBRARY": "Open Library",
        "SEC_AMERICANA": "Americana",
        "SEC_MAGAZINES": "Riviste",
        "SEC_OLD_TIME_RADIO": "Old Time Radio",
        "SEC_AUDIOBOOKS": "Audiolibri",
        "SEC_NETLABELS": "Netlabels",
        "SEC_PODCASTS": "Podcast",
        "SEC_CLASSIC_PC": "PC classici",
        "SEC_INTERNET_ARCADE": "Internet Arcade",
        "SEC_CONSOLE": "Console",
        "SEC_NASA": "NASA",
        "SEC_MET": "Metropolitan Museum",
    },
    "ru": {
        "CACHE_REFRESH": "Обновить каталог",
        "CACHE_REFRESH_TITLE": "Перестроить небольшой кэш навигации с archive.org (текстовый поиск остаётся live). Также каждый день в 05:00.",
        "CACHE_REFRESH_STARTED": "Обновление каталога запущено…",
        "CACHE_REFRESH_PROGRESS": "Каталог: {{phase}} ({{count}} элементов)…",
        "CACHE_REFRESH_DONE": "Каталог обновлён.",
        "CACHE_REFRESH_DONE_SEC": "Каталог обновлён ({{seconds}} с).",
        "CACHE_REFRESH_ERROR": "Не удалось обновить каталог.",
        "CACHE_STATS": "Статистика каталога",
        "CACHE_STATS_TITLE": "Элементы в кэше по типам",
        "CACHE_STATS_TOTAL": "Всего: {{count}} элемент(ов)",
        "CACHE_STATS_EMPTY": "Каталог пуст — запустите обновление.",
        "CACHE_STATS_ERROR": "Не удалось загрузить статистику каталога.",
        "CACHE_STATS_CLOSE": "Закрыть",
        "PLAYLIST_PLAY_ALL": "Слушать всё",
        "SEC_RECENT": "Недавние добавления",
        "SEC_MOST_DOWNLOADED": "Самые скачиваемые",
        "SEC_TOP_RATED": "С высоким рейтингом",
        "SEC_FEATURE_FILMS": "Художественные фильмы",
        "SEC_CLASSIC_FILMS": "Классика",
        "SEC_FILM_NOIR": "Нуар",
        "SEC_SCIFI_HORROR": "Фантастика и ужасы",
        "SEC_SILENT": "Немое кино",
        "SEC_GUTENBERG": "Project Gutenberg",
        "SEC_OPENLIBRARY": "Open Library",
        "SEC_AMERICANA": "Americana",
        "SEC_MAGAZINES": "Журналы",
        "SEC_OLD_TIME_RADIO": "Old Time Radio",
        "SEC_AUDIOBOOKS": "Аудиокниги",
        "SEC_NETLABELS": "Netlabels",
        "SEC_PODCASTS": "Подкасты",
        "SEC_CLASSIC_PC": "Классические ПК",
        "SEC_INTERNET_ARCADE": "Internet Arcade",
        "SEC_CONSOLE": "Консоли",
        "SEC_NASA": "NASA",
        "SEC_MET": "Metropolitan Museum",
    },
    "jp": {
        "CACHE_REFRESH": "カタログを更新",
        "CACHE_REFRESH_TITLE": "archive.org から閲覧用の小さなキャッシュを再構築します（テキスト検索はライブのまま）。毎日 05:00 にも実行。",
        "CACHE_REFRESH_STARTED": "カタログの更新を開始しました…",
        "CACHE_REFRESH_PROGRESS": "カタログ: {{phase}}（{{count}} 件）…",
        "CACHE_REFRESH_DONE": "カタログを更新しました。",
        "CACHE_REFRESH_DONE_SEC": "カタログを更新しました（{{seconds}} 秒）。",
        "CACHE_REFRESH_ERROR": "カタログの更新に失敗しました。",
        "CACHE_STATS": "カタログ統計",
        "CACHE_STATS_TITLE": "タイプ別キャッシュ件数",
        "CACHE_STATS_TOTAL": "合計: {{count}} 件",
        "CACHE_STATS_EMPTY": "カタログが空です — 更新を実行してください。",
        "CACHE_STATS_ERROR": "カタログ統計を読み込めませんでした。",
        "CACHE_STATS_CLOSE": "閉じる",
        "PLAYLIST_PLAY_ALL": "すべて再生",
        "SEC_RECENT": "最近の追加",
        "SEC_MOST_DOWNLOADED": "ダウンロード数が多い",
        "SEC_TOP_RATED": "高評価",
        "SEC_FEATURE_FILMS": "長編映画",
        "SEC_CLASSIC_FILMS": "クラシック",
        "SEC_FILM_NOIR": "フィルム・ノワール",
        "SEC_SCIFI_HORROR": "SF・ホラー",
        "SEC_SILENT": "サイレント映画",
        "SEC_GUTENBERG": "Project Gutenberg",
        "SEC_OPENLIBRARY": "Open Library",
        "SEC_AMERICANA": "Americana",
        "SEC_MAGAZINES": "雑誌",
        "SEC_OLD_TIME_RADIO": "Old Time Radio",
        "SEC_AUDIOBOOKS": "オーディオブック",
        "SEC_NETLABELS": "Netlabels",
        "SEC_PODCASTS": "ポッドキャスト",
        "SEC_CLASSIC_PC": "クラシック PC",
        "SEC_INTERNET_ARCADE": "Internet Arcade",
        "SEC_CONSOLE": "コンソール",
        "SEC_NASA": "NASA",
        "SEC_MET": "Metropolitan Museum",
    },
    "cn": {
        "CACHE_REFRESH": "刷新目录",
        "CACHE_REFRESH_TITLE": "从 archive.org 重建小型浏览缓存（文本搜索仍为实时）。每天 05:00 也会运行。",
        "CACHE_REFRESH_STARTED": "目录刷新已开始…",
        "CACHE_REFRESH_PROGRESS": "目录：{{phase}}（{{count}} 项）…",
        "CACHE_REFRESH_DONE": "目录已刷新。",
        "CACHE_REFRESH_DONE_SEC": "目录已刷新（{{seconds}} 秒）。",
        "CACHE_REFRESH_ERROR": "目录刷新失败。",
        "CACHE_STATS": "目录统计",
        "CACHE_STATS_TITLE": "按类型缓存的条目",
        "CACHE_STATS_TOTAL": "总计：{{count}} 项",
        "CACHE_STATS_EMPTY": "目录为空 — 请运行刷新。",
        "CACHE_STATS_ERROR": "无法加载目录统计。",
        "CACHE_STATS_CLOSE": "关闭",
        "PLAYLIST_PLAY_ALL": "全部播放",
        "SEC_RECENT": "最近添加",
        "SEC_MOST_DOWNLOADED": "下载最多",
        "SEC_TOP_RATED": "评分最高",
        "SEC_FEATURE_FILMS": "剧情长片",
        "SEC_CLASSIC_FILMS": "经典",
        "SEC_FILM_NOIR": "黑色电影",
        "SEC_SCIFI_HORROR": "科幻与恐怖",
        "SEC_SILENT": "默片",
        "SEC_GUTENBERG": "Project Gutenberg",
        "SEC_OPENLIBRARY": "Open Library",
        "SEC_AMERICANA": "Americana",
        "SEC_MAGAZINES": "杂志",
        "SEC_OLD_TIME_RADIO": "Old Time Radio",
        "SEC_AUDIOBOOKS": "有声书",
        "SEC_NETLABELS": "Netlabels",
        "SEC_PODCASTS": "播客",
        "SEC_CLASSIC_PC": "经典 PC",
        "SEC_INTERNET_ARCADE": "Internet Arcade",
        "SEC_CONSOLE": "主机游戏",
        "SEC_NASA": "NASA",
        "SEC_MET": "Metropolitan Museum",
    },
    "ar": {
        "CACHE_REFRESH": "تحديث الفهرس",
        "CACHE_REFRESH_TITLE": "إعادة بناء ذاكرة التصفح الصغيرة من archive.org (البحث النصي يبقى مباشرًا). وأيضًا كل يوم الساعة 05:00.",
        "CACHE_REFRESH_STARTED": "بدأ تحديث الفهرس…",
        "CACHE_REFRESH_PROGRESS": "الفهرس: {{phase}} ({{count}} عنصر)…",
        "CACHE_REFRESH_DONE": "تم تحديث الفهرس.",
        "CACHE_REFRESH_DONE_SEC": "تم تحديث الفهرس ({{seconds}} ث).",
        "CACHE_REFRESH_ERROR": "فشل تحديث الفهرس.",
        "CACHE_STATS": "إحصاءات الفهرس",
        "CACHE_STATS_TITLE": "العناصر المخزّنة حسب النوع",
        "CACHE_STATS_TOTAL": "المجموع: {{count}} عنصر",
        "CACHE_STATS_EMPTY": "الفهرس فارغ — شغّل التحديث.",
        "CACHE_STATS_ERROR": "تعذّر تحميل إحصاءات الفهرس.",
        "CACHE_STATS_CLOSE": "إغلاق",
        "PLAYLIST_PLAY_ALL": "تشغيل الكل",
        "SEC_RECENT": "إضافات حديثة",
        "SEC_MOST_DOWNLOADED": "الأكثر تنزيلًا",
        "SEC_TOP_RATED": "الأعلى تقييمًا",
        "SEC_FEATURE_FILMS": "أفلام روائية",
        "SEC_CLASSIC_FILMS": "كلاسيكيات",
        "SEC_FILM_NOIR": "فيلم نوار",
        "SEC_SCIFI_HORROR": "خيال علمي ورعب",
        "SEC_SILENT": "أفلام صامتة",
        "SEC_GUTENBERG": "Project Gutenberg",
        "SEC_OPENLIBRARY": "Open Library",
        "SEC_AMERICANA": "Americana",
        "SEC_MAGAZINES": "مجلات",
        "SEC_OLD_TIME_RADIO": "Old Time Radio",
        "SEC_AUDIOBOOKS": "كتب صوتية",
        "SEC_NETLABELS": "Netlabels",
        "SEC_PODCASTS": "بودكاست",
        "SEC_CLASSIC_PC": "حواسيب كلاسيكية",
        "SEC_INTERNET_ARCADE": "Internet Arcade",
        "SEC_CONSOLE": "أجهزة ألعاب",
        "SEC_NASA": "NASA",
        "SEC_MET": "Metropolitan Museum",
    },
    "el": {
        "CACHE_REFRESH": "Ανανέωση καταλόγου",
        "CACHE_REFRESH_TITLE": "Ανακατασκευή της μικρής προσωρινής μνήμης περιήγησης από το archive.org (η αναζήτηση κειμένου παραμένει ζωντανή). Επίσης κάθε μέρα στις 05:00.",
        "CACHE_REFRESH_STARTED": "Η ανανέωση καταλόγου ξεκίνησε…",
        "CACHE_REFRESH_PROGRESS": "Κατάλογος: {{phase}} ({{count}} στοιχεία)…",
        "CACHE_REFRESH_DONE": "Ο κατάλογος ανανεώθηκε.",
        "CACHE_REFRESH_DONE_SEC": "Ο κατάλογος ανανεώθηκε ({{seconds}} δ).",
        "CACHE_REFRESH_ERROR": "Αποτυχία ανανέωσης καταλόγου.",
        "CACHE_STATS": "Στατιστικά καταλόγου",
        "CACHE_STATS_TITLE": "Στοιχεία σε cache ανά τύπο",
        "CACHE_STATS_TOTAL": "Σύνολο: {{count}} στοιχείο/α",
        "CACHE_STATS_EMPTY": "Ο κατάλογος είναι κενός — εκτελέστε ανανέωση.",
        "CACHE_STATS_ERROR": "Αδυναμία φόρτωσης στατιστικών καταλόγου.",
        "CACHE_STATS_CLOSE": "Κλείσιμο",
        "PLAYLIST_PLAY_ALL": "Αναπαραγωγή όλων",
        "SEC_RECENT": "Πρόσφατες προσθήκες",
        "SEC_MOST_DOWNLOADED": "Περισσότερες λήψεις",
        "SEC_TOP_RATED": "Κορυφαία βαθμολογία",
        "SEC_FEATURE_FILMS": "Ταινίες μεγάλου μήκους",
        "SEC_CLASSIC_FILMS": "Κλασικά",
        "SEC_FILM_NOIR": "Film noir",
        "SEC_SCIFI_HORROR": "Sci-fi & τρόμος",
        "SEC_SILENT": "Βωβές ταινίες",
        "SEC_GUTENBERG": "Project Gutenberg",
        "SEC_OPENLIBRARY": "Open Library",
        "SEC_AMERICANA": "Americana",
        "SEC_MAGAZINES": "Περιοδικά",
        "SEC_OLD_TIME_RADIO": "Old Time Radio",
        "SEC_AUDIOBOOKS": "Ηχητικά βιβλία",
        "SEC_NETLABELS": "Netlabels",
        "SEC_PODCASTS": "Podcast",
        "SEC_CLASSIC_PC": "Κλασικοί υπολογιστές",
        "SEC_INTERNET_ARCADE": "Internet Arcade",
        "SEC_CONSOLE": "Κονσόλες",
        "SEC_NASA": "NASA",
        "SEC_MET": "Metropolitan Museum",
    },
    "he": {
        "CACHE_REFRESH": "רענון הקטלוג",
        "CACHE_REFRESH_TITLE": "בנייה מחדש של מטמון הגלישה הקטן מ־archive.org (חיפוש טקסט נשאר חי). גם כל יום ב־05:00.",
        "CACHE_REFRESH_STARTED": "רענון הקטלוג התחיל…",
        "CACHE_REFRESH_PROGRESS": "קטלוג: {{phase}} ({{count}} פריטים)…",
        "CACHE_REFRESH_DONE": "הקטלוג רוענן.",
        "CACHE_REFRESH_DONE_SEC": "הקטלוג רוענן ({{seconds}} שנ׳).",
        "CACHE_REFRESH_ERROR": "רענון הקטלוג נכשל.",
        "CACHE_STATS": "סטטיסטיקת קטלוג",
        "CACHE_STATS_TITLE": "פריטים במטמון לפי סוג",
        "CACHE_STATS_TOTAL": "סה״כ: {{count}} פריט(ים)",
        "CACHE_STATS_EMPTY": "הקטלוג ריק — הפעילו רענון.",
        "CACHE_STATS_ERROR": "לא ניתן לטעון סטטיסטיקת קטלוג.",
        "CACHE_STATS_CLOSE": "סגור",
        "PLAYLIST_PLAY_ALL": "נגן הכול",
        "SEC_RECENT": "הוספות אחרונות",
        "SEC_MOST_DOWNLOADED": "הכי מורדים",
        "SEC_TOP_RATED": "דירוג גבוה",
        "SEC_FEATURE_FILMS": "סרטי עלילה",
        "SEC_CLASSIC_FILMS": "קלאסיקות",
        "SEC_FILM_NOIR": "פילם נואר",
        "SEC_SCIFI_HORROR": "מדע בדיוני ואימה",
        "SEC_SILENT": "סרטים אילמים",
        "SEC_GUTENBERG": "Project Gutenberg",
        "SEC_OPENLIBRARY": "Open Library",
        "SEC_AMERICANA": "Americana",
        "SEC_MAGAZINES": "מגזינים",
        "SEC_OLD_TIME_RADIO": "Old Time Radio",
        "SEC_AUDIOBOOKS": "ספרים מוקלטים",
        "SEC_NETLABELS": "Netlabels",
        "SEC_PODCASTS": "פודקאסטים",
        "SEC_CLASSIC_PC": "מחשבים קלאסיים",
        "SEC_INTERNET_ARCADE": "Internet Arcade",
        "SEC_CONSOLE": "קונסולות",
        "SEC_NASA": "NASA",
        "SEC_MET": "Metropolitan Museum",
    },
    "in": {
        "CACHE_REFRESH": "कैटलॉग रिफ्रेश करें",
        "CACHE_REFRESH_TITLE": "archive.org से छोटा ब्राउज़ कैश फिर बनाएँ (टेक्स्ट खोज लाइव रहती है)। प्रतिदिन 05:00 पर भी।",
        "CACHE_REFRESH_STARTED": "कैटलॉग रिफ्रेश शुरू…",
        "CACHE_REFRESH_PROGRESS": "कैटलॉग: {{phase}} ({{count}} आइटम)…",
        "CACHE_REFRESH_DONE": "कैटलॉग अपडेट हो गया।",
        "CACHE_REFRESH_DONE_SEC": "कैटलॉग अपडेट ({{seconds}} से॰)।",
        "CACHE_REFRESH_ERROR": "कैटलॉग रिफ्रेश विफल।",
        "CACHE_STATS": "कैटलॉग आँकड़े",
        "CACHE_STATS_TITLE": "प्रकार के अनुसार कैश आइटम",
        "CACHE_STATS_TOTAL": "कुल: {{count}} आइटम",
        "CACHE_STATS_EMPTY": "कैटलॉग खाली है — रिफ्रेश चलाएँ।",
        "CACHE_STATS_ERROR": "कैटलॉग आँकड़े लोड नहीं हो सके।",
        "CACHE_STATS_CLOSE": "बंद करें",
        "PLAYLIST_PLAY_ALL": "सभी चलाएँ",
        "SEC_RECENT": "हाल की जोड़ियाँ",
        "SEC_MOST_DOWNLOADED": "सबसे अधिक डाउनलोड",
        "SEC_TOP_RATED": "शीर्ष रेटेड",
        "SEC_FEATURE_FILMS": "फीचर फ़िल्में",
        "SEC_CLASSIC_FILMS": "क्लासिक्स",
        "SEC_FILM_NOIR": "फ़िल्म नॉयर",
        "SEC_SCIFI_HORROR": "साइ-फ़ाई और हॉरर",
        "SEC_SILENT": "मूक फ़िल्में",
        "SEC_GUTENBERG": "Project Gutenberg",
        "SEC_OPENLIBRARY": "Open Library",
        "SEC_AMERICANA": "Americana",
        "SEC_MAGAZINES": "पत्रिकाएँ",
        "SEC_OLD_TIME_RADIO": "Old Time Radio",
        "SEC_AUDIOBOOKS": "ऑडियोबुक्स",
        "SEC_NETLABELS": "Netlabels",
        "SEC_PODCASTS": "पॉडकास्ट",
        "SEC_CLASSIC_PC": "क्लासिक PC",
        "SEC_INTERNET_ARCADE": "Internet Arcade",
        "SEC_CONSOLE": "कंसोल",
        "SEC_NASA": "NASA",
        "SEC_MET": "Metropolitan Museum",
    },
}

CACHE_KEYS = [
    "CACHE_REFRESH",
    "CACHE_REFRESH_TITLE",
    "CACHE_REFRESH_STARTED",
    "CACHE_REFRESH_PROGRESS",
    "CACHE_REFRESH_DONE",
    "CACHE_REFRESH_DONE_SEC",
    "CACHE_REFRESH_ERROR",
    "CACHE_STATS",
    "CACHE_STATS_TITLE",
    "CACHE_STATS_TOTAL",
    "CACHE_STATS_EMPTY",
    "CACHE_STATS_ERROR",
    "CACHE_STATS_CLOSE",
]
SEC_KEYS = [
    "SEC_RECENT",
    "SEC_MOST_DOWNLOADED",
    "SEC_TOP_RATED",
    "SEC_FEATURE_FILMS",
    "SEC_CLASSIC_FILMS",
    "SEC_FILM_NOIR",
    "SEC_SCIFI_HORROR",
    "SEC_SILENT",
    "SEC_GUTENBERG",
    "SEC_OPENLIBRARY",
    "SEC_AMERICANA",
    "SEC_MAGAZINES",
    "SEC_OLD_TIME_RADIO",
    "SEC_AUDIOBOOKS",
    "SEC_NETLABELS",
    "SEC_PODCASTS",
    "SEC_CLASSIC_PC",
    "SEC_INTERNET_ARCADE",
    "SEC_CONSOLE",
    "SEC_NASA",
    "SEC_MET",
]


def escape_json_str(s: str) -> str:
    return json.dumps(s, ensure_ascii=False)[1:-1]


def find_archive_span(text: str) -> tuple[int, int]:
    """Return [start, end) of the top-level ARCHIVE object including braces."""
    m = re.search(r'\n  "ARCHIVE": \{', text)
    if not m:
        raise ValueError("ARCHIVE block not found")
    start = m.start() + len("\n  \"ARCHIVE\": ")
    i = start
    assert text[i] == "{"
    depth = 0
    in_str = False
    esc = False
    while i < len(text):
        ch = text[i]
        if in_str:
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == '"':
                in_str = False
        else:
            if ch == '"':
                in_str = True
            elif ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    return start, i + 1
        i += 1
    raise ValueError("unclosed ARCHIVE")


def parse_object(obj_text: str) -> dict[str, str]:
    return json.loads(obj_text)


def format_archive(archive: dict[str, str]) -> str:
    lines = ["{"]
    items = list(archive.items())
    for idx, (k, v) in enumerate(items):
        comma = "," if idx < len(items) - 1 else ""
        lines.append(f'    "{k}": "{escape_json_str(v)}"{comma}')
    lines.append("  }")
    return "\n".join(lines)


def ordered_archive(archive: dict[str, str], lang: str) -> dict[str, str]:
    extras = TRANSLATIONS[lang]
    out: dict[str, str] = {}
    inserted_cache = False
    for key, value in archive.items():
        if key.startswith("SEC_") or key in CACHE_KEYS or key == "PLAYLIST_PLAY_ALL":
            # drop; re-insert in controlled places
            continue
        out[key] = value
        if key == "SEARCH_BTN" and not inserted_cache:
            for ck in CACHE_KEYS:
                out[ck] = extras[ck]
            inserted_cache = True
        if key == "PLAYLIST_COUNT":
            out["PLAYLIST_PLAY_ALL"] = extras["PLAYLIST_PLAY_ALL"]
    if not inserted_cache:
        for ck in CACHE_KEYS:
            out[ck] = extras[ck]
    if "PLAYLIST_PLAY_ALL" not in out:
        out["PLAYLIST_PLAY_ALL"] = extras["PLAYLIST_PLAY_ALL"]
    for sk in SEC_KEYS:
        out[sk] = extras[sk]
    # Keep any other existing ARCHIVE keys that we didn't touch
    for key, value in archive.items():
        if key not in out and not key.startswith("SEC_"):
            out[key] = value
    return out


def main() -> None:
    en_keys = None
    for lang in TRANSLATIONS:
        path = I18N / f"{lang}.json"
        text = path.read_text(encoding="utf-8")
        start, end = find_archive_span(text)
        archive = parse_object(text[start:end])
        # Prefer existing translated cache keys for en/fr if already present
        for k, v in TRANSLATIONS[lang].items():
            if k in archive and lang in ("en", "fr") and not k.startswith("SEC_"):
                TRANSLATIONS[lang][k] = archive[k]
        updated = ordered_archive(archive, lang)
        new_block = format_archive(updated)
        new_text = text[:start] + new_block + text[end:]
        path.write_text(new_text, encoding="utf-8")
        print(f"OK {lang} keys={len(updated)}")
        if lang == "en":
            en_keys = set(updated)

    assert en_keys is not None
    for lang in TRANSLATIONS:
        path = I18N / f"{lang}.json"
        text = path.read_text(encoding="utf-8")
        start, end = find_archive_span(text)
        keys = set(parse_object(text[start:end]))
        missing = sorted(en_keys - keys)
        extra = sorted(keys - en_keys)
        status = "PARITY" if not missing and not extra else f"DIFF missing={missing} extra={extra}"
        print(f"{status} {lang}")


if __name__ == "__main__":
    main()
