package com.pat.repo;


import com.pat.repo.domain.ChatRequest;
import org.springframework.data.jpa.repository.JpaRepository;

public interface ChatRequestRepository extends JpaRepository<ChatRequest, Long> {
}
