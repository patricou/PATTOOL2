package com.pat.service;

import com.pat.controller.dto.ArchiveAudioCollectionDto;
import com.pat.controller.dto.ArchiveAudioPlaylistDto;
import com.pat.controller.dto.ArchiveItemDto;
import com.pat.repo.ArchiveAudioCollectionRepository;
import com.pat.repo.domain.ArchiveAudioCollection;
import com.pat.repo.domain.Member;
import org.springframework.stereotype.Service;
import org.springframework.util.StringUtils;

import java.util.ArrayList;
import java.util.Date;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.Set;

/**
 * Shared Archive.org audio collections persisted in Mongo {@code archive_audio_collections}.
 * Anyone may read; only the owning member may create/update/delete or manage items.
 */
@Service
public class ArchiveAudioCollectionService {

    private static final int MAX_ITEMS = 100;
    private static final int MAX_NAME_LEN = 120;
    private static final int MAX_DESC_LEN = 500;
    private static final int MAX_ID_LEN = 200;
    private static final int MAX_TITLE_LEN = 300;
    private static final int MAX_TEXT_LEN = 400;
    private static final int MAX_URL_LEN = 2000;
    private static final int MAX_COLLECTIONS_PER_OWNER = 30;
    private static final Set<String> AUDIO_TYPES = Set.of("audio", "etree");

    private final ArchiveAudioCollectionRepository repository;
    private final ArchiveAudioPlaylistService legacyPlaylistService;

    public ArchiveAudioCollectionService(
            ArchiveAudioCollectionRepository repository,
            ArchiveAudioPlaylistService legacyPlaylistService) {
        this.repository = repository;
        this.legacyPlaylistService = legacyPlaylistService;
    }

    public List<ArchiveAudioCollectionDto> listAll(Member viewer) {
        maybeMigrateLegacy(viewer);
        String viewerId = viewer != null ? viewer.getId() : null;
        List<ArchiveAudioCollection> all = repository.findAllByOrderByUpdatedAtDesc();
        List<ArchiveAudioCollectionDto> out = new ArrayList<>(all.size());
        for (ArchiveAudioCollection entity : all) {
            out.add(toDto(entity, viewerId, false));
        }
        return out;
    }

    public Optional<ArchiveAudioCollectionDto> get(String id, Member viewer) {
        maybeMigrateLegacy(viewer);
        return repository.findById(id)
                .map(entity -> toDto(entity, viewer != null ? viewer.getId() : null, true));
    }

    public ArchiveAudioCollectionDto create(Member owner, ArchiveAudioCollectionDto body) {
        if (owner == null || !StringUtils.hasText(owner.getId())) {
            throw new IllegalArgumentException("owner_required");
        }
        long owned = repository.countByOwnerMemberId(owner.getId());
        if (owned >= MAX_COLLECTIONS_PER_OWNER) {
            throw new IllegalArgumentException("too_many_collections");
        }
        String name = requireName(body != null ? body.getName() : null);
        Date now = new Date();
        ArchiveAudioCollection entity = new ArchiveAudioCollection();
        entity.setName(name);
        entity.setDescription(trimTo(body != null ? body.getDescription() : null, MAX_DESC_LEN));
        entity.setOwnerMemberId(owner.getId());
        entity.setOwnerUsername(resolveUsername(owner));
        entity.setOwnerKeycloakId(owner.getKeycloakId());
        entity.setItems(normalizeItems(body != null ? body.getItems() : null));
        entity.setCreatedAt(now);
        entity.setUpdatedAt(now);
        return toDto(repository.save(entity), owner.getId(), true);
    }

    public Optional<ArchiveAudioCollectionDto> updateMeta(String id, Member me, ArchiveAudioCollectionDto body) {
        ArchiveAudioCollection entity = requireOwned(id, me);
        entity.setName(requireName(body != null ? body.getName() : null));
        entity.setDescription(trimTo(body != null ? body.getDescription() : null, MAX_DESC_LEN));
        entity.setOwnerUsername(resolveUsername(me));
        entity.setUpdatedAt(new Date());
        return Optional.of(toDto(repository.save(entity), me.getId(), true));
    }

    public boolean delete(String id, Member me) {
        ArchiveAudioCollection entity = requireOwned(id, me);
        repository.delete(entity);
        return true;
    }

    public ArchiveAudioCollectionDto addItem(String id, Member me, ArchiveItemDto item) {
        ArchiveAudioCollection entity = requireOwned(id, me);
        ArchiveItemDto normalized = normalizeItem(item);
        if (normalized == null) {
            throw new IllegalArgumentException("invalid_audio_item");
        }
        Map<String, ArchiveItemDto> byId = new LinkedHashMap<>();
        for (ArchiveItemDto existing : entity.getItems()) {
            byId.put(itemKey(existing), existing);
        }
        byId.put(itemKey(normalized), normalized);
        List<ArchiveItemDto> list = new ArrayList<>(byId.values());
        if (list.size() > MAX_ITEMS) {
            list = new ArrayList<>(list.subList(list.size() - MAX_ITEMS, list.size()));
        }
        entity.setItems(list);
        entity.setOwnerUsername(resolveUsername(me));
        entity.setUpdatedAt(new Date());
        return toDto(repository.save(entity), me.getId(), true);
    }

    public ArchiveAudioCollectionDto removeItem(String id, Member me, String identifier) {
        ArchiveAudioCollection entity = requireOwned(id, me);
        if (!StringUtils.hasText(identifier)) {
            return toDto(entity, me.getId(), true);
        }
        String target = identifier.trim();
        List<ArchiveItemDto> kept = new ArrayList<>();
        for (ArchiveItemDto item : entity.getItems()) {
            if (item.getIdentifier() == null || !item.getIdentifier().equals(target)) {
                kept.add(item);
            }
        }
        entity.setItems(kept);
        entity.setOwnerUsername(resolveUsername(me));
        entity.setUpdatedAt(new Date());
        return toDto(repository.save(entity), me.getId(), true);
    }

    private void maybeMigrateLegacy(Member viewer) {
        if (viewer == null || !StringUtils.hasText(viewer.getId()) || !StringUtils.hasText(viewer.getKeycloakId())) {
            return;
        }
        if (repository.countByOwnerMemberId(viewer.getId()) > 0) {
            return;
        }
        ArchiveAudioPlaylistDto legacy = legacyPlaylistService.findForSubject(viewer.getKeycloakId());
        if (legacy == null || legacy.getItems() == null || legacy.getItems().isEmpty()) {
            return;
        }
        Date now = new Date();
        ArchiveAudioCollection entity = new ArchiveAudioCollection();
        entity.setName("My playlist");
        entity.setDescription("Migrated from previous account playlist");
        entity.setOwnerMemberId(viewer.getId());
        entity.setOwnerUsername(resolveUsername(viewer));
        entity.setOwnerKeycloakId(viewer.getKeycloakId());
        entity.setItems(normalizeItems(legacy.getItems()));
        entity.setCreatedAt(now);
        entity.setUpdatedAt(now);
        repository.save(entity);
    }

    private ArchiveAudioCollection requireOwned(String id, Member me) {
        if (me == null || !StringUtils.hasText(me.getId())) {
            throw new SecurityException("not_owner");
        }
        ArchiveAudioCollection entity = repository.findById(id)
                .orElseThrow(() -> new IllegalArgumentException("not_found"));
        if (!me.getId().equals(entity.getOwnerMemberId())) {
            throw new SecurityException("not_owner");
        }
        return entity;
    }

    private ArchiveAudioCollectionDto toDto(ArchiveAudioCollection entity, String viewerMemberId, boolean includeItems) {
        ArchiveAudioCollectionDto dto = new ArchiveAudioCollectionDto();
        dto.setId(entity.getId());
        dto.setName(entity.getName());
        dto.setDescription(entity.getDescription());
        dto.setOwnerMemberId(entity.getOwnerMemberId());
        dto.setOwnerUsername(entity.getOwnerUsername());
        dto.setOwnedByMe(viewerMemberId != null && viewerMemberId.equals(entity.getOwnerMemberId()));
        List<ArchiveItemDto> items = entity.getItems() != null ? entity.getItems() : List.of();
        dto.setItemCount(items.size());
        if (includeItems) {
            dto.setItems(new ArrayList<>(items));
        } else {
            dto.setItems(new ArrayList<>());
        }
        dto.setCreatedAt(entity.getCreatedAt());
        dto.setUpdatedAt(entity.getUpdatedAt());
        return dto;
    }

    private static String requireName(String raw) {
        String name = trimTo(raw, MAX_NAME_LEN);
        if (!StringUtils.hasText(name)) {
            throw new IllegalArgumentException("name_required");
        }
        return name;
    }

    private static List<ArchiveItemDto> normalizeItems(List<ArchiveItemDto> items) {
        if (items == null || items.isEmpty()) {
            return new ArrayList<>();
        }
        Map<String, ArchiveItemDto> byId = new LinkedHashMap<>();
        for (ArchiveItemDto item : items) {
            ArchiveItemDto n = normalizeItem(item);
            if (n != null) {
                byId.putIfAbsent(itemKey(n), n);
            }
            if (byId.size() >= MAX_ITEMS) {
                break;
            }
        }
        return new ArrayList<>(byId.values());
    }

    private static ArchiveItemDto normalizeItem(ArchiveItemDto item) {
        if (item == null) {
            return null;
        }
        String mediatype = trimTo(item.getMediatype(), 40);
        String mt = mediatype != null ? mediatype.toLowerCase(Locale.ROOT) : "";
        if (!AUDIO_TYPES.contains(mt)) {
            return null;
        }
        String identifier = trimTo(item.getIdentifier(), MAX_ID_LEN);
        if (!StringUtils.hasText(identifier)) {
            identifier = trimTo(item.getId(), MAX_ID_LEN);
        }
        if (!StringUtils.hasText(identifier)) {
            return null;
        }
        String title = trimTo(item.getTitle(), MAX_TITLE_LEN);
        if (!StringUtils.hasText(title)) {
            title = identifier;
        }
        ArchiveItemDto out = new ArchiveItemDto();
        out.setId(identifier);
        out.setIdentifier(identifier);
        out.setTitle(title);
        out.setSubtitle(trimTo(item.getSubtitle(), MAX_TEXT_LEN));
        out.setDescription(trimTo(item.getDescription(), MAX_TEXT_LEN));
        out.setCreator(trimTo(item.getCreator(), MAX_TEXT_LEN));
        out.setMediatype(mt);
        out.setYear(trimTo(item.getYear(), 20));
        out.setDate(trimTo(item.getDate(), 40));
        out.setLanguage(trimTo(item.getLanguage(), 80));
        out.setSubject(trimTo(item.getSubject(), MAX_TEXT_LEN));
        out.setCollection(trimTo(item.getCollection(), MAX_TEXT_LEN));
        out.setDownloads(item.getDownloads());
        out.setAvgRating(item.getAvgRating());
        out.setImageUrl(httpUrl(item.getImageUrl()));
        out.setDetailsUrl(httpUrl(item.getDetailsUrl()));
        out.setEmbedUrl(httpUrl(item.getEmbedUrl()));
        out.setPlayable(item.isPlayable());
        return out;
    }

    private static String itemKey(ArchiveItemDto item) {
        return item.getIdentifier() != null
                ? item.getIdentifier().toLowerCase(Locale.ROOT)
                : "";
    }

    private static String httpUrl(String value) {
        String url = trimTo(value, MAX_URL_LEN);
        if (url == null) {
            return null;
        }
        String lower = url.toLowerCase(Locale.ROOT);
        if (!(lower.startsWith("http://") || lower.startsWith("https://"))) {
            return null;
        }
        return url;
    }

    private static String trimTo(String value, int max) {
        if (value == null) {
            return null;
        }
        String t = value.trim();
        if (t.isEmpty()) {
            return null;
        }
        return t.length() > max ? t.substring(0, max) : t;
    }

    private static String resolveUsername(Member m) {
        if (m == null) {
            return null;
        }
        if (StringUtils.hasText(m.getUserName())) {
            return m.getUserName().trim();
        }
        String first = m.getFirstName() != null ? m.getFirstName().trim() : "";
        String last = m.getLastName() != null ? m.getLastName().trim() : "";
        String full = (first + " " + last).trim();
        return StringUtils.hasText(full) ? full : m.getId();
    }
}
