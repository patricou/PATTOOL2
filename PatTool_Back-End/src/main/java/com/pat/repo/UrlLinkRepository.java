package com.pat.repo;

import com.pat.repo.domain.UrlLink;
import org.springframework.data.domain.Sort;
import org.springframework.data.mongodb.repository.MongoRepository;
import org.springframework.data.rest.core.annotation.RepositoryRestResource;

import java.util.List;

@RepositoryRestResource(collectionResourceRel = "urllink", path = "urllink")
public interface UrlLinkRepository extends MongoRepository<UrlLink,String> {

    //List<UrlLink> findAllByVisibilityContainsAuthor_id(Sort sort,String visibility, String authorId);
    List<UrlLink> findByVisibilityOrAuthor_Id(Sort sort,String visibility, String AuthorId);
    //List<UrlLink> findByVisibilityOrAuthor_Id(String visibility, String AuthorId);
    //List<UrlLink> findAllByAuthor_Id(String AuthorId);
    List<UrlLink> findByCategoryLinkID(String categoryLinkID);


}
