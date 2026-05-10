package com.pat.repo;

import com.pat.repo.domain.LotoDraw;
import org.springframework.data.mongodb.repository.MongoRepository;
import org.springframework.stereotype.Repository;

import java.util.List;

@Repository
public interface LotoDrawRepository extends MongoRepository<LotoDraw, String> {

    List<LotoDraw> findAllByOrderByDrawDateDesc();
}
