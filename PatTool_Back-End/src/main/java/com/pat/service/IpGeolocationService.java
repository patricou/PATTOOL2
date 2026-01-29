package com.pat.service;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import org.springframework.web.client.RestTemplate;

import java.net.InetAddress;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Service to lookup IP geolocation information
 */
@Service
public class IpGeolocationService {

    private static final Logger log = LoggerFactory.getLogger(IpGeolocationService.class);
    
    private final RestTemplate restTemplate;
    
    // Cache to avoid repeated lookups for the same IP
    // Using CacheEntry to store value with timestamp
    private final Map<String, CacheEntry> locationCache = new ConcurrentHashMap<>();
    private final Map<String, CacheEntry> domainCache = new ConcurrentHashMap<>();
    private final Map<String, CoordinatesCacheEntry> coordinatesCache = new ConcurrentHashMap<>();
    
    // Maximum cache size to prevent memory leak
    @Value("${app.ip.geolocation.cache.max-size:5000}")
    private int maxCacheSize;
    
    // Cache TTL in milliseconds (default: 24 hours)
    @Value("${app.ip.geolocation.cache.ttl-hours:24}")
    private long cacheTtlHours;
    
    private static class CacheEntry {
        final String value;
        final long timestamp;
        
        CacheEntry(String value) {
            this.value = value;
            this.timestamp = System.currentTimeMillis();
        }
        
        boolean isExpired(long ttlMillis) {
            return (System.currentTimeMillis() - timestamp) > ttlMillis;
        }
    }
    
    private static class CoordinatesCacheEntry {
        final Double latitude;
        final Double longitude;
        final long timestamp;
        
        CoordinatesCacheEntry(Double latitude, Double longitude) {
            this.latitude = latitude;
            this.longitude = longitude;
            this.timestamp = System.currentTimeMillis();
        }
        
        boolean isExpired(long ttlMillis) {
            return (System.currentTimeMillis() - timestamp) > ttlMillis;
        }
    }
    
    // Private/local IP addresses that don't need lookup
    private static final String[] PRIVATE_IP_PATTERNS = {
        "127.", "localhost", "192.168.", "10.", "172.16.", "172.17.", 
        "172.18.", "172.19.", "172.20.", "172.21.", "172.22.", "172.23.",
        "172.24.", "172.25.", "172.26.", "172.27.", "172.28.", "172.29.",
        "172.30.", "172.31.", "unknown"
    };

    public IpGeolocationService(RestTemplate restTemplate) {
        this.restTemplate = restTemplate;
    }

    /**
     * Get location information for an IP address
     * @param ipAddress IP address to lookup
     * @return Location string (e.g., "Paris, France" or "United States") or null if lookup fails
     */
    public String getLocationInfo(String ipAddress) {
        if (ipAddress == null || ipAddress.trim().isEmpty()) {
            return "Unknown IP";
        }

        // Check if it's a private/local IP
        for (String pattern : PRIVATE_IP_PATTERNS) {
            if (ipAddress.startsWith(pattern)) {
                return "Local/Private IP";
            }
        }

        // Check cache first
        CacheEntry cached = locationCache.get(ipAddress);
        if (cached != null) {
            long ttlMillis = cacheTtlHours * 60 * 60 * 1000;
            if (!cached.isExpired(ttlMillis)) {
                return cached.value;
            } else {
                // Remove expired entry
                locationCache.remove(ipAddress);
            }
        }
        
        // Enforce cache size limit
        enforceCacheSizeLimit(locationCache);

        try {
            // Use ip-api.com free service (no API key required for basic usage)
            // Format: http://ip-api.com/json/{ip}?fields=status,message,country,regionName,city,isp,lat,lon
            String url = "http://ip-api.com/json/" + ipAddress + "?fields=status,message,country,regionName,city,isp,org,lat,lon";
            
            @SuppressWarnings("unchecked")
            Map<String, Object> response = restTemplate.getForObject(url, Map.class);
            
            if (response != null) {
                String status = (String) response.get("status");
                
                if ("success".equals(status)) {
                    String country = (String) response.get("country");
                    String region = (String) response.get("regionName");
                    String city = (String) response.get("city");
                    String isp = (String) response.get("isp");
                    String org = (String) response.get("org");
                    
                    StringBuilder location = new StringBuilder();
                    
                    if (city != null && !city.isEmpty()) {
                        location.append(city);
                    }
                    if (region != null && !region.isEmpty()) {
                        if (location.length() > 0) location.append(", ");
                        location.append(region);
                    }
                    if (country != null && !country.isEmpty()) {
                        if (location.length() > 0) location.append(", ");
                        location.append(country);
                    }
                    
                    // Add ISP/Organization info in parentheses if available
                    String ispOrOrg = isp != null && !isp.isEmpty() ? isp : (org != null && !org.isEmpty() ? org : null);
                    if (ispOrOrg != null) {
                        if (location.length() > 0) {
                            location.append(" (").append(ispOrOrg).append(")");
                        } else {
                            location.append(ispOrOrg);
                        }
                    }
                    
                    String locationStr = location.length() > 0 ? location.toString() : "Unknown Location";
                    
                    // Cache the result
                    locationCache.put(ipAddress, new CacheEntry(locationStr));
                    
                    log.debug("IP {} location: {}", ipAddress, locationStr);
                    return locationStr;
                } else {
                    String message = (String) response.get("message");
                    log.error("IP geolocation lookup failed for {}: {}", ipAddress, message);
                    String errorMsg = "Lookup failed: " + (message != null ? message : "Unknown error");
                    locationCache.put(ipAddress, new CacheEntry(errorMsg));
                    return errorMsg;
                }
            }
        } catch (Exception e) {
            log.warn("Error looking up IP geolocation for {}: {}", ipAddress, e.getMessage());
            // Don't cache errors - might be temporary network issues
        }
        
        return "Location lookup failed";
    }

    /**
     * Get domain name (reverse DNS lookup) for an IP address
     * @param ipAddress IP address to lookup
     * @return Domain name or null if lookup fails or is not available
     */
    public String getDomainName(String ipAddress) {
        if (ipAddress == null || ipAddress.trim().isEmpty()) {
            return null;
        }

        // Check if it's a private/local IP
        for (String pattern : PRIVATE_IP_PATTERNS) {
            if (ipAddress.startsWith(pattern)) {
                return null; // No domain name for private IPs
            }
        }

        // Check cache first
        CacheEntry cached = domainCache.get(ipAddress);
        if (cached != null) {
            long ttlMillis = cacheTtlHours * 60 * 60 * 1000;
            if (!cached.isExpired(ttlMillis)) {
                return "N/A".equals(cached.value) ? null : cached.value;
            } else {
                // Remove expired entry
                domainCache.remove(ipAddress);
            }
        }
        
        // Enforce cache size limit
        enforceCacheSizeLimit(domainCache);

        try {
            InetAddress inetAddress = InetAddress.getByName(ipAddress);
            String hostName = inetAddress.getCanonicalHostName();
            
            // If the hostname is the same as the IP, reverse DNS lookup failed
            if (hostName != null && !hostName.equals(ipAddress)) {
                domainCache.put(ipAddress, new CacheEntry(hostName));
                log.debug("IP {} domain: {}", ipAddress, hostName);
                return hostName;
            } else {
                // No reverse DNS record found
                domainCache.put(ipAddress, new CacheEntry("N/A"));
                return null;
            }
        } catch (Exception e) {
            log.debug("Reverse DNS lookup failed for IP {}: {}", ipAddress, e.getMessage());
            // Cache the failure to avoid repeated attempts
            domainCache.put(ipAddress, new CacheEntry("N/A"));
            return null;
        }
    }

    /**
     * Get coordinates (latitude, longitude) for an IP address
     * @param ipAddress IP address to lookup
     * @return CoordinatesInfo object containing latitude and longitude, or null if lookup fails
     */
    public CoordinatesInfo getCoordinates(String ipAddress) {
        if (ipAddress == null || ipAddress.trim().isEmpty()) {
            return null;
        }

        // Check if it's a private/local IP
        for (String pattern : PRIVATE_IP_PATTERNS) {
            if (ipAddress.startsWith(pattern)) {
                return null; // No coordinates for private IPs
            }
        }

        // Check cache first
        CoordinatesCacheEntry cached = coordinatesCache.get(ipAddress);
        if (cached != null) {
            long ttlMillis = cacheTtlHours * 60 * 60 * 1000;
            if (!cached.isExpired(ttlMillis)) {
                return new CoordinatesInfo(cached.latitude, cached.longitude);
            } else {
                // Remove expired entry
                coordinatesCache.remove(ipAddress);
            }
        }
        
        // Enforce cache size limit
        enforceCoordinatesCacheSizeLimit();

        try {
            // Use ip-api.com free service (no API key required for basic usage)
            // Format: http://ip-api.com/json/{ip}?fields=status,message,lat,lon
            String url = "http://ip-api.com/json/" + ipAddress + "?fields=status,message,lat,lon";
            
            @SuppressWarnings("unchecked")
            Map<String, Object> response = restTemplate.getForObject(url, Map.class);
            
            if (response != null) {
                String status = (String) response.get("status");
                
                if ("success".equals(status)) {
                    Object latObj = response.get("lat");
                    Object lonObj = response.get("lon");
                    
                    if (latObj instanceof Number && lonObj instanceof Number) {
                        Double latitude = ((Number) latObj).doubleValue();
                        Double longitude = ((Number) lonObj).doubleValue();
                        
                        // Cache the result
                        coordinatesCache.put(ipAddress, new CoordinatesCacheEntry(latitude, longitude));
                        
                        log.debug("IP {} coordinates: lat={}, lon={}", ipAddress, latitude, longitude);
                        return new CoordinatesInfo(latitude, longitude);
                    }
                } else {
                    String message = (String) response.get("message");
                    log.warn("IP coordinates lookup failed for {}: {}", ipAddress, message);
                }
            }
        } catch (Exception e) {
            log.warn("Error looking up IP coordinates for {}: {}", ipAddress, e.getMessage());
            // Don't cache errors - might be temporary network issues
        }
        
        return null;
    }

    /**
     * Get complete IP information including location and domain name
     * @param ipAddress IP address to lookup
     * @return IPInfo object containing location and domain name
     */
    public IPInfo getCompleteIpInfo(String ipAddress) {
        String location = getLocationInfo(ipAddress);
        String domain = getDomainName(ipAddress);
        return new IPInfo(ipAddress, location, domain);
    }
    
    /**
     * Get complete IP information including location, domain name, and coordinates
     * @param ipAddress IP address to lookup
     * @return ExtendedIPInfo object containing location, domain name, and coordinates
     */
    public ExtendedIPInfo getCompleteIpInfoWithCoordinates(String ipAddress) {
        String location = getLocationInfo(ipAddress);
        String domain = getDomainName(ipAddress);
        CoordinatesInfo coordinates = getCoordinates(ipAddress);
        return new ExtendedIPInfo(ipAddress, location, domain, 
            coordinates != null ? coordinates.getLatitude() : null,
            coordinates != null ? coordinates.getLongitude() : null);
    }

    /**
     * Clear all caches (useful for testing or if needed)
     */
    public void clearCache() {
        locationCache.clear();
        domainCache.clear();
        coordinatesCache.clear();
    }
    
    /**
     * Enforce cache size limit by removing oldest entries
     */
    private void enforceCacheSizeLimit(Map<String, CacheEntry> cache) {
        if (cache.size() >= maxCacheSize) {
            // Remove oldest entries (simple approach: remove first entry found)
            // In practice, with TTL, entries expire naturally
            String firstKey = cache.keySet().iterator().next();
            cache.remove(firstKey);
            log.debug("Cache size limit reached, removed entry: {}", firstKey);
        }
    }
    
    /**
     * Enforce coordinates cache size limit by removing oldest entries
     */
    private void enforceCoordinatesCacheSizeLimit() {
        if (coordinatesCache.size() >= maxCacheSize) {
            String firstKey = coordinatesCache.keySet().iterator().next();
            coordinatesCache.remove(firstKey);
            log.debug("Coordinates cache size limit reached, removed entry: {}", firstKey);
        }
    }
    
    /**
     * Cleanup expired entries from caches
     */
    public void cleanupExpiredEntries() {
        long ttlMillis = cacheTtlHours * 60 * 60 * 1000;
        locationCache.entrySet().removeIf(entry -> entry.getValue().isExpired(ttlMillis));
        domainCache.entrySet().removeIf(entry -> entry.getValue().isExpired(ttlMillis));
        coordinatesCache.entrySet().removeIf(entry -> entry.getValue().isExpired(ttlMillis));
    }

    /**
     * Data class to hold coordinates information
     */
    public static class CoordinatesInfo {
        private final Double latitude;
        private final Double longitude;

        public CoordinatesInfo(Double latitude, Double longitude) {
            this.latitude = latitude;
            this.longitude = longitude;
        }

        public Double getLatitude() {
            return latitude;
        }

        public Double getLongitude() {
            return longitude;
        }
    }

    /**
     * Data class to hold complete IP information
     */
    public static class IPInfo {
        private final String ipAddress;
        private final String location;
        private final String domainName;

        public IPInfo(String ipAddress, String location, String domainName) {
            this.ipAddress = ipAddress;
            this.location = location;
            this.domainName = domainName;
        }

        public String getIpAddress() {
            return ipAddress;
        }

        public String getLocation() {
            return location;
        }

        public String getDomainName() {
            return domainName;
        }
    }
    
    /**
     * Data class to hold complete IP information including coordinates
     */
    public static class ExtendedIPInfo {
        private final String ipAddress;
        private final String location;
        private final String domainName;
        private final Double latitude;
        private final Double longitude;

        public ExtendedIPInfo(String ipAddress, String location, String domainName, Double latitude, Double longitude) {
            this.ipAddress = ipAddress;
            this.location = location;
            this.domainName = domainName;
            this.latitude = latitude;
            this.longitude = longitude;
        }

        public String getIpAddress() {
            return ipAddress;
        }

        public String getLocation() {
            return location;
        }

        public String getDomainName() {
            return domainName;
        }

        public Double getLatitude() {
            return latitude;
        }

        public Double getLongitude() {
            return longitude;
        }
    }
}
