package com.pat.controller.dto;

import java.util.List;

/** Compound-name suggestions from PubChem autocomplete ({@code /rest/autocomplete/compound}). */
public record ChemAutocompleteDto(
        String query,
        List<String> suggestions
) {}
