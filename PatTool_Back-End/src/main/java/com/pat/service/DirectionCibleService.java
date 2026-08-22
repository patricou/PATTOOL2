package com.pat.service;

import com.pat.controller.dto.DirectionCibleDto;
import com.pat.repo.DirectionCibleRepository;
import com.pat.repo.domain.DirectionCible;
import org.springframework.stereotype.Service;
import org.springframework.util.StringUtils;

import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

@Service
public class DirectionCibleService {

    static final int MAX_CIBLES_PER_USER = 40;
    static final int MAX_NAME_LENGTH = 80;
    static final int MAX_ADDRESS_LENGTH = 240;
    static final int MAX_PHOTO_LENGTH = 800_000;

    private final DirectionCibleRepository repository;
    private final UserOwnerService userOwnerService;

    public DirectionCibleService(
            DirectionCibleRepository repository,
            UserOwnerService userOwnerService) {
        this.repository = repository;
        this.userOwnerService = userOwnerService;
    }

    public List<DirectionCibleDto> list(String ownerUsername, String ownerSubject) {
        return listEntities(ownerUsername, ownerSubject).stream().map(this::toDto).toList();
    }

    public DirectionCibleDto create(String ownerUsername, String ownerSubject, DirectionCibleDto incoming) {
        if (listEntities(ownerUsername, ownerSubject).size() >= MAX_CIBLES_PER_USER) {
            throw new IllegalArgumentException("too many cibles");
        }
        DirectionCible row = new DirectionCible();
        applyOwner(row, ownerUsername, ownerSubject);
        String now = Instant.now().toString();
        row.setCreatedAt(now);
        row.setUpdatedAt(now);
        applyWrite(row, incoming, true);
        if (row.isActive()) {
            clearActiveExcept(ownerUsername, ownerSubject, null);
        }
        return toDto(repository.save(row));
    }

    public DirectionCibleDto update(String ownerUsername, String ownerSubject, String id, DirectionCibleDto incoming) {
        DirectionCible row = requireOwned(ownerUsername, ownerSubject, id);
        applyWrite(row, incoming, false);
        row.setUpdatedAt(Instant.now().toString());
        if (Boolean.TRUE.equals(incoming.active())) {
            clearActiveExcept(ownerUsername, ownerSubject, row.getId());
            row.setActive(true);
        }
        return toDto(repository.save(row));
    }

    public DirectionCibleDto recalibrate(String ownerUsername, String ownerSubject, String id, DirectionCibleDto incoming) {
        DirectionCible row = requireOwned(ownerUsername, ownerSubject, id);
        if (incoming.phoneHeadingDeg() != null) {
            row.setPhoneHeadingDeg(normalizeDeg(incoming.phoneHeadingDeg()));
        }
        applyMark(row, incoming);
        if (incoming.refAzimuthDeg() != null && (row.getRefAzimuthDeg() == null || hasMark(row))) {
            row.setRefAzimuthDeg(normalizeDeg(incoming.refAzimuthDeg()));
        }
        if (incoming.phoneElevationDeg() != null) {
            row.setPhoneElevationDeg(clampEl(incoming.phoneElevationDeg()));
        }
        if (incoming.userLat() != null && incoming.userLon() != null) {
            row.setUserLat(incoming.userLat());
            row.setUserLon(incoming.userLon());
            row.setUserAccM(incoming.userAccM());
        }
        if (incoming.photoDataUrl() != null) {
            row.setPhotoDataUrl(normalizePhoto(incoming.photoDataUrl()));
        }
        if (StringUtils.hasText(incoming.name())) {
            row.setName(normalizeName(incoming.name()));
        }
        row.setUpdatedAt(Instant.now().toString());
        row.setActive(true);
        clearActiveExcept(ownerUsername, ownerSubject, row.getId());
        return toDto(repository.save(row));
    }

    public DirectionCibleDto setActive(String ownerUsername, String ownerSubject, String id) {
        DirectionCible row = requireOwned(ownerUsername, ownerSubject, id);
        clearActiveExcept(ownerUsername, ownerSubject, row.getId());
        row.setActive(true);
        row.setUpdatedAt(Instant.now().toString());
        return toDto(repository.save(row));
    }

    public void delete(String ownerUsername, String ownerSubject, String id) {
        DirectionCible row = requireOwned(ownerUsername, ownerSubject, id);
        repository.delete(row);
    }

    private List<DirectionCible> listEntities(String ownerUsername, String ownerSubject) {
        Set<String> seen = new LinkedHashSet<>();
        List<DirectionCible> out = new ArrayList<>();
        if (StringUtils.hasText(ownerUsername)) {
            addAll(out, seen, backfillOwner(
                    repository.findByOwnerUsernameOrderByUpdatedAtDesc(ownerUsername),
                    ownerUsername,
                    ownerSubject));
        }
        for (String sub : ownerSubjects(ownerUsername, ownerSubject)) {
            addAll(out, seen, backfillOwner(
                    repository.findByOwnerSubjectOrderByUpdatedAtDesc(sub),
                    ownerUsername,
                    ownerSubject));
        }
        return out;
    }

    private DirectionCible requireOwned(String ownerUsername, String ownerSubject, String id) {
        if (!StringUtils.hasText(id)) {
            throw new IllegalArgumentException("id required");
        }
        return listEntities(ownerUsername, ownerSubject).stream()
                .filter(c -> id.equals(c.getId()))
                .findFirst()
                .orElseThrow(() -> new IllegalArgumentException("cible not found"));
    }

    private void applyWrite(DirectionCible row, DirectionCibleDto incoming, boolean creating) {
        if (incoming == null) {
            throw new IllegalArgumentException("body required");
        }
        if (creating || incoming.name() != null) {
            row.setName(normalizeName(incoming.name()));
        }
        if (creating && !StringUtils.hasText(row.getName())) {
            throw new IllegalArgumentException("name required");
        }
        if (incoming.userLat() != null) {
            row.setUserLat(incoming.userLat());
        }
        if (incoming.userLon() != null) {
            row.setUserLon(incoming.userLon());
        }
        if (incoming.userAccM() != null) {
            row.setUserAccM(incoming.userAccM());
        }
        if (incoming.phoneHeadingDeg() != null) {
            row.setPhoneHeadingDeg(normalizeDeg(incoming.phoneHeadingDeg()));
        }
        applyMark(row, incoming);
        if (incoming.refAzimuthDeg() != null
                && (creating || row.getRefAzimuthDeg() == null || hasMark(row))) {
            row.setRefAzimuthDeg(normalizeDeg(incoming.refAzimuthDeg()));
        }
        if (incoming.phoneElevationDeg() != null) {
            row.setPhoneElevationDeg(clampEl(incoming.phoneElevationDeg()));
        }
        if (incoming.photoDataUrl() != null) {
            row.setPhotoDataUrl(normalizePhoto(incoming.photoDataUrl()));
        }
        if (incoming.active() != null) {
            row.setActive(incoming.active());
        } else if (creating) {
            row.setActive(true);
        }
    }

    private void applyOwner(DirectionCible row, String ownerUsername, String ownerSubject) {
        if (!StringUtils.hasText(ownerUsername)) {
            throw new IllegalArgumentException("ownerUsername required");
        }
        row.setOwnerUsername(ownerUsername);
        row.setOwnerSubject(StringUtils.hasText(ownerUsername) ? ownerUsername : ownerSubject);
    }

    private void clearActiveExcept(String ownerUsername, String ownerSubject, String keepId) {
        for (DirectionCible c : listEntities(ownerUsername, ownerSubject)) {
            if (c.isActive() && (keepId == null || !keepId.equals(c.getId()))) {
                c.setActive(false);
                repository.save(c);
            }
        }
    }

    private List<DirectionCible> backfillOwner(
            List<DirectionCible> rows, String ownerUsername, String ownerSubject) {
        List<DirectionCible> out = new ArrayList<>();
        for (DirectionCible c : rows) {
            if (c == null) {
                continue;
            }
            boolean dirty = false;
            if (StringUtils.hasText(ownerUsername) && !ownerUsername.equals(c.getOwnerUsername())) {
                c.setOwnerUsername(ownerUsername);
                dirty = true;
            }
            if (StringUtils.hasText(ownerUsername) && !ownerUsername.equals(c.getOwnerSubject())) {
                c.setOwnerSubject(ownerUsername);
                dirty = true;
            }
            out.add(dirty ? repository.save(c) : c);
        }
        return out;
    }

    private Set<String> ownerSubjects(String ownerUsername, String ownerSubject) {
        Set<String> subjects = new LinkedHashSet<>();
        if (StringUtils.hasText(ownerSubject)) {
            subjects.addAll(userOwnerService.aliases(ownerSubject));
        }
        if (StringUtils.hasText(ownerUsername)) {
            subjects.addAll(userOwnerService.aliases(ownerUsername));
        }
        return subjects;
    }

    private static void addAll(List<DirectionCible> out, Set<String> seen, List<DirectionCible> batch) {
        for (DirectionCible c : batch) {
            if (c != null && c.getId() != null && seen.add(c.getId())) {
                out.add(c);
            }
        }
    }

    private DirectionCibleDto toDto(DirectionCible c) {
        return new DirectionCibleDto(
                c.getId(),
                c.getName(),
                c.getUserLat(),
                c.getUserLon(),
                c.getUserAccM(),
                c.getPhoneHeadingDeg(),
                c.getRefAzimuthDeg(),
                c.getPhoneElevationDeg(),
                c.getMarkLat(),
                c.getMarkLon(),
                c.getMarkAltM(),
                c.getMarkAddress(),
                null,
                c.getPhotoDataUrl(),
                c.isActive(),
                c.getOwnerUsername(),
                c.getCreatedAt(),
                c.getUpdatedAt());
    }

    private static void applyMark(DirectionCible row, DirectionCibleDto incoming) {
        if (Boolean.TRUE.equals(incoming.clearMark())) {
            row.setMarkLat(null);
            row.setMarkLon(null);
            row.setMarkAltM(null);
            row.setMarkAddress(null);
            return;
        }
        if (incoming.markLat() != null && incoming.markLon() != null) {
            boolean moved =
                    row.getMarkLat() == null
                            || row.getMarkLon() == null
                            || !incoming.markLat().equals(row.getMarkLat())
                            || !incoming.markLon().equals(row.getMarkLon());
            row.setMarkLat(incoming.markLat());
            row.setMarkLon(incoming.markLon());
            if (incoming.markAltM() != null) {
                row.setMarkAltM(incoming.markAltM());
            }
            if (incoming.markAddress() != null) {
                row.setMarkAddress(normalizeAddress(incoming.markAddress()));
            } else if (moved) {
                row.setMarkAddress(null);
            }
        } else if (incoming.markAddress() != null) {
            row.setMarkAddress(normalizeAddress(incoming.markAddress()));
        }
    }

    private static boolean hasMark(DirectionCible row) {
        return row.getMarkLat() != null && row.getMarkLon() != null;
    }

    private static String normalizeName(String name) {
        if (!StringUtils.hasText(name)) {
            return "";
        }
        String trimmed = name.trim();
        if (trimmed.length() > MAX_NAME_LENGTH) {
            return trimmed.substring(0, MAX_NAME_LENGTH);
        }
        return trimmed;
    }

    private static String normalizeAddress(String address) {
        if (!StringUtils.hasText(address)) {
            return null;
        }
        String trimmed = address.trim();
        if (trimmed.length() > MAX_ADDRESS_LENGTH) {
            return trimmed.substring(0, MAX_ADDRESS_LENGTH);
        }
        return trimmed;
    }

    private static String normalizePhoto(String photo) {
        if (!StringUtils.hasText(photo)) {
            return null;
        }
        String value = photo.trim();
        if (!value.startsWith("data:image/")) {
            throw new IllegalArgumentException("invalid photo");
        }
        if (value.length() > MAX_PHOTO_LENGTH) {
            throw new IllegalArgumentException("photo too large");
        }
        return value;
    }

    private static Double normalizeDeg(Double deg) {
        if (deg == null || !Double.isFinite(deg)) {
            return null;
        }
        return ((deg % 360d) + 360d) % 360d;
    }

    private static Double clampEl(Double deg) {
        if (deg == null || !Double.isFinite(deg)) {
            return null;
        }
        return Math.max(-90d, Math.min(90d, deg));
    }
}
