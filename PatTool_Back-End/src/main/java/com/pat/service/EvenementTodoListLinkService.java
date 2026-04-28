package com.pat.service;

import com.pat.repo.TodoListRepository;
import com.pat.repo.domain.Evenement;
import com.pat.repo.domain.TodoList;
import org.springframework.stereotype.Service;
import org.springframework.util.StringUtils;

import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Fills {@link Evenement#setLinkedTodoListId} from {@link TodoList} rows linked by {@code evenementId}.
 * The field is transient on {@link Evenement}; callers must attach after loading from Mongo.
 */
@Service
public class EvenementTodoListLinkService {

    private final TodoListRepository todoListRepository;

    public EvenementTodoListLinkService(TodoListRepository todoListRepository) {
        this.todoListRepository = todoListRepository;
    }

    /**
     * Batched: one {@code findByEvenementIdIn} plus one accessibility check per distinct list id
     * (cached in {@code listAccessById} when non-null, e.g. per SSE stream).
     */
    public void attachLinkedTodoListsForEvents(List<Evenement> events, String memberId) {
        attachLinkedTodoListsForEvents(events, memberId, null);
    }

    /**
     * @param listAccessById when non-null, memoizes {@code todoListId -> accessible} for this call sequence
     *                       (reuse across many singleton batches on the same stream).
     */
    public void attachLinkedTodoListsForEvents(List<Evenement> events, String memberId,
                                               Map<String, Boolean> listAccessById) {
        if (events == null || events.isEmpty()) {
            return;
        }
        for (Evenement e : events) {
            if (e != null) {
                e.setLinkedTodoListId(null);
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
        List<TodoList> linkedLists = todoListRepository.findByEvenementIdIn(eventIds);
        Map<String, String> eventIdToTodoListId = new HashMap<>();
        for (TodoList tl : linkedLists) {
            if (tl != null && StringUtils.hasText(tl.getEvenementId()) && StringUtils.hasText(tl.getId())) {
                eventIdToTodoListId.putIfAbsent(tl.getEvenementId(), tl.getId());
            }
        }
        if (eventIdToTodoListId.isEmpty()) {
            return;
        }
        Set<String> accessibleListIds = new HashSet<>();
        String mid = memberId.trim();
        for (String todoListId : new HashSet<>(eventIdToTodoListId.values())) {
            if (!StringUtils.hasText(todoListId)) {
                continue;
            }
            boolean ok;
            if (listAccessById != null) {
                Boolean cached = listAccessById.get(todoListId);
                if (cached != null) {
                    ok = cached;
                } else {
                    ok = todoListRepository.findAccessibleByIdAndMember(todoListId, mid).isPresent();
                    listAccessById.put(todoListId, ok);
                }
            } else {
                ok = todoListRepository.findAccessibleByIdAndMember(todoListId, mid).isPresent();
            }
            if (ok) {
                accessibleListIds.add(todoListId);
            }
        }
        for (Evenement ev : events) {
            if (ev == null || !StringUtils.hasText(ev.getId())) {
                continue;
            }
            String listId = eventIdToTodoListId.get(ev.getId());
            if (listId != null && accessibleListIds.contains(listId)) {
                ev.setLinkedTodoListId(listId);
            }
        }
    }

    public void attachLinkedTodoListIfAccessible(Evenement evenement, String memberId) {
        if (evenement == null) {
            return;
        }
        evenement.setLinkedTodoListId(null);
        if (!StringUtils.hasText(evenement.getId()) || !StringUtils.hasText(memberId)) {
            return;
        }
        final String mid = memberId.trim();
        todoListRepository.findFirstByEvenementId(evenement.getId()).ifPresent(tl -> {
            if (tl != null && StringUtils.hasText(tl.getId())
                    && todoListRepository.findAccessibleByIdAndMember(tl.getId(), mid).isPresent()) {
                evenement.setLinkedTodoListId(tl.getId());
            }
        });
    }

    /** SSE: enrich one event; {@code listAccessById} is shared for the whole stream (memoized list checks). */
    public void attachForStreamEvent(Evenement event, String userId, Map<String, Boolean> listAccessById) {
        if (event == null) {
            return;
        }
        String mid = StringUtils.hasText(userId) ? userId.trim() : "";
        attachLinkedTodoListsForEvents(Collections.singletonList(event), mid, listAccessById);
    }
}
