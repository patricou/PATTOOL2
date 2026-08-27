package com.pat.service;

import com.pat.controller.dto.GpsItineraryDto;
import com.pat.controller.dto.GpsPlacePointDto;
import com.pat.repo.GpsItineraryRepository;
import com.pat.repo.MembersRepository;
import com.pat.repo.domain.GpsItinerary;
import com.pat.repo.domain.GpsPlacePoint;
import com.pat.repo.domain.Member;
import org.springframework.stereotype.Service;
import org.springframework.util.StringUtils;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.Date;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.stream.Collectors;

@Service
public class GpsItineraryService {

    private static final int MAX_COORDINATES = 8_000;
    private static final int MAX_VIA_POINTS = OpenRouteProxyService.MAX_VIA_POINTS;
    private static final Set<String> ALLOWED_PROFILES = Set.of(
            "driving-car", "cycling-regular", "foot-walking");

    private final GpsItineraryRepository repository;
    private final MembersRepository membersRepository;
    private final FriendsService friendsService;

    public GpsItineraryService(
            GpsItineraryRepository repository,
            MembersRepository membersRepository,
            FriendsService friendsService) {
        this.repository = repository;
        this.membersRepository = membersRepository;
        this.friendsService = friendsService;
    }

    public List<GpsItineraryDto> listForMember(Member me) {
        List<GpsItinerary> owned = repository.findByOwnerMemberIdOrderByUpdatedAtDesc(me.getId());
        List<GpsItinerary> shared = repository.findBySharedWithMemberIdsContainingOrderByUpdatedAtDesc(me.getId());
        Map<String, GpsItinerary> byId = new LinkedHashMap<>();
        for (GpsItinerary it : owned) {
            byId.put(it.getId(), it);
        }
        for (GpsItinerary it : shared) {
            byId.putIfAbsent(it.getId(), it);
        }
        return byId.values().stream()
                .sorted(Comparator.comparing(GpsItinerary::getUpdatedAt, Comparator.nullsLast(Comparator.reverseOrder())))
                .map(it -> toDto(it, me.getId()))
                .collect(Collectors.toList());
    }

    public Optional<GpsItineraryDto> getForMember(String id, Member me) {
        return repository.findById(id)
                .filter(it -> canRead(it, me.getId()))
                .map(it -> toDto(it, me.getId()));
    }

    public GpsItineraryDto create(Member me, GpsItineraryDto body) {
        validateWritable(body);
        Date now = new Date();
        GpsItinerary entity = new GpsItinerary();
        applyWritableFields(entity, body);
        entity.setOwnerMemberId(me.getId());
        entity.setOwnerUsername(resolveUsername(me));
        entity.setSharedWithMemberIds(new ArrayList<>());
        entity.setCreatedAt(now);
        entity.setUpdatedAt(now);
        return toDto(repository.save(entity), me.getId());
    }

    public Optional<GpsItineraryDto> update(String id, Member me, GpsItineraryDto body) {
        Optional<GpsItinerary> opt = repository.findById(id);
        if (opt.isEmpty()) {
            return Optional.empty();
        }
        GpsItinerary entity = opt.get();
        if (!me.getId().equals(entity.getOwnerMemberId())) {
            throw new SecurityException("not_owner");
        }
        validateWritable(body);
        applyWritableFields(entity, body);
        entity.setOwnerUsername(resolveUsername(me));
        entity.setUpdatedAt(new Date());
        return Optional.of(toDto(repository.save(entity), me.getId()));
    }

    public boolean delete(String id, Member me) {
        Optional<GpsItinerary> opt = repository.findById(id);
        if (opt.isEmpty()) {
            return false;
        }
        GpsItinerary entity = opt.get();
        if (!me.getId().equals(entity.getOwnerMemberId())) {
            throw new SecurityException("not_owner");
        }
        repository.delete(entity);
        return true;
    }

    /**
     * Replace the share list with the given friend member ids (owner only).
     */
    public GpsItineraryDto share(String id, Member me, List<String> memberIds) {
        GpsItinerary entity = repository.findById(id)
                .orElseThrow(() -> new IllegalArgumentException("not_found"));
        if (!me.getId().equals(entity.getOwnerMemberId())) {
            throw new SecurityException("not_owner");
        }
        LinkedHashSet<String> next = new LinkedHashSet<>();
        if (memberIds != null) {
            for (String raw : memberIds) {
                if (!StringUtils.hasText(raw)) {
                    continue;
                }
                String memberId = raw.trim();
                if (memberId.equals(me.getId())) {
                    continue;
                }
                Member target = membersRepository.findById(memberId).orElse(null);
                if (target == null || !friendsService.areFriends(me, target)) {
                    throw new IllegalArgumentException("not_friend:" + memberId);
                }
                next.add(memberId);
            }
        }
        entity.setSharedWithMemberIds(new ArrayList<>(next));
        entity.setUpdatedAt(new Date());
        return toDto(repository.save(entity), me.getId());
    }

    private boolean canRead(GpsItinerary it, String memberId) {
        if (memberId.equals(it.getOwnerMemberId())) {
            return true;
        }
        List<String> shared = it.getSharedWithMemberIds();
        return shared != null && shared.contains(memberId);
    }

    private void validateWritable(GpsItineraryDto body) {
        if (body == null) {
            throw new IllegalArgumentException("body_required");
        }
        if (!StringUtils.hasText(body.getProfile()) || !ALLOWED_PROFILES.contains(body.getProfile().trim())) {
            throw new IllegalArgumentException("invalid_profile");
        }
        if (body.getFrom() == null || body.getTo() == null) {
            throw new IllegalArgumentException("from_to_required");
        }
        if (!isValidLatLon(body.getFrom().getLat(), body.getFrom().getLon())
                || !isValidLatLon(body.getTo().getLat(), body.getTo().getLon())) {
            throw new IllegalArgumentException("invalid_coordinates");
        }
        List<GpsPlacePointDto> vias = body.getVias() != null ? body.getVias() : List.of();
        if (vias.size() > MAX_VIA_POINTS) {
            throw new IllegalArgumentException("too_many_vias");
        }
        for (GpsPlacePointDto via : vias) {
            if (via == null || !isValidLatLon(via.getLat(), via.getLon())) {
                throw new IllegalArgumentException("invalid_via");
            }
        }
    }

    private void applyWritableFields(GpsItinerary entity, GpsItineraryDto body) {
        entity.setProfile(body.getProfile().trim());
        entity.setFrom(toPlace(body.getFrom()));
        entity.setVias(toPlaces(body.getVias()));
        entity.setTo(toPlace(body.getTo()));
        entity.setDistanceMeters(body.getDistanceMeters());
        entity.setDurationSeconds(body.getDurationSeconds());
        entity.setAscentMeters(body.getAscentMeters());
        entity.setDescentMeters(body.getDescentMeters());
        List<double[]> coords = body.getCoordinates() != null ? body.getCoordinates() : List.of();
        if (coords.size() > MAX_COORDINATES) {
            coords = downsample(coords, MAX_COORDINATES);
        }
        entity.setCoordinates(new ArrayList<>(coords));
    }

    private static List<double[]> downsample(List<double[]> coords, int max) {
        if (coords.size() <= max) {
            return coords;
        }
        List<double[]> out = new ArrayList<>(max);
        int last = coords.size() - 1;
        for (int i = 0; i < max - 1; i++) {
            int idx = (int) Math.round((double) i * last / (max - 1));
            out.add(coords.get(idx));
        }
        out.add(coords.get(last));
        return out;
    }

    private GpsItineraryDto toDto(GpsItinerary entity, String viewerMemberId) {
        GpsItineraryDto dto = new GpsItineraryDto();
        dto.setId(entity.getId());
        dto.setOwnerMemberId(entity.getOwnerMemberId());
        dto.setOwnerUsername(entity.getOwnerUsername());
        dto.setProfile(entity.getProfile());
        dto.setFrom(toPlaceDto(entity.getFrom()));
        dto.setVias(toPlaceDtos(entity.getVias()));
        dto.setTo(toPlaceDto(entity.getTo()));
        dto.setDistanceMeters(entity.getDistanceMeters());
        dto.setDurationSeconds(entity.getDurationSeconds());
        dto.setAscentMeters(entity.getAscentMeters());
        dto.setDescentMeters(entity.getDescentMeters());
        dto.setCoordinates(entity.getCoordinates() != null ? entity.getCoordinates() : List.of());
        List<String> sharedIds = entity.getSharedWithMemberIds() != null
                ? entity.getSharedWithMemberIds()
                : List.of();
        dto.setSharedWithMemberIds(sharedIds);
        dto.setSharedWithUsernames(resolveUsernames(sharedIds));
        dto.setCreatedAt(entity.getCreatedAt());
        dto.setUpdatedAt(entity.getUpdatedAt());
        dto.setSharedWithMe(!viewerMemberId.equals(entity.getOwnerMemberId())
                && sharedIds.contains(viewerMemberId));
        return dto;
    }

    private List<String> resolveUsernames(List<String> memberIds) {
        List<String> names = new ArrayList<>();
        for (String id : memberIds) {
            membersRepository.findById(id).ifPresent(m -> {
                String name = resolveUsername(m);
                if (StringUtils.hasText(name)) {
                    names.add(name);
                }
            });
        }
        return names;
    }

    private static String resolveUsername(Member m) {
        if (m == null) {
            return null;
        }
        if (StringUtils.hasText(m.getUserName())) {
            return m.getUserName().trim();
        }
        String first = m.getFirstName() != null ? m.getFirstName().trim() : "";
        String last = m.getLastName() != null ? m.getLastName().trim() : "";
        String full = (first + " " + last).trim();
        return StringUtils.hasText(full) ? full : m.getId();
    }

    private static GpsPlacePoint toPlace(GpsPlacePointDto dto) {
        GpsPlacePoint p = new GpsPlacePoint();
        p.setLat(dto.getLat());
        p.setLon(dto.getLon());
        p.setLabel(dto.getLabel() != null ? dto.getLabel() : "");
        return p;
    }

    private static List<GpsPlacePoint> toPlaces(List<GpsPlacePointDto> dtos) {
        List<GpsPlacePoint> out = new ArrayList<>();
        if (dtos == null) {
            return out;
        }
        for (GpsPlacePointDto dto : dtos) {
            if (dto != null) {
                out.add(toPlace(dto));
            }
        }
        return out;
    }

    private static List<GpsPlacePointDto> toPlaceDtos(List<GpsPlacePoint> points) {
        List<GpsPlacePointDto> out = new ArrayList<>();
        if (points == null) {
            return out;
        }
        for (GpsPlacePoint p : points) {
            GpsPlacePointDto dto = toPlaceDto(p);
            if (dto != null) {
                out.add(dto);
            }
        }
        return out;
    }

    private static GpsPlacePointDto toPlaceDto(GpsPlacePoint p) {
        if (p == null) {
            return null;
        }
        GpsPlacePointDto dto = new GpsPlacePointDto();
        dto.setLat(p.getLat());
        dto.setLon(p.getLon());
        dto.setLabel(p.getLabel());
        return dto;
    }

    private static boolean isValidLatLon(double lat, double lon) {
        return Double.isFinite(lat) && Double.isFinite(lon)
                && lat >= -90 && lat <= 90
                && lon >= -180 && lon <= 180;
    }
}
