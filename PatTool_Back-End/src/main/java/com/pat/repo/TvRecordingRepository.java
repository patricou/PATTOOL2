package com.pat.repo;

import com.pat.repo.domain.TvRecording;
import org.springframework.data.mongodb.repository.MongoRepository;

import java.util.List;
import java.util.Optional;

public interface TvRecordingRepository extends MongoRepository<TvRecording, String>, TvRecordingRepositoryCustom {

    List<TvRecording> findByOwnerSubOrderByStartedAtDesc(String ownerSub);

    Optional<TvRecording> findByIdAndOwnerSub(String id, String ownerSub);

    Optional<TvRecording> findByGridFsFileId(String gridFsFileId);
}
