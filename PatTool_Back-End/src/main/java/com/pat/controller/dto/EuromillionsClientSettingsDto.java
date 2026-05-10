package com.pat.controller.dto;

/**
 * Réglages EuroMillions exposés au client (lecture seule), p.ex. borne basse des tirages dans le JSON assistant.
 */
public record EuromillionsClientSettingsDto(String minDrawDateIso) {}
