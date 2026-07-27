package com.pat.repo;

import com.pat.repo.domain.TvRecording;

import java.util.List;
import java.util.Optional;

public interface TvRecordingRepositoryCustom {

    /**
     * Recordings visible to the caller: public, own, friends, or friend-groups.
     * Sorted by {@code startedAt} descending.
     */
    List<TvRecording> findAccessible(String jwtSubject, String memberId);

    Optional<TvRecording> findAccessibleById(String id, String jwtSubject, String memberId);
}
