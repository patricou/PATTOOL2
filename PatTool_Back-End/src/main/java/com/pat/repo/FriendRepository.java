package com.pat.repo;

import com.pat.repo.domain.Friend;
import com.pat.repo.domain.Member;
import org.springframework.data.mongodb.repository.MongoRepository;
import org.springframework.stereotype.Repository;

import java.util.List;
import java.util.Optional;

@Repository
public interface FriendRepository extends MongoRepository<Friend, String> {
    
    List<Friend> findByUser1OrUser2(Member user1, Member user2);
    
    Optional<Friend> findByUser1AndUser2(Member user1, Member user2);
    
    Optional<Friend> findByUser2AndUser1(Member user1, Member user2);
    
    boolean existsByUser1AndUser2(Member user1, Member user2);
    
    boolean existsByUser2AndUser1(Member user1, Member user2);
}

