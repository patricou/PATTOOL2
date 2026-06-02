package com.pat.controller.dto;

/**
 * Related CERN ecosystem API documented but not proxied by PatTool (read-only info for the UI).
 */
public record CernCatalogNoteDto(
        String name,
        String upstreamBaseUrl,
        String documentationUrl,
        String note
) {}
