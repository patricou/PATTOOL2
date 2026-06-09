package com.pat.service;

import com.pat.config.PatToolParameterCodeDefaults;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.context.ApplicationContext;
import org.springframework.core.io.ClassPathResource;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.io.InputStream;
import java.lang.annotation.Annotation;
import java.lang.reflect.Constructor;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.lang.reflect.Parameter;
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
 * Infers how configuration keys are used by combining runtime Spring bean inspection
 * and optional Java source scanning (for Javadoc hints).
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

    private final ApplicationContext applicationContext;

    private volatile Map<String, List<Usage>> index;
    private volatile boolean indexed;

    public PatToolParameterUsageIndexService(ApplicationContext applicationContext) {
        this.applicationContext = applicationContext;
    }

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
        Optional<String> propertiesHint = inferFromApplicationPropertiesComments(key);
        if (propertiesHint.isPresent()) {
            return propertiesHint;
        }
        Optional<String> codeDefault = PatToolParameterCodeDefaults.codeDefault(key);
        if (codeDefault.isPresent()) {
            return Optional.of(
                    "Défaut Java (@Value avec repli) : « " + codeDefault.get()
                            + " ». Aucune injection directe trouvée dans le code PatTool."
            );
        }
        if (PatToolParameterCodeDefaults.isRequiredInProperties(key)) {
            return Optional.of(
                    "Clé obligatoire dans application.properties (aucune valeur par défaut dans le code Java)."
            );
        }
        return Optional.of(
                "Aucune référence trouvée dans le code PatTool ; propriété Spring, legacy ou lue indirectement."
        );
    }

    private Optional<String> inferFromApplicationPropertiesComments(String key) {
        for (String resourcePath : List.of(
                "application.properties.example",
                "application.properties",
                "application-assistant.example.properties")) {
            ClassPathResource resource = new ClassPathResource(resourcePath);
            if (!resource.exists()) {
                continue;
            }
            try (InputStream input = resource.getInputStream()) {
                String content = new String(input.readAllBytes(), StandardCharsets.UTF_8);
                if (!content.contains(key + "=")) {
                    continue;
                }
                String comment = extractInlineComment(content, key);
                if (comment != null && !comment.isBlank()) {
                    return Optional.of("Commentaire application.properties : " + comment.trim());
                }
            } catch (IOException ignored) {
                /* try next resource */
            }
        }
        return Optional.empty();
    }

    private static String extractInlineComment(String content, String key) {
        String[] lines = content.split("\\R");
        String lastComment = null;
        for (String line : lines) {
            String trimmed = line.trim();
            if (trimmed.startsWith("#")) {
                lastComment = trimmed.substring(1).trim();
                continue;
            }
            if (trimmed.startsWith(key + "=") || trimmed.startsWith(key + " =")) {
                if (trimmed.contains("#")) {
                    return trimmed.substring(trimmed.indexOf('#') + 1).trim();
                }
                return lastComment;
            }
            if (!trimmed.isEmpty() && !trimmed.startsWith("#")) {
                lastComment = null;
            }
        }
        return null;
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
        indexFromRuntimeBeans(result);
        indexFromSourceFiles(result);
        return result;
    }

    private void indexFromRuntimeBeans(Map<String, List<Usage>> result) {
        for (String beanName : applicationContext.getBeanDefinitionNames()) {
            Class<?> type = applicationContext.getType(beanName, false);
            if (type == null) {
                continue;
            }
            indexType(type, result);
        }
    }

    private void indexType(Class<?> type, Map<String, List<Usage>> result) {
        Class<?> current = type;
        while (current != null && current != Object.class && current.getName().startsWith("com.pat")) {
            ConfigurationProperties configProps = current.getAnnotation(ConfigurationProperties.class);
            if (configProps != null) {
                String prefix = configProps.prefix().trim();
                if (!prefix.isEmpty()) {
                    for (Field field : current.getDeclaredFields()) {
                        if (field.isSynthetic() || java.lang.reflect.Modifier.isStatic(field.getModifiers())) {
                            continue;
                        }
                        String key = prefix + "." + camelToKebab(field.getName());
                        addUsage(result, key, new Usage(
                                current.getSimpleName(), field.getName(), UsageKind.CONFIGURATION_PROPERTIES, null));
                    }
                }
            }
            for (Field field : current.getDeclaredFields()) {
                indexValueAnnotation(current, field.getAnnotation(Value.class), field.getName(), result);
            }
            for (Constructor<?> constructor : current.getDeclaredConstructors()) {
                Parameter[] parameters = constructor.getParameters();
                Annotation[][] paramAnnotations = constructor.getParameterAnnotations();
                for (int i = 0; i < parameters.length; i++) {
                    for (var annotation : paramAnnotations[i]) {
                        if (annotation instanceof Value value) {
                            indexValueAnnotation(current, value, parameters[i].getName(), result);
                        }
                    }
                }
            }
            for (Method method : current.getDeclaredMethods()) {
                for (Parameter parameter : method.getParameters()) {
                    indexValueAnnotation(current, parameter.getAnnotation(Value.class), parameter.getName(), result);
                }
            }
            current = current.getSuperclass();
        }
    }

    private void indexValueAnnotation(Class<?> type, Value value, String memberName, Map<String, List<Usage>> result) {
        if (value == null) {
            return;
        }
        String key = extractValuePropertyKey(value.value());
        if (key == null || key.isBlank()) {
            return;
        }
        addUsage(result, key, new Usage(type.getSimpleName(), memberName, UsageKind.VALUE_INJECTION, null));
    }

    private static String extractValuePropertyKey(String expression) {
        if (expression == null || !expression.contains("${")) {
            return null;
        }
        int start = expression.indexOf("${") + 2;
        int end = expression.indexOf('}', start);
        if (end < 0) {
            return null;
        }
        String inside = expression.substring(start, end);
        int colon = inside.indexOf(':');
        return colon >= 0 ? inside.substring(0, colon).trim() : inside.trim();
    }

    private void indexFromSourceFiles(Map<String, List<Usage>> result) {
        Path sourceRoot = resolveSourceRoot();
        if (sourceRoot == null) {
            return;
        }
        try (Stream<Path> files = Files.walk(sourceRoot)) {
            files.filter(p -> p.toString().endsWith(".java"))
                    .forEach(path -> scanFile(path, result));
        } catch (IOException ex) {
            /* optional dev-time hints only */
        }
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
        List<Usage> existing = result.computeIfAbsent(key, k -> new ArrayList<>());
        boolean duplicate = existing.stream().anyMatch(u ->
                u.javaClass().equals(usage.javaClass())
                        && u.kind() == usage.kind()
                        && java.util.Objects.equals(u.memberName(), usage.memberName()));
        if (!duplicate) {
            existing.add(usage);
            if (usage.contextHint() != null && !usage.contextHint().isBlank()) {
                for (int i = 0; i < existing.size() - 1; i++) {
                    Usage prior = existing.get(i);
                    if (prior.javaClass().equals(usage.javaClass()) && prior.contextHint() == null) {
                        existing.set(i, new Usage(prior.javaClass(), prior.memberName(), prior.kind(), usage.contextHint()));
                    }
                }
            }
        }
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
