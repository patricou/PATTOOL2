package com.pat.service;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.time.LocalDateTime;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.time.format.DateTimeParseException;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Service for parsing dates and numbers from filenames for sorting purposes.
 * Supports two filename formats:
 * 1. YYYYMMDD_HHMMSS (e.g., 20251129_113012 = 2025-11-29 11:30:12)
 * 2. PATnnnnn (e.g., PAT00001, PAT12345)
 */
@Service
public class FilenameDateService {

    private static final Logger log = LoggerFactory.getLogger(FilenameDateService.class);

    // Pattern for YYYYMMDD_HHMMSS format (e.g., 20251129_113012)
    private static final Pattern DATE_PATTERN = Pattern.compile("^(\\d{8})_(\\d{6})$");
    private static final DateTimeFormatter DATE_FORMATTER = DateTimeFormatter.ofPattern("yyyyMMdd_HHmmss");

    // Pattern for PATnnnnn format (case-insensitive, e.g., PAT00001, PAT12345, pat00001)
    private static final Pattern PAT_PATTERN = Pattern.compile("^PAT(\\d+)$", Pattern.CASE_INSENSITIVE);

    /**
     * Removes file extension from filename
     * @param fileName The full filename including extension
     * @return The filename without extension
     */
    public String removeExtension(String fileName) {
        if (fileName == null || fileName.isEmpty()) {
            return fileName;
        }
        int lastDot = fileName.lastIndexOf('.');
        if (lastDot > 0) {
            return fileName.substring(0, lastDot);
        }
        return fileName;
    }

    /**
     * Parses date from filename in YYYYMMDD_HHMMSS format
     * Example: "20251129_113012" = 2025-11-29 11:30:12
     * 
     * @param name The filename (without extension)
     * @return Timestamp in milliseconds since epoch, or null if format doesn't match
     */
    public Long parseDateFromFilename(String name) {
        if (name == null || name.isEmpty()) {
            return null;
        }

        Matcher matcher = DATE_PATTERN.matcher(name);
        
        if (matcher.matches()) {
            try {
                String dateStr = matcher.group(1) + "_" + matcher.group(2);
                LocalDateTime dateTime = LocalDateTime.parse(dateStr, DATE_FORMATTER);
                // Convert to milliseconds since epoch using system default timezone
                return dateTime.atZone(ZoneId.systemDefault()).toInstant().toEpochMilli();
            } catch (DateTimeParseException e) {
                log.debug("Failed to parse date from filename '{}': {}", name, e.getMessage());
                return null;
            }
        }
        return null;
    }

    /**
     * Parses PAT number from filename in PATnnnnn format
     * Examples: "PAT00001" -> 1, "PAT12345" -> 12345, "pat00001" -> 1 (case-insensitive)
     * 
     * @param name The filename (without extension)
     * @return The number, or null if format doesn't match
     */
    public Integer parsePatNumber(String name) {
        if (name == null || name.isEmpty()) {
            return null;
        }

        Matcher matcher = PAT_PATTERN.matcher(name);
        
        if (matcher.matches()) {
            try {
                return Integer.parseInt(matcher.group(1));
            } catch (NumberFormatException e) {
                log.debug("Failed to parse PAT number from filename '{}': {}", name, e.getMessage());
                return null;
            }
        }
        return null;
    }

    /**
     * Determines the sort timestamp for a filename.
     * Priority:
     * 1. YYYYMMDD_HHMMSS format -> returns date timestamp
     * 2. PATnnnnn format -> returns PAT number as timestamp (lower number = older)
     * 3. Otherwise -> returns null (should use filesystem date)
     * 
     * @param fileName The full filename (with or without extension)
     * @return Sort timestamp in milliseconds, or null if format doesn't match
     */
    public Long getSortTimestamp(String fileName) {
        if (fileName == null || fileName.isEmpty()) {
            return null;
        }

        String nameWithoutExt = removeExtension(fileName);
        
        // Try date format first
        Long dateTimestamp = parseDateFromFilename(nameWithoutExt);
        if (dateTimestamp != null) {
            return dateTimestamp;
        }

        // Try PAT format - convert number to a comparable timestamp
        // We'll use the PAT number directly as a sort key (lower = older)
        // But we need to return null here so the caller can handle PAT separately
        // or we could return a special value, but it's better to handle in comparator
        return null;
    }

    /**
     * Checks if filename matches YYYYMMDD_HHMMSS format
     * @param fileName The filename to check
     * @return true if matches date format
     */
    public boolean isDateFormat(String fileName) {
        if (fileName == null || fileName.isEmpty()) {
            return false;
        }
        String nameWithoutExt = removeExtension(fileName);
        return parseDateFromFilename(nameWithoutExt) != null;
    }

    /**
     * Checks if filename matches PATnnnnn format
     * @param fileName The filename to check
     * @return true if matches PAT format
     */
    public boolean isPatFormat(String fileName) {
        if (fileName == null || fileName.isEmpty()) {
            return false;
        }
        String nameWithoutExt = removeExtension(fileName);
        return parsePatNumber(nameWithoutExt) != null;
    }
}

