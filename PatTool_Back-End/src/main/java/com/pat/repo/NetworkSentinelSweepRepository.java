package com.pat.repo;

import com.pat.repo.domain.NetworkSentinelSweep;
import org.springframework.data.domain.Pageable;
import org.springframework.data.mongodb.repository.MongoRepository;
import org.springframework.stereotype.Repository;

import java.util.List;
import java.util.Optional;

@Repository
public interface NetworkSentinelSweepRepository extends MongoRepository<NetworkSentinelSweep, String> {

    List<NetworkSentinelSweep> findAllByOrderByStartedAtDesc(Pageable pageable);

    Optional<NetworkSentinelSweep> findFirstByOrderByStartedAtDesc();
}
