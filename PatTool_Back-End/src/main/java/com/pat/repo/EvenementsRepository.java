package com.pat.repo;

import com.pat.domain.Evenement;
import com.pat.domain.Member;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.PageRequest;
import org.springframework.data.domain.Pageable;
import org.springframework.data.domain.Sort;
import org.springframework.data.mongodb.repository.MongoRepository;
import org.springframework.data.mongodb.repository.Query;
import org.springframework.data.repository.PagingAndSortingRepository;
import org.springframework.data.repository.Repository;
import org.springframework.data.rest.core.annotation.RepositoryRestResource;

import java.util.List;

/**
 * Created by patricou on 4/20/2017.
 */
@RepositoryRestResource(collectionResourceRel = "evenements", path = "evenements")
public interface EvenementsRepository extends PagingAndSortingRepository<Evenement, String> , MongoRepository<Evenement,String> {

    Page<Evenement> findByEvenementNameLikeIgnoreCaseAndAuthor_idOrEvenementNameLikeIgnoreCaseAndVisibility(Pageable pageable, String eventName1, String AuthorId,String eventName2, String visibility );

}

