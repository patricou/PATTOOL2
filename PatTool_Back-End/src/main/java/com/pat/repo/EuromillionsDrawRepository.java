package com.pat.repo;

import com.pat.repo.domain.EuromillionsDraw;
import org.springframework.data.mongodb.repository.MongoRepository;

import java.util.List;

public interface EuromillionsDrawRepository extends MongoRepository<EuromillionsDraw, String> {

    List<EuromillionsDraw> findAllByOrderByDrawDateDesc();
}
