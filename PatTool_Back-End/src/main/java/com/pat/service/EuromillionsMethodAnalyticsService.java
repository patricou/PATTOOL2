package com.pat.service;

import com.pat.controller.dto.EuromMethodEntryDto;
import com.pat.controller.dto.EuromillionsMethodAnalyticsDto;
import com.pat.repo.EuromillionsDrawRepository;
import com.pat.repo.EuromillionsMethodAnalyticsRepository;
import com.pat.repo.domain.EuromillionsDraw;
import com.pat.repo.domain.EuromillionsMethodAnalyticsDocument;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

@Service
public class EuromillionsMethodAnalyticsService {

    private static final Logger log = LoggerFactory.getLogger(EuromillionsMethodAnalyticsService.class);

    private final EuromillionsDrawRepository drawRepository;
    private final EuromillionsMethodAnalyticsRepository snapshotRepository;
    private final EuromillionsAiSettingsService aiSettingsService;

    public EuromillionsMethodAnalyticsService(
            EuromillionsDrawRepository drawRepository,
            EuromillionsMethodAnalyticsRepository snapshotRepository,
            EuromillionsAiSettingsService aiSettingsService) {
        this.drawRepository = drawRepository;
        this.snapshotRepository = snapshotRepository;
        this.aiSettingsService = aiSettingsService;
    }

    /**
     * @param forceRecompute si {@code true}, ignore le snapshot Mongo même si encore aligné sur les tirages.
     */
    public EuromillionsMethodAnalyticsDto getSnapshot(boolean forceRecompute) {
        String sinceInclusive =
                aiSettingsService.effectiveMinDrawDate().minDrawDateIso().substring(0, 10);
        LocalDate min = LocalDate.parse(sinceInclusive);
        long liveCount = drawRepository.countByDrawDateGreaterThanEqual(min);

        if (!forceRecompute) {
            Optional<EuromillionsMethodAnalyticsDocument> opt =
                    snapshotRepository.findById(EuromillionsMethodAnalyticsDocument.SINGLETON_ID);
            if (opt.isPresent()) {
                EuromillionsMethodAnalyticsDocument doc = opt.get();
                if (sinceInclusive.equals(doc.getSinceInclusive()) && liveCount == doc.getDrawCount()) {
                    return toDto(doc);
                }
            }
        }

        return computePersistAndReturn(sinceInclusive, min, liveCount);
    }

    /** À appeler après import CSV — silence les erreurs pour ne pas masquer le résultat d’import. */
    public void refreshSnapshotBestEffort() {
        try {
            getSnapshot(true);
        } catch (RuntimeException e) {
            log.warn("Euromillions method-analytics recompute after import failed: {}", e.getMessage());
        }
    }

    private EuromillionsMethodAnalyticsDto computePersistAndReturn(
            String sinceInclusive, LocalDate min, long liveCount) {
        List<EuromillionsDraw> ascending =
                liveCount > 0 ? drawRepository.findByDrawDateGreaterThanEqualOrderByDrawDateAsc(min)
                        : List.of();

        Map<String, Map<String, Object>> computed =
                EuromillionsMethodAnalyticsCalculator.computeAll(ascending);

        EuromillionsMethodAnalyticsDocument doc = new EuromillionsMethodAnalyticsDocument();
        doc.setId(EuromillionsMethodAnalyticsDocument.SINGLETON_ID);
        doc.setComputedAt(Instant.now());
        doc.setSinceInclusive(sinceInclusive);
        doc.setDrawCount(liveCount);
        Map<String, Map<String, Object>> persisted = new LinkedHashMap<>();
        for (Map.Entry<String, Map<String, Object>> e : computed.entrySet()) {
            persisted.put(e.getKey(), deepCopyMap(e.getValue()));
        }
        doc.setMethods(persisted);
        EuromillionsMethodAnalyticsDocument saved = snapshotRepository.save(doc);
        return toDto(saved);
    }

    private static Map<String, Object> deepCopyMap(Map<String, Object> src) {
        Map<String, Object> out = new LinkedHashMap<>();
        if (src == null) {
            return out;
        }
        for (Map.Entry<String, Object> e : src.entrySet()) {
            Object v = e.getValue();
            if (v instanceof Map<?, ?> m) {
                Map<String, Object> inner = new LinkedHashMap<>();
                for (Map.Entry<?, ?> ie : m.entrySet()) {
                    if (ie.getKey() != null) {
                        inner.put(String.valueOf(ie.getKey()), ie.getValue());
                    }
                }
                out.put(e.getKey(), inner);
            } else if (v instanceof List<?> list) {
                List<Object> nl = new ArrayList<>();
                for (Object o : list) {
                    if (o instanceof Map<?, ?> m) {
                        Map<String, Object> inner = new LinkedHashMap<>();
                        for (Map.Entry<?, ?> ie : m.entrySet()) {
                            if (ie.getKey() != null) {
                                inner.put(String.valueOf(ie.getKey()), ie.getValue());
                            }
                        }
                        nl.add(inner);
                    } else {
                        nl.add(o);
                    }
                }
                out.put(e.getKey(), nl);
            } else {
                out.put(e.getKey(), v);
            }
        }
        return out;
    }

    private EuromillionsMethodAnalyticsDto toDto(EuromillionsMethodAnalyticsDocument doc) {
        List<EuromMethodEntryDto> list = new ArrayList<>();
        Map<String, Map<String, Object>> byId = doc.getMethods();
        if (byId != null) {
            for (String id : EuromillionsMethodIds.ORDERED) {
                Map<String, Object> m = byId.get(id);
                if (m != null) {
                    list.add(new EuromMethodEntryDto(id, m));
                }
            }
        }
        Instant t = doc.getComputedAt();
        String iso =
                t != null ? t.atOffset(ZoneOffset.UTC).toString() : Instant.EPOCH.atOffset(ZoneOffset.UTC).toString();
        return new EuromillionsMethodAnalyticsDto(
                doc.getSinceInclusive() != null ? doc.getSinceInclusive() : "",
                doc.getDrawCount(),
                iso,
                list);
    }
}
