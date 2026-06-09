package com.pat.config;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.annotation.PostConstruct;
import org.springframework.core.io.ClassPathResource;
import org.springframework.stereotype.Component;

import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * Sanitized {@code PATTOOL_PARAMS.PARAM.*} keys that have a curated French description in i18n.
 */
@Component
public class PatToolParameterI18nCatalog {

    private static final List<String> I18N_RESOURCE_PATHS = List.of(
            "static/assets/i18n/fr.json",
            "assets/i18n/fr.json"
    );

    private final ObjectMapper objectMapper;
    private Set<String> documentedSanitizedKeys = Set.of();

    public PatToolParameterI18nCatalog(ObjectMapper objectMapper) {
        this.objectMapper = objectMapper;
    }

    @PostConstruct
    void load() {
        Set<String> keys = new HashSet<>();
        for (String path : I18N_RESOURCE_PATHS) {
            if (loadFromClasspath(path, keys)) {
                break;
            }
        }
        if (keys.isEmpty()) {
            loadFromFilesystem(keys);
        }
        documentedSanitizedKeys = Set.copyOf(keys);
    }

    public boolean hasCuratedDescription(String propertyKey) {
        if (propertyKey == null || propertyKey.isBlank()) {
            return false;
        }
        return documentedSanitizedKeys.contains(sanitize(propertyKey));
    }

    public static String sanitize(String propertyKey) {
        return propertyKey.replace('.', '_').replace('-', '_');
    }

    private boolean loadFromClasspath(String path, Set<String> keys) {
        ClassPathResource resource = new ClassPathResource(path);
        if (!resource.exists()) {
            return false;
        }
        try (InputStream input = resource.getInputStream()) {
            return loadParamKeys(objectMapper.readTree(input), keys);
        } catch (Exception ex) {
            return false;
        }
    }

    private void loadFromFilesystem(Set<String> keys) {
        String userDir = System.getProperty("user.dir", ".");
        List<Path> candidates = List.of(
                Path.of(userDir, "PatTool_Front-End", "src", "assets", "i18n", "fr.json"),
                Path.of(userDir).resolve("..").resolve("PatTool_Front-End").resolve("src")
                        .resolve("assets").resolve("i18n").resolve("fr.json").normalize()
        );
        for (Path candidate : candidates) {
            if (!Files.isRegularFile(candidate)) {
                continue;
            }
            try (InputStream input = Files.newInputStream(candidate)) {
                if (loadParamKeys(objectMapper.readTree(input), keys)) {
                    return;
                }
            } catch (Exception ex) {
                /* try next */
            }
        }
    }

    private boolean loadParamKeys(JsonNode root, Set<String> keys) {
        JsonNode param = root.path("PATTOOL_PARAMS").path("PARAM");
        if (!param.isObject()) {
            return false;
        }
        param.fieldNames().forEachRemaining(keys::add);
        return !keys.isEmpty();
    }
}
