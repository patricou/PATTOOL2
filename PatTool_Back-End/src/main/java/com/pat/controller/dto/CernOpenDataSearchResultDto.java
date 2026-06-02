package com.pat.controller.dto;

import java.util.List;
import java.util.Map;

public record CernOpenDataSearchResultDto(
        long total,
        int page,
        int size,
        List<CernOpenDataRecordSummaryDto> records,
        Map<String, Long> experimentCounts,
        Map<String, Long> typeCounts,
        Map<String, Long> yearCounts,
        Map<String, Long> availabilityCounts,
        Map<String, Long> categoryCounts,
        Map<String, Long> collisionEnergyCounts,
        Map<String, Long> collisionTypeCounts
) {}
