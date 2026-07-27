package com.pat.repo;

import com.pat.repo.domain.PdfConverterDocument;
import org.springframework.data.mongodb.repository.MongoRepository;

import java.util.List;
import java.util.Optional;

public interface PdfConverterDocumentRepository extends MongoRepository<PdfConverterDocument, String> {

    List<PdfConverterDocument> findByOwnerMemberIdOrderByUpdatedAtDesc(String ownerMemberId);

    List<PdfConverterDocument> findAllByOrderByUpdatedAtDesc();

    Optional<PdfConverterDocument> findByIdAndOwnerMemberId(String id, String ownerMemberId);

    long deleteByIdAndOwnerMemberId(String id, String ownerMemberId);

    List<PdfConverterDocument> findByEvenementIdIn(List<String> evenementIds);

    List<PdfConverterDocument> findByEvenementIdOrderByUpdatedAtDesc(String evenementId);

    List<PdfConverterDocument> findByCalendarAppointmentIdIn(List<String> appointmentIds);

    List<PdfConverterDocument> findByCalendarAppointmentIdOrderByUpdatedAtDesc(String calendarAppointmentId);
}
