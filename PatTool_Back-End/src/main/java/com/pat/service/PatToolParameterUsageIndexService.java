package com.pat.service;

import com.pat.config.PatToolParameterCodeDefaults;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Stream;

/**
 * Scans PatTool Java sources to infer how configuration keys are used when no curated i18n
 * description exists.
 */
@Service
public class PatToolParameterUsageIndexService {

    private static final Pattern VALUE_KEY = Pattern.compile("@Value\\(\"\\$\\{([^}:\"]+)");
    private static final Pattern GET_PROPERTY = Pattern.compile("getProperty\\(\\s*\"([^\"]+)\"");
    private static final Pattern CONFIG_PREFIX = Pattern.compile("@ConfigurationProperties\\(\\s*prefix\\s*=\\s*\"([^\"]+)\"");
    private static final Pattern CLASS_NAME = Pattern.compile("(?:public\\s+)?class\\s+(\\w+)");
    private static final Pattern PRIVATE_FIELD = Pattern.compile("private\\s+\\S+\\s+(\\w+)\\s*[;=]");
    private static final Pattern MEMBER_AFTER_VALUE = Pattern.compile(
            "(?:private\\s+\\S+\\s+|\\()\\s*(\\w+)\\s*(?:[,)=;]|\\))");

    private volatile Map<String, List<Usage>> index;
    private volatile boolean indexed;

    public Optional<String> inferDescription(String key) {
        if (key == null || key.isBlank()) {
            return Optional.empty();
        }
        ensureIndexed();
        List<Usage> usages = index.getOrDefault(key, List.of());
        if (usages.isEmpty()) {
            return inferWhenNotReferenced(key);
        }
        return Optional.of(formatUsages(usages));
    }

    private Optional<String> inferWhenNotReferenced(String key) {
        Optional<String> codeDefault = PatToolParameterCodeDefaults.codeDefault(key);
        if (codeDefault.isPresent()) {
            return Optional.of(
                    "Défaut Java (@Value avec repli) : « " + codeDefault.get()
                            + " ». Aucune injection directe trouvée dans les sources PatTool."
            );
        }
        if (PatToolParameterCodeDefaults.isRequiredInProperties(key)) {
            return Optional.of(
                    "Clé obligatoire dans application.properties (aucune valeur par défaut dans le code Java)."
            );
        }
        return Optional.of(
                "Aucune référence trouvée dans le code Java PatTool ; propriété Spring, legacy ou lue indirectement."
        );
    }

    private String formatUsages(List<Usage> usages) {
        LinkedHashSet<String> lines = new LinkedHashSet<>();
        for (Usage usage : usages) {
            lines.add(formatUsage(usage));
        }
        StringBuilder sb = new StringBuilder();
        sb.append("Usage déduit du code : ");
        sb.append(String.join(" · ", lines));
        String hint = usages.stream()
                .map(Usage::contextHint)
                .filter(h -> h != null && !h.isBlank())
                .findFirst()
                .orElse(null);
        if (hint != null) {
            sb.append(". ").append(hint);
        }
        return sb.toString();
    }

    private static String formatUsage(Usage usage) {
        return switch (usage.kind()) {
            case VALUE_INJECTION -> {
                if (usage.memberName() != null && !usage.memberName().isBlank()) {
                    yield usage.javaClass() + " (@Value → " + usage.memberName() + ")";
                }
                yield usage.javaClass() + " (@Value)";
            }
            case CONFIGURATION_PROPERTIES ->
                    usage.javaClass() + " (@ConfigurationProperties, champ « " + usage.memberName() + " »)";
            case ENVIRONMENT_LOOKUP -> usage.javaClass() + " (Environment.getProperty)";
        };
    }

    private void ensureIndexed() {
        if (indexed) {
            return;
        }
        synchronized (this) {
            if (indexed) {
                return;
            }
            index = buildIndex();
            indexed = true;
        }
    }

    private Map<String, List<Usage>> buildIndex() {
        Map<String, List<Usage>> result = new LinkedHashMap<>();
        Path sourceRoot = resolveSourceRoot();
        if (sourceRoot == null) {
            return result;
        }
        try (Stream<Path> files = Files.walk(sourceRoot)) {
            files.filter(p -> p.toString().endsWith(".java"))
                    .forEach(path -> scanFile(path, result));
        } catch (IOException ex) {
            return result;
        }
        return result;
    }

    private void scanFile(Path path, Map<String, List<Usage>> result) {
        String content;
        try {
            content = Files.readString(path, StandardCharsets.UTF_8);
        } catch (IOException ex) {
            return;
        }
        Matcher classMatcher = CLASS_NAME.matcher(content);
        if (!classMatcher.find()) {
            return;
        }
        String className = classMatcher.group(1);
        String classHint = extractClassJavadoc(content, classMatcher.start());

        scanValueAnnotations(content, className, classHint, result);
        scanEnvironmentLookups(content, className, classHint, result);
        scanConfigurationProperties(content, className, classHint, result);
    }

    private void scanValueAnnotations(String content, String className, String classHint, Map<String, List<Usage>> result) {
        Matcher matcher = VALUE_KEY.matcher(content);
        while (matcher.find()) {
            String key = matcher.group(1).trim();
            int valueStart = matcher.start();
            String member = inferMemberName(content, matcher.end());
            String hint = extractJavadocBefore(content, valueStart, classHint);
            addUsage(result, key, new Usage(className, member, UsageKind.VALUE_INJECTION, hint));
        }
    }

    private void scanEnvironmentLookups(String content, String className, String classHint, Map<String, List<Usage>> result) {
        Matcher matcher = GET_PROPERTY.matcher(content);
        while (matcher.find()) {
            String key = matcher.group(1).trim();
            if (key.contains("${")) {
                continue;
            }
            addUsage(result, key, new Usage(className, null, UsageKind.ENVIRONMENT_LOOKUP, classHint));
        }
    }

    private void scanConfigurationProperties(String content, String className, String classHint, Map<String, List<Usage>> result) {
        Matcher prefixMatcher = CONFIG_PREFIX.matcher(content);
        if (!prefixMatcher.find()) {
            return;
        }
        String prefix = prefixMatcher.group(1).trim();
        Matcher fieldMatcher = PRIVATE_FIELD.matcher(content);
        while (fieldMatcher.find()) {
            String field = fieldMatcher.group(1);
            if ("serialVersionUID".equals(field)) {
                continue;
            }
            String key = prefix + "." + camelToKebab(field);
            String hint = extractJavadocBefore(content, fieldMatcher.start(), classHint);
            addUsage(result, key, new Usage(className, field, UsageKind.CONFIGURATION_PROPERTIES, hint));
        }
    }

    private static void addUsage(Map<String, List<Usage>> result, String key, Usage usage) {
        result.computeIfAbsent(key, k -> new ArrayList<>()).add(usage);
    }

    private static String inferMemberName(String content, int afterValueEnd) {
        int windowEnd = Math.min(content.length(), afterValueEnd + 180);
        String window = content.substring(afterValueEnd, windowEnd);
        Matcher matcher = MEMBER_AFTER_VALUE.matcher(window);
        if (matcher.find()) {
            String name = matcher.group(1);
            if (!"Value".equals(name) && !"Autowired".equals(name)) {
                return name;
            }
        }
        return null;
    }

    private static String extractClassJavadoc(String content, int classPos) {
        return extractJavadocBefore(content, classPos, null);
    }

    private static String extractJavadocBefore(String content, int pos, String fallback) {
        int searchFrom = Math.max(0, pos - 800);
        String before = content.substring(searchFrom, pos);
        int end = before.lastIndexOf("*/");
        if (end < 0) {
            return fallback;
        }
        int start = before.lastIndexOf("/**", end);
        if (start < 0) {
            return fallback;
        }
        String flattened = flattenJavadoc(before.substring(start + 3, end));
        return flattened.isEmpty() ? fallback : flattened;
    }

    private static String flattenJavadoc(String block) {
        if (block == null || block.isBlank()) {
            return "";
        }
        String flattened = block
                .replace('*', ' ')
                .replaceAll("\\{@code[^}]*}", "")
                .replaceAll("\\s+", " ")
                .trim();
        if (flattened.isEmpty()) {
            return "";
        }
        int dot = flattened.indexOf('.');
        return dot > 0 ? flattened.substring(0, dot + 1).trim() : flattened;
    }

    private static String camelToKebab(String camel) {
        if (camel == null || camel.isBlank()) {
            return camel;
        }
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < camel.length(); i++) {
            char c = camel.charAt(i);
            if (Character.isUpperCase(c)) {
                if (i > 0) {
                    sb.append('-');
                }
                sb.append(Character.toLowerCase(c));
            } else {
                sb.append(c);
            }
        }
        return sb.toString();
    }

    private static Path resolveSourceRoot() {
        String userDir = System.getProperty("user.dir", ".");
        List<Path> candidates = List.of(
                Path.of(userDir, "src", "main", "java"),
                Path.of(userDir, "PatTool_Back-End", "src", "main", "java"),
                Path.of(userDir).resolve("..").resolve("PatTool_Back-End").resolve("src").resolve("main").resolve("java").normalize()
        );
        for (Path candidate : candidates) {
            if (Files.isDirectory(candidate)) {
                return candidate;
            }
        }
        return null;
    }

    private enum UsageKind {
        VALUE_INJECTION,
        CONFIGURATION_PROPERTIES,
        ENVIRONMENT_LOOKUP
    }

    private record Usage(String javaClass, String memberName, UsageKind kind, String contextHint) {}
}
