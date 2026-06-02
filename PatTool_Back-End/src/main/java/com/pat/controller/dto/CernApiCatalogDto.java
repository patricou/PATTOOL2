package com.pat.controller.dto;

import java.util.List;

/**
 * Catalog of public CERN REST APIs exposed through PatTool's backend proxy.
 */
public record CernApiCatalogDto(
        List<CernApiSourceDto> sources,
        List<CernCatalogNoteDto> relatedApis
) {

    public record CernApiSourceDto(
            String id,
            String name,
            String description,
            String upstreamBaseUrl,
            String documentationUrl,
            String status,
            List<CernApiEndpointDto> endpoints
    ) {}

    public record CernApiEndpointDto(
            String method,
            String upstreamPath,
            String patToolPath,
            String description
    ) {}
}
