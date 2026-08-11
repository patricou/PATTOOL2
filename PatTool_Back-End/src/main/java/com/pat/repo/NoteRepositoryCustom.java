package com.pat.repo;

import com.pat.repo.domain.Note;

import java.util.List;
import java.util.Optional;

public interface NoteRepositoryCustom {

    /**
     * Lists every {@link Note} the given member may see (owner, public, friends, friend groups).
     */
    List<Note> findAccessibleByMember(String memberId);

    /**
     * Single {@link Note} by id if {@code memberId} may see it.
     */
    Optional<Note> findAccessibleByIdAndMember(String id, String memberId);
}
