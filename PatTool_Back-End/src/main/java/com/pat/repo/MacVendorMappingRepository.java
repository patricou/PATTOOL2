package com.pat.repo;

import com.pat.repo.domain.MacVendorMapping;
import org.springframework.data.mongodb.repository.MongoRepository;
import org.springframework.stereotype.Repository;

import java.util.Optional;

/**
 * Repository for MacVendorMapping entities
 * Stores OUI -> Vendor mappings to avoid repeated API calls
 */
@Repository
public interface MacVendorMappingRepository extends MongoRepository<MacVendorMapping, String> {
    
    /**
     * Find vendor by OUI (first 3 octets of MAC address)
     * @param oui OUI in format XX:XX:XX
     * @return Optional MacVendorMapping
     */
    Optional<MacVendorMapping> findByOui(String oui);
    
    /**
     * Check if vendor exists for given OUI
     * @param oui OUI in format XX:XX:XX
     * @return true if exists
     */
    boolean existsByOui(String oui);
}
