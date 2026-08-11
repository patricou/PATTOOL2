package com.pat.repo;

import com.pat.repo.domain.Note;
import org.springframework.data.mongodb.repository.MongoRepository;

import java.util.List;
import java.util.Optional;

public interface NoteRepository extends MongoRepository<Note, String>, NoteRepositoryCustom {

    List<Note> findByOwnerMemberIdOrderByCreatedAtDesc(String ownerMemberId);

    Optional<Note> findByIdAndOwnerMemberId(String id, String ownerMemberId);

    List<Note> findByEvenementIdIn(List<String> evenementIds);

    List<Note> findByCalendarAppointmentIdIn(List<String> calendarAppointmentIds);

    Optional<Note> findFirstByEvenementId(String evenementId);

    Optional<Note> findFirstByCalendarAppointmentId(String calendarAppointmentId);
}
