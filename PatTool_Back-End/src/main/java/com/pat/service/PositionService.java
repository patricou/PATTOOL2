package com.pat.service;

import com.pat.repo.domain.Member;
import com.pat.repo.domain.Position;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;

import java.util.Date;
import java.util.Calendar;

/**
 * Service to handle position storage for members
 * Centralized service to be used by all components
 */
@Service
public class PositionService {

    private static final Logger log = LoggerFactory.getLogger(PositionService.class);

    @Autowired
    private IpGeolocationService ipGeolocationService;

    /**
     * Add a GPS position to a member
     * If the last position has the same coordinates, it will be removed and replaced with the new one
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
        
        // Check if the last position has the same coordinates AND is from the same day
        if (!member.getPositions().isEmpty()) {
            Position lastPosition = member.getPositions().get(member.getPositions().size() - 1);
            if (lastPosition.getLatitude() != null && lastPosition.getLongitude() != null &&
                lastPosition.getLatitude().equals(latitude) && lastPosition.getLongitude().equals(longitude) &&
                isSameDay(lastPosition.getDatetime(), new Date())) {
                // Remove the last position (same coordinates and same day)
                member.getPositions().remove(member.getPositions().size() - 1);
                log.debug("Removed duplicate GPS position for member {} (same coordinates and same day): lat={}, lon={}", 
                    member.getUserName(), latitude, longitude);
            }
        }
        
        // Add the new position
        Position position = new Position(new Date(), "GPS", latitude, longitude);
        member.getPositions().add(position);
        
        // Keep only the last 30 positions
        limitPositions(member);
        
        // Log with full precision to verify coordinates are stored correctly
        log.debug("Added GPS position for member {}: lat={}, lon={} (full precision preserved)", 
            member.getUserName(), latitude, longitude);
    }

    /**
     * Add an IP-based position to a member
     * If the last position has the same coordinates, it will be removed and replaced with the new one
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
                if (member.getPositions() == null) {
                    member.setPositions(new java.util.ArrayList<>());
                }
                
                // Check if the last position has the same coordinates AND is from the same day
                if (!member.getPositions().isEmpty()) {
                    Position lastPosition = member.getPositions().get(member.getPositions().size() - 1);
                    if (lastPosition.getLatitude() != null && lastPosition.getLongitude() != null &&
                        lastPosition.getLatitude().equals(coordinates.getLatitude()) && 
                        lastPosition.getLongitude().equals(coordinates.getLongitude()) &&
                        isSameDay(lastPosition.getDatetime(), new Date())) {
                        // Remove the last position (same coordinates and same day)
                        member.getPositions().remove(member.getPositions().size() - 1);
                        log.debug("Removed duplicate IP position for member {} (same coordinates and same day): lat={}, lon={} (from IP: {})", 
                            member.getUserName(), coordinates.getLatitude(), coordinates.getLongitude(), ipAddress);
                    }
                }
                
                // Add the new position
                Position position = new Position(new Date(), "IP", coordinates.getLatitude(), coordinates.getLongitude());
                member.getPositions().add(position);
                
                // Keep only the last 30 positions
                limitPositions(member);
                
                log.debug("Added IP position for member {}: lat={}, lon={} (from IP: {})", 
                    member.getUserName(), coordinates.getLatitude(), coordinates.getLongitude(), ipAddress);
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
     * Limit the positions list to the last 30 positions
     * @param member The member whose positions should be limited
     */
    private void limitPositions(Member member) {
        if (member == null || member.getPositions() == null) {
            return;
        }
        
        final int MAX_POSITIONS = 30;
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
     * Check if two dates are on the same day (ignoring time)
     * @param date1 First date
     * @param date2 Second date
     * @return true if both dates are on the same day
     */
    private boolean isSameDay(Date date1, Date date2) {
        if (date1 == null || date2 == null) {
            return false;
        }
        
        Calendar cal1 = Calendar.getInstance();
        cal1.setTime(date1);
        Calendar cal2 = Calendar.getInstance();
        cal2.setTime(date2);
        
        return cal1.get(Calendar.YEAR) == cal2.get(Calendar.YEAR) &&
               cal1.get(Calendar.DAY_OF_YEAR) == cal2.get(Calendar.DAY_OF_YEAR);
    }
}
