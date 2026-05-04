import pathlib
import re

p = pathlib.Path(__file__).resolve().parent / "src/main/resources/application.properties"
lines = p.read_text(encoding="utf-8").splitlines()


def is_commented_property(line: str) -> bool:
    s = line.strip()
    if not s.startswith("#"):
        return False
    rest = s[1:].lstrip()
    return bool(re.match(r"^[A-Za-z0-9_\.\$\{\}\[\]\-]+\s*=", rest))


for i, l in enumerate(lines, 1):
    if l.strip().startswith("#") and not is_commented_property(l):
        print(i, l)
