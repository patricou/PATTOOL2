package com.pat.repo;


import com.pat.repo.domain.ChatRequest;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;

import java.util.List;

public interface ChatRequestRepository extends JpaRepository<ChatRequest, Long> {
    
    /**
     * Get the most recent chat requests, ordered by ID descending (newest first)
     * This limits memory usage by only loading a subset of the history
     */
    @Query("SELECT c FROM ChatRequest c ORDER BY c.id DESC")
    List<ChatRequest> findRecentChatRequests(Pageable pageable);
}
