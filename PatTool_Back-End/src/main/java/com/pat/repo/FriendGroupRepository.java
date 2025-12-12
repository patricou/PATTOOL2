package com.pat.repo;

import com.pat.repo.domain.FriendGroup;
import com.pat.repo.domain.Member;
import org.springframework.data.mongodb.repository.MongoRepository;
import org.springframework.stereotype.Repository;

import java.util.List;

@Repository
public interface FriendGroupRepository extends MongoRepository<FriendGroup, String> {
    
    /**
     * Find all friend groups owned by a specific member
     */
    List<FriendGroup> findByOwner(Member owner);
    
    /**
     * Find friend groups where a specific member is in the members list
     */
    List<FriendGroup> findByMembersContaining(Member member);
    
    /**
     * Find friend groups where a specific member is in the authorizedUsers list
     */
    List<FriendGroup> findByAuthorizedUsersContaining(Member member);
    
    /**
     * Find all friend groups with a specific discussionId
     */
    List<FriendGroup> findByDiscussionId(String discussionId);
}

