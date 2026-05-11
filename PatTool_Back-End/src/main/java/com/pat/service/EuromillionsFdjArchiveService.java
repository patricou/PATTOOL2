package com.pat.service;

import com.pat.controller.dto.EuromillionsSyncResultDto;
import org.jsoup.Jsoup;
import org.jsoup.nodes.Document;
import org.jsoup.nodes.Element;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.web.client.RestTemplateBuilder;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.stereotype.Service;
import org.springframework.web.client.RestTemplate;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

/**
 * Télécharge l’archive ZIP « de février 2020 » depuis la page FDJ historique,
 * extrait les {@code *.csv} dans {@code euromillions.import.directory}, puis enchaîne l’import Mongo.
 */
@Service
public class EuromillionsFdjArchiveService {

    private static final Logger log = LoggerFactory.getLogger(EuromillionsFdjArchiveService.class);

    private final RestTemplate restTemplate;
    private final EuromillionsCsvImportService csvImportService;
    private final String historiqueUrl;
    /** Attribut HTML {@code download} sur fdj.fr (ex. {@code euromillions_202002} = début févr. 2020). */
    private final String downloadAnchor;

    public EuromillionsFdjArchiveService(
            RestTemplateBuilder restTemplateBuilder,
            EuromillionsCsvImportService csvImportService,
            @Value("${euromillions.fdj.historique-url:https://www.fdj.fr/jeux-de-tirage/euromillions-my-million/historique}")
                    String historiqueUrlRaw,
            @Value("${euromillions.fdj.archive-download-attribute:euromillions_202002}") String downloadAnchorRaw) {
        this.restTemplate = restTemplateBuilder
                .setConnectTimeout(Duration.ofSeconds(15))
                .setReadTimeout(Duration.ofSeconds(120))
                .build();
        this.csvImportService = csvImportService;
        this.historiqueUrl = historiqueUrlRaw == null ? "" : historiqueUrlRaw.trim();
        this.downloadAnchor = downloadAnchorRaw == null ? "" : downloadAnchorRaw.trim();
    }

    /**
     * Résout l’URL du ZIP sur fdj.fr, télécharge, extrait les CSV dans le dossier configuré, puis import Mongo.
     */
    public EuromillionsSyncResultDto fetchArchiveExtractAndImport() {
        List<String> prelude = new ArrayList<>();
        URI zipUri = resolveZipDownloadUri(prelude);
        byte[] zipBytes = downloadZip(zipUri);
        prelude.add("Archive ZIP téléchargée (" + zipBytes.length + " octets).");

        Path importDir = csvImportService.configuredImportDirectory();
        Path targetDir = importDir.toAbsolutePath().normalize();
        int extracted = unzipCsvOnly(zipBytes, targetDir, prelude);
        prelude.add(extracted + " fichier(s) .csv extrait(s) dans " + targetDir + ".");

        EuromillionsSyncResultDto csvResult = csvImportService.importFromConfiguredDirectory();
        List<String> merged = new ArrayList<>(prelude);
        merged.addAll(csvResult.getMessages());
        csvResult.setMessages(merged);
        return csvResult;
    }

    private URI resolveZipDownloadUri(List<String> prelude) {
        if (historiqueUrl.isBlank()) {
            throw new IllegalArgumentException("euromillions.fdj.historique-url vide.");
        }
        if (downloadAnchor.isBlank()) {
            throw new IllegalArgumentException("euromillions.fdj.archive-download-attribute vide.");
        }
        URI pageUri = URI.create(historiqueUrl);
        enforceAllowedFdjHost(pageUri, "page historique");

        HttpHeaders headers = browserHeadersForHtml();
        ResponseEntity<byte[]> htmlResp =
                restTemplate.exchange(pageUri, HttpMethod.GET, new HttpEntity<>(headers), byte[].class);
        byte[] body = htmlResp.getBody();
        if (body == null || body.length == 0) {
            throw new IllegalStateException("Réponse vide pour la page FDJ historique.");
        }
        String html = new String(body, StandardCharsets.UTF_8);
        Document doc = Jsoup.parse(html, historiqueUrl);

        Element anchor = doc.selectFirst("a[download=" + escapeCssAttribute(downloadAnchor) + "]");
        if (anchor == null) {
            anchor = findArchiveLinkByFeb2020Text(doc);
        }
        if (anchor == null) {
            throw new IllegalStateException(
                    "Impossible de trouver le lien d’archive FDJ (attendu download=\"" + downloadAnchor + "\").");
        }
        String href = anchor.absUrl("href");
        if (href == null || href.isBlank()) {
            throw new IllegalStateException("Lien d’archive FDJ sans URL (href vide).");
        }
        prelude.add("URL ZIP résolue : " + href);
        URI zipUri = URI.create(href);
        enforceAllowedFdjHost(zipUri, "archive ZIP");
        return zipUri;
    }

    private static Element findArchiveLinkByFeb2020Text(Document doc) {
        for (Element link : doc.select("a[href]")) {
            String href = link.attr("href");
            if (!href.contains("/documentations/")) {
                continue;
            }
            String haystack = (link.attr("title") + " " + link.attr("aria-label")).toLowerCase(Locale.FRENCH);
            // « février » avec ou sans accent
            if (haystack.contains("février 2020") || haystack.contains("fevrier 2020")) {
                return link;
            }
        }
        return null;
    }

    /** Échapper minimal pour sélecteur CSS {@code [download=…]}. */
    private static String escapeCssAttribute(String raw) {
        if (raw.chars().anyMatch(c -> !Character.isLetterOrDigit(c) && c != '_' && c != '-')) {
            throw new IllegalArgumentException("archive-download-attribute non supporté pour le sélecteur CSS.");
        }
        return raw;
    }

    private byte[] downloadZip(URI zipUri) {
        HttpHeaders headers = browserHeadersForZip();
        ResponseEntity<byte[]> r =
                restTemplate.exchange(zipUri, HttpMethod.GET, new HttpEntity<>(headers), byte[].class);
        byte[] zip = r.getBody();
        if (zip == null || zip.length == 0) {
            throw new IllegalStateException("ZIP FDJ vide.");
        }
        if (zip.length > 80 * 1024 * 1024) {
            throw new IllegalStateException("ZIP FDJ trop volumineux (limite sécurité 80 Mo).");
        }
        return zip;
    }

    private static int unzipCsvOnly(byte[] zipBytes, Path targetDir, List<String> prelude) {
        try {
            int count = 0;
            try (ZipInputStream zis = new ZipInputStream(new ByteArrayInputStream(zipBytes))) {
                ZipEntry entry;
                while ((entry = zis.getNextEntry()) != null) {
                    try {
                        if (entry.isDirectory()) {
                            continue;
                        }
                        String name = entry.getName().replace('\\', '/');
                        if (!name.toLowerCase(Locale.ROOT).endsWith(".csv")) {
                            continue;
                        }
                        String base = Path.of(name).getFileName().toString();
                        Path out = targetDir.resolve(base).normalize();
                        if (!out.startsWith(targetDir)) {
                            log.warn("Entrée ZIP ignorée (traversée de répertoire) : {}", entry.getName());
                            continue;
                        }
                        prelude.add("Extraction : " + base);
                        Files.copy(zis, out, StandardCopyOption.REPLACE_EXISTING);
                        count++;
                    } finally {
                        zis.closeEntry();
                    }
                }
            }
            return count;
        } catch (IOException e) {
            throw new IllegalArgumentException("Lecture / extraction ZIP FDJ impossible : " + e.getMessage());
        }
    }

    private static void enforceAllowedFdjHost(URI uri, String ctx) {
        String host = uri.getHost();
        if (host == null || host.isBlank()) {
            throw new IllegalArgumentException("URL invalide (" + ctx + ") : pas d’hôte");
        }
        String h = host.toLowerCase(Locale.ROOT);
        if (!(h.equals("fdj.fr") || h.endsWith(".fdj.fr"))) {
            throw new IllegalArgumentException("Hôte non autorisé pour " + ctx + " : " + host);
        }
    }

    private static HttpHeaders browserHeadersForHtml() {
        HttpHeaders h = new HttpHeaders();
        h.set(HttpHeaders.ACCEPT_LANGUAGE, "fr-FR,fr;q=0.9");
        h.set(HttpHeaders.USER_AGENT,
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 PatTool Eurom importer/1.0");
        h.setAccept(List.of(MediaType.TEXT_HTML, MediaType.APPLICATION_XML, MediaType.ALL));
        return h;
    }

    private static HttpHeaders browserHeadersForZip() {
        HttpHeaders h = new HttpHeaders();
        h.set(HttpHeaders.ACCEPT_LANGUAGE, "fr-FR,fr;q=0.9");
        h.set(HttpHeaders.USER_AGENT,
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 PatTool Eurom importer/1.0");
        h.setAccept(List.of(
                MediaType.parseMediaType("application/zip"),
                MediaType.APPLICATION_OCTET_STREAM,
                MediaType.ALL));
        return h;
    }
}
