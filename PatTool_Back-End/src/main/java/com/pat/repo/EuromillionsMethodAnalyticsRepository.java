package com.pat.repo;

import com.pat.repo.domain.EuromillionsMethodAnalyticsDocument;
import org.springframework.data.mongodb.repository.MongoRepository;

public interface EuromillionsMethodAnalyticsRepository
        extends MongoRepository<EuromillionsMethodAnalyticsDocument, String> {}
