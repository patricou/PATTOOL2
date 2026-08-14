package com.pat.repo;

import com.pat.repo.domain.DirectionPattoolSample;
import org.springframework.data.mongodb.repository.MongoRepository;
import org.springframework.stereotype.Repository;

import java.util.List;

@Repository
public interface DirectionPattoolSampleRepository extends MongoRepository<DirectionPattoolSample, String> {

    List<DirectionPattoolSample> findByOwnerSubjectOrderByCapturedAtAsc(String ownerSubject);

    long countByOwnerSubject(String ownerSubject);

    void deleteByOwnerSubject(String ownerSubject);

    List<DirectionPattoolSample> findByOwnerUsernameOrderByCapturedAtAsc(String ownerUsername);

    long countByOwnerUsername(String ownerUsername);

    void deleteByOwnerUsername(String ownerUsername);
}
