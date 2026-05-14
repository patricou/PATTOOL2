package com.pat.controller.dto;

import java.util.List;

/** Réponse GET /api/euromillions/method-analytics — instantané Mongo ou fraîchement recalculé. */
public record EuromillionsMethodAnalyticsDto(
        String sinceInclusive,
        long drawCount,
        String computedAtIso,
        List<EuromMethodEntryDto> methods) {}
