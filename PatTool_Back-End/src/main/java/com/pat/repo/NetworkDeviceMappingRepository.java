package com.pat.repo;

import com.pat.repo.domain.NetworkDeviceMapping;
import org.springframework.data.mongodb.repository.MongoRepository;
import org.springframework.stereotype.Repository;

import java.util.Optional;

@Repository
public interface NetworkDeviceMappingRepository extends MongoRepository<NetworkDeviceMapping, String> {
    
    Optional<NetworkDeviceMapping> findByIpAddress(String ipAddress);
    
    Optional<NetworkDeviceMapping> findByMacAddress(String macAddress);
    
    void deleteByIpAddress(String ipAddress);
}

