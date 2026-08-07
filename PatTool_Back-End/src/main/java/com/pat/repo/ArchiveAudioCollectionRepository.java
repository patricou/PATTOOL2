package com.pat.repo;

import com.pat.repo.domain.ArchiveAudioCollection;
import org.springframework.data.mongodb.repository.MongoRepository;

import java.util.List;

public interface ArchiveAudioCollectionRepository extends MongoRepository<ArchiveAudioCollection, String> {

    List<ArchiveAudioCollection> findAllByOrderByUpdatedAtDesc();

    List<ArchiveAudioCollection> findByOwnerMemberIdOrderByUpdatedAtDesc(String ownerMemberId);

    long countByOwnerMemberId(String ownerMemberId);
}
