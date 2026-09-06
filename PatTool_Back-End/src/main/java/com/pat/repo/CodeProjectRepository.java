package com.pat.repo;

import com.pat.repo.domain.CodeProject;
import org.springframework.data.mongodb.repository.MongoRepository;

import java.util.List;
import java.util.Optional;

public interface CodeProjectRepository extends MongoRepository<CodeProject, String> {

    List<CodeProject> findByOwnerMemberIdOrderByUpdatedAtDesc(String ownerMemberId);

    List<CodeProject> findAllByOrderByUpdatedAtDesc();

    Optional<CodeProject> findByIdAndOwnerMemberId(String id, String ownerMemberId);

    long deleteByIdAndOwnerMemberId(String id, String ownerMemberId);
}
