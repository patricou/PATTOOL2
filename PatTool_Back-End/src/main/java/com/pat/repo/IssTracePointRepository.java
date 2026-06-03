package com.pat.repo;

import com.pat.repo.domain.IssTracePoint;
import org.springframework.data.mongodb.repository.MongoRepository;

import java.time.Instant;
import java.util.List;
import java.util.Optional;

public interface IssTracePointRepository extends MongoRepository<IssTracePoint, String> {

    Optional<IssTracePoint> findTopByOrderByRecordedAtDesc();

    List<IssTracePoint> findByRecordedAtAfterOrderByRecordedAtAsc(Instant after);

    long deleteByRecordedAtBefore(Instant before);
}
