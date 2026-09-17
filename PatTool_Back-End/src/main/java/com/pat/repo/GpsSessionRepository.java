package com.pat.repo;

import com.pat.repo.domain.GpsSession;
import org.springframework.data.mongodb.repository.MongoRepository;

import java.util.List;
import java.util.Optional;

public interface GpsSessionRepository extends MongoRepository<GpsSession, String> {

    List<GpsSession> findByOwnerMemberIdOrderByUpdatedAtDesc(String ownerMemberId);

    Optional<GpsSession> findByOwnerMemberIdAndClientSessionId(String ownerMemberId, String clientSessionId);
}
