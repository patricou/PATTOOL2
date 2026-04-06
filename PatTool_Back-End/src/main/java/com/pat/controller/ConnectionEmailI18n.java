package com.pat.controller;

import java.util.Locale;
import java.util.regex.Pattern;

/**
 * Localized strings and locale metadata for the PatTool user connection notification email.
 */
public final class ConnectionEmailI18n {

    /** Shown instead of ISP reverse-DNS hostnames that trigger spam filters (e.g. Kwaoo FTTH). */
    public static final String CONNECTION_EMAIL_PUBLIC_DOMAIN = "www.patrickdeschamps.com";

    private static final Pattern KWAOO_FTTH_REVERSE_DNS = Pattern.compile(
            "\\d{1,3}-\\d{1,3}-\\d{1,3}-\\d{1,3}\\.ftth\\.cust\\.kwaoo\\.net",
            Pattern.CASE_INSENSITIVE);

    private ConnectionEmailI18n() {
    }

    /**
     * Reverse DNS like {@code 182-193-28-81.ftth.cust.kwaoo.net} is replaced in connection emails
     * by {@link #CONNECTION_EMAIL_PUBLIC_DOMAIN} with a localized note.
     */
    public static boolean shouldReplaceConnectionEmailDomain(String domainName) {
        if (domainName == null || domainName.isBlank()) {
            return false;
        }
        String d = domainName.trim();
        if ("182-193-28-81.ftth.cust.kwaoo.net".equalsIgnoreCase(d)) {
            return true;
        }
        return KWAOO_FTTH_REVERSE_DNS.matcher(d).matches();
    }

    /**
     * Parenthetical shown after the replacement domain (same language codes as {@link #normalizeLangCode}).
     */
    public static String domainReplacementNote(String langCode) {
        return switch (langCode) {
            case "fr" -> "(domaine remplacé)";
            case "de" -> "(Domain ersetzt)";
            case "es" -> "(dominio sustituido)";
            case "it" -> "(dominio sostituito)";
            case "el" -> "(ο τομέας αντικαταστάθηκε)";
            case "he" -> "(הדומיין הוחלף)";
            case "ru" -> "(домен заменён)";
            case "ar" -> "(تم استبدال النطاق)";
            case "cn" -> "(域名已替换)";
            case "jp" -> "(ドメインを置換済み)";
            case "en" -> "(domain replaced)";
            default -> "(domain replaced)";
        };
    }

    public record Texts(
            String headlineNewUser,
            String headlineExistingUser,
            String subjectPrefixNewUser,
            String subjectPrefixExistingUser,
            String sectionUser,
            String sectionConnection,
            String labelUsername,
            String labelFirstName,
            String labelLastName,
            String labelEmail,
            String labelTimestamp,
            String labelClientIp,
            String labelLocation,
            String labelDomain,
            String labelCoordinates,
            String labelAddress,
            String labelMap,
            String mapButton,
            String footerAutomated,
            String footerNewUserSuffix,
            String coordsGpsBrowser,
            String coordsApproxFromIp,
            String na
    ) {
    }

    public record Bundle(Texts texts, Locale dateLocale, String htmlLang) {
    }

    /**
     * Normalizes member locale (same codes as the Angular app: ar, cn, de, el, en, es, fr, he, it, jp, ru).
     */
    public static String normalizeLangCode(String raw) {
        if (raw == null || raw.isBlank()) {
            return "en";
        }
        String p = raw.trim().toLowerCase(Locale.ROOT).split("[-_]", 2)[0];
        return switch (p) {
            case "fr" -> "fr";
            case "en" -> "en";
            case "de" -> "de";
            case "es" -> "es";
            case "it" -> "it";
            case "el" -> "el";
            case "he" -> "he";
            case "ru" -> "ru";
            case "ar" -> "ar";
            case "jp" -> "jp";
            case "cn", "zh" -> "cn";
            default -> "en";
        };
    }

    public static Locale dateLocaleForLang(String lang) {
        return switch (lang) {
            case "fr" -> Locale.FRENCH;
            case "de" -> Locale.GERMAN;
            case "es" -> Locale.forLanguageTag("es");
            case "it" -> Locale.ITALIAN;
            case "el" -> Locale.forLanguageTag("el");
            case "he" -> Locale.forLanguageTag("he");
            case "ru" -> Locale.forLanguageTag("ru");
            case "ar" -> Locale.forLanguageTag("ar");
            case "jp" -> Locale.JAPANESE;
            case "cn" -> Locale.SIMPLIFIED_CHINESE;
            default -> Locale.ENGLISH;
        };
    }

    public static String htmlLangForLang(String lang) {
        return switch (lang) {
            case "jp" -> "ja";
            case "cn" -> "zh-CN";
            case "el" -> "el";
            case "he" -> "he";
            default -> lang;
        };
    }

    public static Bundle bundleForMemberLocale(String memberLocale) {
        String lang = normalizeLangCode(memberLocale);
        Locale dateLocale = dateLocaleForLang(lang);
        String htmlLang = htmlLangForLang(lang);
        return new Bundle(textsForLang(lang), dateLocale, htmlLang);
    }

    private static Texts textsForLang(String lang) {
        return switch (lang) {
            case "fr" -> textsFr();
            case "de" -> textsDe();
            case "es" -> textsEs();
            case "it" -> textsIt();
            default -> textsEn();
        };
    }

    private static Texts textsEn() {
        return new Texts(
                "NEW USER CONNECTION",
                "USER CONNECTION",
                "PatTool - New user connection - ",
                "PatTool - User connection - ",
                "User",
                "Connection",
                "Username",
                "First name",
                "Last name",
                "Email",
                "Timestamp",
                "Client IP",
                "Location",
                "Domain",
                "Coordinates",
                "Address",
                "Map",
                "Open in Maps",
                "This is an automated notification from the PatTool application.",
                " The user was created on first connection.",
                "GPS from browser (smartphone)",
                "Approximate location from IP",
                "N/A"
        );
    }

    private static Texts textsFr() {
        return new Texts(
                "NOUVELLE CONNEXION UTILISATEUR",
                "CONNEXION UTILISATEUR",
                "PatTool - Nouvelle connexion utilisateur - ",
                "PatTool - Connexion utilisateur - ",
                "Utilisateur",
                "Connexion",
                "Nom d'utilisateur",
                "Prénom",
                "Nom",
                "E-mail",
                "Date et heure",
                "Adresse IP client",
                "Localisation",
                "Domaine",
                "Coordonnées",
                "Adresse",
                "Carte",
                "Ouvrir dans Maps",
                "Ceci est une notification automatique de l'application PatTool.",
                " L'utilisateur a été créé lors de la première connexion.",
                "GPS du navigateur (smartphone)",
                "Localisation approximative par adresse IP",
                "N/D"
        );
    }

    private static Texts textsDe() {
        return new Texts(
                "NEUE BENUTZERVERBINDUNG",
                "BENUTZERVERBINDUNG",
                "PatTool - Neue Benutzerverbindung - ",
                "PatTool - Benutzerverbindung - ",
                "Benutzer",
                "Verbindung",
                "Benutzername",
                "Vorname",
                "Nachname",
                "E-Mail",
                "Zeitstempel",
                "Client-IP",
                "Standort",
                "Domain",
                "Koordinaten",
                "Adresse",
                "Karte",
                "In Karten öffnen",
                "Dies ist eine automatische Benachrichtigung der PatTool-Anwendung.",
                " Der Benutzer wurde bei der ersten Anmeldung erstellt.",
                "GPS aus dem Browser (Smartphone)",
                "Ungefähre Position aus der IP-Adresse",
                "k. A."
        );
    }

    private static Texts textsEs() {
        return new Texts(
                "NUEVA CONEXIÓN DE USUARIO",
                "CONEXIÓN DE USUARIO",
                "PatTool - Nueva conexión de usuario - ",
                "PatTool - Conexión de usuario - ",
                "Usuario",
                "Conexión",
                "Nombre de usuario",
                "Nombre",
                "Apellidos",
                "Correo electrónico",
                "Fecha y hora",
                "IP del cliente",
                "Ubicación",
                "Dominio",
                "Coordenadas",
                "Dirección",
                "Mapa",
                "Abrir en mapas",
                "Esta es una notificación automática de la aplicación PatTool.",
                " El usuario se creó en el primer acceso.",
                "GPS del navegador (smartphone)",
                "Ubicación aproximada por dirección IP",
                "N/D"
        );
    }

    private static Texts textsIt() {
        return new Texts(
                "NUOVA CONNESSIONE UTENTE",
                "CONNESSIONE UTENTE",
                "PatTool - Nuova connessione utente - ",
                "PatTool - Connessione utente - ",
                "Utente",
                "Connessione",
                "Nome utente",
                "Nome",
                "Cognome",
                "Email",
                "Data e ora",
                "IP client",
                "Posizione",
                "Dominio",
                "Coordinate",
                "Indirizzo",
                "Mappa",
                "Apri in Mappe",
                "Questa è una notifica automatica dall'applicazione PatTool.",
                " L'utente è stato creato al primo accesso.",
                "GPS dal browser (smartphone)",
                "Posizione approssimativa da indirizzo IP",
                "N/D"
        );
    }
}
