package com.pat.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.pat.controller.dto.ChemAutocompleteDto;
import com.pat.controller.dto.ChemElementDto;
import com.pat.controller.dto.ChemMoleculeDto;
import com.pat.controller.dto.ChemMoleculeDto.ChemAtomDto;
import com.pat.controller.dto.ChemMoleculeDto.ChemBondDto;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import org.springframework.util.StringUtils;
import org.springframework.web.client.RestClientException;
import org.springframework.web.client.RestTemplate;

import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Server-side proxy for the public PubChem REST APIs (PUG REST + autocomplete).
 * <p>
 * Provides chemistry data for the "Chimie" page without exposing PubChem
 * directly to the browser:
 * <ul>
 *   <li>Periodic table of elements — {@code /rest/pug/periodictable/JSON}</li>
 *   <li>Molecule lookup (properties + 3D conformer + description) —
 *       {@code /rest/pug/compound/...}</li>
 *   <li>2D structure image (PNG bytes proxied) —
 *       {@code /rest/pug/compound/cid/{cid}/PNG}</li>
 *   <li>Compound-name autocomplete — {@code /rest/autocomplete/compound/{q}/json}</li>
 * </ul>
 *
 * @see <a href="https://pubchem.ncbi.nlm.nih.gov/docs/pug-rest">PubChem PUG REST docs</a>
 */
@Service
public class ChemistryProxyService {

    private static final Logger log = LoggerFactory.getLogger(ChemistryProxyService.class);

    /** Element symbols indexed by atomic number (index 0 unused). */
    private static final String[] SYMBOLS = {
            "", "H", "He", "Li", "Be", "B", "C", "N", "O", "F", "Ne",
            "Na", "Mg", "Al", "Si", "P", "S", "Cl", "Ar", "K", "Ca",
            "Sc", "Ti", "V", "Cr", "Mn", "Fe", "Co", "Ni", "Cu", "Zn",
            "Ga", "Ge", "As", "Se", "Br", "Kr", "Rb", "Sr", "Y", "Zr",
            "Nb", "Mo", "Tc", "Ru", "Rh", "Pd", "Ag", "Cd", "In", "Sn",
            "Sb", "Te", "I", "Xe", "Cs", "Ba", "La", "Ce", "Pr", "Nd",
            "Pm", "Sm", "Eu", "Gd", "Tb", "Dy", "Ho", "Er", "Tm", "Yb",
            "Lu", "Hf", "Ta", "W", "Re", "Os", "Ir", "Pt", "Au", "Hg",
            "Tl", "Pb", "Bi", "Po", "At", "Rn", "Fr", "Ra", "Ac", "Th",
            "Pa", "U", "Np", "Pu", "Am", "Cm", "Bk", "Cf", "Es", "Fm",
            "Md", "No", "Lr", "Rf", "Db", "Sg", "Bh", "Hs", "Mt", "Ds",
            "Rg", "Cn", "Nh", "Fl", "Mc", "Lv", "Ts", "Og"
    };

    private final RestTemplate restTemplate;
    private final ObjectMapper objectMapper;

    @Value("${app.chem.pubchem-rest-base:https://pubchem.ncbi.nlm.nih.gov/rest/pug}")
    private String pubChemRestBase;

    @Value("${app.chem.pubchem-autocomplete-base:https://pubchem.ncbi.nlm.nih.gov/rest/autocomplete}")
    private String pubChemAutocompleteBase;

    /** Periodic table data is effectively static — cache it after the first successful fetch. */
    private volatile List<ChemElementDto> cachedElements;

    public ChemistryProxyService(
            @Qualifier("chemRestTemplate") RestTemplate restTemplate,
            ObjectMapper objectMapper) {
        this.restTemplate = restTemplate;
        this.objectMapper = objectMapper;
    }

    // ------------------------------------------------------------------
    // Periodic table
    // ------------------------------------------------------------------

    public List<ChemElementDto> listElements() {
        List<ChemElementDto> cached = cachedElements;
        if (cached != null) {
            return cached;
        }
        JsonNode root = fetchJson(normalizeBase(pubChemRestBase) + "/periodictable/JSON");
        if (root == null) {
            return null;
        }
        JsonNode columns = root.path("Table").path("Columns").path("Column");
        JsonNode rows = root.path("Table").path("Row");
        if (!columns.isArray() || !rows.isArray()) {
            return null;
        }
        Map<String, Integer> col = new LinkedHashMap<>();
        for (int i = 0; i < columns.size(); i++) {
            col.put(columns.get(i).asText(), i);
        }
        List<ChemElementDto> elements = new ArrayList<>(rows.size());
        for (JsonNode row : rows) {
            JsonNode cells = row.path("Cell");
            if (!cells.isArray()) {
                continue;
            }
            int atomicNumber = parseInt(cell(cells, col, "AtomicNumber"));
            if (atomicNumber <= 0) {
                continue;
            }
            int[] pos = gridPosition(atomicNumber);
            elements.add(new ChemElementDto(
                    atomicNumber,
                    cell(cells, col, "Symbol"),
                    cell(cells, col, "Name"),
                    cell(cells, col, "AtomicMass"),
                    cell(cells, col, "CPKHexColor"),
                    cell(cells, col, "ElectronConfiguration"),
                    cell(cells, col, "Electronegativity"),
                    cell(cells, col, "AtomicRadius"),
                    cell(cells, col, "IonizationEnergy"),
                    cell(cells, col, "ElectronAffinity"),
                    cell(cells, col, "OxidationStates"),
                    cell(cells, col, "StandardState"),
                    cell(cells, col, "MeltingPoint"),
                    cell(cells, col, "BoilingPoint"),
                    cell(cells, col, "Density"),
                    cell(cells, col, "GroupBlock"),
                    cell(cells, col, "YearDiscovered"),
                    pos[0], pos[1], pos[2], pos[3]
            ));
        }
        if (elements.isEmpty()) {
            return null;
        }
        cachedElements = elements;
        return elements;
    }

    // ------------------------------------------------------------------
    // Molecules
    // ------------------------------------------------------------------

    public ChemMoleculeDto getMoleculeByName(String name) {
        String encoded = URLEncoder.encode(name.trim(), StandardCharsets.UTF_8).replace("+", "%20");
        JsonNode props = fetchProperties("name/" + encoded);
        return props == null ? null : buildMolecule(props);
    }

    public ChemMoleculeDto getMoleculeByCid(long cid) {
        JsonNode props = fetchProperties("cid/" + cid);
        return props == null ? null : buildMolecule(props);
    }

    private JsonNode fetchProperties(String nsAndId) {
        String url = normalizeBase(pubChemRestBase) + "/compound/" + nsAndId
                + "/property/MolecularFormula,MolecularWeight,IUPACName,CanonicalSMILES,"
                + "IsomericSMILES,InChIKey,XLogP,Charge/JSON";
        JsonNode root = fetchJson(url);
        if (root == null) {
            return null;
        }
        JsonNode props = root.path("PropertyTable").path("Properties");
        if (!props.isArray() || props.isEmpty()) {
            return null;
        }
        return props.get(0);
    }

    private ChemMoleculeDto buildMolecule(JsonNode props) {
        long cid = props.path("CID").asLong(0);
        if (cid <= 0) {
            return null;
        }

        String[] desc = fetchDescription(cid);
        String name = desc[0];
        if (!StringUtils.hasText(name)) {
            name = textOrNull(props.path("IUPACName"));
        }

        List<ChemAtomDto> atoms = new ArrayList<>();
        List<ChemBondDto> bonds = new ArrayList<>();
        // Prefer the real 3D conformer; fall back to the 2D record (planar coords,
        // z = 0) so single atoms and small species still render something.
        boolean has3d = parseRecord(cid, true, atoms, bonds);
        if (!has3d) {
            atoms.clear();
            bonds.clear();
            has3d = parseRecord(cid, false, atoms, bonds);
        }

        return new ChemMoleculeDto(
                cid,
                name,
                textOrNull(props.path("MolecularFormula")),
                textOrNull(props.path("MolecularWeight")),
                textOrNull(props.path("IUPACName")),
                firstSmiles(props),
                textOrNull(props.path("InChIKey")),
                textOrNull(props.path("XLogP")),
                textOrNull(props.path("Charge")),
                desc[1],
                desc[2],
                desc[3],
                "/api/external/chem/image/" + cid,
                has3d,
                atoms,
                bonds
        );
    }

    /** @return {title, description, descriptionSource, descriptionUrl} (any element may be null). */
    private String[] fetchDescription(long cid) {
        String[] out = new String[]{null, null, null, null};
        JsonNode root = fetchJson(normalizeBase(pubChemRestBase) + "/compound/cid/" + cid + "/description/JSON");
        if (root == null) {
            return out;
        }
        for (JsonNode info : root.path("InformationList").path("Information")) {
            if (out[0] == null) {
                out[0] = textOrNull(info.path("Title"));
            }
            String description = textOrNull(info.path("Description"));
            if (out[1] == null && StringUtils.hasText(description)) {
                out[1] = description;
                out[2] = textOrNull(info.path("DescriptionSourceName"));
                out[3] = textOrNull(info.path("DescriptionURL"));
            }
        }
        return out;
    }

    private boolean parseRecord(long cid, boolean threeD, List<ChemAtomDto> atoms, List<ChemBondDto> bonds) {
        String url = normalizeBase(pubChemRestBase) + "/compound/cid/" + cid + "/record/JSON"
                + (threeD ? "?record_type=3d" : "?record_type=2d");
        JsonNode root = fetchJson(url);
        if (root == null) {
            return false;
        }
        JsonNode comp = root.path("PC_Compounds").path(0);
        if (comp.isMissingNode()) {
            return false;
        }
        JsonNode aidNode = comp.path("atoms").path("aid");
        JsonNode elementNode = comp.path("atoms").path("element");
        if (!aidNode.isArray() || !elementNode.isArray() || aidNode.isEmpty()) {
            return false;
        }
        Map<Integer, Integer> aidToElement = new LinkedHashMap<>();
        for (int i = 0; i < aidNode.size(); i++) {
            aidToElement.put(aidNode.get(i).asInt(), elementNode.path(i).asInt());
        }

        JsonNode coords = comp.path("coords").path(0);
        JsonNode coordAid = coords.path("aid");
        JsonNode conformer = coords.path("conformers").path(0);
        JsonNode xs = conformer.path("x");
        JsonNode ys = conformer.path("y");
        JsonNode zs = conformer.path("z");
        if (!coordAid.isArray() || !xs.isArray() || !ys.isArray()) {
            return false;
        }

        Map<Integer, Integer> aidToIndex = new LinkedHashMap<>();
        for (int i = 0; i < coordAid.size(); i++) {
            int aid = coordAid.get(i).asInt();
            int atomicNumber = aidToElement.getOrDefault(aid, 0);
            double x = xs.path(i).asDouble(0);
            double y = ys.path(i).asDouble(0);
            double z = zs.path(i).asDouble(0);
            atoms.add(new ChemAtomDto(atomicNumber, symbolOf(atomicNumber), round(x), round(y), round(z)));
            aidToIndex.put(aid, i);
        }

        JsonNode bondAid1 = comp.path("bonds").path("aid1");
        JsonNode bondAid2 = comp.path("bonds").path("aid2");
        JsonNode bondOrder = comp.path("bonds").path("order");
        if (bondAid1.isArray() && bondAid2.isArray()) {
            for (int i = 0; i < bondAid1.size(); i++) {
                Integer from = aidToIndex.get(bondAid1.get(i).asInt());
                Integer to = aidToIndex.get(bondAid2.get(i).asInt());
                if (from == null || to == null) {
                    continue;
                }
                int order = bondOrder.path(i).asInt(1);
                bonds.add(new ChemBondDto(from, to, Math.max(1, Math.min(3, order))));
            }
        }
        return !atoms.isEmpty();
    }

    /** Resolves a molecular formula (e.g. {@code CO2}) to the first matching PubChem CID. */
    public Long resolveFormulaToCid(String formula) {
        String encoded = URLEncoder.encode(formula.trim(), StandardCharsets.UTF_8).replace("+", "%20");
        String url = normalizeBase(pubChemRestBase)
                + "/compound/fastformula/" + encoded + "/cids/JSON?MaxRecords=1";
        JsonNode root = fetchJson(url);
        if (root == null) {
            return null;
        }
        JsonNode cid = root.path("IdentifierList").path("CID").path(0);
        return cid.isNumber() ? cid.asLong() : null;
    }

    public byte[] fetchImage(long cid) {
        String url = normalizeBase(pubChemRestBase) + "/compound/cid/" + cid + "/PNG?image_size=large";
        try {
            return restTemplate.getForObject(url, byte[].class);
        } catch (RestClientException ex) {
            log.warn("PubChem image call failed for cid {}: {}", cid, rootCauseMessage(ex));
            return null;
        }
    }

    public ChemAutocompleteDto autocomplete(String query, int limit) {
        String encoded = URLEncoder.encode(query.trim(), StandardCharsets.UTF_8).replace("+", "%20");
        String url = normalizeBase(pubChemAutocompleteBase) + "/compound/" + encoded + "/json?limit=" + limit;
        JsonNode root = fetchJson(url);
        List<String> suggestions = new ArrayList<>();
        if (root != null) {
            for (JsonNode term : root.path("dictionary_terms").path("compound")) {
                String value = textOrNull(term);
                if (StringUtils.hasText(value)) {
                    suggestions.add(value);
                }
            }
        }
        return new ChemAutocompleteDto(query.trim(), suggestions);
    }

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------

    private static String firstSmiles(JsonNode props) {
        for (String field : new String[]{"SMILES", "IsomericSMILES", "ConnectivitySMILES", "CanonicalSMILES"}) {
            String value = textOrNull(props.path(field));
            if (StringUtils.hasText(value)) {
                return value;
            }
        }
        return null;
    }

    private static String symbolOf(int atomicNumber) {
        if (atomicNumber >= 1 && atomicNumber < SYMBOLS.length) {
            return SYMBOLS[atomicNumber];
        }
        return "?";
    }

    /**
     * Computes {period, group, xpos (1..18), ypos (1..10)} for a periodic-table
     * grid. Lanthanides land on row 9 and actinides on row 10 (columns 4..18),
     * matching the conventional standalone f-block layout.
     */
    private static int[] gridPosition(int z) {
        int period;
        int group;
        int xpos;
        int ypos;
        if (z == 1) {
            period = 1; group = 1; xpos = 1; ypos = 1;
        } else if (z == 2) {
            period = 1; group = 18; xpos = 18; ypos = 1;
        } else if (z <= 10) {
            period = 2; ypos = 2;
            group = (z <= 4) ? z - 2 : z + 8;
            xpos = group;
        } else if (z <= 18) {
            period = 3; ypos = 3;
            group = (z <= 12) ? z - 10 : z;
            xpos = group;
        } else if (z <= 36) {
            period = 4; ypos = 4; group = z - 18; xpos = group;
        } else if (z <= 54) {
            period = 5; ypos = 5; group = z - 36; xpos = group;
        } else if (z <= 86) {
            period = 6;
            if (z <= 56) {
                group = z - 54; ypos = 6; xpos = group;
            } else if (z <= 71) {
                group = 3; ypos = 9; xpos = (z - 57) + 4;
            } else {
                group = z - 68; ypos = 6; xpos = group;
            }
        } else if (z <= 118) {
            period = 7;
            if (z <= 88) {
                group = z - 86; ypos = 7; xpos = group;
            } else if (z <= 103) {
                group = 3; ypos = 10; xpos = (z - 89) + 4;
            } else {
                group = z - 100; ypos = 7; xpos = group;
            }
        } else {
            period = 0; group = 0; xpos = 1; ypos = 1;
        }
        return new int[]{period, group, xpos, ypos};
    }

    private static String cell(JsonNode cells, Map<String, Integer> col, String name) {
        Integer idx = col.get(name);
        if (idx == null || idx >= cells.size()) {
            return null;
        }
        return textOrNull(cells.get(idx));
    }

    private JsonNode fetchJson(String url) {
        try {
            String body = restTemplate.getForObject(url, String.class);
            if (!StringUtils.hasText(body)) {
                return null;
            }
            return objectMapper.readTree(body);
        } catch (RestClientException ex) {
            log.warn("PubChem call failed for {}: {}", url, rootCauseMessage(ex));
            return null;
        } catch (Exception ex) {
            log.warn("PubChem call failed for {}: {}", url, ex.getMessage());
            return null;
        }
    }

    private static double round(double value) {
        return Math.round(value * 1000.0) / 1000.0;
    }

    private static int parseInt(String value) {
        if (!StringUtils.hasText(value)) {
            return 0;
        }
        try {
            return Integer.parseInt(value.trim());
        } catch (NumberFormatException ex) {
            return 0;
        }
    }

    private static String textOrNull(JsonNode node) {
        if (node == null || node.isMissingNode() || node.isNull()) {
            return null;
        }
        if (node.isTextual()) {
            String t = node.asText().trim();
            return t.isEmpty() ? null : t;
        }
        if (node.isNumber()) {
            return node.asText();
        }
        return null;
    }

    private static String rootCauseMessage(Throwable ex) {
        Throwable t = ex;
        while (t.getCause() != null && t.getCause() != t) {
            t = t.getCause();
        }
        return t.getMessage() != null ? t.getMessage() : ex.getMessage();
    }

    private static String normalizeBase(String base) {
        if (!StringUtils.hasText(base)) {
            return "";
        }
        String trimmed = base.trim();
        while (trimmed.endsWith("/")) {
            trimmed = trimmed.substring(0, trimmed.length() - 1);
        }
        return trimmed;
    }
}
