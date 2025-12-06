package com.pat.repo;

import com.pat.repo.domain.Discussion;
import org.springframework.data.mongodb.repository.MongoRepository;
import org.springframework.data.repository.PagingAndSortingRepository;
import org.springframework.data.rest.core.annotation.RepositoryRestResource;

import java.util.List;

/**
 * Repository for Discussion entities
 */
@RepositoryRestResource(collectionResourceRel = "discussions", path = "discussions")
public interface DiscussionRepository extends PagingAndSortingRepository<Discussion, String>, MongoRepository<Discussion, String> {

    List<Discussion> findAllByOrderByCreationDateDesc();

    List<Discussion> findByCreatedByUserNameOrderByCreationDateDesc(String userName);
}

