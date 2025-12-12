package com.pat.repo;

import com.pat.repo.domain.UserConnectionLog;
import org.springframework.data.mongodb.repository.MongoRepository;

import java.util.Date;
import java.util.List;

/**
 * Repository for UserConnectionLog entities
 */
public interface UserConnectionLogRepository extends MongoRepository<UserConnectionLog, String> {

    /**
     * Find all connection logs between two dates, ordered by connection date descending (newest first)
     * @param startDate Start date (inclusive)
     * @param endDate End date (inclusive)
     * @return List of connection logs
     */
    List<UserConnectionLog> findByConnectionDateBetweenOrderByConnectionDateDesc(Date startDate, Date endDate);

    /**
     * Find all connection logs, ordered by connection date descending (newest first)
     * @return List of all connection logs
     */
    List<UserConnectionLog> findAllByOrderByConnectionDateDesc();
    
    /**
     * Find all connection logs with a specific discussionId
     * @param discussionId The discussion ID to search for
     * @return List of connection logs with the specified discussionId
     */
    List<UserConnectionLog> findByDiscussionId(String discussionId);
}

