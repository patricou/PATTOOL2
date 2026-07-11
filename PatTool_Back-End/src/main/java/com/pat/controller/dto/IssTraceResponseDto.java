package com.pat.controller.dto;

import com.pat.service.IssTraceService.IssTracePointView;

import java.util.List;

/** Response for GET /api/external/globe/iss/trace (historical ISS ground track). */
public record IssTraceResponseDto(
        List<IssTracePointView> points,
        int retentionDays,
        int sampleIntervalSeconds) {
}
