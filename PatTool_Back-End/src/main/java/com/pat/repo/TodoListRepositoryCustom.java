package com.pat.repo;

import com.pat.repo.domain.TodoList;

import java.util.List;
import java.util.Optional;

public interface TodoListRepositoryCustom {

    /**
     * Lists every {@link TodoList} the given member may see (owner, public, friends, friend groups).
     * When {@code memberId} is null only {@code visibility == "public"} entries are returned.
     */
    List<TodoList> findAccessibleByMember(String memberId);

    /**
     * Single {@link TodoList} by id if {@code memberId} may see it (same rules as
     * {@link #findAccessibleByMember}).
     */
    Optional<TodoList> findAccessibleByIdAndMember(String id, String memberId);
}
