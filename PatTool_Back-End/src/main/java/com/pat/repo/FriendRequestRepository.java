package com.pat.repo;

import com.pat.repo.domain.FriendRequest;
import com.pat.repo.domain.Member;
import org.springframework.data.mongodb.repository.MongoRepository;
import org.springframework.stereotype.Repository;

import java.util.List;
import java.util.Optional;

@Repository
public interface FriendRequestRepository extends MongoRepository<FriendRequest, String> {
    
    List<FriendRequest> findByRecipientAndStatus(Member recipient, String status);
    
    List<FriendRequest> findByRequesterAndStatus(Member requester, String status);
    
    Optional<FriendRequest> findByRequesterAndRecipientAndStatus(Member requester, Member recipient, String status);
    
    List<FriendRequest> findByRequesterOrRecipient(Member user1, Member user2);
}

