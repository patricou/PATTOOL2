package com.pat.service;

import com.pat.controller.dto.AstroGroundPositionDto;
import com.pat.repo.AstroGroundPositionRepository;
import com.pat.repo.domain.AstroGroundPosition;
import org.springframework.stereotype.Service;
import org.springframework.util.StringUtils;

import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

@Service
public class AstroGroundPositionService {

    static final int MAX_PER_USER = 80;
    static final int MAX_NAME_LENGTH = 80;
    static final int MAX_DESC_LENGTH = 500;
    static final int MAX_ADDRESS_LENGTH = 240;

    private final AstroGroundPositionRepository repository;
    private final UserOwnerService userOwnerService;

    public AstroGroundPositionService(
            AstroGroundPositionRepository repository,
            UserOwnerService userOwnerService) {
        this.repository = repository;
        this.userOwnerService = userOwnerService;
    }

    public List<AstroGroundPositionDto> list(String ownerUsername, String ownerSubject) {
        return listEntities(ownerUsername, ownerSubject).stream().map(this::toDto).toList();
    }

    public AstroGroundPositionDto create(String ownerUsername, String ownerSubject, AstroGroundPositionDto incoming) {
        if (listEntities(ownerUsername, ownerSubject).size() >= MAX_PER_USER) {
            throw new IllegalArgumentException("too many ground positions");
        }
        AstroGroundPosition row = new AstroGroundPosition();
        applyOwner(row, ownerUsername, ownerSubject);
        String now = Instant.now().toString();
        row.setCreatedAt(now);
        row.setUpdatedAt(now);
        applyWrite(row, incoming, true);
        return toDto(repository.save(row));
    }

    public AstroGroundPositionDto update(
            String ownerUsername,
            String ownerSubject,
            String id,
            AstroGroundPositionDto incoming) {
        AstroGroundPosition row = requireOwned(ownerUsername, ownerSubject, id);
        applyWrite(row, incoming, false);
        row.setUpdatedAt(Instant.now().toString());
        return toDto(repository.save(row));
    }

    public void delete(String ownerUsername, String ownerSubject, String id) {
        AstroGroundPosition row = requireOwned(ownerUsername, ownerSubject, id);
        repository.delete(row);
    }

    private List<AstroGroundPosition> listEntities(String ownerUsername, String ownerSubject) {
        Set<String> seen = new LinkedHashSet<>();
        List<AstroGroundPosition> out = new ArrayList<>();
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

    private AstroGroundPosition requireOwned(String ownerUsername, String ownerSubject, String id) {
        if (!StringUtils.hasText(id)) {
            throw new IllegalArgumentException("id required");
        }
        return listEntities(ownerUsername, ownerSubject).stream()
                .filter(c -> id.equals(c.getId()))
                .findFirst()
                .orElseThrow(() -> new IllegalArgumentException("ground position not found"));
    }

    private void applyWrite(AstroGroundPosition row, AstroGroundPositionDto incoming, boolean creating) {
        if (incoming == null) {
            throw new IllegalArgumentException("body required");
        }
        if (creating || incoming.name() != null) {
            row.setName(normalizeName(incoming.name()));
        }
        if (!StringUtils.hasText(row.getName())) {
            throw new IllegalArgumentException("name required");
        }
        if (creating || incoming.description() != null) {
            row.setDescription(normalizeText(incoming.description(), MAX_DESC_LENGTH));
        }
        Double lat = creating || incoming.lat() != null ? incoming.lat() : row.getLat();
        Double lon = creating || incoming.lon() != null ? incoming.lon() : row.getLon();
        if (lat == null || lon == null || !Double.isFinite(lat) || !Double.isFinite(lon)) {
            throw new IllegalArgumentException("gps required");
        }
        if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
            throw new IllegalArgumentException("gps out of range");
        }
        row.setLat(lat);
        row.setLon(lon);
        if (incoming.altM() != null) {
            row.setAltM(Double.isFinite(incoming.altM()) ? incoming.altM() : null);
        } else if (creating) {
            row.setAltM(null);
        }
        if (creating || incoming.address() != null) {
            row.setAddress(normalizeText(incoming.address(), MAX_ADDRESS_LENGTH));
        }
    }

    private void applyOwner(AstroGroundPosition row, String ownerUsername, String ownerSubject) {
        if (!StringUtils.hasText(ownerUsername)) {
            throw new IllegalArgumentException("ownerUsername required");
        }
        row.setOwnerUsername(ownerUsername);
        row.setOwnerSubject(StringUtils.hasText(ownerUsername) ? ownerUsername : ownerSubject);
    }

    private List<AstroGroundPosition> backfillOwner(
            List<AstroGroundPosition> rows, String ownerUsername, String ownerSubject) {
        List<AstroGroundPosition> out = new ArrayList<>();
        for (AstroGroundPosition c : rows) {
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

    private static void addAll(
            List<AstroGroundPosition> out, Set<String> seen, List<AstroGroundPosition> batch) {
        for (AstroGroundPosition c : batch) {
            if (c != null && c.getId() != null && seen.add(c.getId())) {
                out.add(c);
            }
        }
    }

    private AstroGroundPositionDto toDto(AstroGroundPosition c) {
        return new AstroGroundPositionDto(
                c.getId(),
                c.getName(),
                c.getDescription(),
                c.getLat(),
                c.getLon(),
                c.getAltM(),
                c.getAddress(),
                c.getOwnerUsername(),
                c.getCreatedAt(),
                c.getUpdatedAt());
    }

    private static String normalizeName(String name) {
        String trimmed = normalizeText(name, MAX_NAME_LENGTH);
        return trimmed == null ? "" : trimmed;
    }

    private static String normalizeText(String value, int max) {
        if (!StringUtils.hasText(value)) {
            return null;
        }
        String trimmed = value.trim();
        if (trimmed.length() > max) {
            return trimmed.substring(0, max);
        }
        return trimmed;
    }
}
