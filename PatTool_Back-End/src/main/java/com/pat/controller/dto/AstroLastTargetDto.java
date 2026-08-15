package com.pat.controller.dto;

import com.fasterxml.jackson.annotation.JsonInclude;

/**
 * Dernier astre choisi dans le viseur, persisté par utilisateur Keycloak dans
 * {@code appParameters} (clé {@code globe.astro.last-target.<user>}).
 *
 * <p>{@code kind} : {@code planet}, {@code star}, {@code galaxy}, {@code iss} ou {@code custom}.
 * {@code id} identifie l'objet catalogue ; pour {@code custom}, on mémorise AD/DEC et le nom.</p>
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record AstroLastTargetDto(
        String kind,
        String id,
        Double customRaHours,
        Double customDecDeg,
        String customName
) {}
