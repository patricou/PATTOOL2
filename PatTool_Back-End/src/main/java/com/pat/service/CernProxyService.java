package com.pat.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.pat.controller.dto.CernApiCatalogDto;
import com.pat.controller.dto.CernApiCatalogDto.CernApiEndpointDto;
import com.pat.controller.dto.CernApiCatalogDto.CernApiSourceDto;
import com.pat.controller.dto.CernCatalogNoteDto;
import com.pat.controller.dto.CernOpenDataRecordDetailDto;
import com.pat.controller.dto.CernOpenDataRecordSummaryDto;
import com.pat.controller.dto.CernOpenDataSearchResultDto;
import com.pat.controller.dto.CernRepositorySearchResultDto;
import com.pat.controller.dto.CernRepositorySearchResultDto.CernRepositoryRecordSummaryDto;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.ResponseEntity;
import org.springframework.stereotype.Service;
import org.springframework.util.StringUtils;
import org.springframework.web.client.RestClientException;
import org.springframework.web.client.RestTemplate;
import org.springframework.web.util.UriComponentsBuilder;

import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * Server-side proxy for public CERN REST APIs (Open Data Portal, CDS Repository).
 * <p>
 * Documentation:
 * <ul>
 *   <li><a href="https://opendata.cern.ch">CERN Open Data Portal</a> — {@code /api/records}</li>
 *   <li><a href="https://repository.cern/docs/reference/reference/">CDS Repository</a> — InvenioRDM REST</li>
 * </ul>
 */
@Service
public class CernProxyService {

    private static final Logger log = LoggerFactory.getLogger(CernProxyService.class);

    private final RestTemplate restTemplate;
    private final ObjectMapper objectMapper;

    @Value("${app.cern.opendata-api-base:https://opendata.cern.ch/api}")
    private String openDataApiBase;

    /** Official InvenioRDM base — {@code repository.cern.ch} is not a valid API host. */
    @Value("${app.cern.repository-api-base:https://repository.cern/api}")
    private String repositoryApiBase;

    @Value("${app.cern.opendata-portal-base:https://opendata.cern.ch}")
    private String openDataPortalBase;

    @Value("${app.cern.zenodo-api-base:https://zenodo.org/api}")
    private String zenodoApiBase;

    public CernProxyService(
            @Qualifier("cernRestTemplate") RestTemplate restTemplate,
            ObjectMapper objectMapper) {
        this.restTemplate = restTemplate;
        this.objectMapper = objectMapper;
    }

    public CernApiCatalogDto buildCatalog() {
        List<CernApiSourceDto> sources = List.of(
                openDataSource(),
                repositorySource(),
                zenodoSource()
        );
        return new CernApiCatalogDto(sources, relatedApisNotes());
    }

    /**
     * Zenodo — CERN-hosted open research repository (InvenioRDM), public record search.
     */
    public CernOpenDataSearchResultDto searchZenodo(String query, int size, int page) {
        UriComponentsBuilder builder = UriComponentsBuilder
                .fromHttpUrl(normalizeBase(zenodoApiBase) + "/records")
                .queryParam("size", size)
                .queryParam("page", page)
                .queryParam("sort", "bestmatch");
        if (StringUtils.hasText(query)) {
            builder.queryParam("q", query.trim());
        }
        JsonNode root = fetchJson(builder.toUriString());
        if (root == null) {
            return null;
        }
        long total = root.path("hits").path("total").asLong(0);
        List<CernOpenDataRecordSummaryDto> records = new ArrayList<>();
        for (JsonNode hit : root.path("hits").path("hits")) {
            records.add(toZenodoSummary(hit));
        }
        Map<String, Long> typeCounts = parseAggregationBuckets(root, "resource_type", 10);
        Map<String, Long> yearCounts = parseAggregationBuckets(root, "publication_date", 12);
        Map<String, Long> availabilityCounts = parseAggregationBuckets(root, "access_status", 6);
        Map<String, Long> subjectCounts = parseAggregationBuckets(root, "subject", 10);
        return new CernOpenDataSearchResultDto(
                total, page, size, records,
                Collections.emptyMap(),
                typeCounts, yearCounts, availabilityCounts, subjectCounts,
                Collections.emptyMap(),
                Collections.emptyMap()
        );
    }

    public CernOpenDataSearchResultDto searchOpenData(String query, int size, int page, String experiment) {
        UriComponentsBuilder builder = UriComponentsBuilder
                .fromHttpUrl(normalizeBase(openDataApiBase) + "/records/")
                .queryParam("size", size)
                .queryParam("page", page)
                .queryParam("sort", "mostrecent");
        if (StringUtils.hasText(query)) {
            builder.queryParam("q", query.trim());
        }
        if (StringUtils.hasText(experiment)) {
            builder.queryParam("experiment", experiment.trim());
        }
        JsonNode root = fetchJson(builder.toUriString());
        if (root == null) {
            return null;
        }
        long total = root.path("hits").path("total").asLong(0);
        List<CernOpenDataRecordSummaryDto> records = new ArrayList<>();
        for (JsonNode hit : root.path("hits").path("hits")) {
            records.add(toOpenDataSummary(hit));
        }
        Map<String, Long> experimentCounts = parseAggregationBuckets(root, "experiment", 12);
        Map<String, Long> typeCounts = parseAggregationBuckets(root, "type", 10);
        Map<String, Long> yearCounts = parseAggregationBuckets(root, "year", 12);
        Map<String, Long> availabilityCounts = parseAggregationBuckets(root, "availability", 6);
        Map<String, Long> categoryCounts = parseAggregationBuckets(root, "category", 8);
        Map<String, Long> collisionEnergyCounts = parseAggregationBuckets(root, "collision_energy", 12);
        Map<String, Long> collisionTypeCounts = parseAggregationBuckets(root, "collision_type", 10);
        return new CernOpenDataSearchResultDto(
                total, page, size, records,
                experimentCounts, typeCounts, yearCounts, availabilityCounts, categoryCounts,
                collisionEnergyCounts, collisionTypeCounts
        );
    }

    public CernOpenDataRecordDetailDto getOpenDataRecord(long recid) {
        String url = normalizeBase(openDataApiBase) + "/records/" + recid;
        JsonNode root = fetchJson(url);
        if (root == null) {
            return null;
        }
        JsonNode metadata = root.path("metadata");
        if (metadata.isMissingNode() || metadata.isNull()) {
            metadata = root;
        }
        String title = textOrNull(metadata.path("title"));
        String type = formatType(metadata.path("type"));
        List<String> experiments = stringList(metadata.path("experiment"));
        String accelerator = textOrNull(metadata.path("accelerator"));
        String datePublished = textOrNull(metadata.path("date_published"));
        String availability = textOrNull(metadata.path("availability"));
        String abstractText = textOrNull(metadata.path("abstract").path("description"));
        if (!StringUtils.hasText(abstractText)) {
            abstractText = textOrNull(metadata.path("abstract"));
        }
        List<String> keywords = stringList(metadata.path("keywords"));
        List<Map<String, Object>> files = parseFiles(metadata.path("files"));
        String portalUrl = normalizeBase(openDataPortalBase) + "/record/" + recid;
        String collisionEnergy = formatCollisionEnergy(metadata.path("collision_energy"));
        String collisionType = formatCollisionType(metadata.path("collision_type"));
        String numberEvents = textOrNull(metadata.path("number_events"));
        if (!StringUtils.hasText(numberEvents) && metadata.path("number_events").isNumber()) {
            numberEvents = metadata.path("number_events").asText();
        }
        return new CernOpenDataRecordDetailDto(
                recid,
                title,
                type,
                experiments,
                accelerator,
                datePublished,
                availability,
                abstractText,
                keywords,
                files,
                portalUrl,
                collisionEnergy,
                collisionType,
                numberEvents
        );
    }

    public CernRepositorySearchResultDto searchRepository(String query, int size, int page) {
        UriComponentsBuilder builder = UriComponentsBuilder
                .fromHttpUrl(normalizeBase(repositoryApiBase) + "/records")
                .queryParam("size", size)
                .queryParam("page", page);
        if (StringUtils.hasText(query)) {
            builder.queryParam("q", query.trim());
        }
        JsonNode root = fetchJson(builder.toUriString());
        if (root == null) {
            return null;
        }
        long total = root.path("hits").path("total").asLong(0);
        List<CernRepositoryRecordSummaryDto> records = new ArrayList<>();
        for (JsonNode hit : root.path("hits").path("hits")) {
            records.add(toRepositorySummary(hit));
        }
        return new CernRepositorySearchResultDto(total, page, size, records);
    }

    public CernRepositorySearchResultDto listRepositoryCommunities(int size, int page) {
        UriComponentsBuilder builder = UriComponentsBuilder
                .fromHttpUrl(normalizeBase(repositoryApiBase) + "/communities")
                .queryParam("size", size)
                .queryParam("page", page);
        JsonNode root = fetchJson(builder.toUriString());
        if (root == null) {
            return null;
        }
        long total = root.path("hits").path("total").asLong(0);
        List<CernRepositoryRecordSummaryDto> records = new ArrayList<>();
        for (JsonNode hit : root.path("hits").path("hits")) {
            String id = textOrNull(hit.path("id"));
            JsonNode metadata = hit.path("metadata");
            String title = textOrNull(metadata.path("title"));
            if (!StringUtils.hasText(title)) {
                title = textOrNull(hit.path("slug"));
            }
            records.add(new CernRepositoryRecordSummaryDto(
                    id,
                    title,
                    null,
                    "community"
            ));
        }
        return new CernRepositorySearchResultDto(total, page, size, records);
    }

    private CernApiSourceDto openDataSource() {
        String status = probe(normalizeBase(openDataApiBase) + "/records/?size=1");
        return new CernApiSourceDto(
                "opendata",
                "CERN Open Data Portal",
                "Search and browse open datasets, software and documentation from LHC experiments.",
                normalizeBase(openDataApiBase),
                "https://opendata.cern.ch/docs",
                status,
                List.of(
                        new CernApiEndpointDto("GET", "/records/", "/api/external/cern/opendata/records", "Search records"),
                        new CernApiEndpointDto("GET", "/records/{recid}", "/api/external/cern/opendata/records/{recid}", "Record metadata"),
                        new CernApiEndpointDto("GET", "/records/?size=1", "/api/external/cern/catalog", "Health check (via catalog)")
                )
        );
    }

    private CernApiSourceDto repositorySource() {
        String status = probe(normalizeBase(repositoryApiBase) + "/records?size=1");
        return new CernApiSourceDto(
                "repository",
                "CDS Repository",
                "InvenioRDM REST API for published records, communities and controlled vocabularies.",
                normalizeBase(repositoryApiBase),
                "https://repository.cern/docs/reference/reference/",
                status,
                List.of(
                        new CernApiEndpointDto("GET", "/records", "/api/external/cern/repository/records", "Search published records"),
                        new CernApiEndpointDto("GET", "/communities", "/api/external/cern/repository/communities", "List communities"),
                        new CernApiEndpointDto("GET", "/vocabularies/{type}", null, "Controlled vocabularies (not proxied)")
                )
        );
    }

    private CernApiSourceDto zenodoSource() {
        String status = probe(normalizeBase(zenodoApiBase) + "/records?size=1");
        return new CernApiSourceDto(
                "zenodo",
                "Zenodo (CERN)",
                "Open research repository operated by CERN — publications, data, software (public search API).",
                normalizeBase(zenodoApiBase),
                "https://developers.zenodo.org/",
                status,
                List.of(
                        new CernApiEndpointDto("GET", "/records", "/api/external/cern/zenodo/records", "Search published records")
                )
        );
    }

    private static List<CernCatalogNoteDto> relatedApisNotes() {
        return List.of(
                new CernCatalogNoteDto(
                        "INSPIRE HEP",
                        "https://inspirehep.net/api/",
                        "https://inspirehep.net/help/knowledge-base/api/",
                        "High-energy physics literature index (CERN-hosted). Not proxied in PatTool."
                ),
                new CernCatalogNoteDto(
                        "Indico",
                        "https://indico.cern.ch/",
                        "https://docs.indico.io/en/stable/api/",
                        "Conference and event management. Most write APIs require authentication."
                ),
                new CernCatalogNoteDto(
                        "CERN Open Data Client",
                        null,
                        "https://cernopendata-client.readthedocs.io/",
                        "CLI (not REST) for bulk file download from opendata.cern.ch via EOS/XRootD."
                )
        );
    }

    private CernOpenDataRecordSummaryDto toZenodoSummary(JsonNode hit) {
        JsonNode metadata = hit.path("metadata");
        long recid = hit.path("id").asLong(0);
        if (recid == 0) {
            recid = parseRecidFromId(hit.path("recid").asText(null));
        }
        String title = textOrNull(metadata.path("title"));
        if (!StringUtils.hasText(title)) {
            title = textOrNull(hit.path("title"));
        }
        String type = textOrNull(metadata.path("resource_type").path("title"));
        if (!StringUtils.hasText(type)) {
            type = textOrNull(metadata.path("resource_type").path("type"));
        }
        String datePublished = textOrNull(metadata.path("publication_date"));
        String availability = textOrNull(metadata.path("access_right"));
        String abstractPreview = textOrNull(metadata.path("description"));
        if (StringUtils.hasText(abstractPreview) && abstractPreview.length() > 4000) {
            abstractPreview = abstractPreview.substring(0, 3997) + "...";
        }
        return new CernOpenDataRecordSummaryDto(
                recid, title, type, List.of(), datePublished, availability, abstractPreview
        );
    }

    private String probe(String url) {
        try {
            ResponseEntity<String> response = restTemplate.getForEntity(url, String.class);
            if (response.getStatusCode().is2xxSuccessful()) {
                return "online";
            }
            return "error:" + response.getStatusCode().value();
        } catch (RestClientException ex) {
            log.debug("CERN probe failed for {}: {}", url, ex.getMessage());
            return "offline";
        }
    }

    private JsonNode fetchJson(String url) {
        try {
            String body = restTemplate.getForObject(url, String.class);
            if (!StringUtils.hasText(body)) {
                return null;
            }
            return objectMapper.readTree(body);
        } catch (RestClientException ex) {
            log.warn("CERN API call failed for {}: {}", url, rootCauseMessage(ex));
            return null;
        } catch (Exception ex) {
            log.warn("CERN API call failed for {}: {}", url, ex.getMessage());
            return null;
        }
    }

    private CernOpenDataRecordSummaryDto toOpenDataSummary(JsonNode hit) {
        JsonNode metadata = hit.path("metadata");
        long recid = metadata.path("recid").asLong(0);
        if (recid == 0) {
            recid = parseRecidFromId(hit.path("id").asText(null));
        }
        String title = textOrNull(metadata.path("title"));
        String type = formatType(metadata.path("type"));
        List<String> experiments = stringList(metadata.path("experiment"));
        String datePublished = textOrNull(metadata.path("date_published"));
        String availability = textOrNull(metadata.path("availability"));
        String abstractPreview = textOrNull(metadata.path("abstract").path("description"));
        if (!StringUtils.hasText(abstractPreview)) {
            abstractPreview = textOrNull(metadata.path("abstract"));
        }
        if (StringUtils.hasText(abstractPreview) && abstractPreview.length() > 280) {
            abstractPreview = abstractPreview.substring(0, 277) + "...";
        }
        return new CernOpenDataRecordSummaryDto(
                recid, title, type, experiments, datePublished, availability, abstractPreview
        );
    }

    private CernRepositoryRecordSummaryDto toRepositorySummary(JsonNode hit) {
        String id = textOrNull(hit.path("id"));
        JsonNode metadata = hit.path("metadata");
        String title = textOrNull(metadata.path("title"));
        String publicationDate = textOrNull(metadata.path("publication_date"));
        String resourceType = textOrNull(metadata.path("resource_type").path("id"));
        if (!StringUtils.hasText(resourceType)) {
            resourceType = textOrNull(metadata.path("resource_type"));
        }
        return new CernRepositoryRecordSummaryDto(id, title, publicationDate, resourceType);
    }

    /**
     * Parses Elasticsearch-style aggregation buckets (experiment, type, year, …).
     * Year buckets use {@code key_as_string} when present (e.g. "2016").
     */
    private static Map<String, Long> parseAggregationBuckets(JsonNode root, String aggregationName, int maxBuckets) {
        JsonNode buckets = root.path("aggregations").path(aggregationName).path("buckets");
        if (!buckets.isArray() || buckets.isEmpty()) {
            return Collections.emptyMap();
        }
        Map<String, Long> out = new LinkedHashMap<>();
        int limit = Math.min(buckets.size(), Math.max(maxBuckets, 1));
        for (int i = 0; i < limit; i++) {
            JsonNode bucket = buckets.get(i);
            String key = textOrNull(bucket.path("key_as_string"));
            if (!StringUtils.hasText(key)) {
                key = bucket.path("key").asText(null);
                if (bucket.path("key").isNumber()) {
                    key = bucket.path("key").asText();
                }
            }
            if (!StringUtils.hasText(key)) {
                continue;
            }
            key = key.trim();
            if (key.length() > 80) {
                key = key.substring(0, 77) + "...";
            }
            out.put(key, bucket.path("doc_count").asLong(0));
        }
        return out;
    }

    private static List<Map<String, Object>> parseFiles(JsonNode filesNode) {
        if (!filesNode.isArray()) {
            return List.of();
        }
        List<Map<String, Object>> out = new ArrayList<>();
        int limit = Math.min(filesNode.size(), 20);
        for (int i = 0; i < limit; i++) {
            JsonNode file = filesNode.get(i);
            Map<String, Object> row = new LinkedHashMap<>();
            putIfPresent(row, "key", textOrNull(file.path("key")));
            putIfPresent(row, "size", file.path("size").isNumber() ? file.path("size").asLong() : null);
            putIfPresent(row, "uri", textOrNull(file.path("uri")));
            putIfPresent(row, "checksum", textOrNull(file.path("checksum")));
            if (!row.isEmpty()) {
                out.add(row);
            }
        }
        return out;
    }

    private static void putIfPresent(Map<String, Object> map, String key, Object value) {
        if (value != null && (!(value instanceof String s) || StringUtils.hasText(s))) {
            map.put(key, value);
        }
    }

    private static List<String> stringList(JsonNode node) {
        if (node.isArray()) {
            List<String> out = new ArrayList<>();
            node.forEach(n -> {
                String v = n.isTextual() ? n.asText() : textOrNull(n);
                if (StringUtils.hasText(v)) {
                    out.add(v.trim());
                }
            });
            return out;
        }
        String single = textOrNull(node);
        return StringUtils.hasText(single) ? List.of(single) : List.of();
    }

    private static String formatCollisionEnergy(JsonNode node) {
        if (node.isArray() && !node.isEmpty()) {
            return textOrNull(node.get(0));
        }
        return textOrNull(node);
    }

    private static String formatCollisionType(JsonNode node) {
        if (node.isArray() && !node.isEmpty()) {
            List<String> parts = stringList(node);
            return parts.isEmpty() ? null : String.join(", ", parts);
        }
        return textOrNull(node);
    }

    private static String formatType(JsonNode typeNode) {
        if (typeNode.isMissingNode() || typeNode.isNull()) {
            return null;
        }
        if (typeNode.isTextual()) {
            return typeNode.asText();
        }
        String primary = textOrNull(typeNode.path("primary"));
        String secondary = textOrNull(typeNode.path("secondary"));
        if (typeNode.path("secondary").isArray() && !typeNode.path("secondary").isEmpty()) {
            secondary = typeNode.path("secondary").get(0).asText(null);
        }
        if (StringUtils.hasText(primary) && StringUtils.hasText(secondary)) {
            return primary + " / " + secondary;
        }
        return Optional.ofNullable(primary).orElse(secondary);
    }

    private static long parseRecidFromId(String id) {
        if (!StringUtils.hasText(id)) {
            return 0;
        }
        try {
            return Long.parseLong(id.trim());
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
