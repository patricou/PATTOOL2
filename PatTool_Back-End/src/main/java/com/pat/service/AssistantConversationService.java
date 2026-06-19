package com.pat.service;

import com.pat.controller.dto.AssistantConversationCreatedDto;
import com.pat.controller.dto.AssistantConversationDetailDto;
import com.pat.controller.dto.AssistantConversationSaveRequestDto;
import com.pat.controller.dto.AssistantConversationSummaryDto;
import com.pat.controller.dto.AssistantConversationTurnPersistDto;
import com.pat.controller.dto.AssistantTurnMetaPersistDto;
import com.pat.repo.AssistantConversationRepository;
import com.pat.repo.domain.AssistantConversation;
import com.pat.repo.domain.AssistantConversationTurn;
import com.pat.repo.domain.AssistantConversationTurnMeta;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.web.server.ResponseStatusException;

import java.time.Instant;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Optional;
import java.util.Set;

@Service
public class AssistantConversationService {

    static final int MAX_TURNS = 40;
    /** Limite conservative sous le plafond BSON (~16 Mo). */
    static final int MAX_TOTAL_CHAR_WEIGHT = 11_000_000;
    static final int MAX_SINGLE_IMAGE_DATA_URL_CHARS = 11_000_000;
    static final int MAX_GENERATED_ASSETS_PER_TURN = 16;
    private static final int PREVIEW_MAX = 160;

    private final AssistantConversationRepository repository;
    private final AssistantConversationAssetService assetService;

    public AssistantConversationService(
            AssistantConversationRepository repository,
            AssistantConversationAssetService assetService) {
        this.repository = repository;
        this.assetService = assetService;
    }

    /**
     * @param viewerSubject {@code sub} JWT de l’utilisateur qui consulte la liste
     * @param viewerPreferredUsername {@code preferred_username} du JWT (pour afficher un login là où Mongo ne l’a pas encore)
     */
    public List<AssistantConversationSummaryDto> listSummaries(
            String viewerSubject, String viewerPreferredUsername, boolean assistantAdmin) {
        if (viewerSubject == null || viewerSubject.isBlank()) {
            return List.of();
        }
        List<AssistantConversation> rows =
                assistantAdmin
                        ? repository.findTop100ByOrderByUpdatedAtDesc()
                        : repository.findTop100ByOwnerSubjectOrderByUpdatedAtDesc(viewerSubject);
        return rows.stream()
                .map(doc -> toSummary(doc, viewerSubject, viewerPreferredUsername))
                .toList();
    }

    public Optional<AssistantConversationDetailDto> getDetail(String ownerSubject, String id, boolean assistantAdmin) {
        if (ownerSubject == null || ownerSubject.isBlank() || id == null || id.isBlank()) {
            return Optional.empty();
        }
        return repository
                .findById(id.strip())
                .filter(d -> assistantAdmin || ownerSubject.equals(d.getOwnerSubject()))
                .map(this::toDetail);
    }

    public AssistantConversationCreatedDto create(
            String ownerSubject, String ownerPreferredUsername, AssistantConversationSaveRequestDto req) {
        validate(ownerSubject, req, false);
        AssistantConversation doc = new AssistantConversation();
        doc.setOwnerSubject(ownerSubject);
        if (ownerPreferredUsername != null && !ownerPreferredUsername.isBlank()) {
            doc.setOwnerPreferredUsername(ownerPreferredUsername.strip());
        }
        Instant now = Instant.now();
        doc.setCreatedAt(now);
        doc.setUpdatedAt(now);
        doc.setRoutingProvider(req.routingProvider().trim().toLowerCase());
        doc.setProviderLabel(trimOrEmpty(req.providerLabel()));
        doc.setModel(req.model().trim());
        doc.setTurns(mapIncomingTurns(req.turns()));
        AssistantConversation saved = repository.save(doc);
        return new AssistantConversationCreatedDto(saved.getId());
    }

    public void update(
            String ownerSubject,
            String id,
            AssistantConversationSaveRequestDto req,
            boolean assistantAdmin,
            String jwtPreferredUsername) {
        validate(ownerSubject, req, assistantAdmin);
        if (id == null || id.isBlank()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "id required");
        }
        AssistantConversation doc =
                repository.findById(id.strip()).orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND));
        if (!assistantAdmin && !ownerSubject.equals(doc.getOwnerSubject())) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND);
        }
        final String assetOwner = doc.getOwnerSubject();
        List<String> previousAssets = collectGeneratedAssetIds(doc.getTurns());
        doc.setUpdatedAt(Instant.now());
        doc.setRoutingProvider(req.routingProvider().trim().toLowerCase());
        doc.setProviderLabel(trimOrEmpty(req.providerLabel()));
        doc.setModel(req.model().trim());
        doc.setTurns(mapIncomingTurns(req.turns()));
        if ((doc.getOwnerPreferredUsername() == null || doc.getOwnerPreferredUsername().isBlank())
                && jwtPreferredUsername != null
                && !jwtPreferredUsername.isBlank()
                && ownerSubject.equals(doc.getOwnerSubject())) {
            doc.setOwnerPreferredUsername(jwtPreferredUsername.strip());
        }
        repository.save(doc);
        Set<String> kept = new HashSet<>(collectGeneratedAssetIds(doc.getTurns()));
        for (String aid : previousAssets) {
            if (!kept.contains(aid)) {
                assetService.deleteIfOwned(assetOwner, aid);
            }
        }
    }

    /** @return {@code true} si une ligne a été supprimée */
    public boolean delete(String ownerSubject, String id, boolean assistantAdmin) {
        if (ownerSubject == null || ownerSubject.isBlank() || id == null || id.isBlank()) {
            return false;
        }
        Optional<AssistantConversation> doc = repository.findById(id.strip());
        if (doc.isEmpty()) {
            return false;
        }
        if (!assistantAdmin && !ownerSubject.equals(doc.get().getOwnerSubject())) {
            return false;
        }
        List<String> assets = collectGeneratedAssetIds(doc.get().getTurns());
        repository.deleteById(doc.get().getId());
        assetService.deleteAllIfOwned(doc.get().getOwnerSubject(), assets);
        return true;
    }

    private static String trimOrEmpty(String s) {
        return s != null ? s.trim() : "";
    }

    private static List<String> normalizedGeneratedAssetIds(AssistantConversationTurnPersistDto t) {
        if (t.generatedImageAssetIds() == null || t.generatedImageAssetIds().isEmpty()) {
            return List.of();
        }
        List<String> out = new ArrayList<>();
        for (String raw : t.generatedImageAssetIds()) {
            if (raw == null || raw.isBlank()) {
                continue;
            }
            out.add(raw.strip());
        }
        return out;
    }

    private static List<String> collectGeneratedAssetIds(List<AssistantConversationTurn> turns) {
        if (turns == null) {
            return List.of();
        }
        List<String> out = new ArrayList<>();
        for (AssistantConversationTurn t : turns) {
            if (t.getGeneratedImageAssetIds() != null) {
                for (String id : t.getGeneratedImageAssetIds()) {
                    if (id != null && !id.isBlank()) {
                        out.add(id.strip());
                    }
                }
            }
        }
        return out;
    }

    private void validate(String ownerSubject, AssistantConversationSaveRequestDto req, boolean assistantAdmin) {
        if (ownerSubject == null || ownerSubject.isBlank()) {
            throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "Authentication required");
        }
        String rp = req.routingProvider().trim().toLowerCase();
        if (!"openai".equals(rp) && !"anthropic".equals(rp) && !"gemini".equals(rp) && !"mistral".equals(rp)) {
            throw new ResponseStatusException(
                    HttpStatus.BAD_REQUEST, "routingProvider must be openai, anthropic, gemini or mistral");
        }
        if (req.turns().size() > MAX_TURNS) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Too many turns");
        }
        int weight = 0;
        for (AssistantConversationTurnPersistDto t : req.turns()) {
            String role = t.role().trim().toLowerCase();
            if (!"user".equals(role) && !"assistant".equals(role)) {
                throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Invalid role");
            }
            List<String> gAssets = normalizedGeneratedAssetIds(t);
            if (!gAssets.isEmpty() && !"assistant".equals(role)) {
                throw new ResponseStatusException(
                        HttpStatus.BAD_REQUEST, "generatedImageAssetIds only allowed on assistant turns");
            }
            if ("assistant".equals(role) && gAssets.size() > MAX_GENERATED_ASSETS_PER_TURN) {
                throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Too many generated images on one turn");
            }
            for (String aid : gAssets) {
                assetService.requireOwnedAsset(ownerSubject, aid, assistantAdmin);
            }

            weight += t.content() != null ? t.content().length() : 0;
            weight += gAssets.size() * 48;

            String ct = t.content() != null ? t.content().trim() : "";
            if ("assistant".equals(role) && ct.isEmpty() && gAssets.isEmpty()) {
                throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Empty assistant turn");
            }
            if ("user".equals(role) && ct.isEmpty()) {
                throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Empty user message");
            }

            if (t.imageDataUrl() != null && !t.imageDataUrl().isBlank()) {
                if (!"user".equals(role)) {
                    throw new ResponseStatusException(
                            HttpStatus.BAD_REQUEST, "imageDataUrl only allowed on user turns");
                }
                validateDataUrlImage(t.imageDataUrl());
                weight += t.imageDataUrl().length();
            }
            if (t.meta() != null && !"assistant".equals(role)) {
                throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "meta only allowed on assistant turns");
            }
            weight += estimateMetaChars(t.meta());
            if (weight > MAX_TOTAL_CHAR_WEIGHT) {
                throw new ResponseStatusException(HttpStatus.PAYLOAD_TOO_LARGE, "Conversation too large to store");
            }
        }
    }

    private static int estimateMetaChars(AssistantTurnMetaPersistDto meta) {
        if (meta == null) {
            return 0;
        }
        int n = 0;
        if (meta.provider() != null) {
            n += meta.provider().length();
        }
        if (meta.model() != null) {
            n += meta.model().length();
        }
        return n + 48;
    }

    private static void validateDataUrlImage(String url) {
        String u = url.strip();
        if (!u.startsWith("data:image/")) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Invalid image data URL");
        }
        if (u.length() > MAX_SINGLE_IMAGE_DATA_URL_CHARS) {
            throw new ResponseStatusException(HttpStatus.PAYLOAD_TOO_LARGE, "Image too large");
        }
    }

    private List<AssistantConversationTurn> mapIncomingTurns(List<AssistantConversationTurnPersistDto> dtos) {
        List<AssistantConversationTurn> out = new ArrayList<>();
        for (AssistantConversationTurnPersistDto d : dtos) {
            AssistantConversationTurn t = new AssistantConversationTurn();
            t.setRole(d.role().trim().toLowerCase());
            t.setContent(d.content() != null ? d.content() : "");
            if (Boolean.TRUE.equals(d.hasImage()) && "user".equals(t.getRole())) {
                t.setHasImage(true);
            }
            if (d.imageDataUrl() != null && !d.imageDataUrl().isBlank() && "user".equals(t.getRole())) {
                t.setImageDataUrl(d.imageDataUrl().strip());
            }
            List<String> gIds = normalizedGeneratedAssetIds(d);
            if (!gIds.isEmpty()) {
                t.setGeneratedImageAssetIds(new ArrayList<>(gIds));
            }
            if (d.meta() != null && "assistant".equals(t.getRole())) {
                AssistantTurnMetaPersistDto md = d.meta();
                AssistantConversationTurnMeta m = new AssistantConversationTurnMeta();
                m.setElapsedMs(md.elapsedMs());
                m.setInputTokens(md.inputTokens());
                m.setOutputTokens(md.outputTokens());
                if (md.provider() != null) {
                    m.setProvider(md.provider().trim());
                }
                if (md.model() != null) {
                    m.setModel(md.model().trim());
                }
                t.setMeta(m);
            }
            out.add(t);
        }
        return out;
    }

    private AssistantConversationSummaryDto toSummary(
            AssistantConversation doc, String viewerSubject, String viewerPreferredUsername) {
        String stored = doc.getOwnerPreferredUsername();
        String preferredForApi = stored;
        if ((preferredForApi == null || preferredForApi.isBlank())
                && viewerSubject != null
                && viewerSubject.equals(doc.getOwnerSubject())
                && viewerPreferredUsername != null
                && !viewerPreferredUsername.isBlank()) {
            preferredForApi = viewerPreferredUsername.strip();
        }
        return new AssistantConversationSummaryDto(
                doc.getId(),
                doc.getCreatedAt(),
                doc.getUpdatedAt(),
                doc.getRoutingProvider(),
                doc.getProviderLabel(),
                doc.getModel(),
                previewFrom(doc),
                doc.getOwnerSubject(),
                preferredForApi);
    }

    private String previewFrom(AssistantConversation doc) {
        if (doc.getTurns() == null) {
            return "";
        }
        for (AssistantConversationTurn t : doc.getTurns()) {
            if ("user".equalsIgnoreCase(t.getRole()) && t.getContent() != null) {
                String s = t.getContent().trim().replaceAll("\\s+", " ");
                if (s.isEmpty()) {
                    continue;
                }
                return s.length() > PREVIEW_MAX ? s.substring(0, PREVIEW_MAX) + "…" : s;
            }
        }
        return "";
    }

    private AssistantConversationDetailDto toDetail(AssistantConversation doc) {
        List<AssistantConversationTurnPersistDto> turns =
                doc.getTurns() == null ? List.of() : doc.getTurns().stream().map(this::turnToDto).toList();
        return new AssistantConversationDetailDto(
                doc.getId(),
                doc.getCreatedAt(),
                doc.getUpdatedAt(),
                doc.getRoutingProvider(),
                doc.getProviderLabel(),
                doc.getModel(),
                turns);
    }

    private AssistantConversationTurnPersistDto turnToDto(AssistantConversationTurn t) {
        AssistantTurnMetaPersistDto metaDto = null;
        if (t.getMeta() != null) {
            AssistantConversationTurnMeta m = t.getMeta();
            metaDto = new AssistantTurnMetaPersistDto(
                    m.getElapsedMs(),
                    m.getInputTokens(),
                    m.getOutputTokens(),
                    m.getProvider(),
                    m.getModel());
        }
        List<String> gIds =
                t.getGeneratedImageAssetIds() != null && !t.getGeneratedImageAssetIds().isEmpty()
                        ? List.copyOf(t.getGeneratedImageAssetIds())
                        : List.of();
        return new AssistantConversationTurnPersistDto(
                t.getRole(),
                t.getContent() != null ? t.getContent() : "",
                Boolean.TRUE.equals(t.getHasImage()),
                t.getImageDataUrl(),
                gIds,
                metaDto);
    }
}
