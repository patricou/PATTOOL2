package com.pat.controller.dto;

import java.util.List;

/**
 * A molecule resolved from PubChem (PUG REST): identity + physico-chemical
 * properties + a 3D conformer (atoms with coordinates and bonds) suitable for
 * rendering a ball-and-stick model, plus a textual description.
 */
public record ChemMoleculeDto(
        long cid,
        String name,
        String molecularFormula,
        String molecularWeight,
        String iupacName,
        String smiles,
        String inchiKey,
        String xlogp,
        String charge,
        String description,
        String descriptionSource,
        String descriptionUrl,
        String imagePath,
        boolean has3d,
        List<ChemAtomDto> atoms,
        List<ChemBondDto> bonds
) {

    /** One atom of a 3D conformer. Coordinates are in PubChem Angström-like units. */
    public record ChemAtomDto(
            int atomicNumber,
            String symbol,
            double x,
            double y,
            double z
    ) {}

    /**
     * A bond between two atoms, referenced by their zero-based index in
     * {@link ChemMoleculeDto#atoms()}. {@code order} is 1 (single), 2 (double)
     * or 3 (triple).
     */
    public record ChemBondDto(
            int from,
            int to,
            int order
    ) {}
}
