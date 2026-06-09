package com.pat.controller.dto;

/**
 * One application parameter row for the admin read-only PATTOOL Parameters page.
 */
public record PatToolParameterItemDto(
        String key,
        String value,
        String description,
        /** Where the displayed value comes from: mongodb, application_properties, environment, code_default, … */
        String origin,
        /** {@code @Value} fallback in Java when origin is {@code code_default}, or hint when absent. */
        String codeDefault,
        boolean sensitive,
        /** Plain-text hint from Java source analysis when curated i18n description is missing. */
        String descriptionInferred
) {}
