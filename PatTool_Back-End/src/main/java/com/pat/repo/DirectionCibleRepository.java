package com.pat.repo;

import com.pat.repo.domain.DirectionCible;
import org.springframework.data.mongodb.repository.MongoRepository;
import org.springframework.stereotype.Repository;

import java.util.List;
import java.util.Optional;

@Repository
public interface DirectionCibleRepository extends MongoRepository<DirectionCible, String> {

    List<DirectionCible> findByOwnerUsernameOrderByUpdatedAtDesc(String ownerUsername);

    List<DirectionCible> findByOwnerSubjectOrderByUpdatedAtDesc(String ownerSubject);

    Optional<DirectionCible> findByIdAndOwnerUsername(String id, String ownerUsername);

    Optional<DirectionCible> findByIdAndOwnerSubject(String id, String ownerSubject);

    long countByOwnerUsername(String ownerUsername);

    void deleteByOwnerUsername(String ownerUsername);

    void deleteByOwnerSubject(String ownerSubject);
}
