#!/usr/bin/env python3
"""Build airports-icao.json from OpenFlights airports.dat (ICAO -> name, city, IATA)."""
import json
import sys
from pathlib import Path


def parse_openflights_line(line: str) -> list[str]:
    parts: list[str] = []
    cur = ""
    in_q = False
    for ch in line.rstrip("\n"):
        if ch == '"':
            in_q = not in_q
        elif ch == "," and not in_q:
            parts.append(cur)
            cur = ""
        else:
            cur += ch
    parts.append(cur)
    return parts


def main() -> int:
    repo = Path(__file__).resolve().parents[1]
    src = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("/tmp/airports.dat")
    backend_out = Path(sys.argv[2]) if len(sys.argv) > 2 else repo / "PatTool_Back-End/src/main/resources/airports-icao.json"
    frontend_out = Path(sys.argv[3]) if len(sys.argv) > 3 else repo / "PatTool_Front-End/src/assets/airports-icao.json"
    mapping: dict[str, dict[str, str]] = {}
    with src.open(encoding="utf-8", errors="replace") as f:
        for line in f:
            parts = parse_openflights_line(line)
            if len(parts) < 7:
                continue
            name = parts[1].strip()
            city = parts[2].strip()
            iata = parts[4].strip()
            icao = parts[5].strip()
            if not icao or icao == "\\N" or len(icao) != 4:
                continue
            entry: dict[str, str] = {}
            if name and name != "\\N":
                entry["n"] = name
            if city and city != "\\N":
                entry["c"] = city
            if iata and iata != "\\N" and len(iata) == 3:
                entry["i"] = iata
            if entry:
                mapping[icao.upper()] = entry
    payload = json.dumps(mapping, ensure_ascii=False, separators=(",", ":"))
    for out in (backend_out, frontend_out):
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(payload, encoding="utf-8")
        print(f"{len(mapping)} entries -> {out}")
    # Remove legacy city-only file if present
    legacy = backend_out.parent / "airports-icao-cities.json"
    if legacy.exists():
        legacy.unlink()
        print(f"removed legacy {legacy}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
