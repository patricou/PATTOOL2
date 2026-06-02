package com.pat.controller;

import com.pat.controller.dto.CernApiCatalogDto;
import com.pat.controller.dto.CernOpenDataRecordDetailDto;
import com.pat.controller.dto.CernOpenDataSearchResultDto;
import com.pat.controller.dto.CernRepositorySearchResultDto;
import com.pat.service.CernProxyService;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.ResponseEntity;
import org.springframework.util.StringUtils;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.regex.Pattern;

/**
 * Proxy for public CERN-related REST APIs (Open Data, CDS Repository, Zenodo).
 * <p>
 * Endpoints:
 * <ul>
 *   <li>{@code GET /api/external/cern/catalog} — available APIs and live status</li>
 *   <li>{@code GET /api/external/cern/opendata/records} — search open data records</li>
 *   <li>{@code GET /api/external/cern/opendata/records/{recid}} — single record metadata</li>
 *   <li>{@code GET /api/external/cern/repository/records} — search CDS records</li>
 *   <li>{@code GET /api/external/cern/repository/communities} — list CDS communities</li>
 *   <li>{@code GET /api/external/cern/zenodo/records} — search Zenodo records</li>
 * </ul>
 */
@RestController
@RequestMapping("/api/external/cern")
public class CernRestController {

    private static final Pattern SAFE_QUERY = Pattern.compile("^[\\p{L}\\p{N}\\p{P}\\p{Z}]{0,200}$");
    private static final Pattern EXPERIMENT = Pattern.compile("^[A-Za-z0-9][A-Za-z0-9 _-]{0,40}$");

    @Autowired
    private CernProxyService cernProxyService;

    @GetMapping("/catalog")
    public ResponseEntity<CernApiCatalogDto> catalog() {
        return ResponseEntity.ok(cernProxyService.buildCatalog());
    }

    @GetMapping("/opendata/records")
    public ResponseEntity<CernOpenDataSearchResultDto> searchOpenData(
            @RequestParam(required = false) String q,
            @RequestParam(defaultValue = "10") int size,
            @RequestParam(defaultValue = "1") int page,
            @RequestParam(required = false) String experiment) {

        if (!isValidQuery(q) || !isValidExperiment(experiment)) {
            return ResponseEntity.badRequest().build();
        }
        int boundedSize = clamp(size, 1, 20);
        int boundedPage = clamp(page, 1, 500);
        CernOpenDataSearchResultDto dto = cernProxyService.searchOpenData(q, boundedSize, boundedPage, experiment);
        if (dto == null) {
            return ResponseEntity.status(502).build();
        }
        return ResponseEntity.ok(dto);
    }

    @GetMapping("/opendata/records/{recid}")
    public ResponseEntity<CernOpenDataRecordDetailDto> openDataRecord(@PathVariable long recid) {
        if (recid < 1 || recid > 999_999_999L) {
            return ResponseEntity.badRequest().build();
        }
        CernOpenDataRecordDetailDto dto = cernProxyService.getOpenDataRecord(recid);
        if (dto == null) {
            return ResponseEntity.status(502).build();
        }
        return ResponseEntity.ok(dto);
    }

    @GetMapping("/repository/records")
    public ResponseEntity<CernRepositorySearchResultDto> searchRepository(
            @RequestParam(required = false) String q,
            @RequestParam(defaultValue = "10") int size,
            @RequestParam(defaultValue = "1") int page) {

        if (!isValidQuery(q)) {
            return ResponseEntity.badRequest().build();
        }
        int boundedSize = clamp(size, 1, 20);
        int boundedPage = clamp(page, 1, 500);
        CernRepositorySearchResultDto dto = cernProxyService.searchRepository(q, boundedSize, boundedPage);
        if (dto == null) {
            return ResponseEntity.status(502).build();
        }
        return ResponseEntity.ok(dto);
    }

    @GetMapping("/zenodo/records")
    public ResponseEntity<CernOpenDataSearchResultDto> searchZenodo(
            @RequestParam(required = false) String q,
            @RequestParam(defaultValue = "10") int size,
            @RequestParam(defaultValue = "1") int page) {

        if (!isValidQuery(q)) {
            return ResponseEntity.badRequest().build();
        }
        int boundedSize = clamp(size, 1, 20);
        int boundedPage = clamp(page, 1, 500);
        CernOpenDataSearchResultDto dto = cernProxyService.searchZenodo(q, boundedSize, boundedPage);
        if (dto == null) {
            return ResponseEntity.status(502).build();
        }
        return ResponseEntity.ok(dto);
    }

    @GetMapping("/repository/communities")
    public ResponseEntity<CernRepositorySearchResultDto> repositoryCommunities(
            @RequestParam(defaultValue = "10") int size,
            @RequestParam(defaultValue = "1") int page) {

        int boundedSize = clamp(size, 1, 20);
        int boundedPage = clamp(page, 1, 500);
        CernRepositorySearchResultDto dto = cernProxyService.listRepositoryCommunities(boundedSize, boundedPage);
        if (dto == null) {
            return ResponseEntity.status(502).build();
        }
        return ResponseEntity.ok(dto);
    }

    private static boolean isValidQuery(String q) {
        if (!StringUtils.hasText(q)) {
            return true;
        }
        return SAFE_QUERY.matcher(q.trim()).matches();
    }

    private static boolean isValidExperiment(String experiment) {
        if (!StringUtils.hasText(experiment)) {
            return true;
        }
        return EXPERIMENT.matcher(experiment.trim()).matches();
    }

    private static int clamp(int value, int min, int max) {
        return Math.max(min, Math.min(max, value));
    }
}
