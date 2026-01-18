package com.pat.repo;

import com.pat.repo.domain.GoveeThermometerHistory;
import org.springframework.data.mongodb.repository.MongoRepository;
import org.springframework.data.mongodb.repository.Query;
import org.springframework.stereotype.Repository;

import java.time.LocalDateTime;
import java.util.List;

/**
 * Repository for Govee Thermometer History
 */
@Repository
public interface GoveeThermometerHistoryRepository extends MongoRepository<GoveeThermometerHistory, String> {

    /**
     * Find all history records for a specific device
     */
    List<GoveeThermometerHistory> findByDeviceIdOrderByTimestampAsc(String deviceId);

    /**
     * Find all history records for a specific device within a time range
     */
    @Query("{ 'deviceId': ?0, 'timestamp': { $gte: ?1, $lte: ?2 } }")
    List<GoveeThermometerHistory> findByDeviceIdAndTimestampBetween(String deviceId, LocalDateTime start, LocalDateTime end);

    /**
     * Delete all history records for a specific device
     */
    void deleteByDeviceId(String deviceId);

    /**
     * Delete all history records
     */
    void deleteAll();

    /**
     * Count records for a specific device
     */
    long countByDeviceId(String deviceId);

    /**
     * Find the most recent history record for a specific device
     */
    @Query(value = "{ 'deviceId': ?0 }", sort = "{ 'timestamp': -1 }")
    List<GoveeThermometerHistory> findByDeviceIdOrderByTimestampDesc(String deviceId);
    
    /**
     * Find the single most recent history record for a specific device (optimized with limit 1)
     */
    @Query(value = "{ 'deviceId': ?0 }", sort = "{ 'timestamp': -1 }", fields = "{}")
    java.util.Optional<GoveeThermometerHistory> findTopByDeviceIdOrderByTimestampDesc(String deviceId);
}
