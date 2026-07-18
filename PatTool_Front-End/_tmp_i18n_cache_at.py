import json
import pathlib

root = pathlib.Path(r"c:\Dev\PATTOOL2\PatTool_Front-End\src\assets\i18n")
hints = {
    "fr": "Tuiles WMS servies depuis le cache serveur (depuis {{cachedAt}}, TTL {{ttl}} min).",
    "en": "WMS tiles served from server cache (since {{cachedAt}}, TTL {{ttl}} min).",
    "de": "WMS-Kacheln aus dem Server-Cache (seit {{cachedAt}}, TTL {{ttl}} Min.).",
    "es": "Baldosas WMS servidas desde la caché del servidor (desde {{cachedAt}}, TTL {{ttl}} min).",
    "it": "Tile WMS dal cache server (dal {{cachedAt}}, TTL {{ttl}} min).",
    "ru": "Тайлы WMS из серверного кэша (с {{cachedAt}}, TTL {{ttl}} мин).",
    "el": "Πλακίδια WMS από την προσωρινή μνήμη διακομιστή (από {{cachedAt}}, TTL {{ttl}} λεπ).",
    "ar": "بلاطات WMS من ذاكرة التخزين المؤقت للخادم (منذ {{cachedAt}}، TTL {{ttl}} د).",
    "he": "אריחי WMS ממטמון השרת (מאז {{cachedAt}}, TTL {{ttl}} דק').",
    "cn": "WMS 瓦片来自服务器缓存（自 {{cachedAt}}，TTL {{ttl}} 分钟）。",
    "jp": "WMSタイルはサーバーキャッシュから配信（{{cachedAt}}以降、TTL {{ttl}}分）。",
    "in": "WMS टाइलें सर्वर कैश से ({{cachedAt}} से, TTL {{ttl}} मि.)।",
}

for path in sorted(root.glob("*.json")):
    lang = path.stem
    data = json.loads(path.read_text(encoding="utf-8"))
    mf = data.get("METEO_FRANCE")
    if not isinstance(mf, dict):
        print(f"skip {path.name}")
        continue
    mf["FORECAST_MAP_CACHE_HINT"] = hints.get(lang, hints["en"])
    # Ensure OPTIONS_SAVE keys exist (from interrupted previous work)
    if "OPTIONS_SAVE_OK" not in mf:
        save = {
            "fr": ("Paramètre enregistré.", "Échec de l'enregistrement."),
            "en": ("Setting saved.", "Failed to save setting."),
        }.get(lang, ("Setting saved.", "Failed to save setting."))
        if lang == "de":
            save = ("Einstellung gespeichert.", "Speichern fehlgeschlagen.")
        elif lang == "es":
            save = ("Parámetro guardado.", "Error al guardar el parámetro.")
        elif lang == "it":
            save = ("Impostazione salvata.", "Salvataggio non riuscito.")
        elif lang == "ru":
            save = ("Параметр сохранён.", "Не удалось сохранить параметр.")
        elif lang == "el":
            save = ("Η ρύθμιση αποθηκεύτηκε.", "Αποτυχία αποθήκευσης.")
        elif lang == "ar":
            save = ("تم حفظ الإعداد.", "تعذر حفظ الإعداد.")
        elif lang == "he":
            save = ("ההגדרה נשמרה.", "שמירת ההגדרה נכשלה.")
        elif lang == "cn":
            save = ("设置已保存。", "保存设置失败。")
        elif lang == "jp":
            save = ("設定を保存しました。", "設定の保存に失敗しました。")
        elif lang == "in":
            save = ("सेटिंग सहेजी गई।", "सेटिंग सहेजने में विफल।")
        mf["OPTIONS_SAVE_OK"] = save[0]
        mf["OPTIONS_SAVE_ERR"] = save[1]
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"updated {path.name}")
