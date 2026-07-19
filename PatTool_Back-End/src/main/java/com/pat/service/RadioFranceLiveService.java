package com.pat.service;

import org.springframework.stereotype.Service;

import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;

/**
 * Official Radio France live HLS (audio) — stable public CDN URLs, no token.
 * <p>
 * Virtual catalog URLs: {@code radiofrance:franceinter}, etc.
 */
@Service
public class RadioFranceLiveService {

    public static final String SCHEME_PREFIX = "radiofrance:";

    private static final Map<String, ChannelDef> CHANNELS = new LinkedHashMap<>();

    static {
        CHANNELS.put("franceinter", new ChannelDef(
                "France Inter",
                "Radio",
                "https://upload.wikimedia.org/wikipedia/commons/thumb/a/ae/France_Inter_logo_2017.svg/512px-France_Inter_logo_2017.svg.png",
                "https://stream.radiofrance.fr/franceinter/franceinter.m3u8"));
    }

    public static boolean isVirtualUrl(String url) {
        return url != null && url.regionMatches(true, 0, SCHEME_PREFIX, 0, SCHEME_PREFIX.length());
    }

    public static Optional<String> slugFromVirtualUrl(String url) {
        if (!isVirtualUrl(url)) {
            return Optional.empty();
        }
        String slug = url.substring(SCHEME_PREFIX.length()).trim().toLowerCase(Locale.ROOT);
        return slug.isEmpty() ? Optional.empty() : Optional.of(slug);
    }

    public static String virtualUrl(String slug) {
        return SCHEME_PREFIX + slug;
    }

    public Map<String, ChannelDef> channels() {
        return CHANNELS;
    }

    public Optional<ChannelDef> findChannel(String slug) {
        if (slug == null) {
            return Optional.empty();
        }
        return Optional.ofNullable(CHANNELS.get(slug.trim().toLowerCase(Locale.ROOT)));
    }

    public Optional<String> resolveHlsUrl(String slug) {
        return findChannel(slug).map(ChannelDef::hlsUrl);
    }

    public Optional<String> resolveVirtualOrPassthrough(String url) {
        Optional<String> slug = slugFromVirtualUrl(url);
        if (slug.isEmpty()) {
            return Optional.ofNullable(url);
        }
        return resolveHlsUrl(slug.get());
    }

    public record ChannelDef(String name, String group, String logo, String hlsUrl) {
    }
}
