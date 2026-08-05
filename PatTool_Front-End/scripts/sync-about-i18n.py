#!/usr/bin/env python3
"""Update MAP + ABOUT i18n blocks for the rebuilt About page."""
from __future__ import annotations

import json
from pathlib import Path

I18N = Path(__file__).resolve().parents[1] / "src" / "assets" / "i18n"

MAP = {
    "en": {
        "TITLE": "About",
        "FRONTEND": "Front End",
        "BACKEND": "Back End",
        "DATA": "Data",
        "SECURITY": "Security",
        "STREAMING": "Streaming",
        "REF": "Imagined, designed and implemented by",
    },
    "fr": {
        "TITLE": "À propos",
        "FRONTEND": "Front End",
        "BACKEND": "Back End",
        "DATA": "Données",
        "SECURITY": "Sécurité",
        "STREAMING": "Streaming",
        "REF": "Imaginé, conçu et implémenté par",
    },
}

# Full ABOUT block (English). Other languages merge overrides on top of English.
ABOUT_EN = {
    "TITLE": "About PatTool",
    "SUBTITLE": "Full-stack platform for sportive events, friends, tools, IoT and the world — designed and built end to end.",
    "TAB_OVERVIEW": "Overview",
    "TAB_STACK": "Tech stack",
    "TAB_RESOURCES": "Resources",
    "ENV_DEV": "Development",
    "ENV_PROD": "Production",
    "VERSION_LABEL": "Version",
    "COPY_VERSION": "Copy version",
    "COPY": "Copy",
    "COPY_OK": "Copied to clipboard",
    "COPY_FAIL": "Could not copy",
    "DESIGNED_BY": "Designed and developed by",
    "ALL_RIGHTS_RESERVED": "All rights reserved",
    "VERSION": "Version 2.0.1",
    "INTRO": "PatTool is a private social network for organizing sportive activities, with discussions, photo wall, calendar, AI assistant, geo tools, media watchers and home automation.",
    "BUSINESS_CARD": "Business card",
    "AUTHOR_SITE": "Author website",
    "FEATURES_TITLE": "Main features",
    "FEATURES_DESC": "Jump to a module. Everything below is available from the application menus.",
    "FEAT_EVENTS": "Create and manage sportive activities",
    "FEAT_PHOTOS": "Photo wall timeline from activities",
    "FEAT_WHATSPAT": "Real-time discussions (WhatsPat)",
    "FEAT_CALENDAR": "Personal calendar and reminders",
    "FEAT_TODO": "Shared to-do lists",
    "FEAT_FRIENDS": "Friends, groups and positions",
    "FEAT_LINKS": "Personal URL library",
    "FEAT_IOT": "Home automation and cameras",
    "FEAT_GEO": "Weather, GPS and local maps",
    "FEAT_GLOBE": "3D Earth, ISS and flights",
    "FEAT_MEDIA": "Archive, TV, radio and webcams",
    "FEAT_SYSTEM": "Caches, reports and admin tools",
    "PROFESSIONAL_PLATFORM": "Professional Development Platform",
    "FULL_STACK_APP": "Full Stack Application",
    "ANGULAR_DESC": "Modern frontend framework (Angular 21) with TypeScript 5.9",
    "UI_TECHNOLOGIES": "UI Technologies",
    "DEVELOPMENT_TOOLS": "Development Tools",
    "FRONT_END": "Front End",
    "BACK_END": "Back End",
    "JAVA_DESC": "Modern enterprise-grade backend development",
    "SPRING_BOOT_DESC": "Spring Boot with Security, WebSocket, MongoDB and OpenAPI",
    "API_ARCHITECTURE": "API Architecture",
    "API_DESC": "RESTful API with OpenAPI / Swagger documentation",
    "SWAGGER_DOCS": "Swagger Documentation",
    "DATA_PERSISTENCE": "Data Persistence",
    "MONGODB": "MongoDB",
    "MONGODB_DESC": "Cloud NoSQL document database with authentication",
    "MONGODB_ATLAS": "MongoDB Atlas",
    "DISCUSSION_REALTIME": "Real-time discussion",
    "DISCUSSION_DESC": "Real-time discussion via WebSocket (STOMP/SockJS) with backend persistence (Spring Boot).",
    "KEYCLOAK_AUTH": "Keycloak Authentication",
    "KEYCLOAK_DESC": "Enterprise identity and access management",
    "DEV_ADMIN": "DEV Admin",
    "PROD_ADMIN": "PROD Admin",
    "SECURITY_FRAMEWORK": "Security Framework",
    "SPRING_SECURITY_DESC": "Spring Security with JWT / OAuth2 resource server",
    "SSL_CERTIFICATE": "SSL Certificate",
    "SSL_DESC": "Secure communication with TLS certificates in production",
    "GITHUB_DESC": "Source code on GitHub",
    "RESOURCES_DESC": "Documentation, administration consoles and repositories used by this deployment.",
    "STREAMING_ARCHITECTURE": "Streaming Architecture",
    "STREAMING_ARCHITECTURE_DESC": "Hybrid streaming system with client-side caching",
    "STREAMING_OVERVIEW": "The system uses a hybrid approach: backend streams ALL events once via Server-Sent Events (SSE), frontend caches ALL events in memory, and displays only 8 at a time with client-side pagination.",
    "STREAMING_BACKEND": "Server Streaming",
    "STREAMING_BACKEND_DESC": "Backend streams all matching events from MongoDB via SSE, one by one, in real-time.",
    "STREAMING_FRONTEND": "Frontend Caching",
    "STREAMING_FRONTEND_DESC": "Frontend caches all events in memory. Scrolling uses cached data — no backend calls.",
    "STREAMING_BENEFITS": "Benefits",
    "STREAMING_BENEFITS_DESC": "Fast scrolling with no network latency, instant display of next pages, offline-ready, instant search/filter on cached data.",
    "STREAMING_APPROACH": "Approach",
    "STREAMING_APPROACH_DESC": "Stream once, cache all, client-side pagination",
}

ABOUT_FR = {
    "TITLE": "À propos de PatTool",
    "SUBTITLE": "Plateforme full-stack pour activités sportives, amis, outils, IoT et le monde — conçue et réalisée de bout en bout.",
    "TAB_OVERVIEW": "Vue d’ensemble",
    "TAB_STACK": "Stack technique",
    "TAB_RESOURCES": "Ressources",
    "ENV_DEV": "Développement",
    "ENV_PROD": "Production",
    "VERSION_LABEL": "Version",
    "COPY_VERSION": "Copier la version",
    "COPY": "Copier",
    "COPY_OK": "Copié dans le presse-papiers",
    "COPY_FAIL": "Impossible de copier",
    "DESIGNED_BY": "Conçu et développé par",
    "ALL_RIGHTS_RESERVED": "Tous droits réservés",
    "VERSION": "Version 2.0.1",
    "INTRO": "PatTool est un réseau social privé pour organiser des activités sportives, avec discussions, mur de photos, calendrier, assistant IA, outils géo, médias et domotique.",
    "BUSINESS_CARD": "Carte de visite",
    "AUTHOR_SITE": "Site de l’auteur",
    "FEATURES_TITLE": "Fonctionnalités principales",
    "FEATURES_DESC": "Accédez à un module. Tout ce qui suit est disponible dans les menus de l’application.",
    "FEAT_EVENTS": "Créer et gérer des activités sportives",
    "FEAT_PHOTOS": "Mur de photos des activités",
    "FEAT_WHATSPAT": "Discussions temps réel (WhatsPat)",
    "FEAT_CALENDAR": "Calendrier personnel et rappels",
    "FEAT_TODO": "Listes de tâches partagées",
    "FEAT_FRIENDS": "Amis, groupes et positions",
    "FEAT_LINKS": "Bibliothèque d’URL personnelle",
    "FEAT_IOT": "Domotique et caméras",
    "FEAT_GEO": "Météo, GPS et cartes locales",
    "FEAT_GLOBE": "Terre 3D, ISS et vols",
    "FEAT_MEDIA": "Archive, TV, radio et webcams",
    "FEAT_SYSTEM": "Caches, rapports et outils admin",
    "PROFESSIONAL_PLATFORM": "Plateforme de développement professionnel",
    "FULL_STACK_APP": "Application full stack",
    "ANGULAR_DESC": "Framework frontend moderne (Angular 21) avec TypeScript 5.9",
    "UI_TECHNOLOGIES": "Technologies UI",
    "DEVELOPMENT_TOOLS": "Outils de développement",
    "FRONT_END": "Front End",
    "BACK_END": "Back End",
    "JAVA_DESC": "Développement backend moderne de niveau entreprise",
    "SPRING_BOOT_DESC": "Spring Boot avec Security, WebSocket, MongoDB et OpenAPI",
    "API_ARCHITECTURE": "Architecture API",
    "API_DESC": "API RESTful avec documentation OpenAPI / Swagger",
    "SWAGGER_DOCS": "Documentation Swagger",
    "DATA_PERSISTENCE": "Persistance des données",
    "MONGODB": "MongoDB",
    "MONGODB_DESC": "Base de données document NoSQL cloud avec authentification",
    "MONGODB_ATLAS": "MongoDB Atlas",
    "DISCUSSION_REALTIME": "Discussion temps réel",
    "DISCUSSION_DESC": "Discussion temps réel via WebSocket (STOMP/SockJS) avec persistance côté backend (Spring Boot).",
    "KEYCLOAK_AUTH": "Authentification Keycloak",
    "KEYCLOAK_DESC": "Gestion d’identité et d’accès d’entreprise",
    "DEV_ADMIN": "Admin DEV",
    "PROD_ADMIN": "Admin PROD",
    "SECURITY_FRAMEWORK": "Framework de sécurité",
    "SPRING_SECURITY_DESC": "Spring Security avec serveur de ressources JWT / OAuth2",
    "SSL_CERTIFICATE": "Certificat SSL",
    "SSL_DESC": "Communication sécurisée avec certificats TLS en production",
    "GITHUB_DESC": "Code source sur GitHub",
    "RESOURCES_DESC": "Documentation, consoles d’administration et dépôts utilisés par ce déploiement.",
    "STREAMING_ARCHITECTURE": "Architecture de streaming",
    "STREAMING_ARCHITECTURE_DESC": "Système de streaming hybride avec cache côté client",
    "STREAMING_OVERVIEW": "Approche hybride : le backend envoie TOUS les événements une fois via SSE, le frontend les met en cache, et n’affiche que 8 à la fois avec pagination côté client.",
    "STREAMING_BACKEND": "Streaming serveur",
    "STREAMING_BACKEND_DESC": "Le backend transmet les événements depuis MongoDB via SSE, un par un, en temps réel.",
    "STREAMING_FRONTEND": "Cache frontend",
    "STREAMING_FRONTEND_DESC": "Le frontend met tous les événements en mémoire. Le défilement utilise le cache — aucun appel backend.",
    "STREAMING_BENEFITS": "Avantages",
    "STREAMING_BENEFITS_DESC": "Défilement rapide sans latence réseau, pages suivantes instantanées, prêt hors-ligne, recherche/filtre sur le cache.",
    "STREAMING_APPROACH": "Approche",
    "STREAMING_APPROACH_DESC": "Stream une fois, cache tout, pagination côté client",
}

# Light overrides for other locales (fallback to English for missing keys)
ABOUT_OVERRIDES: dict[str, dict[str, str]] = {
    "de": {
        "TITLE": "Über PatTool",
        "TAB_OVERVIEW": "Übersicht",
        "TAB_STACK": "Tech-Stack",
        "TAB_RESOURCES": "Ressourcen",
        "ENV_DEV": "Entwicklung",
        "ENV_PROD": "Produktion",
        "COPY": "Kopieren",
        "COPY_OK": "In die Zwischenablage kopiert",
        "COPY_FAIL": "Kopieren fehlgeschlagen",
        "ALL_RIGHTS_RESERVED": "Alle Rechte vorbehalten",
        "BUSINESS_CARD": "Visitenkarte",
        "FEATURES_TITLE": "Hauptfunktionen",
    },
    "es": {
        "TITLE": "Acerca de PatTool",
        "TAB_OVERVIEW": "Resumen",
        "TAB_STACK": "Stack técnico",
        "TAB_RESOURCES": "Recursos",
        "ENV_DEV": "Desarrollo",
        "ENV_PROD": "Producción",
        "COPY": "Copiar",
        "COPY_OK": "Copiado al portapapeles",
        "COPY_FAIL": "No se pudo copiar",
        "ALL_RIGHTS_RESERVED": "Todos los derechos reservados",
        "BUSINESS_CARD": "Tarjeta de visita",
        "FEATURES_TITLE": "Funciones principales",
    },
    "it": {
        "TITLE": "Informazioni su PatTool",
        "TAB_OVERVIEW": "Panoramica",
        "TAB_STACK": "Stack tecnico",
        "TAB_RESOURCES": "Risorse",
        "ENV_DEV": "Sviluppo",
        "ENV_PROD": "Produzione",
        "COPY": "Copia",
        "COPY_OK": "Copiato negli appunti",
        "COPY_FAIL": "Impossibile copiare",
        "ALL_RIGHTS_RESERVED": "Tutti i diritti riservati",
        "BUSINESS_CARD": "Biglietto da visita",
        "FEATURES_TITLE": "Funzionalità principali",
    },
    "ru": {
        "TITLE": "О PatTool",
        "TAB_OVERVIEW": "Обзор",
        "TAB_STACK": "Стек",
        "TAB_RESOURCES": "Ресурсы",
        "ENV_DEV": "Разработка",
        "ENV_PROD": "Продакшен",
        "COPY": "Копировать",
        "COPY_OK": "Скопировано в буфер",
        "COPY_FAIL": "Не удалось скопировать",
        "ALL_RIGHTS_RESERVED": "Все права защищены",
        "BUSINESS_CARD": "Визитка",
        "FEATURES_TITLE": "Основные функции",
    },
    "cn": {
        "TITLE": "关于 PatTool",
        "TAB_OVERVIEW": "概览",
        "TAB_STACK": "技术栈",
        "TAB_RESOURCES": "资源",
        "ENV_DEV": "开发",
        "ENV_PROD": "生产",
        "COPY": "复制",
        "COPY_OK": "已复制到剪贴板",
        "COPY_FAIL": "无法复制",
        "ALL_RIGHTS_RESERVED": "保留所有权利",
        "BUSINESS_CARD": "名片",
        "FEATURES_TITLE": "主要功能",
    },
    "jp": {
        "TITLE": "PatTool について",
        "TAB_OVERVIEW": "概要",
        "TAB_STACK": "技術スタック",
        "TAB_RESOURCES": "リソース",
        "ENV_DEV": "開発",
        "ENV_PROD": "本番",
        "COPY": "コピー",
        "COPY_OK": "クリップボードにコピーしました",
        "COPY_FAIL": "コピーできませんでした",
        "ALL_RIGHTS_RESERVED": "全著作権所有",
        "BUSINESS_CARD": "名刺",
        "FEATURES_TITLE": "主な機能",
    },
    "ar": {
        "TITLE": "حول PatTool",
        "TAB_OVERVIEW": "نظرة عامة",
        "TAB_STACK": "التقنيات",
        "TAB_RESOURCES": "الموارد",
        "ENV_DEV": "تطوير",
        "ENV_PROD": "إنتاج",
        "COPY": "نسخ",
        "COPY_OK": "تم النسخ",
        "COPY_FAIL": "تعذر النسخ",
        "ALL_RIGHTS_RESERVED": "جميع الحقوق محفوظة",
        "BUSINESS_CARD": "بطاقة العمل",
        "FEATURES_TITLE": "الميزات الرئيسية",
    },
    "he": {
        "TITLE": "אודות PatTool",
        "TAB_OVERVIEW": "סקירה",
        "TAB_STACK": "מחסנית טכנולוגית",
        "TAB_RESOURCES": "משאבים",
        "ENV_DEV": "פיתוח",
        "ENV_PROD": "ייצור",
        "COPY": "העתק",
        "COPY_OK": "הועתק ללוח",
        "COPY_FAIL": "לא ניתן להעתיק",
        "ALL_RIGHTS_RESERVED": "כל הזכויות שמורות",
        "BUSINESS_CARD": "כרטיס ביקור",
        "FEATURES_TITLE": "תכונות עיקריות",
    },
    "el": {
        "TITLE": "Σχετικά με το PatTool",
        "TAB_OVERVIEW": "Επισκόπηση",
        "TAB_STACK": "Τεχνολογίες",
        "TAB_RESOURCES": "Πόροι",
        "ENV_DEV": "Ανάπτυξη",
        "ENV_PROD": "Παραγωγή",
        "COPY": "Αντιγραφή",
        "COPY_OK": "Αντιγράφηκε",
        "COPY_FAIL": "Αποτυχία αντιγραφής",
        "ALL_RIGHTS_RESERVED": "Με επιφύλαξη παντός δικαιώματος",
        "BUSINESS_CARD": "Επαγγελματική κάρτα",
        "FEATURES_TITLE": "Κύριες λειτουργίες",
    },
    "in": {
        "TITLE": "PatTool के बारे में",
        "TAB_OVERVIEW": "अवलोकन",
        "TAB_STACK": "टेक स्टैक",
        "TAB_RESOURCES": "संसाधन",
        "ENV_DEV": "विकास",
        "ENV_PROD": "प्रोडक्शन",
        "COPY": "कॉपी",
        "COPY_OK": "क्लिपबोर्ड पर कॉपी किया गया",
        "COPY_FAIL": "कॉपी नहीं हो सका",
        "ALL_RIGHTS_RESERVED": "सर्वाधिकार सुरक्षित",
        "BUSINESS_CARD": "बिज़नेस कार्ड",
        "FEATURES_TITLE": "मुख्य सुविधाएँ",
    },
}


def load(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8-sig"))


def dump(path: Path, data: dict) -> None:
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def about_for(lang: str) -> dict[str, str]:
    if lang == "en":
        return dict(ABOUT_EN)
    if lang == "fr":
        return dict(ABOUT_FR)
    merged = dict(ABOUT_EN)
    merged.update(ABOUT_OVERRIDES.get(lang, {}))
    return merged


def map_for(lang: str) -> dict[str, str]:
    if lang in MAP:
        return dict(MAP[lang])
    return dict(MAP["en"])


def main() -> None:
    for path in sorted(I18N.glob("*.json")):
        lang = path.stem
        data = load(path)
        data["MAP"] = map_for(lang)
        data["ABOUT"] = about_for(lang)
        dump(path, data)
        print(f"updated {path.name}: MAP={len(data['MAP'])} ABOUT={len(data['ABOUT'])}")


if __name__ == "__main__":
    main()
