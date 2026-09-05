package com.pat.repo;

import com.pat.repo.domain.VideoMontageProject;
import org.springframework.data.mongodb.repository.MongoRepository;

import java.util.List;
import java.util.Optional;

public interface VideoMontageProjectRepository extends MongoRepository<VideoMontageProject, String> {

    List<VideoMontageProject> findByOwnerMemberIdOrderByUpdatedAtDesc(String ownerMemberId);

    List<VideoMontageProject> findAllByOrderByUpdatedAtDesc();

    Optional<VideoMontageProject> findByIdAndOwnerMemberId(String id, String ownerMemberId);

    long deleteByIdAndOwnerMemberId(String id, String ownerMemberId);
}
