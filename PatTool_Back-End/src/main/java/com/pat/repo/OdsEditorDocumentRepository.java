package com.pat.repo;

import com.pat.repo.domain.OdsEditorDocument;
import org.springframework.data.mongodb.repository.MongoRepository;

import java.util.List;
import java.util.Optional;

public interface OdsEditorDocumentRepository extends MongoRepository<OdsEditorDocument, String> {

    List<OdsEditorDocument> findByOwnerMemberIdOrderByUpdatedAtDesc(String ownerMemberId);

    List<OdsEditorDocument> findAllByOrderByUpdatedAtDesc();

    Optional<OdsEditorDocument> findByIdAndOwnerMemberId(String id, String ownerMemberId);

    long deleteByIdAndOwnerMemberId(String id, String ownerMemberId);
}
