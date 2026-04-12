package com.pat.service;

import com.pat.repo.domain.Member;
import com.pat.repo.domain.Position;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.util.Date;

/**
 * Service to handle position storage for members
 * Centralized service to be used by all components
 */
@Service
public class PositionService {

    private static final Logger log = LoggerFactory.getLogger(PositionService.class);

    /**
     * When the client registers with {@code POST /memb/user} without GPS, an IP position is stored,
     * then {@code POST /memb/user/gps} sends the real fix. Without this window, both would remain.
     * Only trailing IP entries newer than this are dropped before appending GPS.
     */
    private static final long RECENT_IP_SUPERSEDED_BY_GPS_MS = 300_000L; // 5 minutes

    @Autowired
    private IpGeolocationService ipGeolocationService;

    /**
     * Add a GPS position to a member
     * If the last position(s) have the same coordinates (same address), they are removed so only the latest is kept
     * @param member The member to add the position to
     * @param latitude Latitude coordinate
     * @param longitude Longitude coordinate
     */
    public void addGpsPosition(Member member, Double latitude, Double longitude) {
        if (member == null) {
            log.warn("Cannot add GPS position: member is null");
            return;
        }
        
        if (latitude == null || longitude == null) {
            log.warn("Cannot add GPS position: coordinates are null");
            return;
        }

        if (member.getPositions() == null) {
            member.setPositions(new java.util.ArrayList<>());
        }

        stripRecentTrailingIpSupersededByGps(member);

        // Remove consecutive previous positions with the same address (compare coordinates rounded to 4 decimals)
        // dateFrom = datetime of the immediate previous position (first one we remove)
        Date dateFrom = null;
        while (!member.getPositions().isEmpty()) {
            Position lastPosition = member.getPositions().get(member.getPositions().size() - 1);
            if (sameAddressRounded4(lastPosition.getLatitude(), lastPosition.getLongitude(), latitude, longitude)) {
                if (dateFrom == null) {
                    dateFrom = lastPosition.getDateFrom() != null ? lastPosition.getDateFrom() : lastPosition.getDatetime();
                }
                member.getPositions().remove(member.getPositions().size() - 1);
                log.debug("Removed duplicate GPS position for member {} (same address): lat={}, lon={}",
                    member.getUserName(), latitude, longitude);
            } else {
                break;
            }
        }
        
        Date dateTo = new Date();
        if (dateFrom == null) {
            dateFrom = dateTo;
        }
        // Add the new position (full precision), with date range when we merged with previous
        Position position = new Position(dateFrom, dateTo, "GPS", latitude, longitude);
        member.getPositions().add(position);
        
        // Keep only the last 50 positions
        limitPositions(member);
        
        log.debug("Added GPS position for member {}: lat={}, lon={} (full precision preserved)",
            member.getUserName(), latitude, longitude);
    }

    /**
     * Add an IP-based position to a member
     * If the last position(s) have the same coordinates (same address), they are removed so only the latest is kept
     * @param member The member to add the position to
     * @param ipAddress IP address to lookup coordinates from
     */
    public void addIpPosition(Member member, String ipAddress) {
        if (member == null) {
            log.warn("Cannot add IP position: member is null");
            return;
        }
        
        if (ipAddress == null || ipAddress.trim().isEmpty()) {
            log.warn("Cannot add IP position: IP address is null or empty");
            return;
        }

        try {
            IpGeolocationService.CoordinatesInfo coordinates = ipGeolocationService.getCoordinates(ipAddress);
            
            if (coordinates != null && coordinates.getLatitude() != null && coordinates.getLongitude() != null) {
                Double lat = coordinates.getLatitude();
                Double lon = coordinates.getLongitude();

                if (member.getPositions() == null) {
                    member.setPositions(new java.util.ArrayList<>());
                }
                
                // Remove consecutive previous positions with the same address (compare coordinates rounded to 4 decimals)
                // dateFrom = datetime of the immediate previous position (first one we remove)
                Date dateFrom = null;
                while (!member.getPositions().isEmpty()) {
                    Position lastPosition = member.getPositions().get(member.getPositions().size() - 1);
                    if (sameAddressRounded4(lastPosition.getLatitude(), lastPosition.getLongitude(), lat, lon)) {
                        if (dateFrom == null) {
                            dateFrom = lastPosition.getDateFrom() != null ? lastPosition.getDateFrom() : lastPosition.getDatetime();
                        }
                        member.getPositions().remove(member.getPositions().size() - 1);
                        log.debug("Removed duplicate IP position for member {} (same address): lat={}, lon={} (from IP: {})",
                            member.getUserName(), lat, lon, ipAddress);
                    } else {
                        break;
                    }
                }
                
                Date dateTo = new Date();
                if (dateFrom == null) {
                    dateFrom = dateTo;
                }
                // Add the new position (full precision), with date range when we merged with previous
                Position position = new Position(dateFrom, dateTo, "IP", lat, lon);
                member.getPositions().add(position);
                
                // Keep only the last 50 positions
                limitPositions(member);
                
                log.debug("Added IP position for member {}: lat={}, lon={} (from IP: {})", 
                    member.getUserName(), lat, lon, ipAddress);
            } else {
                log.debug("Could not determine coordinates from IP address {} for member {}", ipAddress, member.getUserName());
            }
        } catch (Exception e) {
            log.warn("Error adding IP position for member {}: {}", member.getUserName(), e.getMessage());
        }
    }

    /**
     * Get the latest position for a member
     * @param member The member
     * @return The latest position, or null if no positions exist
     */
    public Position getLatestPosition(Member member) {
        if (member == null || member.getPositions() == null || member.getPositions().isEmpty()) {
            return null;
        }
        
        // Return the last position in the list (most recent)
        return member.getPositions().get(member.getPositions().size() - 1);
    }
    
    /**
     * Limit the positions list to the last 50 positions
     * @param member The member whose positions should be limited
     */
    private void limitPositions(Member member) {
        if (member == null || member.getPositions() == null) {
            return;
        }
        
        final int MAX_POSITIONS = 50;
        if (member.getPositions().size() > MAX_POSITIONS) {
            // Keep only the last MAX_POSITIONS positions (most recent)
            java.util.List<Position> positions = member.getPositions();
            java.util.List<Position> recentPositions = new java.util.ArrayList<>(
                positions.subList(positions.size() - MAX_POSITIONS, positions.size())
            );
            member.setPositions(recentPositions);
            log.debug("Limited positions for member {} to last {} positions (removed {} old positions)", 
                member.getUserName(), MAX_POSITIONS, positions.size() - MAX_POSITIONS);
        }
    }

    /**
     * Round a coordinate to 4 decimal places (used only for comparison, not storage)
     */
    private static double roundTo4Decimals(Double value) {
        if (value == null) {
            return 0.0;
        }
        return BigDecimal.valueOf(value).setScale(4, RoundingMode.HALF_UP).doubleValue();
    }

    /**
     * True if both coordinate pairs are equal when rounded to 4 decimal places (same address for deduplication)
     */
    private static boolean sameAddressRounded4(Double lat1, Double lon1, Double lat2, Double lon2) {
        if (lat1 == null || lon1 == null || lat2 == null || lon2 == null) {
            return false;
        }
        return Double.compare(roundTo4Decimals(lat1), roundTo4Decimals(lat2)) == 0
            && Double.compare(roundTo4Decimals(lon1), roundTo4Decimals(lon2)) == 0;
    }

    /**
     * Drops trailing {@code IP} positions still "fresh" so a GPS fix from the same app session
     * replaces the placeholder IP instead of stacking a second point.
     */
    private void stripRecentTrailingIpSupersededByGps(Member member) {
        if (member.getPositions() == null || member.getPositions().isEmpty()) {
            return;
        }
        long now = System.currentTimeMillis();
        while (!member.getPositions().isEmpty()) {
            Position last = member.getPositions().get(member.getPositions().size() - 1);
            if (!"IP".equals(last.getType())) {
                break;
            }
            Date ref = last.getDateTo() != null ? last.getDateTo() : last.getDatetime();
            if (ref == null || now - ref.getTime() > RECENT_IP_SUPERSEDED_BY_GPS_MS) {
                break;
            }
            member.getPositions().remove(member.getPositions().size() - 1);
            log.debug("Removed recent IP position for member {} (superseded by GPS in same connection window)",
                member.getUserName());
        }
    }
}
