package com.pat.repo;

import com.pat.repo.domain.CategoryLink;
import org.springframework.data.mongodb.repository.MongoRepository;
import org.springframework.data.repository.PagingAndSortingRepository;
import org.springframework.data.rest.core.annotation.RepositoryRestResource;

@RepositoryRestResource(collectionResourceRel = "categorylink", path = "categorylink")
public interface CategoryLinkRepository extends PagingAndSortingRepository<CategoryLink, String>, MongoRepository<CategoryLink,String> {

}
