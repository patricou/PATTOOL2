package com.pat.controller.dto;

public record ReliefPeakDto(
        String name,
        double lat,
        double lon,
        double eleM,
        double azDeg,
        double elDeg,
        double distKm,
        boolean visible
) {}
