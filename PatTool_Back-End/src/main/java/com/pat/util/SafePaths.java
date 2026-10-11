package com.pat.util;

import java.io.IOException;
import java.nio.file.Path;

/**
 * Resolves user-supplied path segments and keeps the result inside a root directory.
 */
public final class SafePaths {

    private SafePaths() {}

    /**
     * Joins {@code parts} under {@code root}. Rejects absolute paths, drive-relative
     * names, parent segments and any result that normalizes outside {@code root}.
     */
    public static Path resolveInside(Path root, String... parts) throws IOException {
        if (root == null) {
            throw new IOException("missing root");
        }
        Path base = root.toAbsolutePath().normalize();
        Path current = base;
        if (parts != null) {
            for (String part : parts) {
                if (part == null || part.isBlank()) {
                    continue;
                }
                if (part.indexOf('\0') >= 0 || part.indexOf(':') >= 0) {
                    throw new IOException("invalid path");
                }
                String cleaned = part.replace('\\', '/');
                if (cleaned.startsWith("/")) {
                    throw new IOException("invalid path");
                }
                for (String segment : cleaned.split("/")) {
                    if (segment.isEmpty() || ".".equals(segment)) {
                        continue;
                    }
                    if ("..".equals(segment)) {
                        throw new IOException("invalid path");
                    }
                    current = current.resolve(segment).normalize();
                    if (!current.startsWith(base)) {
                        throw new IOException("path escapes root");
                    }
                }
            }
        }
        return current;
    }

    /** Last path segment only, with control characters and separators removed. */
    public static String safeFileName(String original) {
        String fallback = "file";
        if (original == null || original.isBlank()) {
            return fallback;
        }
        String name = original.replace('\\', '/');
        int slash = name.lastIndexOf('/');
        if (slash >= 0) {
            name = name.substring(slash + 1);
        }
        name = name.replaceAll("[\\p{Cntrl}:*?\"<>|]", "_").trim();
        if (name.isBlank() || ".".equals(name) || "..".equals(name)) {
            return fallback;
        }
        if (name.length() > 180) {
            name = name.substring(name.length() - 180);
        }
        return name;
    }
}
