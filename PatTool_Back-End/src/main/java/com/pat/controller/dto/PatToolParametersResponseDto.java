package com.pat.controller.dto;

import java.util.List;

public record PatToolParametersResponseDto(
        List<PatToolParameterSectionDto> sections,
        int totalItems
) {}
