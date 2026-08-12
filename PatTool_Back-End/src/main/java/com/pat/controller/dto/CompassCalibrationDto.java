package com.pat.controller.dto;

import com.fasterxml.jackson.annotation.JsonInclude;

/**
 * Calage du Nord de la boussole ISS, persisté par utilisateur Keycloak dans la
 * collection {@code appParameters} (clé {@code globe.iss.compass.calibration.<sub JWT>}).
 *
 * <ul>
 *   <li>{@code method} : {@code sensor}, {@code manual}, {@code gps}, {@code sun}
 *       ou {@code mouse} (Nord indiqué au clic / glisser sur le cadran).</li>
 *   <li>{@code northOffsetDeg} : correction (degrés, 0..360) à ajouter au cap capteur brut
 *       pour obtenir le vrai Nord.</li>
 *   <li>{@code calibratedAt} : horodatage ISO-8601 du dernier calage (informatif).</li>
 * </ul>
 *
 * Permet aux utilisateurs de ne pas recaler le Nord à chaque ouverture de la boussole :
 * la valeur est rechargée automatiquement et n'est remplacée que sur demande explicite.
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record CompassCalibrationDto(
        String method,
        Double northOffsetDeg,
        String calibratedAt
) {}
