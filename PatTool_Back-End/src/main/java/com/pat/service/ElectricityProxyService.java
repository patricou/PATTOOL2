package com.pat.service;

import com.pat.config.RestTemplateConfig;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.pat.controller.dto.ElectricityCountryNuclearDto;
import com.pat.controller.dto.ElectricityFrPlantDto;
import com.pat.controller.dto.ElectricityGenerationPointDto;
import com.pat.controller.dto.ElectricityNuclearPlantDto;
import com.pat.controller.dto.ElectricityOverviewDto;
import com.pat.controller.dto.ElectricityUnavailabilityDto;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.ResponseEntity;
import org.springframework.stereotype.Service;
import org.springframework.web.client.RestTemplate;
import org.springframework.web.util.UriComponentsBuilder;
import org.w3c.dom.Document;
import org.w3c.dom.Element;
import org.w3c.dom.NodeList;

import javax.xml.parsers.DocumentBuilderFactory;
import java.io.ByteArrayInputStream;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentMap;

/**
 * Proxy open data pour la page Électricité : ODRÉ éCO₂mix, EDF Open Data, GeoNuclearData,
 * ENTSO-E et EIA (optionnels via clés gratuites).
 */
@Service
public class ElectricityProxyService {

    private static final Logger log = LoggerFactory.getLogger(ElectricityProxyService.class);

    private static final long TTL_GENERATION_MS = 5 * 60_000L;
    private static final long TTL_PLANTS_MS = 24 * 60 * 60_000L;
    private static final long TTL_WORLD_MS = 7 * 24 * 60 * 60_000L;
    private static final long TTL_UNAVAIL_MS = 10 * 60_000L;
    private static final long TTL_OVERVIEW_MS = 5 * 60_000L;

    private static final String EDF_PLANTS_URL =
            "https://opendata.edf.fr/data-fair/api/v1/datasets/centrales-de-production-nucleaire-edf/lines";
    private static final String EDF_UNAVAIL_URL =
            "https://opendata.edf.fr/data-fair/api/v1/datasets/indisponibilites-des-moyens-de-production-edf-sa/lines";
    private static final String ODRE_ECO2MIX_URL =
            "https://odre.opendatasoft.com/api/explore/v2.1/catalog/datasets/eco2mix-national-tr/records";
    private static final String GEONUCLEAR_URL =
            "https://raw.githubusercontent.com/cristianst85/GeoNuclearData/master/data/json/denormalized/nuclear_power_plants.json";
    private static final String ENTSOE_API = "https://web-api.tp.entsoe.eu/api";
    private static final String EIA_FUEL_URL = "https://api.eia.gov/v2/electricity/rto/fuel-type-data/data/";

    private record CacheEntry<T>(T value, long expiresAt) {}

    private final RestTemplate restTemplate;
    private final ObjectMapper objectMapper;

    private final ConcurrentMap<String, CacheEntry<?>> cache = new ConcurrentHashMap<>();

    @Value("${app.electricity.entsoe-token:}")
    private String entsoeToken;

    @Value("${app.electricity.eia-api-key:}")
    private String eiaApiKey;

    public ElectricityProxyService(
            @Qualifier(RestTemplateConfig.ELECTRICITY_REST_TEMPLATE) RestTemplate restTemplate,
            ObjectMapper objectMapper) {
        this.restTemplate = restTemplate;
        this.objectMapper = objectMapper;
    }

    public ElectricityOverviewDto fetchOverview() {
        return getCached("overview", TTL_OVERVIEW_MS, this::buildOverview);
    }

    public List<ElectricityGenerationPointDto> fetchFrGeneration(int hours) {
        int safeHours = Math.max(1, Math.min(hours, 96));
        return getCached("fr-gen-" + safeHours, TTL_GENERATION_MS, () -> fetchFrGenerationUncached(safeHours));
    }

    public List<ElectricityFrPlantDto> fetchFrPlants() {
        return getCached("fr-plants", TTL_PLANTS_MS, this::fetchFrPlantsUncached);
    }

    public List<ElectricityUnavailabilityDto> fetchFrUnavailabilities(boolean activeOnly) {
        String key = "fr-unavail-" + activeOnly;
        return getCached(key, TTL_UNAVAIL_MS, () -> fetchFrUnavailabilitiesUncached(activeOnly));
    }

    public List<ElectricityNuclearPlantDto> fetchWorldNuclearPlants() {
        return getCached("world-nuclear", TTL_WORLD_MS, this::fetchWorldNuclearPlantsUncached);
    }

    public List<ElectricityCountryNuclearDto> fetchEuNuclear() {
        if (entsoeToken == null || entsoeToken.isBlank()) {
            return List.of();
        }
        return getCached("eu-nuclear", TTL_GENERATION_MS, this::fetchEuNuclearUncached);
    }

    public ElectricityCountryNuclearDto fetchUsNuclear() {
        if (eiaApiKey == null || eiaApiKey.isBlank()) {
            return null;
        }
        return getCached("us-nuclear", TTL_GENERATION_MS, this::fetchUsNuclearUncached);
    }

    public boolean isEntsoeConfigured() {
        return entsoeToken != null && !entsoeToken.isBlank();
    }

    public boolean isEiaConfigured() {
        return eiaApiKey != null && !eiaApiKey.isBlank();
    }

    @SuppressWarnings("unchecked")
    private <T> T getCached(String key, long ttlMs, java.util.function.Supplier<T> loader) {
        long now = System.currentTimeMillis();
        CacheEntry<?> entry = cache.get(key);
        if (entry != null && entry.expiresAt > now) {
            return (T) entry.value;
        }
        T value = loader.get();
        cache.put(key, new CacheEntry<>(value, now + ttlMs));
        return value;
    }

    private ElectricityOverviewDto buildOverview() {
        ElectricityOverviewDto dto = new ElectricityOverviewDto();
        dto.setUpdatedAt(Instant.now().toString());
        dto.setEntsoeConfigured(isEntsoeConfigured());
        dto.setEiaConfigured(isEiaConfigured());

        List<ElectricityGenerationPointDto> history = fetchFrGenerationUncached(24);
        dto.setFrHistory(history);
        if (!history.isEmpty()) {
            dto.setFrLatest(history.get(0));
        }

        List<ElectricityFrPlantDto> plants = fetchFrPlantsUncached();
        dto.setFrPlantCount(plants.size());
        dto.setFrInstalledNuclearMw(plants.stream()
                .mapToInt(p -> p.getPuissanceInstalleeMw() != null ? p.getPuissanceInstalleeMw() : 0)
                .sum());

        List<ElectricityUnavailabilityDto> unavail = fetchFrUnavailabilitiesUncached(true);
        dto.setFrActiveUnavailabilityCount(unavail.size());

        List<ElectricityNuclearPlantDto> world = fetchWorldNuclearPlantsUncached();
        dto.setWorldNuclearPlantCount(world.size());
        dto.setWorldOperationalCount((int) world.stream()
                .filter(p -> "Operational".equalsIgnoreCase(p.getStatus()))
                .count());

        if (isEntsoeConfigured()) {
            dto.setEuNuclear(fetchEuNuclearUncached());
        }
        if (isEiaConfigured()) {
            dto.setUsNuclear(fetchUsNuclearUncached());
        }
        return dto;
    }

    private List<ElectricityGenerationPointDto> fetchFrGenerationUncached(int hours) {
        int limit = Math.min(Math.max(hours * 4, 4), 384);
        // ODRÉ expects ODSQL in the where clause; use a pre-encoded URL (encode() double-escapes %20).
        String url = ODRE_ECO2MIX_URL
                + "?where=nucleaire%20is%20not%20null"
                + "&order_by=date_heure%20DESC"
                + "&limit=" + limit
                + "&select=date_heure,nucleaire,gaz,eolien,solaire,hydraulique,consommation,bioenergies,charbon,fioul,taux_co2";
        try {
            ResponseEntity<String> resp = restTemplate.getForEntity(URI.create(url), String.class);
            if (!resp.getStatusCode().is2xxSuccessful() || resp.getBody() == null) {
                return List.of();
            }
            JsonNode root = objectMapper.readTree(resp.getBody());
            JsonNode results = root.path("results");
            List<ElectricityGenerationPointDto> out = new ArrayList<>();
            if (results.isArray()) {
                for (JsonNode row : results) {
                    ElectricityGenerationPointDto p = mapOdrePoint(row);
                    if (p.getNucleaire() != null) {
                        out.add(p);
                    }
                }
            }
            return out;
        } catch (Exception e) {
            log.warn("ODRÉ éCO2mix fetch failed: {}", e.getMessage());
            return List.of();
        }
    }

    private ElectricityGenerationPointDto mapOdrePoint(JsonNode row) {
        ElectricityGenerationPointDto p = new ElectricityGenerationPointDto();
        p.setDatetime(textOrNull(row, "date_heure"));
        p.setNucleaire(intOrNull(row, "nucleaire"));
        p.setGaz(intOrNull(row, "gaz"));
        p.setEolien(intOrNull(row, "eolien"));
        p.setSolaire(intOrNull(row, "solaire"));
        p.setHydraulique(intOrNull(row, "hydraulique"));
        p.setConsommation(intOrNull(row, "consommation"));
        p.setBioenergies(intOrNull(row, "bioenergies"));
        p.setCharbon(intOrNull(row, "charbon"));
        p.setFioul(intOrNull(row, "fioul"));
        p.setTauxCo2(intOrNull(row, "taux_co2"));
        return p;
    }

    private List<ElectricityFrPlantDto> fetchFrPlantsUncached() {
        String url = UriComponentsBuilder.fromHttpUrl(EDF_PLANTS_URL)
                .queryParam("size", 100)
                .encode()
                .build()
                .toUriString();
        try {
            ResponseEntity<String> resp = restTemplate.getForEntity(URI.create(url), String.class);
            if (!resp.getStatusCode().is2xxSuccessful() || resp.getBody() == null) {
                return List.of();
            }
            JsonNode results = objectMapper.readTree(resp.getBody()).path("results");
            List<ElectricityFrPlantDto> out = new ArrayList<>();
            if (results.isArray()) {
                for (JsonNode row : results) {
                    ElectricityFrPlantDto p = new ElectricityFrPlantDto();
                    p.setCentrale(textOrNull(row, "centrale"));
                    p.setTranche(textOrNull(row, "tranche"));
                    p.setPuissanceInstalleeMw(intOrNull(row, "puissance_installee"));
                    p.setRegion(textOrNull(row, "region"));
                    p.setSousFiliere(textOrNull(row, "sous_filiere"));
                    p.setDateMiseEnService(textOrNull(row, "date_de_mise_en_service_industrielle"));
                    p.setCommune(textOrNull(row, "commune"));
                    parseGps(row.path("point_gps_wsg84").asText(null), p);
                    if (p.getLatitude() != null) {
                        out.add(p);
                    }
                }
            }
            return out;
        } catch (Exception e) {
            log.warn("EDF plants fetch failed: {}", e.getMessage());
            return List.of();
        }
    }

    private void parseGps(String gps, ElectricityFrPlantDto p) {
        if (gps == null || gps.isBlank()) {
            return;
        }
        String[] parts = gps.split(",");
        if (parts.length >= 2) {
            try {
                p.setLatitude(Double.parseDouble(parts[0].trim()));
                p.setLongitude(Double.parseDouble(parts[1].trim()));
            } catch (NumberFormatException ignored) {
                // skip invalid GPS
            }
        }
    }

    private List<ElectricityUnavailabilityDto> fetchFrUnavailabilitiesUncached(boolean activeOnly) {
        String url = EDF_UNAVAIL_URL + "?size=2000";
        try {
            ResponseEntity<String> resp = restTemplate.getForEntity(URI.create(url), String.class);
            if (!resp.getStatusCode().is2xxSuccessful() || resp.getBody() == null) {
                return List.of();
            }
            JsonNode results = objectMapper.readTree(resp.getBody()).path("results");
            List<ElectricityUnavailabilityDto> out = new ArrayList<>();
            if (results.isArray()) {
                for (JsonNode row : results) {
                    String filiere = textOrNull(row, "filiere");
                    if (filiere == null || !filiere.toLowerCase().contains("nucl")) {
                        continue;
                    }
                    String status = textOrNull(row, "status");
                    if (activeOnly && !"Active".equalsIgnoreCase(status)) {
                        continue;
                    }
                    ElectricityUnavailabilityDto u = new ElectricityUnavailabilityDto();
                    u.setIdentifiant(textOrNull(row, "identifiant"));
                    u.setNom(textOrNull(row, "nom"));
                    u.setFiliere(filiere);
                    u.setStatus(status);
                    u.setType(textOrNull(row, "type"));
                    u.setCause(textOrNull(row, "cause"));
                    u.setDateDebut(textOrNull(row, "date_de_debut"));
                    u.setDateFin(textOrNull(row, "date_de_fin"));
                    u.setPuissanceMaximaleMw(doubleOrNull(row, "puissance_maximale_mw"));
                    u.setPuissanceDisponibleMw(doubleOrNull(row, "puissance_disponible_mw"));
                    u.setInformationComplementaire(textOrNull(row, "information_complementaire"));
                    out.add(u);
                }
            }
            return out;
        } catch (Exception e) {
            log.warn("EDF unavailabilities fetch failed: {}", e.getMessage());
            return List.of();
        }
    }

    private List<ElectricityNuclearPlantDto> fetchWorldNuclearPlantsUncached() {
        try {
            ResponseEntity<String> resp = restTemplate.getForEntity(GEONUCLEAR_URL, String.class);
            if (!resp.getStatusCode().is2xxSuccessful() || resp.getBody() == null) {
                return List.of();
            }
            JsonNode array = objectMapper.readTree(resp.getBody());
            List<ElectricityNuclearPlantDto> out = new ArrayList<>();
            if (array.isArray()) {
                for (JsonNode row : array) {
                    ElectricityNuclearPlantDto p = new ElectricityNuclearPlantDto();
                    p.setId(row.path("Id").asInt(0));
                    p.setName(textOrNull(row, "Name"));
                    p.setCountry(textOrNull(row, "Country"));
                    p.setCountryCode(textOrNull(row, "CountryCode"));
                    p.setStatus(textOrNull(row, "Status"));
                    p.setReactorType(textOrNull(row, "ReactorType"));
                    p.setCapacityMw(intOrNull(row, "Capacity"));
                    if (row.hasNonNull("Latitude")) {
                        p.setLatitude(row.path("Latitude").asDouble());
                    }
                    if (row.hasNonNull("Longitude")) {
                        p.setLongitude(row.path("Longitude").asDouble());
                    }
                    p.setOperationalFrom(textOrNull(row, "OperationalFrom"));
                    p.setOperationalTo(textOrNull(row, "OperationalTo"));
                    if (p.getLatitude() != null && p.getLongitude() != null) {
                        out.add(p);
                    }
                }
            }
            return out;
        } catch (Exception e) {
            log.warn("GeoNuclearData fetch failed: {}", e.getMessage());
            return List.of();
        }
    }

    private static final Map<String, String> EU_EIC = new LinkedHashMap<>();
    static {
        EU_EIC.put("FR", "10YFR-RTE------C");
        EU_EIC.put("DE", "10Y1001A1001A83F");
        EU_EIC.put("ES", "10YES-REE------0");
        EU_EIC.put("GB", "10YGB----------A");
        EU_EIC.put("BE", "10YBE----------2");
        EU_EIC.put("CH", "10YCH-SWISSGRIDZ");
        EU_EIC.put("SE", "10YSE-1--------K");
        EU_EIC.put("FI", "10YFI-1--------U");
        EU_EIC.put("CZ", "10YCZ-CEPS-----N");
    }

    private static final Map<String, String> EU_NAMES = Map.of(
            "FR", "France", "DE", "Allemagne", "ES", "Espagne", "GB", "Royaume-Uni",
            "BE", "Belgique", "CH", "Suisse", "SE", "Suède", "FI", "Finlande", "CZ", "République tchèque"
    );

    private List<ElectricityCountryNuclearDto> fetchEuNuclearUncached() {
        List<ElectricityCountryNuclearDto> out = new ArrayList<>();
        Instant end = Instant.now();
        Instant start = end.minus(6, ChronoUnit.HOURS);
        DateTimeFormatter fmt = DateTimeFormatter.ofPattern("yyyyMMddHHmm").withZone(ZoneOffset.UTC);

        for (Map.Entry<String, String> e : EU_EIC.entrySet()) {
            ElectricityCountryNuclearDto country = fetchEntsoeNuclear(
                    e.getKey(), EU_NAMES.getOrDefault(e.getKey(), e.getKey()), e.getValue(),
                    fmt.format(start), fmt.format(end));
            if (country != null) {
                out.add(country);
            }
        }
        return out;
    }

    private ElectricityCountryNuclearDto fetchEntsoeNuclear(
            String code, String name, String eic, String periodStart, String periodEnd) {
        String url = UriComponentsBuilder.fromHttpUrl(ENTSOE_API)
                .queryParam("securityToken", entsoeToken.trim())
                .queryParam("documentType", "A75")
                .queryParam("processType", "A16")
                .queryParam("in_Domain", eic)
                .queryParam("psrType", "B14")
                .queryParam("periodStart", periodStart)
                .queryParam("periodEnd", periodEnd)
                .encode()
                .build()
                .toUriString();
        try {
            ResponseEntity<String> resp = restTemplate.getForEntity(URI.create(url), String.class);
            if (!resp.getStatusCode().is2xxSuccessful() || resp.getBody() == null || resp.getBody().isBlank()) {
                return null;
            }
            Integer mw = parseEntsoeLatestMw(resp.getBody());
            if (mw == null) {
                return null;
            }
            ElectricityCountryNuclearDto dto = new ElectricityCountryNuclearDto();
            dto.setCountryCode(code);
            dto.setCountryName(name);
            dto.setNuclearMw(mw);
            dto.setDatetime(Instant.now().toString());
            dto.setSource("ENTSO-E");
            return dto;
        } catch (Exception ex) {
            log.debug("ENTSO-E {} failed: {}", code, ex.getMessage());
            return null;
        }
    }

    private Integer parseEntsoeLatestMw(String xml) {
        try {
            DocumentBuilderFactory factory = DocumentBuilderFactory.newInstance();
            factory.setFeature("http://apache.org/xml/features/disallow-doctype-decl", true);
            factory.setNamespaceAware(true);
            Document doc = factory.newDocumentBuilder()
                    .parse(new ByteArrayInputStream(xml.getBytes(StandardCharsets.UTF_8)));
            NodeList points = doc.getElementsByTagName("Point");
            if (points.getLength() == 0) {
                return null;
            }
            Element last = (Element) points.item(points.getLength() - 1);
            String qty = textContent(last, "quantity");
            if (qty == null || qty.isBlank()) {
                return null;
            }
            return (int) Math.round(Double.parseDouble(qty.trim()));
        } catch (Exception e) {
            log.debug("ENTSO-E XML parse error: {}", e.getMessage());
            return null;
        }
    }

    private ElectricityCountryNuclearDto fetchUsNuclearUncached() {
        String url = UriComponentsBuilder.fromHttpUrl(EIA_FUEL_URL)
                .queryParam("api_key", eiaApiKey.trim())
                .queryParam("frequency", "hourly")
                .queryParam("data[0]", "value")
                .queryParam("facets[fueltype][]", "NUC")
                .queryParam("sort[0][column]", "period")
                .queryParam("sort[0][direction]", "desc")
                .queryParam("length", 1)
                .encode()
                .build()
                .toUriString();
        try {
            ResponseEntity<String> resp = restTemplate.getForEntity(URI.create(url), String.class);
            if (!resp.getStatusCode().is2xxSuccessful() || resp.getBody() == null) {
                return null;
            }
            JsonNode row = objectMapper.readTree(resp.getBody()).path("response").path("data").path(0);
            if (row.isMissingNode()) {
                return null;
            }
            ElectricityCountryNuclearDto dto = new ElectricityCountryNuclearDto();
            dto.setCountryCode("US");
            dto.setCountryName("États-Unis");
            dto.setDatetime(textOrNull(row, "period"));
            if (row.has("value")) {
                dto.setNuclearMw((int) Math.round(row.path("value").asDouble()));
            }
            dto.setSource("EIA");
            dto.setNote("Agrégat RTO/BA");
            return dto;
        } catch (Exception e) {
            log.warn("EIA nuclear fetch failed: {}", e.getMessage());
            return null;
        }
    }

    private static String textOrNull(JsonNode node, String field) {
        JsonNode v = node.path(field);
        if (v.isMissingNode() || v.isNull()) {
            return null;
        }
        String s = v.asText(null);
        return s != null && !s.isBlank() ? s : null;
    }

    private static Integer intOrNull(JsonNode node, String field) {
        JsonNode v = node.path(field);
        if (v.isMissingNode() || v.isNull()) {
            return null;
        }
        if (v.isNumber()) {
            return v.asInt();
        }
        try {
            return Integer.parseInt(v.asText().trim());
        } catch (NumberFormatException e) {
            return null;
        }
    }

    private static Double doubleOrNull(JsonNode node, String field) {
        JsonNode v = node.path(field);
        if (v.isMissingNode() || v.isNull()) {
            return null;
        }
        if (v.isNumber()) {
            return v.asDouble();
        }
        try {
            return Double.parseDouble(v.asText().trim());
        } catch (NumberFormatException e) {
            return null;
        }
    }

    private static String textContent(Element parent, String tag) {
        NodeList nodes = parent.getElementsByTagName(tag);
        if (nodes.getLength() == 0) {
            return null;
        }
        return nodes.item(0).getTextContent();
    }
}
