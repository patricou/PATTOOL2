package com.pat.util;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

class SafePathsTest {

    @TempDir
    Path root;

    @Test
    void keepsANestedFileInsideTheRoot() throws IOException {
        Path file = SafePaths.resolveInside(root, "albums/2024", "photo.jpg");
        assertTrue(file.startsWith(root.toAbsolutePath().normalize()));
        assertTrue(file.endsWith("photo.jpg"));
    }

    @Test
    void rejectsParentSegments() {
        assertThrows(IOException.class, () -> SafePaths.resolveInside(root, "..", "secret.txt"));
        assertThrows(IOException.class, () -> SafePaths.resolveInside(root, "albums/../../secret.txt"));
    }

    @Test
    void fileNameDropsDirectories() {
        assertEquals("secret.txt", SafePaths.safeFileName("../../secret.txt"));
        assertEquals("file", SafePaths.safeFileName(".."));
    }
}
