package com.pat.controller.dto;

import java.util.List;

public record CernOpenDataRecordSummaryDto(
        long recid,
        String title,
        String type,
        List<String> experiments,
        String datePublished,
        String availability,
        String abstractPreview
) {}
