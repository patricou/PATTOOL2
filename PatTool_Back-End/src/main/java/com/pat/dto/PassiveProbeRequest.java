package com.pat.dto;

/**
 * Corps JSON pour {@code POST /api/security-scan/passive-probe}.
 *
 * @param targetUrl URL HTTP(S) à analyser (schéma et hôte validés côté serveur).
 * @param authorizationConfirmed doit être {@code true} : confirmation explicite que l’utilisateur est mandaté pour tester cette cible.
 * @param includeActiveChecks si {@code true}, le serveur envoie en plus OPTIONS, TRACE et GET {@code /robots.txt} sur la même origine ;
 *     si absent ou {@code null}, équivalent à {@code false} (contrôles passifs uniquement).
 */
public record PassiveProbeRequest(String targetUrl, boolean authorizationConfirmed, Boolean includeActiveChecks) {}
