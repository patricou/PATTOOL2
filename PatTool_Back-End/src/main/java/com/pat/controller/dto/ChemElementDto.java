package com.pat.controller.dto;

/**
 * A single chemical element from the PubChem periodic table API
 * ({@code /rest/pug/periodictable/JSON}), enriched with computed grid
 * coordinates ({@code xpos}/{@code ypos}) so the frontend can lay out a
 * realistic periodic table (lanthanides/actinides on dedicated rows).
 */
public record ChemElementDto(
        int atomicNumber,
        String symbol,
        String name,
        String atomicMass,
        String cpkHexColor,
        String electronConfiguration,
        String electronegativity,
        String atomicRadius,
        String ionizationEnergy,
        String electronAffinity,
        String oxidationStates,
        String standardState,
        String meltingPoint,
        String boilingPoint,
        String density,
        String groupBlock,
        String yearDiscovered,
        int period,
        int group,
        int xpos,
        int ypos
) {}
