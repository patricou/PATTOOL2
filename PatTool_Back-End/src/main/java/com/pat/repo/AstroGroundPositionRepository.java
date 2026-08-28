package com.pat.repo;

import com.pat.repo.domain.AstroGroundPosition;
import org.springframework.data.mongodb.repository.MongoRepository;
import org.springframework.stereotype.Repository;

import java.util.List;
import java.util.Optional;

@Repository
public interface AstroGroundPositionRepository extends MongoRepository<AstroGroundPosition, String> {

    List<AstroGroundPosition> findByOwnerUsernameOrderByUpdatedAtDesc(String ownerUsername);

    List<AstroGroundPosition> findByOwnerSubjectOrderByUpdatedAtDesc(String ownerSubject);

    Optional<AstroGroundPosition> findByIdAndOwnerUsername(String id, String ownerUsername);

    Optional<AstroGroundPosition> findByIdAndOwnerSubject(String id, String ownerSubject);
}
