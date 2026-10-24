package com.pat.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.pat.controller.dto.YoutubeItemDto;

import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.time.ZoneOffset;
import java.time.ZonedDateTime;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Iterator;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Reads the public YouTube search page (youtubei) when the Data API quota is spent.
 * The browser still only talks to PatTool.
 */
final class YoutubeInnertube {

    private static final Pattern CLOCK = Pattern.compile("^(?:(\\d+):)?(\\d+):(\\d{2})$");
    private static final Pattern RELATIVE = Pattern.compile(
            "(?i)(\\d+)\\s*(secondes?|minutes?|heures?|jours?|semaines?|mois|ans?|années?|seconds?|minutes?|hours?|days?|weeks?|months?|years?)");
    private static final Pattern SCALED_VIEWS = Pattern.compile("(\\d+(?:[.,]\\d+)?)\\s*([kKmMbB])\\b");

    private YoutubeInnertube() {
    }

    /** Protobuf search filter used by youtube.com ({@code sp} / innertube {@code params}). */
    static String searchParams(String type, String order) {
        int typeCode = switch (type == null ? "" : type) {
            case "channel" -> 2;
            case "playlist" -> 3;
            default -> 1;
        };
        Integer sort = switch (order == null ? "" : order) {
            case "rating" -> 1;
            case "date" -> 2;
            case "viewCount" -> 3;
            default -> null;
        };
        byte[] bytes = sort == null
                ? new byte[] {0x12, 0x02, 0x10, (byte) typeCode}
                : new byte[] {0x08, sort.byteValue(), 0x12, 0x02, 0x10, (byte) typeCode};
        return Base64.getEncoder().encodeToString(bytes);
    }

    static String categoryQuery(String category, String region) {
        boolean fr = isFrenchRegion(region);
        return switch (category == null ? "" : category) {
            case "10" -> fr ? "musique" : "music";
            case "20" -> fr ? "jeu vidéo" : "gaming";
            case "17" -> fr ? "sport" : "sports";
            case "25" -> fr ? "actualités" : "news";
            case "1" -> "film";
            case "24" -> fr ? "divertissement" : "entertainment";
            case "23" -> fr ? "humour" : "comedy";
            case "27" -> fr ? "éducation" : "education";
            case "28" -> fr ? "science" : "science";
            case "26" -> fr ? "tutoriel" : "tutorial";
            case "19" -> fr ? "voyage" : "travel";
            case "15" -> fr ? "animaux" : "pets";
            case "2" -> fr ? "automobile" : "cars";
            case "22" -> "vlog";
            default -> "a";
        };
    }

    static boolean isFrenchRegion(String region) {
        if (region == null) {
            return false;
        }
        return switch (region.toUpperCase(Locale.ROOT)) {
            case "FR", "BE", "CH", "CA", "MA", "TN", "DZ" -> true;
            default -> false;
        };
    }

    static List<YoutubeItemDto> items(JsonNode root, String type, int limit) {
        List<YoutubeItemDto> items = new ArrayList<>();
        if (root != null && limit > 0) {
            walk(root, type == null ? "video" : type, limit, items);
        }
        return items;
    }

    static String continuation(JsonNode root) {
        List<String> tokens = new ArrayList<>();
        collectContinuations(root, tokens);
        return tokens.isEmpty() ? null : tokens.get(tokens.size() - 1);
    }

    static String clockToIso(String text) {
        if (text == null) {
            return null;
        }
        Matcher matcher = CLOCK.matcher(text.trim());
        if (!matcher.matches()) {
            return null;
        }
        int hours = matcher.group(1) == null ? 0 : Integer.parseInt(matcher.group(1));
        int minutes = Integer.parseInt(matcher.group(2));
        int seconds = Integer.parseInt(matcher.group(3));
        if (minutes > 59 || seconds > 59 || hours > 99) {
            return null;
        }
        StringBuilder iso = new StringBuilder("PT");
        if (hours > 0) {
            iso.append(hours).append('H');
        }
        if (minutes > 0 || hours > 0) {
            iso.append(minutes).append('M');
        }
        iso.append(seconds).append('S');
        return iso.toString();
    }

    static Long views(String text) {
        if (text == null || text.isBlank()) {
            return null;
        }
        Matcher scaled = SCALED_VIEWS.matcher(text);
        if (scaled.find()) {
            double value = Double.parseDouble(scaled.group(1).replace(',', '.'));
            double factor = switch (Character.toLowerCase(scaled.group(2).charAt(0))) {
                case 'k' -> 1_000d;
                case 'm' -> 1_000_000d;
                default -> 1_000_000_000d;
            };
            return Math.round(value * factor);
        }
        String digits = text.replaceAll("\\D", "");
        if (digits.isEmpty() || digits.length() > 15) {
            return null;
        }
        try {
            return Long.parseLong(digits);
        } catch (NumberFormatException e) {
            return null;
        }
    }

    static String relativeToIso(String text, Instant now) {
        if (text == null || text.isBlank() || now == null) {
            return null;
        }
        String lower = text.toLowerCase(Locale.ROOT);
        if (lower.contains("direct") || lower.contains("live") || lower.contains("premier")) {
            return null;
        }
        ZonedDateTime zoned = now.atZone(ZoneOffset.UTC);
        if (lower.contains("aujourd") || lower.contains("today")) {
            return zoned.toInstant().toString();
        }
        if (lower.contains("hier") || lower.contains("yesterday")) {
            return zoned.minusDays(1).toInstant().toString();
        }
        Matcher matcher = RELATIVE.matcher(lower);
        if (!matcher.find()) {
            return null;
        }
        int amount = Integer.parseInt(matcher.group(1));
        String unit = matcher.group(2);
        ZonedDateTime shifted;
        if (unit.startsWith("sec")) {
            shifted = zoned.minusSeconds(amount);
        } else if (unit.startsWith("min")) {
            shifted = zoned.minusMinutes(amount);
        } else if (unit.startsWith("heur") || unit.startsWith("hour")) {
            shifted = zoned.minusHours(amount);
        } else if (unit.startsWith("jour") || unit.startsWith("day")) {
            shifted = zoned.minusDays(amount);
        } else if (unit.startsWith("sem") || unit.startsWith("week")) {
            shifted = zoned.minusWeeks(amount);
        } else if (unit.startsWith("mois") || unit.startsWith("month")) {
            shifted = zoned.minusMonths(amount);
        } else if (unit.startsWith("an") || unit.startsWith("year")) {
            shifted = zoned.minusYears(amount);
        } else {
            return null;
        }
        return shifted.toInstant().toString();
    }

    private static void walk(JsonNode node, String type, int limit, List<YoutubeItemDto> items) {
        if (node == null || items.size() >= limit) {
            return;
        }
        if (node.isArray()) {
            for (JsonNode child : node) {
                walk(child, type, limit, items);
                if (items.size() >= limit) {
                    return;
                }
            }
            return;
        }
        if (!node.isObject()) {
            return;
        }
        Iterator<Map.Entry<String, JsonNode>> fields = node.fields();
        while (fields.hasNext() && items.size() < limit) {
            Map.Entry<String, JsonNode> field = fields.next();
            JsonNode value = field.getValue();
            switch (field.getKey()) {
                case "videoRenderer" -> {
                    if ("video".equals(type)) {
                        YoutubeItemDto item = videoItem(value);
                        if (item != null) {
                            items.add(item);
                        }
                    }
                }
                case "playlistRenderer" -> {
                    if ("playlist".equals(type)) {
                        YoutubeItemDto item = playlistItem(value);
                        if (item != null) {
                            items.add(item);
                        }
                    }
                }
                case "channelRenderer" -> {
                    if ("channel".equals(type)) {
                        YoutubeItemDto item = channelItem(value);
                        if (item != null) {
                            items.add(item);
                        }
                    }
                }
                default -> walk(value, type, limit, items);
            }
        }
    }

    private static void collectContinuations(JsonNode node, List<String> tokens) {
        if (node == null) {
            return;
        }
        if (node.isArray()) {
            for (JsonNode child : node) {
                collectContinuations(child, tokens);
            }
            return;
        }
        if (!node.isObject()) {
            return;
        }
        JsonNode token = node.path("continuationItemRenderer")
                .path("continuationEndpoint")
                .path("continuationCommand")
                .path("token");
        if (token.isTextual() && !token.asText().isBlank()) {
            tokens.add(token.asText());
        }
        Iterator<Map.Entry<String, JsonNode>> fields = node.fields();
        while (fields.hasNext()) {
            Map.Entry<String, JsonNode> field = fields.next();
            if (!"continuationItemRenderer".equals(field.getKey())) {
                collectContinuations(field.getValue(), tokens);
            }
        }
    }

    private static YoutubeItemDto videoItem(JsonNode video) {
        String id = text(video, "videoId");
        if (!id.matches("[A-Za-z0-9_-]{11}")) {
            return null;
        }
        String length = runs(video.get("lengthText"));
        boolean live = length.isBlank() && looksLive(video);
        String published = runs(video.get("publishedTimeText"));
        return new YoutubeItemDto(
                id,
                "video",
                blankToNull(runs(video.get("title"))),
                blankToNull(runs(video.get("descriptionSnippet"))),
                blankToNull(firstNonBlank(runs(video.get("ownerText")), runs(video.get("longBylineText")))),
                blankToNull(firstNonBlank(browseId(video.get("ownerText")), browseId(video.get("longBylineText")))),
                relativeToIso(published, Instant.now()),
                proxiedThumb("https://i.ytimg.com/vi/" + id + "/hqdefault.jpg"),
                live ? null : clockToIso(length),
                views(runs(video.get("viewCountText"))),
                live ? "live" : "none"
        );
    }

    private static YoutubeItemDto playlistItem(JsonNode playlist) {
        String id = text(playlist, "playlistId");
        if (!id.matches("[A-Za-z0-9_-]{10,64}")) {
            return null;
        }
        String thumb = lastThumb(playlist.get("thumbnail"));
        return new YoutubeItemDto(
                id,
                "playlist",
                blankToNull(runs(playlist.get("title"))),
                null,
                blankToNull(runs(playlist.get("shortBylineText"))),
                blankToNull(browseId(playlist.get("shortBylineText"))),
                null,
                proxiedThumb(thumb),
                null,
                null,
                null
        );
    }

    private static YoutubeItemDto channelItem(JsonNode channel) {
        String id = text(channel, "channelId");
        if (!id.matches("[A-Za-z0-9_-]{10,64}")) {
            return null;
        }
        return new YoutubeItemDto(
                id,
                "channel",
                blankToNull(runs(channel.get("title"))),
                blankToNull(runs(channel.get("descriptionSnippet"))),
                blankToNull(runs(channel.get("title"))),
                id,
                null,
                proxiedThumb(lastThumb(channel.get("thumbnail"))),
                null,
                null,
                null
        );
    }

    private static boolean looksLive(JsonNode video) {
        String published = runs(video.get("publishedTimeText")).toLowerCase(Locale.ROOT);
        if (published.contains("direct") || published.contains("live")) {
            return true;
        }
        JsonNode badges = video.get("badges");
        if (badges == null) {
            return false;
        }
        String blob = badges.toString().toLowerCase(Locale.ROOT);
        return blob.contains("live") || blob.contains("direct");
    }

    private static String lastThumb(JsonNode thumbnail) {
        JsonNode thumbs = thumbnail == null ? null : thumbnail.get("thumbnails");
        if (thumbs == null || !thumbs.isArray() || thumbs.isEmpty()) {
            return "";
        }
        JsonNode last = thumbs.get(thumbs.size() - 1);
        return last.path("url").asText("");
    }

    private static String browseId(JsonNode node) {
        if (node == null) {
            return "";
        }
        JsonNode runs = node.get("runs");
        if (runs != null && runs.isArray()) {
            for (JsonNode run : runs) {
                String id = run.path("navigationEndpoint").path("browseEndpoint").path("browseId").asText("");
                if (!id.isBlank()) {
                    return id;
                }
            }
        }
        return "";
    }

    private static String runs(JsonNode node) {
        if (node == null || node.isNull() || node.isMissingNode()) {
            return "";
        }
        if (node.hasNonNull("simpleText")) {
            return node.get("simpleText").asText("").trim();
        }
        JsonNode runs = node.get("runs");
        if (runs != null && runs.isArray()) {
            StringBuilder text = new StringBuilder();
            for (JsonNode run : runs) {
                text.append(run.path("text").asText(""));
            }
            return text.toString().trim();
        }
        return node.isTextual() ? node.asText("").trim() : "";
    }

    private static String text(JsonNode node, String field) {
        if (node == null) {
            return "";
        }
        return node.path(field).asText("").trim();
    }

    private static String proxiedThumb(String rawUrl) {
        if (!YoutubeProxyService.isAllowedThumbUrl(rawUrl)) {
            return null;
        }
        return "external/youtube/image?u=" + URLEncoder.encode(rawUrl, StandardCharsets.UTF_8);
    }

    private static String firstNonBlank(String... values) {
        for (String value : values) {
            if (value != null && !value.isBlank()) {
                return value;
            }
        }
        return "";
    }

    private static String blankToNull(String value) {
        return value == null || value.isBlank() ? null : value;
    }
}
