package com.pat.service;

import com.pat.controller.dto.AssistantConversationAssetUploadDto;
import com.pat.repo.AssistantConversationAssetRepository;
import com.pat.repo.domain.AssistantConversationAsset;
import com.pat.service.assistant.AssistantMessageSupport;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.web.server.ResponseStatusException;

import java.time.Instant;
import java.util.Base64;
import java.util.Collection;
import java.util.Optional;

@Service
public class AssistantConversationAssetService {

    static final int MAX_DECODED_BYTES = AssistantMessageSupport.MAX_IMAGE_DECODED_BYTES;

    private final AssistantConversationAssetRepository repository;
    private final UserOwnerService userOwnerService;

    public AssistantConversationAssetService(
            AssistantConversationAssetRepository repository, UserOwnerService userOwnerService) {
        this.repository = repository;
        this.userOwnerService = userOwnerService;
    }

    public String saveForOwner(String ownerSubject, AssistantConversationAssetUploadDto dto) {
        if (ownerSubject == null || ownerSubject.isBlank()) {
            throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "Authentication required");
        }
        String writeOwner = userOwnerService.require(ownerSubject).username();
        String mime = dto.mimeType().trim().toLowerCase();
        if (!AssistantMessageSupport.ALLOWED_IMAGE_MIMES.contains(mime)) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Unsupported image MIME type");
        }
        String b64Raw = dto.base64().strip().replaceAll("\\s+", "");
        String b64 = b64Raw;
        if (b64.startsWith("data:")) {
            int comma = b64.indexOf(',');
            if (comma < 6) {
                throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Invalid data URL");
            }
            b64 = b64.substring(comma + 1).replaceAll("\\s+", "");
        }
        byte[] decoded;
        try {
            decoded = Base64.getDecoder().decode(b64);
        } catch (IllegalArgumentException e) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Invalid base64");
        }
        if (decoded.length == 0) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Empty image");
        }
        if (decoded.length > MAX_DECODED_BYTES) {
            throw new ResponseStatusException(HttpStatus.PAYLOAD_TOO_LARGE, "Image too large");
        }
        AssistantConversationAsset doc = new AssistantConversationAsset();
        doc.setOwnerSubject(writeOwner);
        doc.setMimeType(mime);
        doc.setData(decoded);
        doc.setCreatedAt(Instant.now());
        AssistantConversationAsset saved = repository.save(doc);
        return saved.getId();
    }

    /**
     * @param jwtSubject sujet JWT de l’appelant
     * @param assistantAdmin si vrai, lecture autorisée même si l’asset appartient à un autre utilisateur
     */
    public Optional<byte[]> readBytesIfOwned(String jwtSubject, String assetId, boolean assistantAdmin) {
        if (jwtSubject == null || jwtSubject.isBlank() || assetId == null || assetId.isBlank()) {
            return Optional.empty();
        }
        Optional<AssistantConversationAsset> row = repository.findById(assetId.strip());
        if (row.isEmpty()) {
            return Optional.empty();
        }
        AssistantConversationAsset doc = row.get();
        if (!assistantAdmin && !userOwnerService.ownsStored(doc.getOwnerSubject(), jwtSubject)) {
            return Optional.empty();
        }
        return Optional.ofNullable(doc.getData());
    }

    public Optional<String> findMimeIfOwned(String jwtSubject, String assetId, boolean assistantAdmin) {
        if (jwtSubject == null || jwtSubject.isBlank() || assetId == null || assetId.isBlank()) {
            return Optional.empty();
        }
        return repository
                .findById(assetId.strip())
                .filter(a -> assistantAdmin || userOwnerService.ownsStored(a.getOwnerSubject(), jwtSubject))
                .map(AssistantConversationAsset::getMimeType);
    }

    /** Vérifie que l’asset existe ; propriété du JWT sauf si administrateur assistant. */
    public void requireOwnedAsset(String jwtSubject, String assetId, boolean assistantAdmin) {
        if (assetId == null || assetId.isBlank()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Invalid asset id");
        }
        AssistantConversationAsset a =
                repository.findById(assetId.strip()).orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND));
        if (assistantAdmin) {
            return;
        }
        if (!userOwnerService.ownsStored(a.getOwnerSubject(), jwtSubject)) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND);
        }
    }

    public void deleteIfOwned(String ownerSubject, String assetId) {
        if (ownerSubject == null
                || ownerSubject.isBlank()
                || assetId == null
                || assetId.isBlank()) {
            return;
        }
        repository
                .findById(assetId.strip())
                .filter(a -> userOwnerService.ownsStored(a.getOwnerSubject(), ownerSubject))
                .ifPresent(a -> repository.deleteById(a.getId()));
    }

    public void deleteAllIfOwned(String ownerSubject, Collection<String> assetIds) {
        if (assetIds == null || assetIds.isEmpty()) {
            return;
        }
        for (String id : assetIds) {
            deleteIfOwned(ownerSubject, id);
        }
    }
}
