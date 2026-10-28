package com.pat.service;

import com.pat.repo.domain.AppParameter;
import org.springframework.stereotype.Service;

import java.util.Date;
import java.util.List;
import java.util.Locale;
import java.util.Optional;
import java.util.Set;

/**
 * One cabinet style per user, shared by TV, radio and Deezer.
 * Stored in {@code appParameters} under {@code media.skin.<username>}.
 * Older {@code tv.skin.}, {@code radio.skin.} and {@code deezer.skin.} rows
 * are copied onto that key and then removed.
 */
@Service
public class MediaSkinService {

    public static final String PARAM_KEY_PREFIX = "media.skin.";

    /** Older per-page keys. Read for migration, then deleted. */
    public static final List<String> PAGE_PREFIXES = List.of(
            "tv.skin.",
            "radio.skin.",
            "deezer.skin.");

    /** Must match the skin ids in the TV, radio and Deezer watchers. */
    public static final Set<String> ALLOWED_SKINS = Set.of(
            "classic", "artdeco", "synthwave", "spaceage", "military", "steampunk", "aurora",
            "noir", "bamboo", "porcelain", "carbon", "candy", "espace",
            "kanizsa", "cafewall", "penrose", "scintille", "barber");

    private static final String DESCRIPTION =
            "Cabinet style (skin) shared by TV, radio and Deezer, per user.";

    private final AppParameterService appParameterService;
    private final UserOwnerService userOwnerService;

    public MediaSkinService(AppParameterService appParameterService, UserOwnerService userOwnerService) {
        this.appParameterService = appParameterService;
        this.userOwnerService = userOwnerService;
    }

    public String findForSubject(String jwtSubject) {
        String shared = readNormalized(PARAM_KEY_PREFIX, jwtSubject);
        if (shared != null) {
            dropLegacy(jwtSubject);
            return shared;
        }
        String legacy = newestLegacy(jwtSubject);
        if (legacy == null) {
            return null;
        }
        persist(jwtSubject, legacy);
        return legacy;
    }

    public String saveForSubject(String jwtSubject, String skin) {
        String normalized = normalize(skin);
        if (normalized == null) {
            throw new IllegalArgumentException("invalid skin");
        }
        persist(jwtSubject, normalized);
        return normalized;
    }

    /**
     * Copies an older per-page skin onto {@code media.skin} when that is the
     * only copy, then removes {@code tv.skin}, {@code radio.skin} and
     * {@code deezer.skin} so the account has a single skin parameter.
     */
    public void collapseLegacySkins(String jwtSubject) {
        if (jwtSubject == null || jwtSubject.isBlank()) {
            return;
        }
        if (readNormalized(PARAM_KEY_PREFIX, jwtSubject) == null) {
            String legacy = newestLegacy(jwtSubject);
            if (legacy != null) {
                write(PARAM_KEY_PREFIX, jwtSubject, legacy);
            }
        }
        dropLegacy(jwtSubject);
    }

    private void persist(String jwtSubject, String skin) {
        write(PARAM_KEY_PREFIX, jwtSubject, skin);
        dropLegacy(jwtSubject);
    }

    private void dropLegacy(String jwtSubject) {
        for (String prefix : PAGE_PREFIXES) {
            userOwnerService.deleteParams(prefix, jwtSubject);
        }
    }

    private void write(String prefix, String jwtSubject, String skin) {
        String key = userOwnerService.writeKey(prefix, jwtSubject);
        appParameterService.setString(key, skin, DESCRIPTION);
        userOwnerService.dropAliasKeys(prefix, jwtSubject);
    }

    private String newestLegacy(String jwtSubject) {
        String newestSkin = null;
        long newestMod = Long.MIN_VALUE;
        for (String prefix : PAGE_PREFIXES) {
            Optional<AppParameter> row = userOwnerService.findParam(prefix, jwtSubject);
            if (row.isEmpty()) {
                continue;
            }
            String skin = normalize(row.get().getParamValue());
            if (skin == null) {
                continue;
            }
            long mod = modificationEpoch(row.get());
            if (newestSkin == null || mod > newestMod) {
                newestSkin = skin;
                newestMod = mod;
            }
        }
        return newestSkin;
    }

    private String readNormalized(String prefix, String jwtSubject) {
        return userOwnerService.findParam(prefix, jwtSubject)
                .map(AppParameter::getParamValue)
                .map(MediaSkinService::normalize)
                .orElse(null);
    }

    private static long modificationEpoch(AppParameter row) {
        Date modified = row.getDateModification();
        if (modified != null) {
            return modified.getTime();
        }
        Date created = row.getDateCreation();
        return created == null ? 0L : created.getTime();
    }

    static String normalize(String skin) {
        if (skin == null) {
            return null;
        }
        String s = skin.trim().toLowerCase(Locale.ROOT);
        return ALLOWED_SKINS.contains(s) ? s : null;
    }
}
