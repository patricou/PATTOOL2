package com.pat.service;

import com.pat.repo.domain.AppParameter;
import org.springframework.stereotype.Service;

import java.util.Locale;
import java.util.Optional;
import java.util.Set;

/**
 * Per-user Deezer cabinet style (skin id), stored in {@code appParameters}
 * under key {@code deezer.skin.<JWT sub>}.
 */
@Service
public class DeezerSkinService {

    static final String PARAM_KEY_PREFIX = "deezer.skin.";

    /** Must match {@code DzSkin} in deezer-watcher.component.ts. */
    public static final Set<String> ALLOWED_SKINS = Set.of(
            "classic", "artdeco", "synthwave", "spaceage", "military", "steampunk", "aurora",
            "noir", "bamboo", "porcelain", "carbon", "candy", "espace",
            "kanizsa", "cafewall", "penrose", "scintille", "barber");

    private final AppParameterService appParameterService;
    private final UserOwnerService userOwnerService;

    public DeezerSkinService(AppParameterService appParameterService, UserOwnerService userOwnerService) {
        this.appParameterService = appParameterService;
        this.userOwnerService = userOwnerService;
    }

    public String findForSubject(String jwtSubject) {
        Optional<AppParameter> row = userOwnerService.findParam(PARAM_KEY_PREFIX, jwtSubject);
        return row.map(AppParameter::getParamValue).map(DeezerSkinService::normalize).orElse(null);
    }

    public String saveForSubject(String jwtSubject, String skin) {
        String normalized = normalize(skin);
        if (normalized == null) {
            throw new IllegalArgumentException("invalid skin");
        }
        String key = userOwnerService.writeKey(PARAM_KEY_PREFIX, jwtSubject);
        appParameterService.setString(key, normalized, "Deezer watcher: cabinet style (skin) per user.");
        userOwnerService.dropAliasKeys(PARAM_KEY_PREFIX, jwtSubject);
        return normalized;
    }

    static String normalize(String skin) {
        if (skin == null) {
            return null;
        }
        String s = skin.trim().toLowerCase(Locale.ROOT);
        return ALLOWED_SKINS.contains(s) ? s : null;
    }
}
