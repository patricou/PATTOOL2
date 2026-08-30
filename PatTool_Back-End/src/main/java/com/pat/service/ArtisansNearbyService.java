package com.pat.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.pat.config.RestTemplateConfig;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.stereotype.Service;
import org.springframework.util.StringUtils;
import org.springframework.web.client.RestClientException;
import org.springframework.web.client.RestTemplate;
import org.springframework.web.server.ResponseStatusException;
import org.springframework.web.util.UriComponentsBuilder;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.net.URI;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Nearby home-trade search: official SIRENE (Recherche d'entreprises) and OSM Overpass.
 * The browser never calls those APIs directly.
 */
@Service
public class ArtisansNearbyService {

    private static final Logger log = LoggerFactory.getLogger(ArtisansNearbyService.class);
    private static final String USER_AGENT = "PatTool/1.0 (artisans; https://www.patrickdeschamps.com)";
    private static final String SIRENE_BASE = "https://recherche-entreprises.api.gouv.fr";
    private static final String ANNUAIRE_ETAB = "https://annuaire-entreprises.data.gouv.fr/etablissement/";
    private static final int MAX_RADIUS_KM = 50;
    private static final int MAX_PER_PAGE = 100;
    private static final int DEFAULT_PER_PAGE = 100;
    private static final int SIRENE_PER_PAGE = 25;
    private static final int MAX_OSM_ITEMS = 100;
    private static final int MAX_OVERPASS_BYTES = 2 * 1024 * 1024;
    private static final Set<String> SOURCES = Set.of("sirene", "osm");
    private static final Pattern WIKIDATA_ID = Pattern.compile("Q\\d+", Pattern.CASE_INSENSITIVE);
    private static final Set<String> TRADES = Set.of(
            "all", "plumber", "electrician", "heating", "painter", "carpenter",
            "mason", "roofer", "locksmith", "tiler", "glazier", "gardener", "cleaner",
            "hairdresser", "baker", "butcher", "mechanic", "appliance",
            "supermarket", "grocery", "shop", "hardware", "clothing", "furniture",
            "florist", "pharmacy", "optician", "restaurant", "cafe", "hotel", "fuel"
    );

    private static final Map<String, String> SIRENE_NAF = new LinkedHashMap<>();
    private static final Map<String, String> OSM_FILTERS = new LinkedHashMap<>();

    static {
        SIRENE_NAF.put("plumber", "43.22A");
        SIRENE_NAF.put("electrician", "43.21A,43.21B");
        SIRENE_NAF.put("heating", "43.22B");
        SIRENE_NAF.put("painter", "43.34Z");
        SIRENE_NAF.put("carpenter", "43.32A,43.32B,16.23Z");
        SIRENE_NAF.put("mason", "43.99C,43.31Z");
        SIRENE_NAF.put("roofer", "43.91A,43.91B,43.99A");
        SIRENE_NAF.put("locksmith", "43.32B");
        SIRENE_NAF.put("gardener", "81.30Z");
        SIRENE_NAF.put("hairdresser", "96.02A");
        SIRENE_NAF.put("baker", "10.71C,10.71D,47.24Z");
        SIRENE_NAF.put("mechanic", "45.20A,45.20B");
        SIRENE_NAF.put("appliance", "95.21Z,47.54Z");
        SIRENE_NAF.put("tiler", "43.33Z");
        SIRENE_NAF.put("glazier", "23.12Z");
        SIRENE_NAF.put("cleaner", "81.21Z,81.22Z");
        SIRENE_NAF.put("butcher", "47.22Z");
        SIRENE_NAF.put("supermarket", "47.11A,47.11B,47.11C");
        SIRENE_NAF.put("grocery", "47.11D,47.11E,47.21Z,47.29Z");
        SIRENE_NAF.put("shop", "47.19A,47.19B");
        SIRENE_NAF.put("hardware", "47.52A,47.52B");
        SIRENE_NAF.put("clothing", "47.71Z");
        SIRENE_NAF.put("furniture", "47.59A");
        SIRENE_NAF.put("florist", "47.76Z");
        SIRENE_NAF.put("pharmacy", "47.73Z");
        SIRENE_NAF.put("optician", "47.78A");
        SIRENE_NAF.put("restaurant", "56.10A,56.10B,56.10C");
        SIRENE_NAF.put("cafe", "56.30Z");
        SIRENE_NAF.put("hotel", "55.10Z");
        SIRENE_NAF.put("fuel", "47.30Z");

        OSM_FILTERS.put("plumber", "nwr[\"craft\"~\"^(plumber|heating_engineer)$\"]");
        OSM_FILTERS.put("electrician", "nwr[\"craft\"=\"electrician\"]");
        OSM_FILTERS.put("heating", "nwr[\"craft\"~\"^(hvac|heating_engineer)$\"]");
        OSM_FILTERS.put("painter", "nwr[\"craft\"=\"painter\"]");
        OSM_FILTERS.put("carpenter", "nwr[\"craft\"~\"^(carpenter|joiner)$\"]");
        OSM_FILTERS.put("mason", "nwr[\"craft\"=\"mason\"]");
        OSM_FILTERS.put("roofer", "nwr[\"craft\"=\"roofer\"]");
        OSM_FILTERS.put("locksmith", "nwr[\"craft\"=\"locksmith\"];nwr[\"shop\"=\"locksmith\"]");
        OSM_FILTERS.put("tiler", "nwr[\"craft\"=\"tiler\"];nwr[\"shop\"=\"tile\"]");
        OSM_FILTERS.put("glazier", "nwr[\"craft\"=\"glazier\"]");
        OSM_FILTERS.put("gardener", "nwr[\"craft\"=\"gardener\"];nwr[\"shop\"=\"garden_centre\"]");
        OSM_FILTERS.put("cleaner", "nwr[\"craft\"=\"cleaner\"];nwr[\"shop\"=\"dry_cleaning\"]");
        OSM_FILTERS.put("hairdresser", "nwr[\"shop\"=\"hairdresser\"]");
        OSM_FILTERS.put("baker", "nwr[\"shop\"=\"bakery\"]");
        OSM_FILTERS.put("butcher", "nwr[\"shop\"=\"butcher\"]");
        OSM_FILTERS.put("mechanic", "nwr[\"shop\"=\"car_repair\"]");
        OSM_FILTERS.put("appliance", "nwr[\"shop\"=\"appliance\"];nwr[\"craft\"=\"electronics_repair\"]");
        OSM_FILTERS.put("supermarket", "nwr[\"shop\"~\"^(supermarket|hypermarket)$\"]");
        OSM_FILTERS.put("grocery", "nwr[\"shop\"~\"^(convenience|greengrocer|grocery)$\"]");
        OSM_FILTERS.put("shop", "nwr[\"shop\"~\"^(general|kiosk|variety_store|department_store|mall|gift|newsagent|books|toys|sports|jewelry|electronics)$\"]");
        OSM_FILTERS.put("hardware", "nwr[\"shop\"~\"^(doityourself|hardware)$\"]");
        OSM_FILTERS.put("clothing", "nwr[\"shop\"~\"^(clothes|shoes)$\"]");
        OSM_FILTERS.put("furniture", "nwr[\"shop\"=\"furniture\"]");
        OSM_FILTERS.put("florist", "nwr[\"shop\"=\"florist\"]");
        OSM_FILTERS.put("pharmacy", "nwr[\"amenity\"=\"pharmacy\"];nwr[\"shop\"=\"chemist\"]");
        OSM_FILTERS.put("optician", "nwr[\"shop\"=\"optician\"]");
        OSM_FILTERS.put("restaurant", "nwr[\"amenity\"~\"^(restaurant|fast_food)$\"]");
        OSM_FILTERS.put("cafe", "nwr[\"amenity\"~\"^(cafe|bar|pub)$\"]");
        OSM_FILTERS.put("hotel", "nwr[\"tourism\"=\"hotel\"]");
        OSM_FILTERS.put("fuel", "nwr[\"amenity\"=\"fuel\"]");
        OSM_FILTERS.put("all",
                "node[\"shop\"];node[\"craft\"];node[\"amenity\"~\"^(restaurant|cafe|fast_food|bar|pub|pharmacy|fuel)$\"];node[\"tourism\"=\"hotel\"]");
    }

    /** Libellés INSEE NAF 2008 (et quelques codes NAF 2025) pour les métiers maison. */
    private static final Map<String, String> NAF_LABELS = new LinkedHashMap<>();
    private static final Map<String, String> NAF_TRADE = new LinkedHashMap<>();
    private static final Map<String, String> OSM_LABELS = new LinkedHashMap<>();
    private static final Map<String, String> OSM_TRADE = new LinkedHashMap<>();

    static {
        putNaf("41.20A", "Construction de maisons individuelles", "mason");
        putNaf("41.20B", "Construction d'autres bâtiments", "mason");
        putNaf("43.11Z", "Démolition", "mason");
        putNaf("43.12A", "Terrassement", "mason");
        putNaf("43.12B", "Terrassement spécialisé", "mason");
        putNaf("43.13Z", "Forages et sondages", "mason");
        putNaf("43.21A", "Installation électrique", "electrician");
        putNaf("43.21B", "Installation électrique voirie", "electrician");
        putNaf("43.22A", "Plomberie / eau et gaz", "plumber");
        putNaf("43.22B", "Chauffage et climatisation", "heating");
        putNaf("43.29A", "Isolation", "roofer");
        putNaf("43.29B", "Autres installations (bâtiment)", "electrician");
        putNaf("43.31Z", "Plâtrerie", "mason");
        putNaf("43.32A", "Menuiserie bois et PVC", "carpenter");
        putNaf("43.32B", "Menuiserie métallique et serrurerie", "locksmith");
        putNaf("43.32C", "Agencement de lieux de vente", "carpenter");
        putNaf("43.33Z", "Revêtement des sols et murs", "tiler");
        putNaf("43.34Z", "Peinture et vitrerie", "painter");
        putNaf("43.39Z", "Autres travaux de finition", "painter");
        putNaf("43.91A", "Charpente", "roofer");
        putNaf("43.91B", "Couverture", "roofer");
        putNaf("43.99A", "Étanchéité", "roofer");
        putNaf("43.99B", "Montage de structures métalliques", "locksmith");
        putNaf("43.99C", "Maçonnerie et gros œuvre", "mason");
        putNaf("43.99D", "Travaux spécialisés de construction", "mason");
        putNaf("43.99E", "Location de matériel de chantier", "mason");
        putNaf("16.23Z", "Fabrication de charpentes et menuiseries", "carpenter");
        putNaf("25.12Z", "Portes et fenêtres en métal", "locksmith");
        putNaf("31.09B", "Fabrication d'autres meubles", "carpenter");
        putNaf("45.20A", "Réparation de véhicules légers", "mechanic");
        putNaf("45.20B", "Réparation d'autres véhicules", "mechanic");
        putNaf("81.21Z", "Nettoyage de bâtiments", "cleaner");
        putNaf("81.22Z", "Nettoyage industriel / bâtiments", "cleaner");
        putNaf("81.30Z", "Aménagement paysager", "gardener");
        putNaf("95.21Z", "Réparation d'électroménager", "appliance");
        putNaf("95.22Z", "Réparation de chaussures et cuir", "");
        putNaf("95.29Z", "Réparation d'autres biens personnels", "appliance");
        putNaf("96.02A", "Coiffure", "hairdresser");
        putNaf("96.02B", "Soins de beauté", "hairdresser");
        putNaf("10.71C", "Boulangerie-pâtisserie", "baker");
        putNaf("10.71D", "Pâtisserie", "baker");
        putNaf("23.12Z", "Façonnage et transformation du verre", "glazier");
        putNaf("47.11A", "Hypermarchés", "supermarket");
        putNaf("47.11B", "Supermarchés", "supermarket");
        putNaf("47.11C", "Magasins multi-commerces", "supermarket");
        putNaf("47.11D", "Mini-marchés", "grocery");
        putNaf("47.11E", "Commerce d'alimentation générale", "grocery");
        putNaf("47.19A", "Grands magasins", "shop");
        putNaf("47.19B", "Autres commerces non spécialisés", "shop");
        putNaf("47.21Z", "Commerce de fruits et légumes", "grocery");
        putNaf("47.22Z", "Commerce de viandes", "butcher");
        putNaf("47.24Z", "Commerce de pain et pâtisserie", "baker");
        putNaf("47.29Z", "Autres commerces alimentaires", "grocery");
        putNaf("47.30Z", "Commerce de carburants", "fuel");
        putNaf("47.52A", "Quincaillerie", "hardware");
        putNaf("47.52B", "Peintures et verres (bricolage)", "hardware");
        putNaf("47.54Z", "Commerce d'électroménager", "appliance");
        putNaf("47.59A", "Commerce de meubles", "furniture");
        putNaf("47.71Z", "Commerce d'habillement", "clothing");
        putNaf("47.73Z", "Pharmacie", "pharmacy");
        putNaf("47.76Z", "Commerce de fleurs", "florist");
        putNaf("47.78A", "Commerces d'optique", "optician");
        putNaf("55.10Z", "Hôtels et hébergement similaire", "hotel");
        putNaf("56.10A", "Restauration traditionnelle", "restaurant");
        putNaf("56.10B", "Cafétérias et autres libres-services", "restaurant");
        putNaf("56.10C", "Restauration rapide", "restaurant");
        putNaf("56.30Z", "Débits de boissons", "cafe");

        OSM_LABELS.put("plumber", "Plomberie");
        OSM_LABELS.put("heating_engineer", "Chauffage");
        OSM_LABELS.put("hvac", "Chauffage / climatisation");
        OSM_LABELS.put("electrician", "Électricité");
        OSM_LABELS.put("painter", "Peinture");
        OSM_LABELS.put("carpenter", "Menuiserie");
        OSM_LABELS.put("joiner", "Menuiserie");
        OSM_LABELS.put("mason", "Maçonnerie");
        OSM_LABELS.put("roofer", "Couverture");
        OSM_LABELS.put("locksmith", "Serrurerie");
        OSM_LABELS.put("gardener", "Paysagiste");
        OSM_LABELS.put("hairdresser", "Coiffure");
        OSM_LABELS.put("bakery", "Boulangerie");
        OSM_LABELS.put("car_repair", "Garage automobile");
        OSM_LABELS.put("appliance", "Électroménager");
        OSM_LABELS.put("electronics_repair", "Réparation électronique");
        OSM_LABELS.put("window_construction", "Menuiserie / fenêtres");
        OSM_LABELS.put("tiler", "Carrelage");
        OSM_LABELS.put("glazier", "Vitrerie");
        OSM_LABELS.put("cleaner", "Nettoyage");
        OSM_LABELS.put("butcher", "Boucherie");
        OSM_LABELS.put("greengrocer", "Fruits et légumes");
        OSM_LABELS.put("supermarket", "Supermarché");
        OSM_LABELS.put("hypermarket", "Hypermarché");
        OSM_LABELS.put("convenience", "Épicerie");
        OSM_LABELS.put("grocery", "Alimentation");
        OSM_LABELS.put("general", "Magasin");
        OSM_LABELS.put("department_store", "Grand magasin");
        OSM_LABELS.put("mall", "Centre commercial");
        OSM_LABELS.put("clothes", "Habillement");
        OSM_LABELS.put("shoes", "Chaussures");
        OSM_LABELS.put("furniture", "Meubles");
        OSM_LABELS.put("doityourself", "Bricolage");
        OSM_LABELS.put("hardware", "Quincaillerie");
        OSM_LABELS.put("florist", "Fleuriste");
        OSM_LABELS.put("chemist", "Pharmacie");
        OSM_LABELS.put("pharmacy", "Pharmacie");
        OSM_LABELS.put("optician", "Opticien");
        OSM_LABELS.put("restaurant", "Restaurant");
        OSM_LABELS.put("fast_food", "Restauration rapide");
        OSM_LABELS.put("cafe", "Café");
        OSM_LABELS.put("bar", "Bar");
        OSM_LABELS.put("pub", "Bar");
        OSM_LABELS.put("hotel", "Hôtel");
        OSM_LABELS.put("fuel", "Station-service");

        OSM_TRADE.put("plumber", "plumber");
        OSM_TRADE.put("heating_engineer", "heating");
        OSM_TRADE.put("hvac", "heating");
        OSM_TRADE.put("electrician", "electrician");
        OSM_TRADE.put("painter", "painter");
        OSM_TRADE.put("carpenter", "carpenter");
        OSM_TRADE.put("joiner", "carpenter");
        OSM_TRADE.put("mason", "mason");
        OSM_TRADE.put("roofer", "roofer");
        OSM_TRADE.put("locksmith", "locksmith");
        OSM_TRADE.put("gardener", "gardener");
        OSM_TRADE.put("hairdresser", "hairdresser");
        OSM_TRADE.put("bakery", "baker");
        OSM_TRADE.put("car_repair", "mechanic");
        OSM_TRADE.put("appliance", "appliance");
        OSM_TRADE.put("electronics_repair", "appliance");
        OSM_TRADE.put("tiler", "tiler");
        OSM_TRADE.put("glazier", "glazier");
        OSM_TRADE.put("cleaner", "cleaner");
        OSM_TRADE.put("butcher", "butcher");
        OSM_TRADE.put("greengrocer", "grocery");
        OSM_TRADE.put("supermarket", "supermarket");
        OSM_TRADE.put("hypermarket", "supermarket");
        OSM_TRADE.put("convenience", "grocery");
        OSM_TRADE.put("grocery", "grocery");
        OSM_TRADE.put("general", "shop");
        OSM_TRADE.put("kiosk", "shop");
        OSM_TRADE.put("variety_store", "shop");
        OSM_TRADE.put("department_store", "shop");
        OSM_TRADE.put("mall", "shop");
        OSM_TRADE.put("clothes", "clothing");
        OSM_TRADE.put("shoes", "clothing");
        OSM_TRADE.put("furniture", "furniture");
        OSM_TRADE.put("doityourself", "hardware");
        OSM_TRADE.put("hardware", "hardware");
        OSM_TRADE.put("florist", "florist");
        OSM_TRADE.put("chemist", "pharmacy");
        OSM_TRADE.put("pharmacy", "pharmacy");
        OSM_TRADE.put("optician", "optician");
        OSM_TRADE.put("restaurant", "restaurant");
        OSM_TRADE.put("fast_food", "restaurant");
        OSM_TRADE.put("cafe", "cafe");
        OSM_TRADE.put("bar", "cafe");
        OSM_TRADE.put("pub", "cafe");
        OSM_TRADE.put("hotel", "hotel");
        OSM_TRADE.put("fuel", "fuel");
    }

    private static void putNaf(String code, String label, String trade) {
        NAF_LABELS.put(code, label);
        NAF_TRADE.put(code, trade);
    }

    private final RestTemplate restTemplate;
    private final ObjectMapper objectMapper;
    private final FoncierGeoService foncierGeoService;
    private final List<String> overpassUrls;

    public ArtisansNearbyService(
            @Qualifier(RestTemplateConfig.ARTISANS_REST_TEMPLATE) RestTemplate restTemplate,
            ObjectMapper objectMapper,
            FoncierGeoService foncierGeoService,
            @Value("${artisans.overpass-urls:https://overpass.openstreetmap.fr/api/interpreter,https://overpass.osm.ch/api/interpreter,https://overpass-api.de/api/interpreter}")
                    String overpassUrlsCsv) {
        this.restTemplate = restTemplate;
        this.objectMapper = objectMapper;
        this.foncierGeoService = foncierGeoService;
        this.overpassUrls = parseCsv(overpassUrlsCsv);
    }

    public JsonNode nearby(
            String source,
            Double lat,
            Double lon,
            String address,
            Double radiusKm,
            String trade,
            Integer page,
            Integer perPage) {
        String src = normalizeSource(source);
        String job = normalizeTrade(trade);
        int pageN = page == null ? 1 : Math.max(1, page);
        int size = perPage == null ? DEFAULT_PER_PAGE : Math.max(1, Math.min(MAX_PER_PAGE, perPage));
        double radius = radiusKm == null ? 10.0 : Math.max(0.5, Math.min(MAX_RADIUS_KM, radiusKm));

        ResolvedPlace place = resolvePlace(lat, lon, address);

        if ("osm".equals(src)) {
            return searchOsm(place.lat, place.lon, radius, job, pageN, size, place.label);
        }
        return searchSirene(place.lat, place.lon, radius, job, pageN, size, place.label);
    }

    private ResolvedPlace resolvePlace(Double lat, Double lon, String address) {
        if (lat != null && lon != null && isFinite(lat) && isFinite(lon)) {
            String label = StringUtils.hasText(address)
                    ? address.trim()
                    : String.format(Locale.US, "%.5f, %.5f", lat, lon);
            return new ResolvedPlace(clamp(lat, -85, 85), normalizeLon(lon), label);
        }
        if (!StringUtils.hasText(address)) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "lat_lon_or_address_required");
        }
        ObjectNode hit = foncierGeoService.geocodeBan(address.trim(), null);
        if (hit == null || !hit.has("lat") || !hit.has("lon")) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "address_not_found");
        }
        String label = firstNonBlank(textOrEmpty(hit.get("label")), address.trim());
        return new ResolvedPlace(hit.get("lat").asDouble(), hit.get("lon").asDouble(), label);
    }

    private record ResolvedPlace(double lat, double lon, String label) {
    }

    private JsonNode searchSirene(
            double lat,
            double lon,
            double radiusKm,
            String trade,
            int page,
            int perPage,
            String placeLabel) {
        ObjectNode root = baseResult("sirene", lat, lon, radiusKm, trade, placeLabel);
        root.put("page", page);
        root.put("perPage", perPage);
        ArrayNode items = objectMapper.createArrayNode();
        root.set("items", items);
        int start = Math.max(0, (page - 1) * perPage);
        int firstSirenePage = start / SIRENE_PER_PAGE + 1;
        int lastSirenePage = Math.max(firstSirenePage, (start + perPage - 1) / SIRENE_PER_PAGE + 1);
        int skip = start % SIRENE_PER_PAGE;
        int total = 0;
        for (int sirenePage = firstSirenePage; sirenePage <= lastSirenePage && items.size() < perPage; sirenePage++) {
            JsonNode raw = fetchSireneNearPoint(lat, lon, radiusKm, trade, sirenePage, SIRENE_PER_PAGE);
            if (raw == null || !raw.isObject()) {
                break;
            }
            if (sirenePage == firstSirenePage) {
                total = raw.path("total_results").asInt(0);
            }
            JsonNode results = raw.get("results");
            if (results == null || !results.isArray() || results.size() == 0) {
                break;
            }
            for (JsonNode company : results) {
                if (sirenePage == firstSirenePage && skip > 0) {
                    skip--;
                    continue;
                }
                ObjectNode item = mapSirene(company, lat, lon, trade);
                if (item != null) {
                    items.add(item);
                }
                if (items.size() >= perPage) {
                    break;
                }
            }
        }
        root.put("total", total);
        return root;
    }

    private JsonNode fetchSireneNearPoint(
            double lat, double lon, double radiusKm, String trade, int page, int perPage) {
        UriComponentsBuilder builder = UriComponentsBuilder.fromHttpUrl(SIRENE_BASE + "/near_point")
                .queryParam("lat", String.format(Locale.US, "%.6f", lat))
                .queryParam("long", String.format(Locale.US, "%.6f", lon))
                .queryParam("radius", String.format(Locale.US, "%.2f", radiusKm))
                .queryParam("page", page)
                .queryParam("per_page", perPage);
        if ("all".equals(trade)) {
            builder.queryParam("activite_principale", String.join(",", SIRENE_NAF.values()));
        } else {
            builder.queryParam("activite_principale", SIRENE_NAF.get(trade));
        }
        return fetchJson(builder.build().encode().toUri(), "sirene near_point");
    }

    private ObjectNode mapSirene(JsonNode company, double originLat, double originLon, String trade) {
        if (company == null || !company.isObject()) {
            return null;
        }
        Set<String> wantedNaf = nafSetForTrade(trade);
        JsonNode etab = pickEstablishment(company, wantedNaf);
        if (etab == null) {
            return null;
        }
        Double elat = asDouble(etab.get("latitude"));
        Double elon = asDouble(etab.get("longitude"));
        if (elat == null || elon == null) {
            elat = asDouble(firstObject(company, "siege").get("latitude"));
            elon = asDouble(firstObject(company, "siege").get("longitude"));
        }
        if (elat == null || elon == null) {
            return null;
        }
        String name = firstNonBlank(
                textOrEmpty(company.get("nom_complet")),
                textOrEmpty(company.get("nom_raison_sociale")),
                textOrEmpty(etab.get("nom_commercial")),
                textOrEmpty(etab.get("enseigne")));
        if (!StringUtils.hasText(name)) {
            return null;
        }
        String companyNaf = firstNonBlank(
                textOrEmpty(company.get("activite_principale")),
                textOrEmpty(firstObject(company, "siege").get("activite_principale")));
        String etabNaf = firstNonBlank(
                textOrEmpty(etab.get("activite_principale")),
                textOrEmpty(etab.get("activite_principale_naf25")));
        if (!wantedNaf.isEmpty() && !nafMatches(etabNaf, wantedNaf) && !nafMatches(companyNaf, wantedNaf)) {
            return null;
        }
        String naf = !wantedNaf.isEmpty() && nafMatches(etabNaf, wantedNaf)
                ? etabNaf
                : firstNonBlank(
                        nafMatches(companyNaf, wantedNaf) ? companyNaf : "",
                        etabNaf,
                        companyNaf);
        String siret = firstNonBlank(textOrEmpty(etab.get("siret")), textOrEmpty(company.get("siren")));
        ObjectNode item = objectMapper.createObjectNode();
        item.put("id", StringUtils.hasText(siret) ? siret : name);
        item.put("name", name);
        String apiLabel = firstNonBlank(
                textOrEmpty(etab.get("libelle_activite_principale")),
                textOrEmpty(company.get("libelle_activite_principale")));
        item.put("activity", firstNonBlank(labelForNaf(naf), apiLabel, naf));
        item.put("activityCode", naf);
        String tradeKey = firstNonBlank(tradeForNaf(naf), "all".equals(trade) ? "" : trade);
        if (StringUtils.hasText(tradeKey) && !"all".equals(tradeKey)) {
            item.put("tradeKey", tradeKey);
        }
        item.put("address", firstNonBlank(
                textOrEmpty(etab.get("adresse")),
                textOrEmpty(etab.get("geo_adresse")),
                textOrEmpty(firstObject(company, "siege").get("adresse")),
                textOrEmpty(firstObject(company, "siege").get("geo_adresse"))));
        item.put("city", firstNonBlank(
                textOrEmpty(etab.get("libelle_commune")),
                textOrEmpty(firstObject(company, "siege").get("libelle_commune"))));
        item.put("postalCode", firstNonBlank(
                textOrEmpty(etab.get("code_postal")),
                textOrEmpty(firstObject(company, "siege").get("code_postal"))));
        item.put("lat", elat);
        item.put("lon", elon);
        item.put("distanceKm", round1(haversineKm(originLat, originLon, elat, elon)));
        if (StringUtils.hasText(siret) && siret.length() == 14) {
            item.put("url", ANNUAIRE_ETAB + siret);
        } else if (StringUtils.hasText(textOrEmpty(company.get("siren")))) {
            item.put("url", "https://annuaire-entreprises.data.gouv.fr/entreprise/" + company.get("siren").asText());
        }
        String website = normalizeWebsite(firstNonBlank(
                textOrEmpty(company.get("site_internet")),
                textOrEmpty(company.get("site_web")),
                textOrEmpty(company.get("website")),
                textOrEmpty(etab.get("site_internet")),
                textOrEmpty(etab.get("website")),
                textOrEmpty(firstObject(company, "complements").get("site_internet"))));
        if (StringUtils.hasText(website)) {
            item.put("website", website);
        }
        return item;
    }

    private JsonNode pickEstablishment(JsonNode company, Set<String> wantedNaf) {
        JsonNode matching = company.get("matching_etablissements");
        JsonNode fallback = null;
        if (matching != null && matching.isArray()) {
            for (JsonNode node : matching) {
                if (node == null || !node.isObject()
                        || "F".equalsIgnoreCase(textOrEmpty(node.get("etat_administratif")))) {
                    continue;
                }
                if (fallback == null) {
                    fallback = node;
                }
                String naf = firstNonBlank(
                        textOrEmpty(node.get("activite_principale")),
                        textOrEmpty(node.get("activite_principale_naf25")));
                if (nafMatches(naf, wantedNaf)) {
                    return node;
                }
            }
            if (fallback != null) {
                return fallback;
            }
            if (matching.size() > 0) {
                return matching.get(0);
            }
        }
        JsonNode siege = company.get("siege");
        return siege != null && siege.isObject() ? siege : null;
    }

    private static Set<String> nafSetForTrade(String trade) {
        if (!StringUtils.hasText(trade) || "all".equals(trade)) {
            return Set.of();
        }
        String csv = SIRENE_NAF.get(trade);
        if (!StringUtils.hasText(csv)) {
            return Set.of();
        }
        Set<String> out = new java.util.LinkedHashSet<>();
        for (String part : csv.split(",")) {
            String code = normalizeNaf(part);
            if (StringUtils.hasText(code)) {
                out.add(code);
            }
        }
        return out;
    }

    private static boolean nafMatches(String naf, Set<String> wanted) {
        if (wanted == null || wanted.isEmpty()) {
            return true;
        }
        String code = normalizeNaf(naf);
        return StringUtils.hasText(code) && wanted.contains(code);
    }

    private JsonNode searchOsm(
            double lat,
            double lon,
            double radiusKm,
            String trade,
            int page,
            int perPage,
            String placeLabel) {
        JsonNode raw = fetchOverpass(lat, lon, radiusKm, trade);
        List<ObjectNode> all = new ArrayList<>();
        if (raw != null) {
            JsonNode elements = raw.get("elements");
            if (elements != null && elements.isArray()) {
                for (JsonNode el : elements) {
                    ObjectNode item = mapOsm(el, lat, lon);
                    if (item != null) {
                        all.add(item);
                    }
                    if (all.size() >= MAX_OSM_ITEMS) {
                        break;
                    }
                }
            }
        }
        all.sort(Comparator.comparingDouble(n -> n.path("distanceKm").asDouble(999)));
        int from = Math.min((page - 1) * perPage, all.size());
        int to = Math.min(from + perPage, all.size());
        ObjectNode root = baseResult("osm", lat, lon, radiusKm, trade, placeLabel);
        root.put("page", page);
        root.put("perPage", perPage);
        root.put("total", all.size());
        ArrayNode items = objectMapper.createArrayNode();
        root.set("items", items);
        for (ObjectNode item : all.subList(from, to)) {
            items.add(item);
        }
        return root;
    }

    private ObjectNode mapOsm(JsonNode el, double originLat, double originLon) {
        if (el == null || !el.isObject()) {
            return null;
        }
        Double elat = asDouble(el.get("lat"));
        Double elon = asDouble(el.get("lon"));
        if (elat == null || elon == null) {
            JsonNode center = el.get("center");
            if (center != null && center.isObject()) {
                elat = asDouble(center.get("lat"));
                elon = asDouble(center.get("lon"));
            }
        }
        if (elat == null || elon == null) {
            return null;
        }
        JsonNode tags = el.get("tags");
        String name = tags != null ? firstNonBlank(
                textOrEmpty(tags.get("name")),
                textOrEmpty(tags.get("name:fr")),
                textOrEmpty(tags.get("operator")),
                textOrEmpty(tags.get("brand"))) : "";
        if (!StringUtils.hasText(name)) {
            return null;
        }
        String type = textOrEmpty(el.get("type"));
        long id = el.path("id").asLong(0);
        ObjectNode item = objectMapper.createObjectNode();
        item.put("id", type + "/" + id);
        item.put("name", name);
        String osmTag = tags != null ? firstNonBlank(
                textOrEmpty(tags.get("craft")),
                textOrEmpty(tags.get("shop")),
                textOrEmpty(tags.get("amenity")),
                textOrEmpty(tags.get("tourism")),
                textOrEmpty(tags.get("office"))) : "";
        item.put("activity", firstNonBlank(OSM_LABELS.get(osmTag), humanizeOsmTag(osmTag)));
        item.put("activityCode", osmTag);
        String tradeKey = OSM_TRADE.getOrDefault(osmTag, "");
        if (!StringUtils.hasText(tradeKey) && tags != null && StringUtils.hasText(textOrEmpty(tags.get("shop")))) {
            tradeKey = "shop";
        }
        if (StringUtils.hasText(tradeKey)) {
            item.put("tradeKey", tradeKey);
        }
        item.put("address", formatOsmAddress(tags));
        item.put("city", tags != null ? firstNonBlank(
                textOrEmpty(tags.get("addr:city")),
                textOrEmpty(tags.get("addr:municipality"))) : "");
        item.put("postalCode", tags != null ? textOrEmpty(tags.get("addr:postcode")) : "");
        item.put("lat", elat);
        item.put("lon", elon);
        item.put("distanceKm", round1(haversineKm(originLat, originLon, elat, elon)));
        if (id > 0 && ("node".equals(type) || "way".equals(type) || "relation".equals(type))) {
            item.put("url", "https://www.openstreetmap.org/" + type + "/" + id);
        }
        String phone = tags != null ? firstNonBlank(textOrEmpty(tags.get("phone")), textOrEmpty(tags.get("contact:phone"))) : "";
        if (StringUtils.hasText(phone)) {
            item.put("phone", phone);
        }
        String website = normalizeWebsite(tags != null ? firstNonBlank(
                textOrEmpty(tags.get("website")),
                textOrEmpty(tags.get("website:fr")),
                textOrEmpty(tags.get("contact:website")),
                textOrEmpty(tags.get("contact:url")),
                textOrEmpty(tags.get("brand:website")),
                textOrEmpty(tags.get("operator:website")),
                textOrEmpty(tags.get("mobile:website")),
                textOrEmpty(tags.get("url")),
                textOrEmpty(tags.get("website:en"))) : "");
        if (StringUtils.hasText(website)) {
            item.put("website", website);
        }
        String brand = tags != null ? textOrEmpty(tags.get("brand")) : "";
        if (StringUtils.hasText(brand)) {
            item.put("brand", brand);
        }
        String wikidata = normalizeWikidataId(tags != null ? textOrEmpty(tags.get("wikidata")) : "");
        if (StringUtils.hasText(wikidata)) {
            item.put("wikidata", wikidata);
        }
        String brandWikidata = normalizeWikidataId(tags != null ? textOrEmpty(tags.get("brand:wikidata")) : "");
        if (StringUtils.hasText(brandWikidata)) {
            item.put("brandWikidata", brandWikidata);
        }
        return item;
    }

    private static String formatOsmAddress(JsonNode tags) {
        if (tags == null || !tags.isObject()) {
            return "";
        }
        String street = firstNonBlank(textOrEmpty(tags.get("addr:housenumber")), "")
                + (StringUtils.hasText(textOrEmpty(tags.get("addr:housenumber"))) ? " " : "")
                + textOrEmpty(tags.get("addr:street"));
        return firstNonBlank(street.trim(), textOrEmpty(tags.get("addr:full")));
    }

    private JsonNode fetchOverpass(double lat, double lon, double radiusKm, String trade) {
        long around = Math.round(radiusKm * 1000);
        List<String> queries = new ArrayList<>();
        queries.add(buildOverpassQuery(OSM_FILTERS.getOrDefault(trade, OSM_FILTERS.get("all")), around, lat, lon));
        if ("all".equals(trade)) {
            queries.add(buildOverpassQuery("node[\"shop\"];node[\"craft\"]", around, lat, lon));
        }
        Exception last = null;
        for (String query : queries) {
            for (String url : overpassUrls) {
                try {
                    JsonNode parsed = postOverpass(url, query);
                    if (parsed != null) {
                        return parsed;
                    }
                } catch (Exception e) {
                    last = e;
                    log.warn("Overpass {} failed: {}", url, e.toString());
                }
            }
        }
        if (last != null) {
            log.warn("Overpass unavailable: {}", last.toString());
        }
        return null;
    }

    private static String buildOverpassQuery(String filters, long around, double lat, double lon) {
        StringBuilder union = new StringBuilder();
        for (String part : filters.split(";")) {
            String expr = part.trim();
            if (!expr.isEmpty()) {
                union.append("  ").append(expr)
                        .append(String.format(Locale.US, "(around:%d,%.5f,%.5f);\n", around, lat, lon));
            }
        }
        return "[out:json][timeout:20];\n(\n" + union + ");\nout tags center " + MAX_OSM_ITEMS + ";\n";
    }

    private JsonNode postOverpass(String url, String query) {
        HttpHeaders headers = new HttpHeaders();
        headers.set(HttpHeaders.USER_AGENT, USER_AGENT);
        headers.setContentType(MediaType.APPLICATION_FORM_URLENCODED);
        headers.setAccept(List.of(MediaType.APPLICATION_JSON));
        HttpEntity<String> entity = new HttpEntity<>(
                "data=" + URLEncoder.encode(query, StandardCharsets.UTF_8), headers);
        ResponseEntity<byte[]> response = restTemplate.exchange(url, HttpMethod.POST, entity, byte[].class);
        byte[] body = response.getBody();
        if (body == null || body.length == 0 || body.length > MAX_OVERPASS_BYTES) {
            return null;
        }
        try {
            return objectMapper.readTree(body);
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    private JsonNode fetchJson(URI uri, String what) {
        try {
            HttpHeaders headers = new HttpHeaders();
            headers.set(HttpHeaders.USER_AGENT, USER_AGENT);
            headers.setAccept(List.of(MediaType.APPLICATION_JSON));
            ResponseEntity<JsonNode> response = restTemplate.exchange(
                    uri, HttpMethod.GET, new HttpEntity<>(headers), JsonNode.class);
            return response.getBody();
        } catch (RestClientException e) {
            log.warn("Artisans {} failed: {}", what, e.toString());
            throw new ResponseStatusException(HttpStatus.BAD_GATEWAY, "sirene_unavailable", e);
        }
    }

    private ObjectNode baseResult(
            String source, double lat, double lon, double radiusKm, String trade, String placeLabel) {
        ObjectNode root = objectMapper.createObjectNode();
        root.put("source", source);
        root.put("lat", lat);
        root.put("lon", lon);
        root.put("radiusKm", radiusKm);
        root.put("trade", trade);
        if (StringUtils.hasText(placeLabel)) {
            root.put("placeLabel", placeLabel);
        }
        return root;
    }

    private static String normalizeSource(String source) {
        String value = source == null ? "sirene" : source.trim().toLowerCase(Locale.ROOT);
        if (!SOURCES.contains(value)) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "invalid_source");
        }
        return value;
    }

    private static String normalizeTrade(String trade) {
        String value = trade == null || trade.isBlank() ? "all" : trade.trim().toLowerCase(Locale.ROOT);
        if (!TRADES.contains(value)) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "invalid_trade");
        }
        return value;
    }

    static String labelForNaf(String code) {
        String naf = normalizeNaf(code);
        if (!StringUtils.hasText(naf)) {
            return "";
        }
        String exact = NAF_LABELS.get(naf);
        if (exact != null) {
            return exact;
        }
        if (naf.length() >= 5) {
            String prefix = naf.substring(0, 5);
            for (Map.Entry<String, String> e : NAF_LABELS.entrySet()) {
                if (e.getKey().startsWith(prefix)) {
                    return e.getValue();
                }
            }
        }
        if (naf.startsWith("43.21")) {
            return "Installation électrique";
        }
        if (naf.startsWith("43.22")) {
            return "Plomberie / chauffage";
        }
        if (naf.startsWith("43.3")) {
            return "Travaux de finition";
        }
        if (naf.startsWith("43.9")) {
            return "Gros œuvre / couverture";
        }
        if (naf.startsWith("43.")) {
            return "Travaux de bâtiment";
        }
        if (naf.startsWith("41.")) {
            return "Construction de bâtiments";
        }
        if (naf.startsWith("42.")) {
            return "Génie civil";
        }
        return "";
    }

    static String tradeForNaf(String code) {
        String naf = normalizeNaf(code);
        if (!StringUtils.hasText(naf)) {
            return "";
        }
        String exact = NAF_TRADE.get(naf);
        if (exact != null) {
            return exact;
        }
        if (naf.startsWith("43.21")) {
            return "electrician";
        }
        if (naf.startsWith("43.22A") || "43.22".equals(naf)) {
            return "plumber";
        }
        if (naf.startsWith("43.22")) {
            return "heating";
        }
        if (naf.startsWith("43.32B") || naf.startsWith("25.12")) {
            return "locksmith";
        }
        if (naf.startsWith("43.32")) {
            return "carpenter";
        }
        if (naf.startsWith("43.33")) {
            return "tiler";
        }
        if (naf.startsWith("43.34") || naf.startsWith("43.39")) {
            return "painter";
        }
        if (naf.startsWith("43.91") || naf.startsWith("43.99A") || naf.startsWith("43.29A")) {
            return "roofer";
        }
        if (naf.startsWith("43.99") || naf.startsWith("43.11") || naf.startsWith("43.12")
                || naf.startsWith("43.31") || naf.startsWith("41.")) {
            return "mason";
        }
        if (naf.startsWith("47.11A") || naf.startsWith("47.11B") || naf.startsWith("47.11C")) {
            return "supermarket";
        }
        if (naf.startsWith("47.11") || naf.startsWith("47.21") || naf.startsWith("47.29")) {
            return "grocery";
        }
        if (naf.startsWith("47.22")) {
            return "butcher";
        }
        if (naf.startsWith("47.24")) {
            return "baker";
        }
        if (naf.startsWith("47.30")) {
            return "fuel";
        }
        if (naf.startsWith("47.52")) {
            return "hardware";
        }
        if (naf.startsWith("47.59")) {
            return "furniture";
        }
        if (naf.startsWith("47.71") || naf.startsWith("47.72")) {
            return "clothing";
        }
        if (naf.startsWith("47.73")) {
            return "pharmacy";
        }
        if (naf.startsWith("47.76")) {
            return "florist";
        }
        if (naf.startsWith("47.78A")) {
            return "optician";
        }
        if (naf.startsWith("47.19") || naf.startsWith("47.")) {
            return "shop";
        }
        if (naf.startsWith("56.10")) {
            return "restaurant";
        }
        if (naf.startsWith("56.30") || naf.startsWith("56.2")) {
            return "cafe";
        }
        if (naf.startsWith("55.1")) {
            return "hotel";
        }
        if (naf.startsWith("81.21") || naf.startsWith("81.22")) {
            return "cleaner";
        }
        if (naf.startsWith("23.12")) {
            return "glazier";
        }
        return "";
    }

    private static String normalizeNaf(String code) {
        if (!StringUtils.hasText(code)) {
            return "";
        }
        return code.trim().toUpperCase(Locale.ROOT);
    }

    static String normalizeWebsite(String raw) {
        if (!StringUtils.hasText(raw)) {
            return "";
        }
        String value = raw.trim();
        if (value.startsWith("//")) {
            value = "https:" + value;
        } else if (!value.regionMatches(true, 0, "http://", 0, 7)
                && !value.regionMatches(true, 0, "https://", 0, 8)) {
            if (!value.contains(".") || value.contains(" ")) {
                return "";
            }
            value = "https://" + value;
        }
        try {
            URI uri = URI.create(value);
            String scheme = uri.getScheme();
            if (scheme == null
                    || (!"http".equalsIgnoreCase(scheme) && !"https".equalsIgnoreCase(scheme))
                    || !StringUtils.hasText(uri.getHost())) {
                return "";
            }
            if (isJunkWebsiteHost(uri.getHost())) {
                return "";
            }
            return value;
        } catch (IllegalArgumentException ignored) {
            return "";
        }
    }

    static String normalizeWikidataId(String raw) {
        if (!StringUtils.hasText(raw)) {
            return "";
        }
        Matcher matcher = WIKIDATA_ID.matcher(raw.trim());
        return matcher.find() ? matcher.group().toUpperCase(Locale.ROOT) : "";
    }

    static boolean isJunkWebsiteHost(String hostname) {
        if (!StringUtils.hasText(hostname)) {
            return true;
        }
        String host = hostname.toLowerCase(Locale.ROOT);
        if (host.startsWith("www.")) {
            host = host.substring(4);
        }
        return host.equals("facebook.com") || host.endsWith(".facebook.com")
                || host.equals("fb.com") || host.endsWith(".fb.com")
                || host.equals("fb.me")
                || host.equals("instagram.com") || host.endsWith(".instagram.com")
                || host.equals("twitter.com") || host.endsWith(".twitter.com")
                || host.equals("x.com") || host.endsWith(".x.com")
                || host.equals("tiktok.com") || host.endsWith(".tiktok.com")
                || host.equals("linkedin.com") || host.endsWith(".linkedin.com")
                || host.equals("youtube.com") || host.endsWith(".youtube.com")
                || host.equals("youtu.be")
                || host.equals("pagesjaunes.fr") || host.endsWith(".pagesjaunes.fr")
                || host.equals("pagesjaunes.ch") || host.endsWith(".pagesjaunes.ch")
                || host.equals("pagesdor.be") || host.endsWith(".pagesdor.be")
                || host.equals("local.ch") || host.endsWith(".local.ch")
                || host.contains("tripadvisor.")
                || host.contains("thefork.")
                || host.contains("lafourchette.")
                || host.equals("booking.com") || host.endsWith(".booking.com")
                || host.contains("yelp.")
                || host.contains("maps.google.")
                || host.equals("google.com") || host.endsWith(".google.com")
                || host.equals("google.fr") || host.endsWith(".google.fr")
                || host.equals("google.ch") || host.endsWith(".google.ch")
                || host.equals("googleusercontent.com") || host.endsWith(".googleusercontent.com")
                || host.equals("g.page") || host.endsWith(".g.page")
                || host.equals("business.site") || host.endsWith(".business.site")
                || host.equals("societe.com") || host.endsWith(".societe.com")
                || host.equals("pappers.fr") || host.endsWith(".pappers.fr")
                || host.equals("infogreffe.fr") || host.endsWith(".infogreffe.fr")
                || host.equals("annuaire-entreprises.data.gouv.fr")
                || host.contains("wikipedia.org")
                || host.contains("wikidata.org")
                || host.contains("openstreetmap.org")
                || host.equals("foursquare.com") || host.endsWith(".foursquare.com")
                || host.equals("laposte.fr") || host.endsWith(".laposte.fr")
                || host.equals("118000.fr") || host.endsWith(".118000.fr")
                || host.equals("118218.fr") || host.endsWith(".118218.fr")
                || host.equals("118712.fr") || host.endsWith(".118712.fr")
                || host.equals("horaires-commerces.fr") || host.endsWith(".horaires-commerces.fr")
                || host.equals("horaires.com") || host.endsWith(".horaires.com")
                || host.equals("justacote.com") || host.endsWith(".justacote.com")
                || host.equals("cylex.fr") || host.endsWith(".cylex.fr")
                || host.equals("cylex.com") || host.endsWith(".cylex.com")
                || host.equals("kompass.com") || host.endsWith(".kompass.com")
                || host.equals("verif.com") || host.endsWith(".verif.com")
                || host.equals("manageo.fr") || host.endsWith(".manageo.fr")
                || host.equals("score3.fr") || host.endsWith(".score3.fr")
                || host.equals("entreprises.lefigaro.fr")
                || host.equals("mappy.com") || host.endsWith(".mappy.com")
                || host.contains("viamichelin.")
                || host.equals("uneboulangerie.fr") || host.endsWith(".uneboulangerie.fr")
                || host.equals("petitfute.com") || host.endsWith(".petitfute.com")
                || host.equals("timeout.com") || host.endsWith(".timeout.com")
                || host.equals("le-codepostal.com") || host.endsWith(".le-codepostal.com");
    }

    private static String humanizeOsmTag(String tag) {
        if (!StringUtils.hasText(tag)) {
            return "";
        }
        return tag.replace('_', ' ').trim();
    }

    static double haversineKm(double lat1, double lon1, double lat2, double lon2) {
        double r = 6371.0;
        double dLat = Math.toRadians(lat2 - lat1);
        double dLon = Math.toRadians(lon2 - lon1);
        double a = Math.sin(dLat / 2) * Math.sin(dLat / 2)
                + Math.cos(Math.toRadians(lat1)) * Math.cos(Math.toRadians(lat2))
                * Math.sin(dLon / 2) * Math.sin(dLon / 2);
        return r * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }

    private static List<String> parseCsv(String csv) {
        if (!StringUtils.hasText(csv)) {
            return List.of("https://overpass-api.de/api/interpreter");
        }
        List<String> out = new ArrayList<>();
        for (String part : csv.split(",")) {
            String url = part.trim();
            if (StringUtils.hasText(url)) {
                out.add(url);
            }
        }
        return out.isEmpty() ? List.of("https://overpass-api.de/api/interpreter") : out;
    }

    private static JsonNode firstObject(JsonNode parent, String field) {
        JsonNode node = parent == null ? null : parent.get(field);
        return node != null && node.isObject() ? node : com.fasterxml.jackson.databind.node.MissingNode.getInstance();
    }

    private static Double asDouble(JsonNode node) {
        if (node == null || node.isNull() || node.isMissingNode()) {
            return null;
        }
        if (node.isNumber()) {
            return node.asDouble();
        }
        if (node.isTextual()) {
            try {
                return Double.parseDouble(node.asText().trim());
            } catch (NumberFormatException ignored) {
                return null;
            }
        }
        return null;
    }

    private static String textOrEmpty(JsonNode node) {
        return node != null && node.isTextual() ? node.asText() : "";
    }

    private static String firstNonBlank(String... values) {
        if (values == null) {
            return "";
        }
        for (String value : values) {
            if (StringUtils.hasText(value)) {
                return value;
            }
        }
        return "";
    }

    private static boolean isFinite(double value) {
        return !Double.isNaN(value) && !Double.isInfinite(value);
    }

    private static double clamp(double value, double min, double max) {
        return Math.max(min, Math.min(max, value));
    }

    private static double normalizeLon(double lon) {
        double x = lon % 360.0;
        if (x > 180) {
            x -= 360;
        }
        if (x < -180) {
            x += 360;
        }
        return x;
    }

    private static double round1(double value) {
        return Math.round(value * 10.0) / 10.0;
    }
}
