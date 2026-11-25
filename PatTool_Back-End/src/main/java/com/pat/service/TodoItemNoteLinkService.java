package com.pat.service;

import com.pat.repo.NoteRepository;
import com.pat.repo.domain.Note;
import com.pat.repo.domain.TodoList;
import org.springframework.stereotype.Service;
import org.springframework.util.StringUtils;

import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Fills {@link TodoList#setLinkedNoteId} from {@link Note} rows linked by {@code todoListId}.
 * The field is transient. When several notes link to the same list, the first accessible id wins.
 */
@Service
public class TodoItemNoteLinkService {

    private final NoteRepository noteRepository;

    public TodoItemNoteLinkService(NoteRepository noteRepository) {
        this.noteRepository = noteRepository;
    }

    public void attach(List<TodoList> lists, String memberId) {
        if (lists == null || lists.isEmpty()) {
            return;
        }
        for (TodoList list : lists) {
            if (list != null) {
                list.setLinkedNoteId(null);
            }
        }
        if (!StringUtils.hasText(memberId)) {
            return;
        }
        List<String> listIds = lists.stream()
                .filter(list -> list != null && StringUtils.hasText(list.getId()))
                .map(TodoList::getId)
                .distinct()
                .toList();
        if (listIds.isEmpty()) {
            return;
        }
        List<Note> linked = noteRepository.findByTodoListIdIn(listIds);
        Map<String, String> listToNoteId = new HashMap<>();
        for (Note note : linked) {
            if (note == null || !StringUtils.hasText(note.getId()) || !StringUtils.hasText(note.getTodoListId())) {
                continue;
            }
            listToNoteId.putIfAbsent(note.getTodoListId(), note.getId());
        }
        if (listToNoteId.isEmpty()) {
            return;
        }
        String mid = memberId.trim();
        Set<String> accessibleNoteIds = new HashSet<>();
        for (String noteId : new HashSet<>(listToNoteId.values())) {
            if (noteRepository.findAccessibleByIdAndMember(noteId, mid).isPresent()) {
                accessibleNoteIds.add(noteId);
            }
        }
        for (TodoList list : lists) {
            if (list == null || !StringUtils.hasText(list.getId())) {
                continue;
            }
            String noteId = listToNoteId.get(list.getId());
            if (noteId != null && accessibleNoteIds.contains(noteId)) {
                list.setLinkedNoteId(noteId);
            }
        }
    }
}
