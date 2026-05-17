package com.pat.dto;

import com.fasterxml.jackson.annotation.JsonInclude;

@JsonInclude(JsonInclude.Include.NON_NULL)
public record PassiveCheckRow(String id, String severity, String detail) {}
