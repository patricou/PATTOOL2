package com.pat.service;

import com.pat.config.PatToolParameterCatalog;
import com.pat.config.PatToolParameterCatalog.ParameterDef;
import com.pat.config.PatToolParameterCatalog.SectionDef;
import com.pat.config.PatToolParameterCodeDefaults;
import com.pat.controller.dto.PatToolParameterItemDto;
import com.pat.controller.dto.PatToolParameterSectionDto;
import com.pat.controller.dto.PatToolParametersResponseDto;
import com.pat.repo.AppParameterRepository;
import com.pat.repo.domain.AppParameter;
import org.springframework.boot.context.properties.source.ConfigurationPropertyName;
import org.springframework.boot.context.properties.source.ConfigurationPropertySources;
import org.springframework.boot.context.properties.source.ConfigurationPropertySource;
import org.springframework.boot.context.properties.source.InvalidConfigurationPropertyNameException;
import org.springframework.core.env.AbstractEnvironment;
import org.springframework.core.env.EnumerablePropertySource;
import org.springframework.core.env.Environment;
import org.springframework.core.env.PropertySource;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Optional;
import java.util.Set;
import java.util.TreeSet;

/**
 * Builds the read-only PATTOOL Parameters snapshot for admins.
 */
@Service
public class PatToolParametersService {

    private static final String NOT_SET = "(not set)";
    private static final String CONFIGURED = "(configured)";
    private static final int MONGO_JSON_PREVIEW_MAX = 120;

    public static final String ORIGIN_MONGODB = "mongodb";
    public static final String ORIGIN_APPLICATION_PROPERTIES = "application_properties";
    public static final String ORIGIN_ENVIRONMENT = "environment";
    public static final String ORIGIN_COMMAND_LINE = "command_line";
    public static final String ORIGIN_CODE_DEFAULT = "code_default";
    public static final String ORIGIN_REQUIRED = "required";
    public static final String ORIGIN_NOT_CONFIGURED = "not_configured";

    private final Environment environment;
    private final AppParameterService appParameterService;
    private final AppParameterRepository appParameterRepository;
    private final PatToolParameterUsageIndexService usageIndexService;

    public PatToolParametersService(
            Environment environment,
            AppParameterService appParameterService,
            AppParameterRepository appParameterRepository,
            PatToolParameterUsageIndexService usageIndexService) {
        this.environment = environment;
        this.appParameterService = appParameterService;
        this.appParameterRepository = appParameterRepository;
        this.usageIndexService = usageIndexService;
    }

    public PatToolParametersResponseDto buildSnapshot() {
        List<PatToolParameterSectionDto> sections = new ArrayList<>();
        for (SectionDef section : PatToolParameterCatalog.SECTIONS) {
            List<PatToolParameterItemDto> items = section.parameters().stream()
                    .map(this::resolveCatalogItem)
                    .toList();
            sections.add(new PatToolParameterSectionDto(section.id(), section.labelKey(), items));
        }
        PatToolParameterSectionDto discovered = buildDiscoveredApplicationPropertiesSection();
        if (!discovered.items().isEmpty()) {
            sections.add(discovered);
        }
        sections.add(buildMongoRuntimeSection());
        int total = sections.stream().mapToInt(s -> s.items().size()).sum();
        return new PatToolParametersResponseDto(sections, total);
    }

    private PatToolParameterItemDto resolveCatalogItem(ParameterDef def) {
        boolean sensitive = def.sensitive() || PatToolParameterCatalog.isSensitiveKey(def.key());
        return resolveByKey(def.key(), def.description(), def.mongoOverride(), sensitive);
    }

    private PatToolParameterItemDto resolveByKey(String key, String description, boolean mongoOverride, boolean sensitive) {
        Optional<String> codeDefault = PatToolParameterCodeDefaults.codeDefault(key);

        if (mongoOverride) {
            Optional<String> mongo = appParameterService.find(key).map(AppParameter::getParamValue);
            if (mongo.isPresent() && !mongo.get().isBlank()) {
                String display = formatForDisplay(key, mongo.get(), sensitive);
                return new PatToolParameterItemDto(
                        key, display, description, ORIGIN_MONGODB,
                        formatCodeDefaultHint(codeDefault.orElse(null), sensitive), sensitive,
                        inferDescription(key));
            }
        }

        PropertyBinding binding = resolvePropertyBinding(key);
        String effectiveRaw = binding.raw();
        String origin = binding.origin();

        if (effectiveRaw == null && codeDefault.isPresent()) {
            effectiveRaw = codeDefault.get();
            origin = ORIGIN_CODE_DEFAULT;
        } else if (effectiveRaw == null) {
            origin = PatToolParameterCodeDefaults.isRequiredInProperties(key)
                    ? ORIGIN_REQUIRED
                    : ORIGIN_NOT_CONFIGURED;
        }

        String display = formatForDisplay(key, effectiveRaw, sensitive);
        String codeDefaultHint = formatCodeDefaultHint(codeDefault.orElse(null), sensitive);

        return new PatToolParameterItemDto(
                key, display, description, origin, codeDefaultHint, sensitive, inferDescription(key));
    }

    private String inferDescription(String key) {
        return usageIndexService.inferDescription(key).orElse(null);
    }

    /** Keys present in application.properties / yaml but not listed in the curated catalog. */
    private PatToolParameterSectionDto buildDiscoveredApplicationPropertiesSection() {
        Set<String> keys = new TreeSet<>(collectApplicationConfigPropertyKeys());
        List<PatToolParameterItemDto> items = keys.stream()
                .filter(key -> !PatToolParameterCatalog.CATALOG_KEYS.contains(key))
                .filter(key -> !PatToolParameterCatalog.isUserScopedMongoKey(key))
                .filter(this::isIncludedDiscoveredKey)
                .map(key -> resolveByKey(
                        key,
                        PatToolParameterCatalog.paramDescKey(key),
                        PatToolParameterCatalog.MONGO_OVERRIDE_KEYS.contains(key),
                        PatToolParameterCatalog.isSensitiveKey(key)))
                .toList();
        return new PatToolParameterSectionDto(
                "extra-properties",
                "PATTOOL_PARAMS.SECTION.EXTRA_PROPERTIES",
                items
        );
    }

    private Set<String> collectApplicationConfigPropertyKeys() {
        Set<String> keys = new LinkedHashSet<>();
        if (!(environment instanceof AbstractEnvironment abstractEnvironment)) {
            return keys;
        }
        for (PropertySource<?> propertySource : abstractEnvironment.getPropertySources()) {
            if (!isApplicationConfigPropertySource(propertySource.getName())) {
                continue;
            }
            if (propertySource instanceof EnumerablePropertySource<?> enumerable) {
                keys.addAll(Arrays.asList(enumerable.getPropertyNames()));
            }
        }
        return keys;
    }

    private static boolean isApplicationConfigPropertySource(String sourceName) {
        if (sourceName == null) {
            return false;
        }
        String lower = sourceName.toLowerCase();
        return lower.contains("application.properties")
                || lower.contains("application.yml")
                || lower.contains("application.yaml")
                || (lower.contains("config resource") && lower.contains("application"));
    }

    private boolean isIncludedDiscoveredKey(String key) {
        if (key == null || key.isBlank()) {
            return false;
        }
        if (key.startsWith("spring.autoconfigure.")
                || key.startsWith("logging.")
                || key.startsWith("management.")
                || key.startsWith("spring.jackson.")
                || key.startsWith("spring.main.")) {
            return false;
        }
        return PatToolParameterCatalog.isPatToolPropertyKey(key);
    }

    private PatToolParameterSectionDto buildMongoRuntimeSection() {
        List<PatToolParameterItemDto> items = appParameterRepository.findAll().stream()
                .filter(p -> p.getParamKey() != null)
                .filter(p -> !PatToolParameterCatalog.CATALOG_KEYS.contains(p.getParamKey()))
                .filter(p -> !PatToolParameterCatalog.isUserScopedMongoKey(p.getParamKey()))
                .sorted(Comparator.comparing(AppParameter::getParamKey))
                .map(this::toMongoRuntimeItem)
                .toList();
        return new PatToolParameterSectionDto(
                "mongodb-runtime",
                "PATTOOL_PARAMS.SECTION.MONGODB_RUNTIME",
                items
        );
    }

    private PatToolParameterItemDto toMongoRuntimeItem(AppParameter entity) {
        String key = entity.getParamKey();
        boolean sensitive = PatToolParameterCatalog.isSensitiveKey(key)
                || (entity.getValueType() != null && entity.getValueType().contains("JSON")
                && key.toLowerCase().contains("email"));
        String raw = entity.getParamValue();
        String display = formatMongoRuntimeValue(key, raw, entity.getValueType(), sensitive);
        String description = entity.getDescription() != null && !entity.getDescription().isBlank()
                ? entity.getDescription()
                : PatToolParameterCatalog.paramDescKey(key);
        return new PatToolParameterItemDto(
                key, display, description, ORIGIN_MONGODB, null, sensitive, inferDescription(key));
    }

    private PropertyBinding resolvePropertyBinding(String key) {
        if (environment instanceof AbstractEnvironment abstractEnvironment) {
            PropertyBinding fromConfigSources = resolveFromConfigurationPropertySources(abstractEnvironment, key);
            if (fromConfigSources != null) {
                return fromConfigSources;
            }

            PropertyBinding fromEnumerable = resolveFromEnumerablePropertySources(abstractEnvironment, key);
            if (fromEnumerable != null) {
                return fromEnumerable;
            }
        }

        String value = environment.getProperty(key);
        if (value != null) {
            // Value resolved by Spring but source not identified — typical for application.properties.
            return new PropertyBinding(value, ORIGIN_APPLICATION_PROPERTIES);
        }
        return new PropertyBinding(null, ORIGIN_NOT_CONFIGURED);
    }

    private PropertyBinding resolveFromConfigurationPropertySources(AbstractEnvironment environment, String key) {
        final ConfigurationPropertyName configName;
        try {
            configName = ConfigurationPropertyName.of(key);
        } catch (InvalidConfigurationPropertyNameException ex) {
            // Legacy keys such as app.maxContextSize are valid in .properties but not in relaxed binding.
            return null;
        }
        for (ConfigurationPropertySource source : ConfigurationPropertySources.get(environment)) {
            var property = source.getConfigurationProperty(configName);
            if (property == null || property.getValue() == null) {
                continue;
            }
            String sourceName = resolveUnderlyingSourceName(source);
            return new PropertyBinding(property.getValue().toString(), mapPropertySourceName(sourceName));
        }
        return null;
    }

    private PropertyBinding resolveFromEnumerablePropertySources(AbstractEnvironment environment, String key) {
        for (PropertySource<?> propertySource : environment.getPropertySources()) {
            if (propertySource instanceof EnumerablePropertySource<?> enumerable) {
                if (!Arrays.asList(enumerable.getPropertyNames()).contains(key)) {
                    continue;
                }
            } else if (!propertySource.containsProperty(key)) {
                continue;
            }
            Object raw = propertySource.getProperty(key);
            if (raw == null) {
                continue;
            }
            return new PropertyBinding(raw.toString(), mapPropertySourceName(propertySource.getName()));
        }
        return null;
    }

    private static String resolveUnderlyingSourceName(ConfigurationPropertySource source) {
        Object underlying = source.getUnderlyingSource();
        if (underlying instanceof PropertySource<?> propertySource) {
            return propertySource.getName();
        }
        return underlying != null ? underlying.toString() : "";
    }

    private static String mapPropertySourceName(String sourceName) {
        if (sourceName == null) {
            return ORIGIN_NOT_CONFIGURED;
        }
        String lower = sourceName.toLowerCase();
        if (lower.contains("application.properties")
                || lower.contains("application-")
                || lower.contains("config resource")
                || lower.contains("classpath")) {
            return ORIGIN_APPLICATION_PROPERTIES;
        }
        if (lower.contains("systemenvironment") || lower.equals("systemenvironment")) {
            return ORIGIN_ENVIRONMENT;
        }
        if (lower.contains("commandline") || lower.contains("command line")) {
            return ORIGIN_COMMAND_LINE;
        }
        if (lower.contains("systemproperties")) {
            return ORIGIN_ENVIRONMENT;
        }
        return ORIGIN_APPLICATION_PROPERTIES;
    }

    private String formatForDisplay(String key, String raw, boolean sensitive) {
        if (sensitive) {
            return isBlank(raw) ? NOT_SET : CONFIGURED;
        }
        if (isBlank(raw)) {
            return NOT_SET;
        }
        if ("spring.data.mongodb.uri".equals(key)) {
            return maskMongoUri(raw);
        }
        return raw;
    }

    private String formatMongoRuntimeValue(String key, String raw, String valueType, boolean sensitive) {
        if (sensitive) {
            return isBlank(raw) ? NOT_SET : CONFIGURED;
        }
        if (isBlank(raw)) {
            return NOT_SET;
        }
        if (AppParameter.TYPE_JSON.equals(valueType) && raw.length() > MONGO_JSON_PREVIEW_MAX) {
            return raw.substring(0, MONGO_JSON_PREVIEW_MAX) + "… (" + raw.length() + " chars)";
        }
        if (key.toLowerCase().contains("email") && raw.contains("@")) {
            return CONFIGURED;
        }
        return raw;
    }

    private static String maskMongoUri(String uri) {
        return uri.replaceAll("://([^:@/]+):([^@/]+)@", "://$1:***@");
    }

    private static boolean isBlank(String value) {
        return value == null || value.isBlank();
    }

    private static String formatCodeDefaultHint(String codeDefault, boolean sensitive) {
        if (codeDefault == null) {
            return null;
        }
        if (sensitive) {
            return codeDefault.isBlank() ? "(empty)" : CONFIGURED;
        }
        return codeDefault.isBlank() ? "(empty)" : codeDefault;
    }

    private record PropertyBinding(String raw, String origin) {}
}
