#!/usr/bin/env python3
"""Generate complete METEO_FRANCE locale packs via Google Translate (gtx endpoint)."""
from __future__ import annotations

import json
import time
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent / "meteo-france-locales"
EN_PATH = ROOT / "en.json"
FR_PATH = ROOT / "fr.json"

# Google Translate language codes
LANG_CONFIG = {
    "de": ("fr", "de"),
    "es": ("fr", "es"),
    "it": ("fr", "it"),
    "ru": ("en", "ru"),
    "ar": ("en", "ar"),
    "he": ("en", "he"),
    "cn": ("en", "zh-CN"),
    "jp": ("en", "ja"),
    "el": ("en", "el"),
    "in": ("en", "hi"),
}

# Keys that should stay as-is (brands, placeholders, technical tokens)
KEEP_AS_SOURCE = {
    "POINT_SOURCE_AT",
    "RADAR_SOURCE_RAINVIEWER",
    "CLOUD_SOURCE_OWM",
    "TEMPERATURE_SOURCE_OPENMETEO",
    "TEMPERATURE_SOURCE_OWM",
    "TEMPERATURE_COMPARE_ABROAD",
    "LOG_STATUS_OK",
    "LOG_CAT_AROMEPI",
    "LOG_SOURCE_RAINVIEWER",
    "LOG_SOURCE_OWM",
    "LOG_SOURCE_MF_DPOBS_OPEN_METEO",
    "LOG_SOURCE_OPEN_METEO",
    "TEMPERATURE_TRIGGER_ZOOM",
    "FORECAST_3H",
    "WIND",
    "CLIM_NEAREST",
    "AROMEPI_PAUSE",
    "AROMEPI_CAT_WIND",
}


def translate(text: str, target: str, source: str = "en") -> str:
    if not text.strip():
        return text
    url = (
        "https://translate.googleapis.com/translate_a/single"
        f"?client=gtx&sl={source}&tl={target}&dt=t&q={urllib.parse.quote(text)}"
    )
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    return "".join(part[0] for part in data[0] if part[0])


def load_json(path: Path) -> dict[str, str]:
    return json.loads(path.read_text(encoding="utf-8-sig"))


def save_json(path: Path, data: dict[str, str]) -> None:
    path.write_text(json.dumps(data, ensure_ascii=False, indent=4) + "\n", encoding="utf-8")


def generate_pack(source: dict[str, str], source_lang: str, target_lang: str) -> dict[str, str]:
    cache: dict[str, str] = {}
    out: dict[str, str] = {}
    for key, value in source.items():
        if key in KEEP_AS_SOURCE or value in ("{{time}}", "OK", "3 h", "zoom"):
            out[key] = value
            continue
        if value not in cache:
            try:
                cache[value] = translate(value, target_lang, source_lang)
            except Exception as exc:
                print(f"WARN {target_lang} failed for {key!r}: {exc}")
                cache[value] = value
            time.sleep(0.15)
        out[key] = cache[value]
    return out


def main() -> None:
    en = load_json(EN_PATH)
    fr = load_json(FR_PATH)
    assert len(en) == 225 and len(fr) == 225

    for code, (src_lang, tgt_lang) in LANG_CONFIG.items():
        source = fr if src_lang == "fr" else en
        print(f"Generating {code}.json from {src_lang} -> {tgt_lang} ...")
        pack = generate_pack(source, src_lang, tgt_lang)
        save_json(ROOT / f"{code}.json", pack)
        print(f"  wrote {code}.json ({len(pack)} keys)")


if __name__ == "__main__":
    main()
