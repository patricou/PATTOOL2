package com.pat.controller.dto;

/**
 * Réglages EuroMillions exposés au client, p.ex. borne basse des tirages dans le JSON assistant.
 *
 * @param minDrawDateFromMongoDatabase {@code true} si la valeur affichée vient de {@code appParameters}
 * (clé {@code euromillions.ai.min-draw-date}), {@code false} si équivaut au fallback {@code application.properties}.
 */
public record EuromillionsClientSettingsDto(String minDrawDateIso, boolean minDrawDateFromMongoDatabase) {}
