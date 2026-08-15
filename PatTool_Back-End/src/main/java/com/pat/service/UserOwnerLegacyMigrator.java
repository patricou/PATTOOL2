package com.pat.service;

import com.pat.repo .AssistantConversationAssetRepository;
import com.pat.repo.AssistantConversationRepository;
import com.pat.repo.DirectionPattoolSampleRepository;
import com.pat.repo.MembersRepository;
import com.pat.repo.TvRecordingRepository;
import com.pat.repo.domain.AppParameter;
import com.pat.repo.domain.AssistantConversation;
import com.pat.repo.domain.AssistantConversationAsset;
import com.pat.repo.domain.DirectionPattoolSample;
import com.pat.repo.domain.Member;
import com.pat.repo.domain.TvRecording;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
// import org.springframework.boot.context.event.ApplicationReadyEvent;
// import org.springframework.context.event.EventListener;
import org.springframework.stereotype.Component;
import org.springframework.util.StringUtils;

import java.util.HashMap;
import java.util.Map;
import java.util.regex.Pattern;

/**
 * Rewrites per-user Mongo rows keyed by Keycloak id onto Member {@code userName}.
 */
@Component
public class UserOwnerLegacyMigrator {

    private static final Logger log = LoggerFactory.getLogger(UserOwnerLegacyMigrator.class);
    private static final Pattern UUID =
            Pattern.compile("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", Pattern.CASE_INSENSITIVE);

    private final AppParameterService appParameterService;
    private final MembersRepository membersRepository;
    private final AssistantConversationRepository conversationRepository;
    private final AssistantConversationAssetRepository assetRepository;
    private final TvRecordingRepository tvRecordingRepository;
    private final DirectionPattoolSampleRepository directionSampleRepository;

    public UserOwnerLegacyMigrator(
            AppParameterService appParameterService,
            MembersRepository membersRepository,
            AssistantConversationRepository conversationRepository,
            AssistantConversationAssetRepository assetRepository,
            TvRecordingRepository tvRecordingRepository,
            DirectionPattoolSampleRepository directionSampleRepository) {
        this.appParameterService = appParameterService;
        this.membersRepository = membersRepository;
        this.conversationRepository = conversationRepository;
        this.assetRepository = assetRepository;
        this.tvRecordingRepository = tvRecordingRepository;
        this.directionSampleRepository = directionSampleRepository;
    }

    // One-shot: already ran (2026-08-14). New writes use username; leave disabled.
    // @EventListener(ApplicationReadyEvent.class)
    public void migrate() {
        Map<String, String> idToUsername = buildIdMap();
        int params = migrateAppParameters(idToUsername);
        int conv = migrateConversations(idToUsername);
        int assets = migrateAssets(idToUsername);
        int tv = migrateTv(idToUsername);
        int dir = migrateDirection(idToUsername);
        if (params + conv + assets + tv + dir > 0) {
            log.info(
                    "User-owner migration: appParameters={} conversations={} assets={} tvRecordings={} directionSamples={}",
                    params, conv, assets, tv, dir);
        }
    }

    private Map<String, String> buildIdMap() {
        Map<String, String> map = new HashMap<>();
        for (Member m : membersRepository.findAll()) {
            String username = trim(m.getUserName());
            if (username == null) {
                continue;
            }
            map.put(username, username);
            String kc = trim(m.getKeycloakId());
            if (kc != null) {
                map.put(kc, username);
            }
        }
        for (AssistantConversation c : conversationRepository.findAll()) {
            String stored = trim(c.getOwnerSubject());
            String preferred = trim(c.getOwnerPreferredUsername());
            if (stored == null || preferred == null || !UUID.matcher(stored).matches()) {
                continue;
            }
            map.putIfAbsent(stored, preferred);
        }
        for (DirectionPattoolSample s : directionSampleRepository.findAll()) {
            String user = trim(s.getOwnerUsername());
            String sub = trim(s.getOwnerSubject());
            if (user == null || sub == null || !UUID.matcher(sub).matches()) {
                continue;
            }
            map.putIfAbsent(sub, user);
        }
        return map;
    }

    private int migrateAppParameters(Map<String, String> idToUsername) {
        int n = 0;
        for (String prefix : UserOwnerService.userKeyPrefixes()) {
            for (AppParameter row : appParameterService.findByParamKeyStartingWith(prefix)) {
                String key = row.getParamKey();
                if (key == null || !key.startsWith(prefix)) {
                    continue;
                }
                String suffix = key.substring(prefix.length());
                if (!StringUtils.hasText(suffix) || suffix.contains(".")) {
                    continue;
                }
                String username = idToUsername.get(suffix.trim());
                if (username == null || username.equals(suffix.trim())) {
                    continue;
                }
                String dest = prefix + username;
                if (appParameterService.find(dest).isEmpty()) {
                    appParameterService.setValue(dest, row.getParamValue(), row.getValueType(), row.getDescription());
                }
                appParameterService.delete(key);
                n++;
            }
        }
        return n;
    }

    private int migrateConversations(Map<String, String> idToUsername) {
        int n = 0;
        for (AssistantConversation c : conversationRepository.findAll()) {
            String stored = trim(c.getOwnerSubject());
            if (stored == null) {
                continue;
            }
            String username = idToUsername.get(stored);
            if (username == null || username.equals(stored)) {
                continue;
            }
            c.setOwnerSubject(username);
            if (!StringUtils.hasText(c.getOwnerPreferredUsername())) {
                c.setOwnerPreferredUsername(username);
            }
            conversationRepository.save(c);
            n++;
        }
        return n;
    }

    private int migrateAssets(Map<String, String> idToUsername) {
        int n = 0;
        for (AssistantConversationAsset a : assetRepository.findAll()) {
            String stored = trim(a.getOwnerSubject());
            if (stored == null) {
                continue;
            }
            String username = idToUsername.get(stored);
            if (username == null || username.equals(stored)) {
                continue;
            }
            a.setOwnerSubject(username);
            assetRepository.save(a);
            n++;
        }
        return n;
    }

    private int migrateTv(Map<String, String> idToUsername) {
        int n = 0;
        for (TvRecording rec : tvRecordingRepository.findAll()) {
            String stored = trim(rec.getOwnerSub());
            if (stored == null) {
                continue;
            }
            String username = idToUsername.get(stored);
            if (username == null || username.equals(stored)) {
                continue;
            }
            rec.setOwnerSub(username);
            tvRecordingRepository.save(rec);
            n++;
        }
        return n;
    }

    private int migrateDirection(Map<String, String> idToUsername) {
        int n = 0;
        for (DirectionPattoolSample s : directionSampleRepository.findAll()) {
            boolean dirty = false;
            String user = trim(s.getOwnerUsername());
            String sub = trim(s.getOwnerSubject());
            if (user == null && sub != null) {
                String mapped = idToUsername.get(sub);
                if (mapped != null) {
                    s.setOwnerUsername(mapped);
                    user = mapped;
                    dirty = true;
                }
            }
            if (user != null && (sub == null || !user.equals(sub))) {
                s.setOwnerSubject(user);
                dirty = true;
            }
            if (dirty) {
                directionSampleRepository.save(s);
                n++;
            }
        }
        return n;
    }

    private static String trim(String value) {
        if (!StringUtils.hasText(value)) {
            return null;
        }
        return value.trim();
    }
}
