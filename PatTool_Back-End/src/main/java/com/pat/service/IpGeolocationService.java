package com.pat.service;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
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
    private final Map<String, String> locationCache = new ConcurrentHashMap<>();
    private final Map<String, String> domainCache = new ConcurrentHashMap<>();
    
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
        if (locationCache.containsKey(ipAddress)) {
            return locationCache.get(ipAddress);
        }

        try {
            // Use ip-api.com free service (no API key required for basic usage)
            // Format: http://ip-api.com/json/{ip}?fields=status,message,country,regionName,city,isp
            String url = "http://ip-api.com/json/" + ipAddress + "?fields=status,message,country,regionName,city,isp,org";
            
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
                    locationCache.put(ipAddress, locationStr);
                    
                    log.debug("IP {} location: {}", ipAddress, locationStr);
                    return locationStr;
                } else {
                    String message = (String) response.get("message");
                    log.warn("IP geolocation lookup failed for {}: {}", ipAddress, message);
                    String errorMsg = "Lookup failed: " + (message != null ? message : "Unknown error");
                    locationCache.put(ipAddress, errorMsg);
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
        if (domainCache.containsKey(ipAddress)) {
            String cached = domainCache.get(ipAddress);
            return "N/A".equals(cached) ? null : cached;
        }

        try {
            InetAddress inetAddress = InetAddress.getByName(ipAddress);
            String hostName = inetAddress.getCanonicalHostName();
            
            // If the hostname is the same as the IP, reverse DNS lookup failed
            if (hostName != null && !hostName.equals(ipAddress)) {
                domainCache.put(ipAddress, hostName);
                log.debug("IP {} domain: {}", ipAddress, hostName);
                return hostName;
            } else {
                // No reverse DNS record found
                domainCache.put(ipAddress, "N/A");
                return null;
            }
        } catch (Exception e) {
            log.debug("Reverse DNS lookup failed for IP {}: {}", ipAddress, e.getMessage());
            // Cache the failure to avoid repeated attempts
            domainCache.put(ipAddress, "N/A");
            return null;
        }
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
     * Clear all caches (useful for testing or if needed)
     */
    public void clearCache() {
        locationCache.clear();
        domainCache.clear();
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
}
