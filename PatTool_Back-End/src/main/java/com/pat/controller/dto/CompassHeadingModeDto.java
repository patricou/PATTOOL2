package com.pat.controller.dto;

import com.fasterxml.jackson.annotation.JsonInclude;

/**
 * Méthode de calcul du Nord (boussole astres), persistée par utilisateur Keycloak.
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record CompassHeadingModeDto(String headingMode) {}
