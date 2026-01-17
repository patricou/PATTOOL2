package com.pat.repo;

import com.pat.repo.domain.NewDeviceHistory;
import org.springframework.data.mongodb.repository.MongoRepository;
import org.springframework.stereotype.Repository;

import java.util.List;

/**
 * Repository for NewDeviceHistory entities
 */
@Repository
public interface NewDeviceHistoryRepository extends MongoRepository<NewDeviceHistory, String> {
    
    /**
     * Find all new device history entries, ordered by detection date descending (newest first)
     * @return List of new device history entries
     */
    List<NewDeviceHistory> findAllByOrderByDetectionDateDesc();
    
    /**
     * Find by MAC address (to avoid duplicates)
     * @param macAddress MAC address to search for
     * @return List of entries with the specified MAC address
     */
    List<NewDeviceHistory> findByMacAddress(String macAddress);
}