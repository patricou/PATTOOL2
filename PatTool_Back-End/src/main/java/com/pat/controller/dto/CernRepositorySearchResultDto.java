package com.pat.controller.dto;

import java.util.List;

public record CernRepositorySearchResultDto(
        long total,
        int page,
        int size,
        List<CernRepositoryRecordSummaryDto> records
) {

    public record CernRepositoryRecordSummaryDto(
            String id,
            String title,
            String publicationDate,
            String resourceType
    ) {}
}
