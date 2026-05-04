#!/usr/bin/env python3
"""One-off: English comments only in application.properties (gitignored target)."""

import re
from pathlib import Path

PATH = Path(__file__).resolve().parent / "src/main/resources/application.properties"


def is_commented_property(line: str) -> bool:
    s = line.strip()
    if not s.startswith("#"):
        return False
    rest = s[1:].lstrip()
    return bool(re.match(r"^[A-Za-z0-9_\.\$\{\}\[\]\-]+\s*=", rest))


# Full-line replacements keyed by stripped comment body (normalize Unicode apostrophes)
REPLACEMENTS: dict[str, str] = {}

# Populate from explicit English strings we want after '# '
def add(old: str, new: str):
    REPLACEMENTS[old.strip()] = new.strip()


add("# mongodb", "# MongoDB")
add(
    "# Configuration pour MongoDB sans authentification",
    "# MongoDB configuration (authenticated connection below)",
)
add(
    "# Updated to use MongoDB 8.2 on port 27018",
    "# Updated for MongoDB 8.2 on port 27018",
)
add(
    "# MongoDB 8.2 optimized connection settings",
    "# MongoDB 8.2 optimised connection tuning",
)
add(
    "# Note: Connection pool and performance settings are configured via MongoConfig.java",
    "# Note: connection pool / performance tuning is done in MongoConfig.java",
)
add(
    "# These properties are used by Spring Boot's auto-configuration",
    "# Used by Spring Boot auto-configuration",
)
add(
    "# Additional MongoDB 8.2 optimizations are applied programmatically",
    "# Extra MongoDB 8.2 optimisations are applied in code",
)
add("# MongoDB Atlas Connection (Production)", "# MongoDB Atlas (production)")
add(
    "# Pour utiliser MongoDB Atlas, commentez les lignes ci-dessus (host, port, database)",
    "# To use MongoDB Atlas, comment out the lines above (host, port, database)",
)
add(
    "# et décommentez la ligne suivante. IMPORTANT: Remplacez xxxxx par votre mot de passe!",
    "# and uncomment the line below. IMPORTANT: replace xxxxx with your password!",
)

add("# server", "# Server")

add(
    "# Configure Spring Data REST base path",
    "# Spring Data REST base path",
)

add("#app", "# App")

add(
    "# Default discussion ID (Discussion Generale)",
    "# Default discussion ID (general discussion)",
)
add(
    "# Base URL API Nager.Date (jours fériés) — appelée uniquement par le backend",
    "# Public holiday API base (Nager.Date) — backend only",
)
add(
    "# loging level for server messages",
    "# Log level for application / server logs",
)

add(
    "# for prod, sll is activated",
    "# In production SSL can be enabled here",
)

add("# ssl", "# SSL / TLS")

add(
    "# Files load param - Updated for Spring Boot 2.x/3.x",
    "# Multipart / upload sizing (Spring Boot 2.x / 3.x)",
)
add(
    "# Tomcat default max post body is 2MB; without this, large uploads get ERR_CONNECTION_RESET before Spring sees the request",
    "# Tomcat default max POST body is 2 MB; raising this avoids ERR_CONNECTION_RESET before Spring sees the request",
)

add("#keycloak Config", "# Keycloak")
add("# for prod the url and secret are different", "# Production uses different auth-server-url and secret")
add("# role and url securisation", "# Role and URL security constraints")

add(
    "# Intervalle minimum entre 2 mails de connexion pour le meme user (en minutes)",
    "# Minimum interval between duplicate connection-notification emails per user (minutes)",
)
add(
    "# Send email to app.mailsentto when a user connects (set false to disable)",
    "# Notify app.mailsentto when a user signs in (set false to disable)",
)

# Normalize garbled remnants if present
BAD_OPENAI_HDR = "# OpenAI — utilisé par l'assistant latéral, ChatService (PatGPT) et billing/crédits".replace(
    "'", "\u2019"
)
BAD_NE_LINE = "# Ne commitez pas de clé : définissez-la ici en local ou via SPRING_APPLICATION_JSON / variables dédiées."


add(
    BAD_OPENAI_HDR,
    "# OpenAI key: side panel assistant, PatGPT ChatService and billing credits",
)
add(
    BAD_NE_LINE,
    "# Do not commit secrets — set locally or via SPRING_APPLICATION_JSON / env vars.",
)
add(
    "# Ne commitez pas de clé : définissez-la ici en local ou via SPRING_APPLICATION_JSON / variables dédiées.",
    "# Do not commit secrets — set locally or via SPRING_APPLICATION_JSON / env vars.",
)
add(
    "# OpenAI — utilisé par l'assistant latéral, ChatService (PatGPT) et billing/crédits".replace("\u2019", "'"),
    "# OpenAI key: side panel assistant, PatGPT ChatService and billing credits",
)
add(
    "# OpenAI — utilisée par l'assistant latéral, ChatService (PatGPT) et billing/crédits".replace("\u2019", "'"),
    "# OpenAI key: side panel assistant, PatGPT ChatService and billing credits",
)
add(
    "# Délais HTTP client → OpenAI (secondes). Pas de valeur par défaut dans le code : obligatoire ici.",
    "# HTTP client timeouts toward OpenAI (seconds). Required here — no Java defaults.",
)


def normalize_key(s: str) -> str:
    s = s.strip()
    s = re.sub(r"[\u2019\u2018]", "'", s)
    return s.strip()


def main():
    raw = PATH.read_text(encoding="utf-8")
    lines = raw.splitlines(keepends=True)
    out: list[str] = []
    for line in lines:
        stripped = line.rstrip("\r\n")
        eol = line[len(stripped) :]

        if not stripped.strip().startswith("#"):
            out.append(line)
            continue
        if is_commented_property(line):
            out.append(line)
            continue

        key_norm = normalize_key(stripped)

        replaced = False
        for old, new in REPLACEMENTS.items():
            if normalize_key(old) == key_norm:
                out.append(new + eol)
                replaced = True
                break

        if not replaced:
            # Lines already English or unmatched — strip mojibake fixes for fuzzy match
            if "OpenAI" in stripped and ("utilis" in stripped or "PatGPT" in stripped):
                out.append("# OpenAI key: side panel assistant, PatGPT ChatService and billing credits" + eol)
                replaced = True
            elif "HTTP client" in stripped and "OpenAI" in stripped:
                out.append("# HTTP client timeouts toward OpenAI (seconds). Required — no defaults in Java." + eol)
                replaced = True
            elif "commitez" in stripped.lower() or "SPRING_APPLICATION_JSON" in stripped:
                out.append("# Do not commit secrets — set locally or via SPRING_APPLICATION_JSON / env vars." + eol)
                replaced = True

        if not replaced:
            out.append(line)

    PATH.write_text("".join(out), encoding="utf-8")


if __name__ == "__main__":
    main()
