package com.pat.dto;

import java.util.List;

public record PassiveProbeResponse(
        String requestedUrl,
        String finalUrl,
        Integer statusCode,
        List<PassiveCheckRow> checks) {}
