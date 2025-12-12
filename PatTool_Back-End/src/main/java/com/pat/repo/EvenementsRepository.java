package com.pat.repo;

import com.pat.repo.domain.Evenement;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.data.mongodb.repository.MongoRepository;
import org.springframework.data.repository.PagingAndSortingRepository;
import org.springframework.data.rest.core.annotation.RepositoryRestResource;

import java.util.List;

/**
 * Created by patricou on 4/20/2017.
 */
@RepositoryRestResource(collectionResourceRel = "evenements", path = "evenements")
public interface EvenementsRepository extends PagingAndSortingRepository<Evenement, String> , MongoRepository<Evenement,String>, EvenementsRepositoryCustom {

    Page<Evenement> findByEvenementNameLikeIgnoreCaseAndAuthor_idOrEvenementNameLikeIgnoreCaseAndVisibility(Pageable pageable, String eventName1, String AuthorId,String eventName2, String visibility );

    // Additional methods for the controller
    List<Evenement> findByAuthorId(String authorId);
    List<Evenement> findByEvenementNameContainingIgnoreCase(String name);
    java.util.Optional<Evenement> findByDiscussionId(String discussionId);
    List<Evenement> findAllByDiscussionId(String discussionId);
}

