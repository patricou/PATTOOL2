package com.pat.controller;

import com.pat.repo.FriendGroupRepository;
import com.pat.repo.FriendRepository;
import com.pat.repo.MembersRepository;
import com.pat.repo.domain.Evenement;
import com.pat.repo.domain.FileUploaded;
import com.pat.repo.domain.Friend;
import com.pat.repo.domain.FriendGroup;
import com.pat.repo.domain.Member;
import org.bson.types.ObjectId;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.data.domain.Sort;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.data.mongodb.core.query.Criteria;
import org.springframework.data.mongodb.core.query.Query;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.text.Normalizer;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;
import java.util.regex.Pattern;
import java.util.Locale;

@RestController
@RequestMapping("/api/photos")
public class PhotoTimelineRestController {

    private static final Logger log = LoggerFactory.getLogger(PhotoTimelineRestController.class);
    private static final long ACCESS_CACHE_TTL_MS = 2 * 60 * 1000;

    /** Mongo regex (flag i) + Java {@link #looksLikeImageFileName}: fichiers image quand {@code fileType} est absent ou incorrect. */
    private static final String IMAGE_FILENAME_MONGO_REGEX =
            ".*\\.(jpe?g|png|gif|webp|bmp|heic|avif|tif|tiff)$";
    private static final Pattern IMAGE_FILENAME_PATTERN = Pattern.compile(
            IMAGE_FILENAME_MONGO_REGEX, Pattern.CASE_INSENSITIVE);

    private static Criteria criteriaUploadedImageSignal() {
        Criteria byType = Criteria.where("fileUploadeds.fileType").regex("^image/");
        Criteria byName = Criteria.where("fileUploadeds.fileName").regex(IMAGE_FILENAME_MONGO_REGEX, "i");
        return new Criteria().orOperator(byType, byName);
    }

    private static Criteria criteriaThumbnailImageSignal() {
        Criteria byType = Criteria.where("thumbnail.fileType").regex("^image/");
        Criteria byName = Criteria.where("thumbnail.fileName").regex(IMAGE_FILENAME_MONGO_REGEX, "i");
        return new Criteria().orOperator(byType, byName);
    }

    /** Au moins une entrée {@code photosUrl} non vide (évite les tableaux avec chaînes vides). */
    private static Criteria criteriaNonEmptyPhotosUrl() {
        return Criteria.where("photosUrl").regex(".+");
    }

    /** Lien photo FS / album avec {@code link} non vide (aligné sur {@link #extractFsPhotoLinks}). */
    private static Criteria criteriaFsPhotoLinkWithNonemptyLink() {
        return Criteria.where("urlEvents").elemMatch(new Criteria().andOperator(
                Criteria.where("typeUrl").in("PHOTOFROMFS", "PHOTOS", "PHOTO"),
                Criteria.where("link").regex(".+")));
    }

    private static Criteria criteriaTimelineHasAnyPhotoContent() {
        return new Criteria().orOperator(
                criteriaUploadedImageSignal(),
                criteriaNonEmptyPhotosUrl(),
                criteriaFsPhotoLinkWithNonemptyLink(),
                criteriaThumbnailImageSignal());
    }

    @Autowired
    private MongoTemplate mongoTemplate;

    @Autowired
    private MembersRepository membersRepository;

    @Autowired
    private FriendRepository friendRepository;

    @Autowired
    private FriendGroupRepository friendGroupRepository;

    /**
     * Cache the expensive access criteria per user so it's only computed once
     * and reused across all page requests within the TTL.
     */
    private final ConcurrentHashMap<String, CachedAccessCriteria> accessCriteriaCache = new ConcurrentHashMap<>();

    private static class CachedAccessCriteria {
        final Criteria criteria;
        final long createdAt;
        CachedAccessCriteria(Criteria criteria) {
            this.criteria = criteria;
            this.createdAt = System.currentTimeMillis();
        }
        boolean isExpired() {
            return System.currentTimeMillis() - createdAt > ACCESS_CACHE_TTL_MS;
        }
    }

    public static class TimelinePhoto {
        private String fileId;
        private String fileName;
        private String fileType;
        private String uploaderName;
        private String eventId;
        private String eventName;
        private String eventType;
        private Date eventDate;

        public TimelinePhoto() {}

        public TimelinePhoto(String fileId, String fileName, String fileType, String uploaderName,
                             String eventId, String eventName, String eventType, Date eventDate) {
            this.fileId = fileId;
            this.fileName = fileName;
            this.fileType = fileType;
            this.uploaderName = uploaderName;
            this.eventId = eventId;
            this.eventName = eventName;
            this.eventType = eventType;
            this.eventDate = eventDate;
        }

        public String getFileId() { return fileId; }
        public void setFileId(String fileId) { this.fileId = fileId; }
        public String getFileName() { return fileName; }
        public void setFileName(String fileName) { this.fileName = fileName; }
        public String getFileType() { return fileType; }
        public void setFileType(String fileType) { this.fileType = fileType; }
        public String getUploaderName() { return uploaderName; }
        public void setUploaderName(String uploaderName) { this.uploaderName = uploaderName; }
        public String getEventId() { return eventId; }
        public void setEventId(String eventId) { this.eventId = eventId; }
        public String getEventName() { return eventName; }
        public void setEventName(String eventName) { this.eventName = eventName; }
        public String getEventType() { return eventType; }
        public void setEventType(String eventType) { this.eventType = eventType; }
        public Date getEventDate() { return eventDate; }
        public void setEventDate(Date eventDate) { this.eventDate = eventDate; }
    }

    public static class FsPhotoLink {
        /** Link type (WEBSITE, MAP, PHOTOS, PHOTOFROMFS, TRACK, …) — see normalizeUrlEventTypeForTimeline. */
        private String typeUrl;
        private String path;
        private String description;
        /** GridFS / attached file: id used to open the track in the viewer (type {@code TRACK}). */
        private String fieldId;

        public FsPhotoLink() {}
        public FsPhotoLink(String path, String description) {
            this.path = path;
            this.description = description;
        }

        public String getTypeUrl() { return typeUrl; }
        public void setTypeUrl(String typeUrl) { this.typeUrl = typeUrl; }
        public String getPath() { return path; }
        public void setPath(String path) { this.path = path; }
        public String getDescription() { return description; }
        public void setDescription(String description) { this.description = description; }
        public String getFieldId() { return fieldId; }
        public void setFieldId(String fieldId) { this.fieldId = fieldId; }
    }

    public static class TimelineGroup {
        private String eventId;
        private String eventName;
        private String eventType;
        private String eventDescription;
        private Date eventDate;
        private String visibility;
        private String friendGroupId;
        private List<String> friendGroupIds;
        private List<TimelinePhoto> photos;
        private List<TimelinePhoto> videos;
        private List<FsPhotoLink> fsPhotoLinks;
        private String ownerFirstName;
        private String ownerLastName;
        private String ownerUserName;
        /** Number of positive votes for the event (photo wall). */
        private Integer ratingPlus;
        /** Number of negative votes for the event (photo wall). */
        private Integer ratingMinus;

        public TimelineGroup() {}

        public String getEventId() { return eventId; }
        public void setEventId(String eventId) { this.eventId = eventId; }
        public String getEventName() { return eventName; }
        public void setEventName(String eventName) { this.eventName = eventName; }
        public String getEventType() { return eventType; }
        public void setEventType(String eventType) { this.eventType = eventType; }
        public String getEventDescription() { return eventDescription; }
        public void setEventDescription(String eventDescription) { this.eventDescription = eventDescription; }
        public Date getEventDate() { return eventDate; }
        public void setEventDate(Date eventDate) { this.eventDate = eventDate; }
        public String getVisibility() { return visibility; }
        public void setVisibility(String visibility) { this.visibility = visibility; }
        public String getFriendGroupId() { return friendGroupId; }
        public void setFriendGroupId(String friendGroupId) { this.friendGroupId = friendGroupId; }
        public List<String> getFriendGroupIds() { return friendGroupIds; }
        public void setFriendGroupIds(List<String> friendGroupIds) { this.friendGroupIds = friendGroupIds; }
        public List<TimelinePhoto> getPhotos() { return photos; }
        public void setPhotos(List<TimelinePhoto> photos) { this.photos = photos; }
        public List<TimelinePhoto> getVideos() { return videos; }
        public void setVideos(List<TimelinePhoto> videos) { this.videos = videos; }
        public List<FsPhotoLink> getFsPhotoLinks() { return fsPhotoLinks; }
        public void setFsPhotoLinks(List<FsPhotoLink> fsPhotoLinks) { this.fsPhotoLinks = fsPhotoLinks; }
        public String getOwnerFirstName() { return ownerFirstName; }
        public void setOwnerFirstName(String ownerFirstName) { this.ownerFirstName = ownerFirstName; }
        public String getOwnerLastName() { return ownerLastName; }
        public void setOwnerLastName(String ownerLastName) { this.ownerLastName = ownerLastName; }
        public String getOwnerUserName() { return ownerUserName; }
        public void setOwnerUserName(String ownerUserName) { this.ownerUserName = ownerUserName; }
        public Integer getRatingPlus() { return ratingPlus; }
        public void setRatingPlus(Integer ratingPlus) { this.ratingPlus = ratingPlus; }
        public Integer getRatingMinus() { return ratingMinus; }
        public void setRatingMinus(Integer ratingMinus) { this.ratingMinus = ratingMinus; }
    }

    public static class TimelineResponse {
        private List<TimelineGroup> groups;
        private int totalPhotos;
        private int totalGroups;
        private int page;
        private int pageSize;
        private boolean hasMore;
        private List<TimelinePhoto> onThisDay;

        public TimelineResponse() {}

        public List<TimelineGroup> getGroups() { return groups; }
        public void setGroups(List<TimelineGroup> groups) { this.groups = groups; }
        public int getTotalPhotos() { return totalPhotos; }
        public void setTotalPhotos(int totalPhotos) { this.totalPhotos = totalPhotos; }
        public int getTotalGroups() { return totalGroups; }
        public void setTotalGroups(int totalGroups) { this.totalGroups = totalGroups; }
        public int getPage() { return page; }
        public void setPage(int page) { this.page = page; }
        public int getPageSize() { return pageSize; }
        public void setPageSize(int pageSize) { this.pageSize = pageSize; }
        public boolean isHasMore() { return hasMore; }
        public void setHasMore(boolean hasMore) { this.hasMore = hasMore; }
        public List<TimelinePhoto> getOnThisDay() { return onThisDay; }
        public void setOnThisDay(List<TimelinePhoto> onThisDay) { this.onThisDay = onThisDay; }
    }

    /**
     * Resolve event author (owner). With projection, DBRef is often not populated — load from repository if needed.
     * {@code authorCache} avoids N identical {@code findById} calls per timeline page.
     */
    private Member resolveEventAuthor(Evenement e, Map<String, Member> authorCache) {
        if (e == null || e.getAuthor() == null) return null;
        Member author = e.getAuthor();
        String id = author.getId();
        if (id == null || id.isBlank()) return null;
        if (author.getUserName() != null && !author.getUserName().isBlank()) return author;
        return authorCache.computeIfAbsent(id, k -> membersRepository.findById(k).orElse(null));
    }

    @GetMapping(value = "/timeline", produces = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<TimelineResponse> getPhotoTimeline(
            @RequestHeader(value = "user-id", required = false) String userId,
            @RequestParam(value = "page", defaultValue = "0") int page,
            @RequestParam(value = "size", defaultValue = "12") int size,
            @RequestParam(value = "search", required = false) String search,
            @RequestParam(value = "visibility", required = false) String visibility,
            @RequestParam(value = "eventId", required = false) String eventId) {
        try {
            long start = System.currentTimeMillis();

            Criteria accessCriteria = getAccessCriteria(userId, visibility);
            Criteria mainCriteria;
            if (eventId != null && !eventId.trim().isEmpty()) {
                // Single-event wall: load by id + access only, then filter by photos in Java.
                // This avoids missing events with one photo (e.g. regex/deserialization edge cases).
                mainCriteria = new Criteria().andOperator(accessCriteria, eventIdCriteria(eventId.trim()));
            } else {
                Criteria hasAnyPhotoContent = criteriaTimelineHasAnyPhotoContent();
                mainCriteria = new Criteria().andOperator(accessCriteria, hasAnyPhotoContent);
            }
            if (search != null && !search.trim().isEmpty()) {
                mainCriteria = new Criteria().andOperator(mainCriteria, buildSearchCriteria(search.trim()));
            }

            log.info("[PhotoTimeline] userId={} visibility={} page={} query={}", userId, visibility, page, mainCriteria.getCriteriaObject().toJson());
            Query pagedQuery = new Query(mainCriteria);
            pagedQuery.with(Sort.by(Sort.Direction.DESC, "beginEventDate"));
            pagedQuery.skip((long) page * size);
            pagedQuery.limit(size + 1);
            pagedQuery.fields()
                    .include("id")
                    .include("evenementName")
                    .include("type")
                    .include("comments")
                    .include("beginEventDate")
                    .include("ratingPlus")
                    .include("ratingMinus")
                    .include("fileUploadeds")
                    .include("thumbnail")
                    .include("urlEvents")
                    .include("photosUrl")
                    .include("map")
                    .include("visibility")
                    .include("friendGroupId")
                    .include("friendGroupIds")
                    .include("author");

            List<Evenement> events = mongoTemplate.find(pagedQuery, Evenement.class);

            boolean hasMore = events.size() > size;
            if (hasMore) {
                events = events.subList(0, size);
            }

            List<TimelineGroup> groups = new ArrayList<>();
            int totalPhotosInPage = 0;
            Map<String, Member> authorCache = new HashMap<>();

            for (Evenement e : events) {
                List<TimelinePhoto> photos = extractPhotos(e);
                List<TimelinePhoto> videos = extractVideos(e);
                List<FsPhotoLink> fsLinks = extractFsPhotoLinks(e);
                if (!photos.isEmpty() || !fsLinks.isEmpty()) {
                    TimelineGroup group = new TimelineGroup();
                    group.setEventId(e.getId());
                    group.setEventName(e.getEvenementName());
                    group.setEventType(e.getType());
                    group.setEventDescription(e.getComments());
                    group.setEventDate(e.getBeginEventDate());
                    group.setVisibility(e.getVisibility());
                    group.setFriendGroupId(e.getFriendGroupId());
                    group.setFriendGroupIds(e.getFriendGroupIds());
                    group.setPhotos(photos);
                    group.setVideos(videos != null ? videos : Collections.emptyList());
                    group.setFsPhotoLinks(fsLinks);
                    group.setRatingPlus(e.getRatingPlus());
                    group.setRatingMinus(e.getRatingMinus());
                    Member owner = resolveEventAuthor(e, authorCache);
                    if (owner != null) {
                        group.setOwnerFirstName(owner.getFirstName());
                        group.setOwnerLastName(owner.getLastName());
                        group.setOwnerUserName(owner.getUserName());
                    }
                    groups.add(group);
                    totalPhotosInPage += photos.size();
                }
            }

            TimelineResponse response = new TimelineResponse();
            response.setGroups(groups);
            response.setTotalPhotos(totalPhotosInPage);
            response.setTotalGroups(-1);
            response.setPage(page);
            response.setPageSize(size);
            response.setHasMore(hasMore);
            response.setOnThisDay(Collections.emptyList());

            long elapsed = System.currentTimeMillis() - start;
            log.debug("Photo timeline page {} ({} groups) served in {}ms for user {}",
                    page, groups.size(), elapsed, userId);

            return ResponseEntity.ok(response);
        } catch (Exception e) {
            log.error("Error building photo timeline", e);
            return ResponseEntity.status(500).build();
        }
    }

    /**
     * Video timeline: events that have at least one video and NO photos (so they are not already in the main timeline).
     * This avoids showing the same event twice on the wall (once as video-only, once as photos+videos).
     */
    @GetMapping(value = "/timeline/videos", produces = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<TimelineResponse> getVideoTimeline(
            @RequestHeader(value = "user-id", required = false) String userId,
            @RequestParam(value = "page", defaultValue = "0") int page,
            @RequestParam(value = "size", defaultValue = "12") int size,
            @RequestParam(value = "search", required = false) String search,
            @RequestParam(value = "visibility", required = false) String visibility,
            @RequestParam(value = "eventId", required = false) String eventId) {
        try {
            long start = System.currentTimeMillis();
            Criteria accessCriteria = getAccessCriteria(userId, visibility);

            Criteria hasVideo = new Criteria().orOperator(
                    Criteria.where("fileUploadeds.fileType").regex("^video/"),
                    Criteria.where("fileUploadeds.fileName").regex(".*\\.(mp4|webm|ogg|ogv|mov|avi|mkv|m4v|3gp)$", "i"));
            // Exclude events that would already appear on the photo timeline (same signals as criteriaTimelineHasAnyPhotoContent)
            Criteria hasNoUploadedImage = new Criteria().andOperator(
                    new Criteria().norOperator(Criteria.where("fileUploadeds.fileType").regex("^image/")),
                    new Criteria().norOperator(Criteria.where("fileUploadeds.fileName").regex(IMAGE_FILENAME_MONGO_REGEX, "i")));
            Criteria hasNoPhotosUrl = new Criteria().norOperator(Criteria.where("photosUrl").regex(".+"));
            Criteria hasNoFsPhotoLink = new Criteria().norOperator(criteriaFsPhotoLinkWithNonemptyLink());
            Criteria hasNoThumbnailImage = new Criteria().andOperator(
                    new Criteria().norOperator(Criteria.where("thumbnail.fileType").regex("^image/")),
                    new Criteria().norOperator(Criteria.where("thumbnail.fileName").regex(IMAGE_FILENAME_MONGO_REGEX, "i")));
            Criteria hasNoPhotos = new Criteria().andOperator(
                    hasNoUploadedImage, hasNoPhotosUrl, hasNoFsPhotoLink, hasNoThumbnailImage);
            Criteria combined;
            if (eventId != null && !eventId.trim().isEmpty()) {
                // Single-event wall: same rule — only return this event in video timeline if it has videos and NO photos (otherwise it is already shown once in photo timeline)
                combined = new Criteria().andOperator(accessCriteria, eventIdCriteria(eventId.trim()), hasVideo, hasNoPhotos);
            } else {
                combined = new Criteria().andOperator(accessCriteria, hasVideo, hasNoPhotos);
            }
            if (search != null && !search.trim().isEmpty()) {
                combined = new Criteria().andOperator(combined, buildSearchCriteria(search.trim()));
            }
            Query pagedQuery = new Query(combined);
            pagedQuery.with(Sort.by(Sort.Direction.DESC, "beginEventDate"));
            pagedQuery.skip((long) page * size);
            pagedQuery.limit(size + 1);
            pagedQuery.fields()
                    .include("id")
                    .include("evenementName")
                    .include("type")
                    .include("comments")
                    .include("beginEventDate")
                    .include("ratingPlus")
                    .include("ratingMinus")
                    .include("fileUploadeds")
                    .include("urlEvents")
                    .include("photosUrl")
                    .include("map")
                    .include("visibility")
                    .include("friendGroupId")
                    .include("friendGroupIds")
                    .include("author");

            List<Evenement> events = mongoTemplate.find(pagedQuery, Evenement.class);

            boolean hasMore = events.size() > size;
            if (hasMore) {
                events = events.subList(0, size);
            }

            List<TimelineGroup> groups = new ArrayList<>();
            int totalVideosInPage = 0;
            Map<String, Member> authorCache = new HashMap<>();

            for (Evenement e : events) {
                List<TimelinePhoto> videos = extractVideos(e);
                if (!videos.isEmpty()) {
                    TimelineGroup group = new TimelineGroup();
                    group.setEventId(e.getId());
                    group.setEventName(e.getEvenementName());
                    group.setEventType(e.getType());
                    group.setEventDescription(e.getComments());
                    group.setEventDate(e.getBeginEventDate());
                    group.setVisibility(e.getVisibility());
                    group.setFriendGroupId(e.getFriendGroupId());
                    group.setFriendGroupIds(e.getFriendGroupIds());
                    group.setPhotos(videos);
                    group.setFsPhotoLinks(extractFsPhotoLinks(e));
                    group.setRatingPlus(e.getRatingPlus());
                    group.setRatingMinus(e.getRatingMinus());
                    Member owner = resolveEventAuthor(e, authorCache);
                    if (owner != null) {
                        group.setOwnerFirstName(owner.getFirstName());
                        group.setOwnerLastName(owner.getLastName());
                        group.setOwnerUserName(owner.getUserName());
                    }
                    groups.add(group);
                    totalVideosInPage += videos.size();
                }
            }

            TimelineResponse response = new TimelineResponse();
            response.setGroups(groups);
            response.setTotalPhotos(totalVideosInPage);
            response.setTotalGroups(-1);
            response.setPage(page);
            response.setPageSize(size);
            response.setHasMore(hasMore);
            response.setOnThisDay(Collections.emptyList());

            long elapsed = System.currentTimeMillis() - start;
            log.debug("Video timeline page {} ({} groups) served in {}ms for user {}", page, groups.size(), elapsed, userId);
            return ResponseEntity.ok(response);
        } catch (Exception e) {
            log.error("Error building video timeline", e);
            return ResponseEntity.status(500).build();
        }
    }

    @GetMapping(value = "/timeline/onthisday", produces = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<List<TimelinePhoto>> getOnThisDay(
            @RequestHeader(value = "user-id", required = false) String userId,
            @RequestParam(value = "visibility", required = false) String visibility) {
        try {
            long start = System.currentTimeMillis();
            Criteria accessCriteria = getAccessCriteria(userId, visibility);
            List<TimelinePhoto> onThisDay = findOnThisDayPhotos(accessCriteria);
            long elapsed = System.currentTimeMillis() - start;
            log.debug("On-this-day: {} photos in {}ms for user {}", onThisDay.size(), elapsed, userId);
            return ResponseEntity.ok(onThisDay);
        } catch (Exception e) {
            log.error("Error finding on-this-day photos", e);
            return ResponseEntity.ok(Collections.emptyList());
        }
    }

    /**
     * Links displayed in the wall footer: {@code urlEvents} + track files ({@link FileUploaded} GPX/KML/…)
     * + legacy {@code photosUrl} entries + the {@code map} field when it contains an http(s) URL.
     * Deduplication is done by normalized URL or by {@code fieldId} for track files.
     * Only PHOTOFROMFS is a server-side disk path; TRACK opens the track viewer; all others open a URL.
     */
    private List<FsPhotoLink> extractFsPhotoLinks(Evenement e) {
        List<FsPhotoLink> links = new ArrayList<>();
        Set<String> seenUrls = new LinkedHashSet<>();

        if (e.getUrlEvents() != null) {
            for (var urlEvent : e.getUrlEvents()) {
                if (urlEvent == null || urlEvent.getLink() == null || urlEvent.getLink().trim().isEmpty()) {
                    continue;
                }
                String raw = urlEvent.getLink().trim();
                if (!seenUrls.add(normalizeLinkKey(raw))) {
                    continue;
                }
                String rawType = urlEvent.getTypeUrl() != null ? urlEvent.getTypeUrl().trim() : "";
                String canonical = normalizeUrlEventTypeForTimeline(rawType);
                FsPhotoLink f = new FsPhotoLink(raw, urlEvent.getUrlDescription());
                f.setTypeUrl(canonical);
                links.add(f);
            }
        }
        // Track files (GPX, KML, …) in fileUploadeds — same logic as the event map
        if (e.getFileUploadeds() != null) {
            for (FileUploaded file : e.getFileUploadeds()) {
                if (file == null || file.getFieldId() == null || file.getFieldId().trim().isEmpty()) {
                    continue;
                }
                String fn = file.getFileName();
                if (!isUploadedTrackFileName(fn)) {
                    continue;
                }
                String dedupKey = "track:" + file.getFieldId().trim().toLowerCase(Locale.ROOT);
                if (!seenUrls.add(dedupKey)) {
                    continue;
                }
                String fileNameDisplay = fn != null ? fn.trim() : file.getFieldId();
                String custom = file.getDisplayName();
                String linkDescription = (custom != null && !custom.trim().isEmpty())
                    ? custom.trim()
                    : fileNameDisplay;
                FsPhotoLink f = new FsPhotoLink(fileNameDisplay, linkDescription);
                f.setTypeUrl("TRACK");
                f.setFieldId(file.getFieldId().trim());
                links.add(f);
            }
        }
        if (e.getPhotosUrl() != null) {
            for (String url : e.getPhotosUrl()) {
                if (url == null || url.trim().isEmpty()) {
                    continue;
                }
                String raw = url.trim();
                if (!seenUrls.add(normalizeLinkKey(raw))) {
                    continue;
                }
                FsPhotoLink f = new FsPhotoLink(raw, null);
                f.setTypeUrl("PHOTOS");
                links.add(f);
            }
        }
        String mapField = e.getMap();
        if (mapField != null && !mapField.trim().isEmpty()) {
            String raw = mapField.trim();
            if (isHttpOrHttpsUrl(raw) && seenUrls.add(normalizeLinkKey(raw))) {
                FsPhotoLink f = new FsPhotoLink(raw, null);
                f.setTypeUrl("MAP");
                links.add(f);
            }
        }
        return links;
    }

    private static String normalizeLinkKey(String url) {
        return url == null ? "" : url.trim().toLowerCase(Locale.ROOT);
    }

    private static boolean isHttpOrHttpsUrl(String s) {
        if (s == null) {
            return false;
        }
        String lower = s.trim().toLowerCase(Locale.ROOT);
        return lower.startsWith("http://") || lower.startsWith("https://");
    }

    /** Aligned with the frontend (element-evenement isTrackFile). */
    private static boolean isUploadedTrackFileName(String fileName) {
        if (fileName == null || fileName.isEmpty()) {
            return false;
        }
        String lower = fileName.toLowerCase(Locale.ROOT);
        return lower.endsWith(".gpx") || lower.endsWith(".kml") || lower.endsWith(".geojson") || lower.endsWith(".tcx");
    }

    /** Normalize raw URL event type aliases to stable UI identifiers (icons). */
    private static String normalizeUrlEventTypeForTimeline(String rawType) {
        if (rawType == null || rawType.isEmpty()) {
            return "OTHER";
        }
        String u = rawType.toUpperCase(Locale.ROOT);
        if ("PHOTO".equals(u)) return "PHOTOS";
        if ("SITE".equals(u) || "WEB".equals(u) || "SITIO".equals(u)) return "WEBSITE";
        if ("CARTE".equals(u) || "MAPA".equals(u)) return "MAP";
        if ("DOC".equals(u) || "DOCUMENT".equals(u) || "DOCS".equals(u)) return "DOCUMENTATION";
        if ("VIDÉO".equals(u) || "YOUTUBE".equals(u) || "VIMEO".equals(u)) return "VIDEO";
        if ("WA".equals(u)) return "WHATSAPP";
        if ("TRACE".equals(u) || "TRACÉ".equals(u) || "TRACK".equals(u) || "GPS".equals(u) || "GPX".equals(u)) {
            return "TRACK";
        }
        return u;
    }

    private static final String[] VIDEO_EXTENSIONS = { ".mp4", ".webm", ".ogg", ".ogv", ".mov", ".avi", ".mkv", ".m4v", ".3gp" };

    private List<TimelinePhoto> extractPhotos(Evenement e) {
        List<TimelinePhoto> photos = new ArrayList<>();
        List<FileUploaded> files = e.getFileUploadeds();
        if (files != null) {
            for (FileUploaded file : files) {
                if (isImageFile(file)) {
                    photos.add(buildTimelinePhoto(file, e));
                }
            }
        }
        // When event has only one photo, fileUploadeds can be null/empty in some deserialization cases; use thumbnail as fallback
        if (photos.isEmpty() && e.getThumbnail() != null && isImageFile(e.getThumbnail())) {
            photos.add(buildTimelinePhoto(e.getThumbnail(), e));
        }
        return photos;
    }

    private static boolean looksLikeImageFileName(String fileName) {
        return fileName != null && !fileName.isEmpty() && IMAGE_FILENAME_PATTERN.matcher(fileName).matches();
    }

    private static boolean isImageFile(FileUploaded file) {
        if (file == null) return false;
        String type = file.getFileType();
        if (type != null && type.toLowerCase(Locale.ROOT).startsWith("image/")) {
            return true;
        }
        return looksLikeImageFileName(file.getFileName());
    }

    private static TimelinePhoto buildTimelinePhoto(FileUploaded file, Evenement e) {
        return new TimelinePhoto(
                file.getFieldId(),
                file.getFileName(),
                file.getFileType(),
                null,
                e.getId(),
                e.getEvenementName(),
                e.getType(),
                e.getBeginEventDate()
        );
    }

    private boolean isVideoFile(FileUploaded file) {
        if (file.getFileType() != null && file.getFileType().startsWith("video/")) return true;
        String name = file.getFileName();
        if (name == null) return false;
        String lower = name.toLowerCase();
        for (String ext : VIDEO_EXTENSIONS) {
            if (lower.endsWith(ext)) return true;
        }
        return false;
    }

    private List<TimelinePhoto> extractVideos(Evenement e) {
        List<TimelinePhoto> videos = new ArrayList<>();
        if (e.getFileUploadeds() == null) return videos;
        for (FileUploaded file : e.getFileUploadeds()) {
            if (isVideoFile(file)) {
                String type = file.getFileType() != null ? file.getFileType() : "video/mp4";
                videos.add(new TimelinePhoto(
                        file.getFieldId(),
                        file.getFileName(),
                        type,
                        null,
                        e.getId(),
                        e.getEvenementName(),
                        e.getType(),
                        e.getBeginEventDate()
                ));
            }
        }
        return videos;
    }

    /**
     * Criteria to match an event by id. MongoDB _id may be stored as ObjectId or as String;
     * use ObjectId when the string is a valid 24-char hex so the timeline filter finds the event
     * (e.g. when opening the photo wall for a single event with one photo).
     */
    private static Criteria eventIdCriteria(String eventId) {
        if (eventId == null || eventId.isEmpty()) {
            return new Criteria();
        }
        if (eventId.length() == 24 && eventId.matches("[0-9a-fA-F]{24}")) {
            try {
                return Criteria.where("id").is(new ObjectId(eventId));
            } catch (IllegalArgumentException ignored) {
                // fallback to string
            }
        }
        return Criteria.where("id").is(eventId);
    }

    /**
     * Text search criteria (name, description, type) — same as home-evenements.
     * Case-insensitive and accent-insensitive (NFD normalization), word at any position.
     */
    private Criteria buildSearchCriteria(String search) {
        if (search == null || search.trim().isEmpty()) {
            return new Criteria();
        }
        String normalized = normalizeForSearch(search.trim());
        if (normalized.isEmpty()) {
            return new Criteria();
        }
        String regexPattern = ".*" + buildAccentInsensitiveRegex(normalized) + ".*";
        Criteria nameMatch = Criteria.where("evenementName").regex(regexPattern);
        Criteria commentsMatch = Criteria.where("comments").regex(regexPattern);
        Criteria typeMatch = Criteria.where("type").regex(regexPattern);
        return new Criteria().orOperator(nameMatch, commentsMatch, typeMatch);
    }

    /** Normalization matching EvenementsRepositoryImpl: lowercase + NFD without accents. */
    private static String normalizeForSearch(String value) {
        if (value == null || value.isEmpty()) return "";
        String lower = value.toLowerCase(Locale.ROOT);
        String nfd = Normalizer.normalize(lower, Normalizer.Form.NFD);
        return nfd.replaceAll("\\p{M}", "");
    }

    /** Builds a regex where each letter can match its accented variants (a → [aàâäáå], etc.). */
    private static String buildAccentInsensitiveRegex(String normalized) {
        if (normalized == null || normalized.isEmpty()) return "";
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < normalized.length(); i++) {
            char c = normalized.charAt(i);
            String charClass = ACCENT_REGEX_MAP.get(c);
            if (charClass != null) {
                sb.append(charClass);
            } else if (Character.isLetterOrDigit(c)) {
                sb.append("[").append(Character.toUpperCase(c)).append(Character.toLowerCase(c)).append("]");
            } else {
                sb.append(Pattern.quote(String.valueOf(c)));
            }
        }
        return sb.toString();
    }

    private static final Map<Character, String> ACCENT_REGEX_MAP = new HashMap<>();
    static {
        ACCENT_REGEX_MAP.put('a', "[aàâäáåAÀÂÄÁÅ]");
        ACCENT_REGEX_MAP.put('e', "[eéèêëEÉÈÊË]");
        ACCENT_REGEX_MAP.put('i', "[iîïìIÎÏÌ]");
        ACCENT_REGEX_MAP.put('o', "[oôöòóOÔÖÒÓ]");
        ACCENT_REGEX_MAP.put('u', "[uùûüúUÙÛÜÚ]");
        ACCENT_REGEX_MAP.put('y', "[yÿýYŸÝ]");
        ACCENT_REGEX_MAP.put('c', "[cçCÇ]");
        ACCENT_REGEX_MAP.put('n', "[nñNÑ]");
    }

    /**
     * When a specific visibility filter is set (and not "all"), use the same
     * per-visibility access logic as {@link EvenementRestController}, without caching.
     * For "all" (or no filter), always rebuild access criteria for the user so
     * changes in friends / groups / visibilities are immediately reflected,
     * matching the behaviour of the home-evenements feed.
     */
    private Criteria getAccessCriteria(String userId, String visibility) {
        if (visibility != null && !visibility.trim().isEmpty() && !"all".equals(visibility.trim())) {
            return buildAccessCriteriaForVisibility(visibility.trim(), userId);
        }
        return buildAccessCriteria(userId);
    }

    /**
     * Build access criteria for a specific visibility type (same logic as EvenementRestController).
     * Used when filtering by visibility in the photo/video timeline.
     */
    private Criteria buildAccessCriteriaForVisibility(String visibilityFilter, String userId) {
        if ("public".equals(visibilityFilter)) {
            return Criteria.where("visibility").is("public");
        }
        if ("private".equals(visibilityFilter)) {
            if (userId != null && !userId.isEmpty()) {
                return new Criteria().andOperator(
                    Criteria.where("visibility").is("private"),
                    buildAuthorCriteria(userId)
                );
            }
            return Criteria.where("_id").is("__NO_MATCH__");
        }
        if ("friends".equals(visibilityFilter)) {
            if (userId != null && !userId.isEmpty()) {
                List<Criteria> list = new ArrayList<>();
                list.add(new Criteria().andOperator(
                    Criteria.where("visibility").is("friends"),
                    buildAuthorCriteria(userId)
                ));
                Criteria friendsEvents = buildFriendsVisibilityCriteria(userId);
                if (friendsEvents != null) {
                    list.add(friendsEvents);
                }
                if (list.isEmpty()) {
                    return Criteria.where("_id").is("__NO_MATCH__");
                }
                return list.size() == 1 ? list.get(0) : new Criteria().orOperator(list.toArray(new Criteria[0]));
            }
            return Criteria.where("_id").is("__NO_MATCH__");
        }
        // Friend group ID or name — same logic as EvenementRestController.buildAccessCriteriaForVisibility
        String filterValue = visibilityFilter;
        if (userId != null && !userId.isEmpty()) {
            try {
                Member currentUser = membersRepository.findById(userId).orElse(null);
                if (currentUser == null) {
                    return Criteria.where("_id").is("__NO_MATCH__");
                }
                List<FriendGroup> userFriendGroups = friendGroupRepository.findByMembersContaining(currentUser);
                boolean isUserMember = false;
                String matchedGroupId = null;
                String matchedGroupName = null;
                for (FriendGroup group : userFriendGroups) {
                    if (group.getId() != null && group.getId().equals(filterValue)) {
                        isUserMember = true;
                        matchedGroupId = group.getId();
                        if (group.getName() != null) {
                            matchedGroupName = group.getName();
                        }
                        break;
                    }
                    if (group.getName() != null && group.getName().equals(filterValue)) {
                        isUserMember = true;
                        if (group.getId() != null) {
                            matchedGroupId = group.getId();
                        }
                        matchedGroupName = group.getName();
                        break;
                    }
                }
                if (!isUserMember) {
                    try {
                        Optional<FriendGroup> groupOpt = friendGroupRepository.findById(filterValue);
                        if (groupOpt.isPresent()) {
                            FriendGroup g = groupOpt.get();
                            matchedGroupId = g.getId();
                            if (g.getName() != null) {
                                matchedGroupName = g.getName();
                            }
                        }
                    } catch (Exception ignored) {}
                }
                List<Criteria> groupCriteriaList = new ArrayList<>();
                if (matchedGroupId != null) {
                    groupCriteriaList.add(Criteria.where("friendGroupId").is(matchedGroupId));
                    groupCriteriaList.add(Criteria.where("friendGroupIds").is(matchedGroupId));
                }
                if (matchedGroupName != null) {
                    groupCriteriaList.add(Criteria.where("visibility").is(matchedGroupName));
                }
                groupCriteriaList.add(Criteria.where("friendGroupId").is(filterValue));
                groupCriteriaList.add(Criteria.where("friendGroupIds").is(filterValue));
                groupCriteriaList.add(Criteria.where("visibility").is(filterValue));
                if (groupCriteriaList.isEmpty()) {
                    return Criteria.where("_id").is("__NO_MATCH__");
                }
                Criteria groupCriteria = groupCriteriaList.size() == 1
                    ? groupCriteriaList.get(0)
                    : new Criteria().orOperator(groupCriteriaList.toArray(new Criteria[0]));
                log.debug("Photo timeline visibility filter '{}': matchedGroupId={}, matchedGroupName={}, criteria count={}",
                    filterValue, matchedGroupId, matchedGroupName, groupCriteriaList.size());
                return groupCriteria;
            } catch (Exception e) {
                log.warn("[PhotoTimeline] buildAccessCriteriaForVisibility failed for userId={} filter={}: {}", userId, visibilityFilter, e.getMessage(), e);
                return Criteria.where("_id").is("__NO_MATCH__");
            }
        }
        return Criteria.where("_id").is("__NO_MATCH__");
    }

    private List<TimelinePhoto> findOnThisDayPhotos(Criteria accessCriteria) {
        LocalDate today = LocalDate.now();
        int todayMonth = today.getMonthValue();
        int todayDay = today.getDayOfMonth();
        int thisYear = today.getYear();

        // Only fetch events with matching month/day from previous years
        // MongoDB can't filter by month/day directly on Date, so we use a
        // lightweight query that only returns date + file metadata
        Criteria hasPhotoSignal = new Criteria().orOperator(
                criteriaUploadedImageSignal(), criteriaThumbnailImageSignal());
        // Single andOperator: two addCriteria() calls both using $or break BasicDocument merge in Spring Data MongoDB
        Query query = new Query(new Criteria().andOperator(accessCriteria, hasPhotoSignal));
        query.fields()
                .include("id")
                .include("evenementName")
                .include("type")
                .include("beginEventDate")
                .include("fileUploadeds")
                .include("thumbnail");

        List<Evenement> events = mongoTemplate.find(query, Evenement.class);

        List<TimelinePhoto> result = new ArrayList<>();
        for (Evenement e : events) {
            if (e.getBeginEventDate() == null) continue;
            LocalDate eventDate = e.getBeginEventDate().toInstant()
                    .atZone(ZoneId.systemDefault()).toLocalDate();
            if (eventDate.getMonthValue() != todayMonth || eventDate.getDayOfMonth() != todayDay
                    || eventDate.getYear() == thisYear) {
                continue;
            }
            result.addAll(extractPhotos(e));
        }
        return result;
    }

    private Criteria buildAccessCriteria(String userId) {
        List<Criteria> accessCriteria = new ArrayList<>();
        accessCriteria.add(Criteria.where("visibility").is("public"));

        if (userId != null && !userId.isEmpty()) {
            accessCriteria.add(buildAuthorCriteria(userId));

            Criteria friendsCriteria = buildFriendsVisibilityCriteria(userId);
            if (friendsCriteria != null) {
                accessCriteria.add(friendsCriteria);
            } else {
                log.info("[PhotoTimeline] buildFriendsVisibilityCriteria returned null for userId={}", userId);
            }

            Criteria friendGroupCriteria = buildFriendGroupVisibilityCriteria(userId);
            if (friendGroupCriteria != null) {
                accessCriteria.add(friendGroupCriteria);
            } else {
                log.info("[PhotoTimeline] buildFriendGroupVisibilityCriteria returned null for userId={}", userId);
            }
        } else {
            log.warn("[PhotoTimeline] buildAccessCriteria called with null/empty userId — only public events will be returned");
        }

        if (accessCriteria.size() == 1) {
            return accessCriteria.get(0);
        }

        return new Criteria().orOperator(accessCriteria.toArray(new Criteria[0]));
    }

    private Criteria buildAuthorCriteria(String userId) {
        List<Criteria> authorCriteria = new ArrayList<>();
        try {
            authorCriteria.add(Criteria.where("author.$id").is(new ObjectId(userId)));
        } catch (IllegalArgumentException ex) {
            // not an ObjectId
        }
        authorCriteria.add(Criteria.where("author.id").is(userId));
        return new Criteria().orOperator(authorCriteria.toArray(new Criteria[0]));
    }

    private Criteria buildFriendsVisibilityCriteria(String userId) {
        try {
            Member currentUser = membersRepository.findById(userId).orElse(null);
            if (currentUser == null) return null;

            List<Friend> friendships = friendRepository.findByUser1OrUser2(currentUser, currentUser);
            if (friendships.isEmpty()) return null;

            List<String> friendIds = new ArrayList<>();
            for (Friend f : friendships) {
                if (f.getUser1() != null && !f.getUser1().getId().equals(userId)) {
                    friendIds.add(f.getUser1().getId());
                }
                if (f.getUser2() != null && !f.getUser2().getId().equals(userId)) {
                    friendIds.add(f.getUser2().getId());
                }
            }
            if (friendIds.isEmpty()) return null;

            // Build criteria: visibility="friends" AND author is in friend list.
            // The author field is stored as DBRef: { "$ref": "members", "$id": "..." }
            // The $id can be stored as ObjectId or as string, so we try both — same logic as EvenementRestController.
            List<Criteria> friendAuthorCriteria = new ArrayList<>();
            for (String friendId : friendIds) {
                List<Criteria> friendIdCriteria = new ArrayList<>();
                try {
                    ObjectId friendObjectId = new ObjectId(friendId);
                    friendIdCriteria.add(Criteria.where("author.$id").is(friendObjectId));
                    friendIdCriteria.add(new Criteria().andOperator(
                            Criteria.where("author.$ref").is("members"),
                            Criteria.where("author.$id").is(friendObjectId)
                    ));
                } catch (IllegalArgumentException ex) {
                    // not a valid ObjectId
                }
                // Also try string format (in case $id is stored as string)
                friendIdCriteria.add(Criteria.where("author.$id").is(friendId));
                friendIdCriteria.add(new Criteria().andOperator(
                        Criteria.where("author.$ref").is("members"),
                        Criteria.where("author.$id").is(friendId)
                ));
                friendAuthorCriteria.add(
                        friendIdCriteria.size() == 1
                                ? friendIdCriteria.get(0)
                                : new Criteria().orOperator(friendIdCriteria.toArray(new Criteria[0]))
                );
            }
            if (friendAuthorCriteria.isEmpty()) return null;

            Criteria authorInFriends = friendAuthorCriteria.size() == 1
                    ? friendAuthorCriteria.get(0)
                    : new Criteria().orOperator(friendAuthorCriteria.toArray(new Criteria[0]));
            return new Criteria().andOperator(
                    Criteria.where("visibility").is("friends"),
                    authorInFriends
            );
        } catch (Exception e) {
            log.warn("[PhotoTimeline] buildFriendsVisibilityCriteria failed for userId={}: {}", userId, e.getMessage(), e);
            return null;
        }
    }

    private Criteria buildFriendGroupVisibilityCriteria(String userId) {
        try {
            java.util.Optional<Member> currentUserOpt = membersRepository.findById(userId);
            if (currentUserOpt.isEmpty()) {
                return null;
            }
            Member currentUser = currentUserOpt.get();

            // Groups where user is a member
            java.util.List<FriendGroup> userFriendGroups = friendGroupRepository.findByMembersContaining(currentUser);
            // Groups where user is the owner
            java.util.List<FriendGroup> ownedFriendGroups = friendGroupRepository.findByOwner(currentUser);
            // Groups where user is explicitly authorized
            java.util.List<FriendGroup> authorizedFriendGroups = friendGroupRepository.findByAuthorizedUsersContaining(currentUser);

            java.util.List<Criteria> groupCriteriaList = new java.util.ArrayList<>();
            java.util.Set<String> friendGroupIds = new java.util.HashSet<>();
            java.util.Map<String, String> groupIdToName = new java.util.HashMap<>();

            for (FriendGroup group : userFriendGroups) {
                if (group.getId() != null) {
                    friendGroupIds.add(group.getId());
                    if (group.getName() != null) {
                        groupIdToName.put(group.getId(), group.getName());
                    }
                }
            }
            for (FriendGroup group : ownedFriendGroups) {
                if (group.getId() != null) {
                    friendGroupIds.add(group.getId());
                    if (group.getName() != null) {
                        groupIdToName.put(group.getId(), group.getName());
                    }
                }
            }
            for (FriendGroup group : authorizedFriendGroups) {
                if (group.getId() != null) {
                    friendGroupIds.add(group.getId());
                    if (group.getName() != null) {
                        groupIdToName.put(group.getId(), group.getName());
                    }
                }
            }

            for (String groupId : friendGroupIds) {
                try {
                    groupCriteriaList.add(Criteria.where("friendGroupId").is(groupId));
                } catch (Exception ignored) {
                }
            }
            for (String groupId : friendGroupIds) {
                try {
                    groupCriteriaList.add(Criteria.where("friendGroupIds").is(groupId));
                } catch (Exception ignored) {
                }
            }
            for (String groupName : groupIdToName.values()) {
                if (groupName != null && !groupName.trim().isEmpty()) {
                    groupCriteriaList.add(Criteria.where("visibility").is(groupName));
                }
            }

            // Always include events created by the user with friend-group visibility
            Criteria authorCriteria = buildAuthorCriteria(userId);
            Criteria userCreatedFriendGroupEvents = new Criteria().andOperator(
                    Criteria.where("visibility").nin("public", "private", "friends"),
                    authorCriteria
            );

            java.util.List<Criteria> finalCriteriaList = new java.util.ArrayList<>();
            if (!groupCriteriaList.isEmpty()) {
                Criteria groupMatch = groupCriteriaList.size() == 1
                        ? groupCriteriaList.get(0)
                        : new Criteria().orOperator(groupCriteriaList.toArray(new Criteria[0]));
                finalCriteriaList.add(
                        new Criteria().andOperator(
                                Criteria.where("visibility").nin("public", "private", "friends"),
                                groupMatch
                        )
                );
            }
            finalCriteriaList.add(userCreatedFriendGroupEvents);

            if (finalCriteriaList.isEmpty()) {
                return null;
            }
            return finalCriteriaList.size() == 1
                    ? finalCriteriaList.get(0)
                    : new Criteria().orOperator(finalCriteriaList.toArray(new Criteria[0]));
        } catch (Exception e) {
            log.warn("[PhotoTimeline] buildFriendGroupVisibilityCriteria failed for userId={}: {}", userId, e.getMessage(), e);
            return null;
        }
    }
}
