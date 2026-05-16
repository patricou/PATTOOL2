#!/usr/bin/env python3
"""Remove obsolete WORLD_GLOBE activity-on-globe keys and refresh SUBTITLE / ROADMAP_HINT."""
from __future__ import annotations

import json
import pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent / "src" / "assets" / "i18n"

REMOVE_KEYS = {
    "LAYER_ACTIVITY_TRACE",
    "LOAD_ACTIVITIES",
    "ACTIVITIES_LOADING",
    "ACTIVITIES_NEED_LOGIN",
    "ACTIVITIES_NONE",
    "ACTIVITIES_DONE",
    "ACTIVITIES_ERROR",
    "ACTIVITY_PICKER_TITLE",
    "ACTIVITY_PICKER_HINT",
    "ACTIVITY_TRACK_BADGE",
    "ACTIVITY_TRACK_BADGE_HINT",
    "ACTIVITY_SELECT_TRACKS_ONLY",
    "ACTIVITY_APPLY_GLOBE",
    "ACTIVITIES_APPLYING",
}

# Per-locale SUBTITLE / ROADMAP for WORLD_GLOBE only (feature removed)
SUBTITLE_BY_LANG: dict[str, str] = {
    "en": "Interactive 3D globe (WebGL). Imagery is proxied through the PatTool API; place search uses the same backend as Address/GPS.",
    "fr": "Globe interactif 3D (WebGL). Les images passent par l\u2019API PatTool ; le géocodage des lieux utilise le même backend que Adresse/GPS.",
    "de": "Interaktiver 3D-Globus (WebGL). Bilder laufen über die PatTool-API; Geocoding von Orten nutzt dasselbe Backend wie Adresse/GPS.",
    "es": "Globo 3D interactivo (WebGL). Las imágenes se obtienen mediante la API de PatTool; el geocodificado de lugares usa el mismo backend que Dirección/GPS.",
    "it": "Globo 3D interattivo (WebGL). Le immagini passano tramite l\u2019API PatTool; il geocoding dei luoghi usa lo stesso backend di Indirizzo/GPS.",
    "ar": "\u0643\u0631\u0629 \u0623\u0631\u0636 \u062a\u0641\u0627\u0639\u0644\u064a\u0629 \u062b\u0644\u0627\u062b\u064a\u0629 \u0627\u0644\u0623\u0628\u0639\u0627\u062f (WebGL). \u0627\u0644\u0635\u0648\u0631 \u062a\u0645\u0631 \u0639\u0628\u0631 \u0648\u0627\u062c\u0647\u0629 PatTool\u061b \u062a\u0631\u0645\u064a\u0632 \u0627\u0644\u0645\u0648\u0627\u0642\u0639 \u0627\u0644\u062c\u063a\u0631\u0627\u0641\u064a \u064a\u0633\u062a\u062e\u062f\u0645 \u0646\u0641\u0633 \u0627\u0644\u062e\u0644\u0641\u064a\u0629 \u0645\u062b\u0644 \u0639\u0646\u0648\u0627\u0646/GPS.",
    "el": "\u0394\u03b9\u03b1\u03b4\u03c1\u03b1\u03c3\u03c4\u03b9\u03ba\u03ae 3D \u03c5\u03b4\u03c1\u03cc\u03b3\u03b5\u03b9\u03bf\u03c2 (WebGL). \u039f\u03b9 \u03b5\u03b9\u03ba\u03cc\u03bd\u03b5\u03c2 \u03b4\u03b9\u03ad\u03c1\u03c7\u03bf\u03bd\u03c4\u03b1\u03b9 \u03bc\u03ad\u03c3\u03c9 \u03c4\u03bf\u03c5 API PatTool\u00b7 \u03b7 \u03b3\u03b5\u03c9\u03ba\u03c9\u03b4\u03b9\u03ba\u03bf\u03c0\u03bf\u03af\u03b7\u03c3\u03b7 \u03c4\u03bf\u03c0\u03bf\u03b8\u03b5\u03c3\u03b9\u03ce\u03bd \u03c7\u03c1\u03b7\u03c3\u03b9\u03bc\u03bf\u03c0\u03bf\u03b9\u03b5\u03af \u03c4\u03bf \u03af\u03b4\u03b9\u03bf backend \u03bc\u03b5 \u0394\u03b9\u03b5\u03cd\u03b8\u03c5\u03bd\u03c3\u03b7/GPS.",
    "he": '\u05d2\u05dc\u05d5\u05d1\u05d5\u05e1 \u05ea\u05dc\u05ea\u2013\u05de\u05de\u05d3\u05d9 \u05d0\u05d9\u05e0\u05d8\u05e8\u05d0\u05e7\u05d8\u05d9\u05d1\u05d9 (WebGL). \u05d4\u05ea\u05de\u05d5\u05e0\u05d5\u05ea \u05de\u05d2\u05d9\u05e2\u05d5\u05ea \u05d3\u05e8\u05da \u05de\u05de\u05e9\u05e7 PatTool; \u05e7\u05d9\u05d3\u05d5\u05d3 \u05d2\u05d9\u05d0\u05d5\u05d2\u05e8\u05e4\u05d9 \u05dc\u05de\u05d9\u05e7\u05d5\u05de\u05d5\u05ea \u05de\u05e9\u05ea\u05de\u05e9 \u05d1\u05d0\u05d5\u05ea\u05d5 \u05e9\u05e8\u05ea \u05e2\u05d5\u05e8\u05e4\u05d9 \u05db\u05de\u05d5 \u05db\u05ea\u05d5\u05d1\u05ea/GPS.',
    "jp": "\u30a4\u30f3\u30bf\u30e9\u30af\u30c6\u30a3\u30d6\u306a 3D \u5730\u7403\uff08WebGL\uff09\u3002\u753b\u50cf\u306f PatTool API \u7d4c\u7531\u3002\u5730\u540d\u306e\u30b8\u30aa\u30b3\u30fc\u30c7\u30a3\u30f3\u30b0\u306f\u4f4f\u6240/GPS \u3068\u540c\u3058\u30d0\u30c3\u30af\u30a8\u30f3\u30c9\u3092\u4f7f\u7528\u3057\u307e\u3059\u3002",
    "cn": "\u4ea4\u4e92\u5f0f 3D \u5730\u7403\uff08WebGL\uff09\u3002\u56fe\u50cf\u7ecf PatTool API \u4ee3\u7406\uff1b\u5730\u70b9\u7684\u5730\u7406\u7f16\u7801\u4e0e\u5730\u5740/GPS \u5171\u7528\u540c\u4e00\u540e\u7aef\u3002",
    "ru": "\u0418\u043d\u0442\u0435\u0440\u0430\u043a\u0442\u0438\u0432\u043d\u044b\u0439 3D-\u0433\u043b\u043e\u0431\u0443\u0441 (WebGL). \u0418\u0437\u043e\u0431\u0440\u0430\u0436\u0435\u043d\u0438\u044f \u0438\u0434\u0443\u0442 \u0447\u0435\u0440\u0435\u0437 API PatTool; \u0433\u0435\u043e\u043a\u043e\u0434\u0438\u0440\u043e\u0432\u0430\u043d\u0438\u0435 \u043c\u0435\u0441\u0442 \u0438\u0441\u043f\u043e\u043b\u044c\u0437\u0443\u0435\u0442 \u0442\u043e\u0442 \u0436\u0435 \u0431\u044d\u043a\u0435\u043d\u0434, \u0447\u0442\u043e \u0430\u0434\u0440\u0435\u0441/GPS.",
    "in": "\u0907\u0902\u091f\u0930\u0948\u0915\u094d\u091f\u093f\u0935 3D \u0917\u094d\u0932\u094b\u092c (WebGL)\u0964 \u091b\u0935\u093f\u092f\u093e\u0901 PatTool API \u0938\u0947 \u0906\u0924\u0940 \u0939\u0948\u0902; \u0938\u094d\u0925\u093e\u0928\u094b\u0902 \u0915\u093e \u091c\u093f\u092f\u094b\u0915\u094b\u0921\u093f\u0902\u0917 \u092a\u0924\u093e/GPS \u091c\u0948\u0938\u093e \u0939\u0940 \u092c\u0948\u0915\u090f\u0902\u0921 \u0909\u092a\u092f\u094b\u0917 \u0915\u0930\u0924\u093e \u0939\u0948\u0964",
}

ROADMAP_BY_LANG: dict[str, str] = {
    "en": "Next steps: weather imagery (infrared / clouds), optional satellite basemaps.",
    "fr": "Suite prévue : imagerie météo, fonds satellite optionnels.",
    "de": "Geplant: Wetterbilder, optionale Satelliten-Hintergründe.",
    "es": "Próximos pasos: imágenes meteorológicas, fondos satelitales opcionales.",
    "it": "Prossimi passi: immagini meteo, mappe satellitari opzionali.",
    "ar": "\u0627\u0644\u062e\u0637\u0648\u0627\u062a \u0627\u0644\u062a\u0627\u0644\u064a\u0629: \u0635\u0648\u0631 \u0627\u0644\u0637\u0642\u0633\u060c \u062e\u0631\u0627\u0626\u0637 \u0623\u0642\u0645\u0627\u0631 \u0627\u062e\u062a\u064a\u0627\u0631\u064a\u0629.",
    "el": "\u0395\u03c0\u03cc\u03bc\u03b5\u03bd\u03b1 \u03b2\u03ae\u03bc\u03b1\u03c4\u03b1: \u03b4\u03bf\u03c1\u03c5\u03c6\u03bf\u03c1\u03b9\u03ba\u03ad\u03c2 \u03b5\u03b9\u03ba\u03cc\u03bd\u03b5\u03c2 \u03ba\u03b1\u03b9\u03c1\u03bf\u03cd, \u03c0\u03c1\u03bf\u03b1\u03b9\u03c1\u03b5\u03c4\u03b9\u03ba\u03bf\u03af \u03b4\u03bf\u03c1\u03c5\u03c6\u03bf\u03c1\u03b9\u03ba\u03bf\u03af \u03c7\u03ac\u03c1\u03c4\u03b5\u03c2.",
    "he": "\u05e9\u05dc\u05d1\u05d9\u05dd \u05d4\u05d1\u05d0\u05d9\u05dd: \u05ea\u05de\u05d5\u05e0\u05d5\u05ea \u05de\u05d6\u05d2 \u05d0\u05d5\u05d5\u05d9\u05e8, \u05de\u05e4\u05d5\u05ea \u05dc\u05d5\u05d5\u05d9\u05d9\u05df \u05d0\u05d5\u05e4\u05e6\u05d9\u05d5\u05e0\u05dc\u05d9\u05d5\u05ea.",
    "jp": "\u4eca\u5f8c\uff1a\u6c17\u8c61\u753b\u50cf\u3001\u30aa\u30d7\u30b7\u30e7\u30f3\u306e\u885b\u661f\u5730\u56f3\u306a\u3069\u3002",
    "cn": "\u540e\u7eed\u8ba1\u5212\uff1a\u6c14\u8c61\u56fe\u50cf\u3001\u53ef\u9009\u536b\u661f\u5e95\u56fe\u7b49\u3002",
    "ru": "\u0414\u0430\u043b\u044c\u0448\u0435: \u043c\u0435\u0442\u0435\u043e\u0441\u043d\u0438\u043c\u043a\u0438, \u043e\u043f\u0446\u0438\u043e\u043d\u0430\u043b\u044c\u043d\u044b\u0435 \u0441\u043f\u0443\u0442\u043d\u0438\u043a\u043e\u0432\u044b\u0435 \u043f\u043e\u0434\u043b\u043e\u0436\u043a\u0438.",
    "in": "\u0906\u0917\u0947: \u092e\u094c\u0938\u092e \u0915\u0940 \u0924\u0938\u094d\u0935\u0940\u0930\u0947\u0902, \u0935\u0948\u0915\u0932\u094d\u092a\u093f\u0915 \u0909\u092a\u0917\u094d\u0930\u0939 \u092e\u093e\u0928\u091a\u093f\u0924\u094d\u0930\u0964",
}


def main() -> None:
    for path in sorted(ROOT.glob("*.json")):
        text = path.read_text(encoding="utf-8")
        data = json.loads(text)
        wg = data.get("WORLD_GLOBE")
        if not isinstance(wg, dict):
            continue
        lang = path.stem
        dirty = False
        removed = []
        for k in REMOVE_KEYS:
            if k in wg:
                del wg[k]
                removed.append(k)
                dirty = True
        if lang in SUBTITLE_BY_LANG and wg.get("SUBTITLE") != SUBTITLE_BY_LANG[lang]:
            wg["SUBTITLE"] = SUBTITLE_BY_LANG[lang]
            dirty = True
        if lang in ROADMAP_BY_LANG and wg.get("ROADMAP_HINT") != ROADMAP_BY_LANG[lang]:
            wg["ROADMAP_HINT"] = ROADMAP_BY_LANG[lang]
            dirty = True
        if not dirty:
            print(f"{path.name}: (no changes)")
            continue
        out = json.dumps(data, ensure_ascii=False, indent=4) + "\n"
        path.write_text(out, encoding="utf-8")
        extra = []
        if removed:
            extra.append(f"removed {len(removed)} keys")
        if lang in SUBTITLE_BY_LANG:
            extra.append("SUBTITLE/ROADMAP ok")
        print(f"{path.name}: " + ", ".join(extra) if extra else f"{path.name}: updated")


if __name__ == "__main__":
    main()
