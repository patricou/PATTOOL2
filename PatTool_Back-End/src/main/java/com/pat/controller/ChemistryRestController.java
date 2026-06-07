package com.pat.controller;

import com.pat.controller.dto.ChemAutocompleteDto;
import com.pat.controller.dto.ChemElementDto;
import com.pat.controller.dto.ChemMoleculeDto;
import com.pat.service.ChemistryProxyService;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.CacheControl;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.util.StringUtils;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;

/**
 * Proxy for public PubChem chemistry APIs powering the "Chimie" page.
 * <p>
 * Endpoints (all public, read-only):
 * <ul>
 *   <li>{@code GET /api/external/chem/elements} — periodic table of elements</li>
 *   <li>{@code GET /api/external/chem/molecule?name=...} — molecule by name (properties + 3D + description)</li>
 *   <li>{@code GET /api/external/chem/molecule/{cid}} — molecule by PubChem CID</li>
 *   <li>{@code GET /api/external/chem/image/{cid}} — 2D structure PNG (proxied bytes)</li>
 *   <li>{@code GET /api/external/chem/autocomplete?q=...} — compound-name suggestions</li>
 * </ul>
 */
@RestController
@RequestMapping("/api/external/chem")
public class ChemistryRestController {

    /** Compound names / search terms: letters, digits, spaces and common chemistry punctuation. */
    private static final Pattern SAFE_NAME = Pattern.compile("^[\\p{L}\\p{N}][\\p{L}\\p{N} .,'()\\[\\]+\\-]{0,120}$");

    /** Molecular formula: element letters, digits, parentheses/brackets. */
    private static final Pattern SAFE_FORMULA = Pattern.compile("^[A-Za-z0-9()\\[\\]]{1,40}$");

    @Autowired
    private ChemistryProxyService chemistryProxyService;

    @GetMapping("/elements")
    public ResponseEntity<List<ChemElementDto>> elements() {
        List<ChemElementDto> elements = chemistryProxyService.listElements();
        if (elements == null) {
            return ResponseEntity.status(502).build();
        }
        return ResponseEntity.ok()
                .cacheControl(CacheControl.maxAge(Duration.ofDays(7)).cachePublic())
                .body(elements);
    }

    @GetMapping("/molecule")
    public ResponseEntity<ChemMoleculeDto> moleculeByName(@RequestParam String name) {
        if (!isValidName(name)) {
            return ResponseEntity.badRequest().build();
        }
        ChemMoleculeDto dto = chemistryProxyService.getMoleculeByName(name);
        if (dto == null) {
            return ResponseEntity.status(404).build();
        }
        return ResponseEntity.ok(dto);
    }

    @GetMapping("/molecule/{cid}")
    public ResponseEntity<ChemMoleculeDto> moleculeByCid(@PathVariable long cid) {
        if (cid < 1 || cid > 9_999_999_999L) {
            return ResponseEntity.badRequest().build();
        }
        ChemMoleculeDto dto = chemistryProxyService.getMoleculeByCid(cid);
        if (dto == null) {
            return ResponseEntity.status(404).build();
        }
        return ResponseEntity.ok(dto);
    }

    @GetMapping("/formula")
    public ResponseEntity<Map<String, Long>> formula(@RequestParam String value) {
        if (!StringUtils.hasText(value) || !SAFE_FORMULA.matcher(value.trim()).matches()) {
            return ResponseEntity.badRequest().build();
        }
        Long cid = chemistryProxyService.resolveFormulaToCid(value);
        if (cid == null) {
            return ResponseEntity.status(404).build();
        }
        return ResponseEntity.ok(Map.of("cid", cid));
    }

    @GetMapping("/image/{cid}")
    public ResponseEntity<byte[]> image(@PathVariable long cid) {
        if (cid < 1 || cid > 9_999_999_999L) {
            return ResponseEntity.badRequest().build();
        }
        byte[] image = chemistryProxyService.fetchImage(cid);
        if (image == null || image.length == 0) {
            return ResponseEntity.status(502).build();
        }
        return ResponseEntity.ok()
                .contentType(MediaType.IMAGE_PNG)
                .cacheControl(CacheControl.maxAge(Duration.ofDays(7)).cachePublic())
                .body(image);
    }

    @GetMapping("/autocomplete")
    public ResponseEntity<ChemAutocompleteDto> autocomplete(
            @RequestParam String q,
            @RequestParam(defaultValue = "10") int limit) {
        if (!isValidName(q)) {
            return ResponseEntity.badRequest().build();
        }
        int boundedLimit = Math.max(1, Math.min(20, limit));
        return ResponseEntity.ok(chemistryProxyService.autocomplete(q, boundedLimit));
    }

    private static boolean isValidName(String value) {
        return StringUtils.hasText(value) && SAFE_NAME.matcher(value.trim()).matches();
    }
}
