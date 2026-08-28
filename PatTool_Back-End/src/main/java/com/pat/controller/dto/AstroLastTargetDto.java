package com.pat.controller.dto;

import com.fasterxml.jackson.annotation.JsonInclude;

/**
 * Dernier astre choisi dans le viseur, persisté par username (surnom Member) dans
 * {@code appParameters} (clé {@code globe.astro.last-target.<username>}).
 *
 * <p>{@code kind} : {@code planet}, {@code star}, {@code galaxy}, {@code deepsky}, {@code constellation},
 * {@code iss}, {@code custom} ou {@code ground}.
 * {@code id} identifie l'objet catalogue ou la position au sol ; pour {@code custom}, on mémorise AD/DEC et le nom.</p>
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record AstroLastTargetDto(
        String kind,
        String id,
        Double customRaHours,
        Double customDecDeg,
        String customName
) {}
