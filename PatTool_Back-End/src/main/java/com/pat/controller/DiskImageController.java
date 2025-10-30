package com.pat.controller;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.io.InputStreamResource;
import org.springframework.core.io.Resource;
import org.springframework.http.MediaType;
import org.springframework.http.CacheControl;
import org.springframework.http.ResponseEntity;
import org.springframework.util.StringUtils;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.bind.annotation.RequestParam;

import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Locale;
import java.util.Optional;
import java.util.Set;
import java.util.concurrent.TimeUnit;
import java.util.stream.Stream;

@RestController
@RequestMapping("/api/fsphotos")
public class DiskImageController {

    @Value("${file.storage.base-path:r:/photo}")
    private String basePath;

    private static final Logger log = LoggerFactory.getLogger(DiskImageController.class);

    private static final Set<String> IMAGE_EXTENSIONS = Set.of(
            ".jpg", ".jpeg", ".png", ".gif", ".bmp", ".webp", ".svg", ".tif", ".tiff"
    );

    // Use query parameter to carry sub-paths safely with modern PathPatternParser
    @GetMapping("/list")
    public List<String> listImages(@RequestParam("relativePath") String relativePath,
                                   @RequestParam(value = "limit", required = false) Optional<Integer> limit,
                                   @RequestParam(value = "sort", required = false) Optional<String> sort) throws IOException {
        log.info("[FSPhotos][LIST] basePath='{}', relativePath='{}'", basePath, relativePath);
        String sanitized = sanitizeRelativePath(relativePath);
        Path dir = Paths.get(basePath, sanitized).normalize();
        log.info("[FSPhotos][LIST] sanitized='{}', resolvedDir='{}'", sanitized, dir);

        if (!Files.exists(dir)) {
            log.warn("[FSPhotos][LIST] Directory does not exist: {}", dir);
            return List.of();
        }
        if (!Files.isDirectory(dir)) {
            log.warn("[FSPhotos][LIST] Path is not a directory: {}", dir);
            return List.of();
        }

        List<Path> paths = new ArrayList<>();
        try (Stream<Path> stream = Files.list(dir)) {
            stream.filter(Files::isRegularFile)
                  .filter(p -> isImageFile(p.getFileName().toString()))
                  .forEach(paths::add);
        }
        // Sorting
        if (sort.isPresent() && sort.get().equalsIgnoreCase("mtime")) {
            paths.sort((a, b) -> {
                try {
                    return Long.compare(Files.getLastModifiedTime(b).toMillis(), Files.getLastModifiedTime(a).toMillis());
                } catch (IOException e) {
                    return 0;
                }
            });
        } else {
            paths.sort(Comparator.comparing(p -> p.getFileName().toString().toLowerCase(Locale.ROOT)));
        }

        // Apply limit (for faster first paint)
        int lim = limit.orElse(0);
        List<String> files = new ArrayList<>();
        paths.stream().limit(lim > 0 ? lim : paths.size())
             .map(Path::getFileName)
             .map(Path::toString)
             .forEach(files::add);

        log.info("[FSPhotos][LIST] imagesFoundTotal={}, returned={}, dir={}", paths.size(), files.size(), dir);
        return files;
    }

    // Use query parameters to avoid invalid pattern with ** in the middle
    @GetMapping("/image")
    public ResponseEntity<Resource> getImage(@RequestParam("relativePath") String relativePath,
                                             @RequestParam("fileName") String fileName) throws IOException {
        log.info("[FSPhotos][IMAGE] basePath='{}', relativePath='{}', fileName='{}'", basePath, relativePath, fileName);
        String sanitizedRel = sanitizeRelativePath(relativePath);
        String sanitizedName = sanitizeFileName(fileName);

        Path file = Paths.get(basePath, sanitizedRel, sanitizedName).normalize();
        log.info("[FSPhotos][IMAGE] sanitizedRel='{}', sanitizedName='{}', resolvedFile='{}'", sanitizedRel, sanitizedName, file);

        if (!Files.exists(file) || !Files.isRegularFile(file)) {
            log.warn("[FSPhotos][IMAGE] File not found or not regular: {}", file);
            return ResponseEntity.notFound().build();
        }

        String contentType = Files.probeContentType(file);
        if (contentType == null) {
            contentType = "application/octet-stream";
        }
        log.info("[FSPhotos][IMAGE] contentType='{}'", contentType);

        long lastModified = Files.getLastModifiedTime(file).toMillis();
        InputStream is = Files.newInputStream(file);
        return ResponseEntity.ok()
                .lastModified(lastModified)
                .cacheControl(CacheControl.maxAge(3600, TimeUnit.SECONDS).cachePublic())
                .contentType(MediaType.parseMediaType(contentType))
                .body(new InputStreamResource(is));
    }

    private boolean isImageFile(String fileName) {
        String lower = fileName.toLowerCase(Locale.ROOT);
        return IMAGE_EXTENSIONS.stream().anyMatch(lower::endsWith);
    }

    private String sanitizeRelativePath(String input) {
        if (input == null) return "";
        String cleaned = input.replace("..", "");
        cleaned = cleaned.replace("\\", "/");
        cleaned = cleaned.replaceAll("^/+", "");
        return cleaned;
    }

    private String sanitizeFileName(String input) {
        if (!StringUtils.hasText(input)) return input;
        String name = input;
        name = name.replace("..", "");
        name = name.replace("/", "");
        name = name.replace("\\", "");
        return name;
    }
}


