package com.pat.service;

import com.pat.config.PatToolParameterCatalog;
import com.pat.repo.MembersRepository;
import com.pat.repo.domain.AppParameter;
import com.pat.repo.domain.Member;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.stereotype.Service;
import org.springframework.util.StringUtils;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Optional;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * Identity for per-user persistence: writes use Member {@code userName} (surnom).
 * Reads also accept legacy Keycloak ids ({@code JWT sub}, {@code Member.keycloakId}).
 */
@Service
public class UserOwnerService {

    private static final Pattern UUID_ID = Pattern.compile(
            "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
            Pattern.CASE_INSENSITIVE);

    public record Owner(String username, List<String> aliases) {
        public boolean owns(String stored) {
            if (!StringUtils.hasText(stored) || aliases == null) {
                return false;
            }
            String v = stored.trim();
            for (String a : aliases) {
                if (v.equals(a)) {
                    return true;
                }
            }
            return false;
        }
    }

    private final MembersRepository membersRepository;
    private final AppParameterService appParameterService;

    public UserOwnerService(MembersRepository membersRepository, AppParameterService appParameterService) {
        this.membersRepository = membersRepository;
        this.appParameterService = appParameterService;
    }

    public static Jwt currentJwt() {
        Authentication auth = SecurityContextHolder.getContext().getAuthentication();
        if (auth == null || !(auth.getPrincipal() instanceof Jwt jwt)) {
            return null;
        }
        return jwt;
    }

    public String username(Jwt jwt) {
        return resolve(jwt, null).username();
    }

    public Owner resolve(Jwt jwt) {
        return resolve(jwt, null);
    }

    /**
     * Resolve the current request JWT when present, merging {@code ownerHint}
     * (typically {@code jwt.getSubject()} from a controller).
     */
    public Owner resolve(String ownerHint) {
        return resolve(currentJwt(), ownerHint);
    }

    public Owner resolve(Jwt jwt, String ownerHint) {
        Set<String> aliases = new LinkedHashSet<>();
        add(aliases, ownerHint);
        String preferred = null;
        if (jwt != null) {
            add(aliases, jwt.getSubject());
            preferred = trimToNull(jwt.getClaimAsString("preferred_username"));
            add(aliases, preferred);
        }
        Member member = null;
        for (String a : List.copyOf(aliases)) {
            member = findMember(a);
            if (member != null) {
                break;
            }
        }
        if (member == null && preferred != null) {
            member = membersRepository.findByUserName(preferred);
        }
        String username = null;
        if (member != null) {
            username = trimToNull(member.getUserName());
            add(aliases, username);
            add(aliases, member.getKeycloakId());
        }
        if (username == null) {
            username = preferred;
        }
        if (username == null) {
            username = trimToNull(ownerHint);
        }
        if (username == null && jwt != null) {
            username = trimToNull(jwt.getSubject());
        }
        add(aliases, username);
        if (looksLikeUuid(username)) {
            String named = firstNonUuid(aliases);
            if (named != null) {
                username = named;
            }
        }
        add(aliases, username);
        return new Owner(username, List.copyOf(aliases));
    }

    public Owner require(String ownerHint) {
        Owner owner = resolve(ownerHint);
        if (owner.username() == null) {
            throw new IllegalArgumentException("username required");
        }
        return owner;
    }

    public String writeKey(String prefix, String ownerHint) {
        Owner owner = require(ownerHint);
        return prefix + owner.username();
    }

    /**
     * Read {@code prefix + username} and legacy {@code prefix + keycloakId},
     * then keep the newest {@code dateModification}. Copies a newer alias onto
     * the username key so later reads stay on the surnom.
     */
    public Optional<AppParameter> findParam(String prefix, String ownerHint) {
        if (!StringUtils.hasText(prefix)) {
            return Optional.empty();
        }
        Owner owner = resolve(ownerHint);
        if (owner.username() == null && owner.aliases().isEmpty()) {
            return Optional.empty();
        }
        String writeId = owner.username();
        AppParameter newest = null;
        long newestMod = Long.MIN_VALUE;
        for (String alias : owner.aliases()) {
            Optional<AppParameter> row = appParameterService.find(prefix + alias);
            if (row.isEmpty()) {
                continue;
            }
            long mod = modificationEpoch(row.get());
            if (newest == null || mod > newestMod) {
                newest = row.get();
                newestMod = mod;
            }
        }
        if (newest == null) {
            return Optional.empty();
        }
        if (writeId != null && !newest.getParamKey().equals(prefix + writeId)) {
            AppParameter src = newest;
            appParameterService.setValue(
                    prefix + writeId,
                    src.getParamValue(),
                    src.getValueType(),
                    src.getDescription());
            return appParameterService.find(prefix + writeId);
        }
        return Optional.of(newest);
    }

    private static long modificationEpoch(AppParameter row) {
        if (row.getDateModification() != null) {
            return row.getDateModification().getTime();
        }
        if (row.getDateCreation() != null) {
            return row.getDateCreation().getTime();
        }
        return 0L;
    }

    public void dropAliasKeys(String prefix, String ownerHint) {
        if (!StringUtils.hasText(prefix)) {
            return;
        }
        Owner owner = resolve(ownerHint);
        if (owner.username() == null) {
            return;
        }
        for (String alias : owner.aliases()) {
            if (!alias.equals(owner.username())) {
                appParameterService.delete(prefix + alias);
            }
        }
    }

    public void deleteParams(String prefix, String ownerHint) {
        Owner owner = resolve(ownerHint);
        for (String alias : owner.aliases()) {
            appParameterService.delete(prefix + alias);
        }
    }

    public boolean ownsStored(String storedOwner, String ownerHint) {
        return resolve(ownerHint).owns(storedOwner);
    }

    public List<String> aliases(String ownerHint) {
        return resolve(ownerHint).aliases();
    }

    public static List<String> userKeyPrefixes() {
        List<String> out = new ArrayList<>(PatToolParameterCatalog.MONGO_USER_KEY_PREFIXES);
        if (!out.contains("radio.favorites.")) {
            out.add("radio.favorites.");
        }
        return out;
    }

    private Member findMember(String id) {
        String v = trimToNull(id);
        if (v == null) {
            return null;
        }
        Member byKc = membersRepository.findByKeycloakId(v);
        if (byKc != null) {
            return byKc;
        }
        return membersRepository.findByUserName(v);
    }

    private static void add(Set<String> aliases, String value) {
        String v = trimToNull(value);
        if (v != null) {
            aliases.add(v);
        }
    }

    private static String trimToNull(String value) {
        if (!StringUtils.hasText(value)) {
            return null;
        }
        return value.trim();
    }

    private static boolean looksLikeUuid(String value) {
        return value != null && UUID_ID.matcher(value).matches();
    }

    private static String firstNonUuid(Set<String> aliases) {
        for (String a : aliases) {
            if (!looksLikeUuid(a)) {
                return a;
            }
        }
        return null;
    }
}
