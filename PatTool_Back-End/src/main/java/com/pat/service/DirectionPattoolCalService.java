package com.pat.service;

import com.pat.repo.DirectionPattoolSampleRepository;
import com.pat.repo.domain.DirectionPattoolSample;
import org.springframework.stereotype.Service;
import org.springframework.util.StringUtils;

import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

@Service
public class DirectionPattoolCalService {

    private static final int MAX_SAMPLES_PER_USER = 400;

    private final DirectionPattoolSampleRepository repository;
    private final UserOwnerService userOwnerService;

    public DirectionPattoolCalService(
            DirectionPattoolSampleRepository repository,
            UserOwnerService userOwnerService) {
        this.repository = repository;
        this.userOwnerService = userOwnerService;
    }

    public DirectionPattoolSample save(
            String ownerUsername,
            String ownerSubject,
            DirectionPattoolSample incoming) {
        if (!StringUtils.hasText(ownerUsername)) {
            throw new IllegalArgumentException("ownerUsername required");
        }
        if (incoming == null || !StringUtils.hasText(incoming.getPoseId())) {
            throw new IllegalArgumentException("poseId required");
        }
        if (!StringUtils.hasText(incoming.getSessionId())) {
            throw new IllegalArgumentException("sessionId required");
        }
        if (list(ownerUsername, ownerSubject).size() >= MAX_SAMPLES_PER_USER) {
            throw new IllegalArgumentException("too many samples");
        }
        incoming.setId(null);
        incoming.setOwnerUsername(ownerUsername);
        incoming.setOwnerSubject(ownerUsername);
        if (!StringUtils.hasText(incoming.getCapturedAt())) {
            incoming.setCapturedAt(Instant.now().toString());
        }
        return repository.save(incoming);
    }

    /**
     * Poses of this Member surnom, including legacy rows keyed only by a Keycloak {@code sub}
     * (JWT subject and/or {@code Member.keycloakId}, which can differ between devices).
     */
    public List<DirectionPattoolSample> list(String ownerUsername, String ownerSubject) {
        Set<String> seen = new LinkedHashSet<>();
        List<DirectionPattoolSample> out = new ArrayList<>();
        if (StringUtils.hasText(ownerUsername)) {
            addAll(
                    out,
                    seen,
                    backfillOwner(
                            repository.findByOwnerUsernameOrderByCapturedAtAsc(ownerUsername),
                            ownerUsername,
                            ownerSubject));
        }
        for (String sub : ownerSubjects(ownerUsername, ownerSubject)) {
            List<DirectionPattoolSample> bySub = repository.findByOwnerSubjectOrderByCapturedAtAsc(sub);
            if (StringUtils.hasText(ownerUsername)) {
                bySub = backfillOwner(bySub, ownerUsername, ownerSubject);
            }
            addAll(out, seen, bySub);
        }
        return out;
    }

    public long count(String ownerUsername, String ownerSubject) {
        return list(ownerUsername, ownerSubject).size();
    }

    public Map<String, Object> export(String ownerUsername, String ownerSubject) {
        List<DirectionPattoolSample> samples = list(ownerUsername, ownerSubject);
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("version", 1);
        out.put("kind", "pattool-direction-cal");
        out.put("ownerUsername", ownerUsername);
        out.put("exportedAt", Instant.now().toString());
        out.put("count", samples.size());
        out.put("samples", samples);
        return out;
    }

    public Map<String, Object> listPayload(String ownerUsername, String ownerSubject) {
        List<DirectionPattoolSample> samples = list(ownerUsername, ownerSubject);
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("ownerUsername", ownerUsername);
        out.put("count", samples.size());
        out.put("samples", samples);
        return out;
    }

    public void deleteAll(String ownerUsername, String ownerSubject) {
        if (StringUtils.hasText(ownerUsername)) {
            repository.deleteByOwnerUsername(ownerUsername);
        }
        for (String sub : ownerSubjects(ownerUsername, ownerSubject)) {
            repository.deleteByOwnerSubject(sub);
        }
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

    /** Persist the Member surnom; Keycloak ids remain readable via {@link #ownerSubjects}. */
    private String canonicalOwnerSubject(String ownerUsername, String ownerSubject) {
        if (StringUtils.hasText(ownerUsername)) {
            return ownerUsername.trim();
        }
        return StringUtils.hasText(ownerSubject) ? ownerSubject.trim() : null;
    }

    private List<DirectionPattoolSample> backfillOwner(
            List<DirectionPattoolSample> samples, String ownerUsername, String ownerSubject) {
        String canonical = canonicalOwnerSubject(ownerUsername, ownerSubject);
        List<DirectionPattoolSample> out = new ArrayList<>(samples.size());
        for (DirectionPattoolSample s : samples) {
            if (s == null) {
                continue;
            }
            boolean dirty = false;
            if (StringUtils.hasText(ownerUsername) && !ownerUsername.equals(s.getOwnerUsername())) {
                s.setOwnerUsername(ownerUsername);
                dirty = true;
            }
            if (StringUtils.hasText(canonical) && !canonical.equals(s.getOwnerSubject())) {
                s.setOwnerSubject(canonical);
                dirty = true;
            }
            out.add(dirty ? repository.save(s) : s);
        }
        return out;
    }

    private static void addAll(
            List<DirectionPattoolSample> out,
            Set<String> seen,
            List<DirectionPattoolSample> batch) {
        for (DirectionPattoolSample s : batch) {
            if (s != null && s.getId() != null && seen.add(s.getId())) {
                out.add(s);
            }
        }
    }
}
