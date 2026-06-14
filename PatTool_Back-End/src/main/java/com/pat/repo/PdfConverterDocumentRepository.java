package com.pat.repo;

import com.pat.repo.domain.PdfConverterDocument;
import org.springframework.data.mongodb.repository.MongoRepository;

import java.util.List;
import java.util.Optional;

public interface PdfConverterDocumentRepository extends MongoRepository<PdfConverterDocument, String> {

    List<PdfConverterDocument> findByOwnerMemberIdOrderByUpdatedAtDesc(String ownerMemberId);

    Optional<PdfConverterDocument> findByIdAndOwnerMemberId(String id, String ownerMemberId);

    long deleteByIdAndOwnerMemberId(String id, String ownerMemberId);
}
