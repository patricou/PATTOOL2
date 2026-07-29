# -*- coding: utf-8 -*-
import json
from pathlib import Path

root = Path(r"c:\Dev\PATTOOL2\PatTool_Front-End\src\assets\i18n")
langs = sorted(p.stem for p in root.glob("*.json"))


def load(lang):
    return json.loads((root / f"{lang}.json").read_text(encoding="utf-8-sig"))


ref = load("en")
ref_share = ref["TODOLISTS"]["SHARE"]
ref_rem = ref["TODOLISTS"]["REMINDER"]
fr = load("fr")
fr_share = fr["TODOLISTS"]["SHARE"]
fr_rem = fr["TODOLISTS"]["REMINDER"]

print("=== KEY COVERAGE vs EN ===")
for lang in langs:
    data = load(lang)
    share = data["TODOLISTS"].get("SHARE", {})
    rem = data["TODOLISTS"].get("REMINDER", {})
    miss_s = sorted(set(ref_share) - set(share))
    miss_r = sorted(set(ref_rem) - set(rem))
    extra_s = sorted(set(share) - set(ref_share))
    extra_r = sorted(set(rem) - set(ref_rem))
    print(
        f"{lang}: share miss={miss_s or '-'} extra={extra_s or '-'} "
        f"| rem miss={miss_r or '-'} extra={extra_r or '-'}"
    )

# Identical to English (untranslated), excluding intentional brand terms
skip_equal = {"WhatsApp", "E-mail", "Email"}

print()
print("=== STILL IDENTICAL TO ENGLISH (likely untranslated) ===")
for lang in langs:
    if lang == "en":
        continue
    data = load(lang)
    share = data["TODOLISTS"]["SHARE"]
    rem = data["TODOLISTS"]["REMINDER"]
    same = []
    for section, src, ref_sec in (
        ("SHARE", share, ref_share),
        ("REMINDER", rem, ref_rem),
    ):
        for k, v in ref_sec.items():
            if not isinstance(v, str) or not v.strip():
                continue
            if v in skip_equal:
                continue
            if k in src and src[k] == v:
                same.append((f"{section}.{k}", v))
    if same:
        print(f"\n{lang}: {len(same)} key(s)")
        for key, val in same:
            print(f"  {key}: {val}")
    else:
        print(f"\n{lang}: OK (no English leftovers in SHARE/REMINDER)")

# Also report FR completeness vs EN keys
print()
print("=== FR vs EN key parity ===")
print("SHARE miss in FR:", sorted(set(ref_share) - set(fr_share)) or "-")
print("REMINDER miss in FR:", sorted(set(ref_rem) - set(fr_rem)) or "-")
