from pathlib import Path
import re

I18N = Path(r"c:\Dev\PATTOOL2\PatTool_Front-End\src\assets\i18n")
replacements = {
    "en": ("Title, description, identifier…", "Title, description, identifier, artist…"),
    "fr": ("Titre, description, identifiant…", "Titre, description, identifiant, artiste…"),
    "de": ("Titel, Beschreibung, Kennung…", "Titel, Beschreibung, Kennung, Künstler…"),
    "es": ("Título, descripción, identificador…", "Título, descripción, identificador, artista…"),
    "it": ("Titolo, descrizione, identificatore…", "Titolo, descrizione, identificatore, artista…"),
    "ru": ("Название, описание, идентификатор…", "Название, описание, идентификатор, исполнитель…"),
    "jp": ("タイトル、説明、識別子…", "タイトル、説明、識別子、アーティスト…"),
    "cn": ("标题、描述、标识符…", "标题、描述、标识符、艺术家…"),
    "ar": ("العنوان، الوصف، المعرّف…", "العنوان، الوصف، المعرّف، الفنان…"),
    "el": ("Τίτλος, περιγραφή, αναγνωριστικό…", "Τίτλος, περιγραφή, αναγνωριστικό, καλλιτέχνης…"),
    "he": ("כותרת, תיאור, מזהה…", "כותרת, תיאור, מזהה, אמן…"),
    "in": ("शीर्षक, विवरण, पहचानकर्ता…", "शीर्षक, विवरण, पहचानकर्ता, कलाकार…"),
}


def find_archive_span(text: str):
    m = re.search(r'\n  "ARCHIVE": \{', text)
    start = m.start() + len('\n  "ARCHIVE": ')
    i = start
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
    raise RuntimeError("unclosed")


for lang, (old, new) in replacements.items():
    path = I18N / f"{lang}.json"
    text = path.read_text(encoding="utf-8")
    start, end = find_archive_span(text)
    block = text[start:end]
    key = '"SEARCH_PLACEHOLDER": '
    needle = f'{key}"{old}"'
    repl = f'{key}"{new}"'
    if needle not in block:
        print(f"MISS {lang}")
        m = re.search(r'"SEARCH_PLACEHOLDER": "([^"]*)"', block)
        print("  current=", m.group(1) if m else None)
        continue
    new_block = block.replace(needle, repl, 1)
    path.write_text(text[:start] + new_block + text[end:], encoding="utf-8")
    print(f"OK {lang}")
