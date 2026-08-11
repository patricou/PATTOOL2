package com.pat.service;

import com.pat.repo.NoteRepository;
import com.pat.repo.domain.Evenement;
import com.pat.repo.domain.Note;
import org.springframework.stereotype.Service;
import org.springframework.util.StringUtils;

import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Fills {@link Evenement#setLinkedNoteId} from {@link Note} rows linked by {@code evenementId}.
 * The field is transient; callers must attach after loading from Mongo. When several notes
 * link to the same event, the first accessible id wins (same pattern as to-do lists).
 */
@Service
public class EvenementNoteLinkService {

    private final NoteRepository noteRepository;

    public EvenementNoteLinkService(NoteRepository noteRepository) {
        this.noteRepository = noteRepository;
    }

    public void attachLinkedNotesForEvents(List<Evenement> events, String memberId) {
        attachLinkedNotesForEvents(events, memberId, null);
    }

    public void attachLinkedNotesForEvents(List<Evenement> events, String memberId,
            Map<String, Boolean> noteAccessById) {
        if (events == null || events.isEmpty()) {
            return;
        }
        for (Evenement e : events) {
            if (e != null) {
                e.setLinkedNoteId(null);
            }
        }
        if (!StringUtils.hasText(memberId)) {
            return;
        }
        List<String> eventIds = events.stream()
                .filter(e -> e != null && StringUtils.hasText(e.getId()))
                .map(Evenement::getId)
                .distinct()
                .toList();
        if (eventIds.isEmpty()) {
            return;
        }
        List<Note> linkedNotes = noteRepository.findByEvenementIdIn(eventIds);
        Map<String, String> eventIdToNoteId = new HashMap<>();
        for (Note n : linkedNotes) {
            if (n != null && StringUtils.hasText(n.getEvenementId()) && StringUtils.hasText(n.getId())) {
                eventIdToNoteId.putIfAbsent(n.getEvenementId(), n.getId());
            }
        }
        if (eventIdToNoteId.isEmpty()) {
            return;
        }
        Set<String> accessibleNoteIds = new HashSet<>();
        String mid = memberId.trim();
        for (String noteId : new HashSet<>(eventIdToNoteId.values())) {
            if (!StringUtils.hasText(noteId)) {
                continue;
            }
            boolean ok;
            if (noteAccessById != null) {
                Boolean cached = noteAccessById.get(noteId);
                if (cached != null) {
                    ok = cached;
                } else {
                    ok = noteRepository.findAccessibleByIdAndMember(noteId, mid).isPresent();
                    noteAccessById.put(noteId, ok);
                }
            } else {
                ok = noteRepository.findAccessibleByIdAndMember(noteId, mid).isPresent();
            }
            if (ok) {
                accessibleNoteIds.add(noteId);
            }
        }
        for (Evenement ev : events) {
            if (ev == null || !StringUtils.hasText(ev.getId())) {
                continue;
            }
            String noteId = eventIdToNoteId.get(ev.getId());
            if (noteId != null && accessibleNoteIds.contains(noteId)) {
                ev.setLinkedNoteId(noteId);
            }
        }
    }

    public void attachLinkedNoteIfAccessible(Evenement evenement, String memberId) {
        if (evenement == null) {
            return;
        }
        evenement.setLinkedNoteId(null);
        if (!StringUtils.hasText(evenement.getId()) || !StringUtils.hasText(memberId)) {
            return;
        }
        final String mid = memberId.trim();
        noteRepository.findFirstByEvenementId(evenement.getId()).ifPresent(n -> {
            if (n != null && StringUtils.hasText(n.getId())
                    && noteRepository.findAccessibleByIdAndMember(n.getId(), mid).isPresent()) {
                evenement.setLinkedNoteId(n.getId());
            }
        });
    }

    /** SSE: enrich one event; {@code noteAccessById} is shared for the whole stream. */
    public void attachForStreamEvent(Evenement event, String userId, Map<String, Boolean> noteAccessById) {
        if (event == null) {
            return;
        }
        String mid = StringUtils.hasText(userId) ? userId.trim() : "";
        attachLinkedNotesForEvents(java.util.Collections.singletonList(event), mid, noteAccessById);
    }
}
