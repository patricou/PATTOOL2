package com.pat.controller.dto;

import java.util.List;
import java.util.Map;

public record CernOpenDataRecordDetailDto(
        long recid,
        String title,
        String type,
        List<String> experiments,
        String accelerator,
        String datePublished,
        String availability,
        String abstractText,
        List<String> keywords,
        List<Map<String, Object>> files,
        String portalUrl,
        String collisionEnergy,
        String collisionType,
        String numberEvents
) {}
