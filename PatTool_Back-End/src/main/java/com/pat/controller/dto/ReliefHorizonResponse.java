package com.pat.controller.dto;

import java.util.List;

public record ReliefHorizonResponse(
        double lat,
        double lon,
        double observerAltM,
        double radiusKm,
        double stepDeg,
        int zoom,
        float[] horizonElDeg,
        float[] horizonDistM,
        List<ReliefPeakDto> peaks,
        String demSource,
        String peakSource
) {}
