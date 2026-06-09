package com.pat.controller.dto;

import java.util.List;

public record PatToolParameterSectionDto(
        String id,
        String labelKey,
        List<PatToolParameterItemDto> items
) {}
