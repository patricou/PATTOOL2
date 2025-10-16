package com.pat.repo;

import com.pat.domain.Member;
import org.springframework.data.mongodb.repository.MongoRepository;
import org.springframework.data.repository.PagingAndSortingRepository;
import org.springframework.data.rest.core.annotation.RepositoryRestResource;

/**
 * Created by patricou on 4/20/2017.
 */
@RepositoryRestResource(collectionResourceRel = "members", path = "members")
public interface MembersRepository  extends PagingAndSortingRepository<Member, String>, MongoRepository<Member,String>  {

    Member findByUserName(String userName);
}
