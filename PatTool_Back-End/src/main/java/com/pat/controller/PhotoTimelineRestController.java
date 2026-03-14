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

import java.time.LocalDate;
import java.time.ZoneId;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;

@RestController
@RequestMapping("/api/photos")
public class PhotoTimelineRestController {

    private static final Logger log = LoggerFactory.getLogger(PhotoTimelineRestController.class);
    private static final long ACCESS_CACHE_TTL_MS = 2 * 60 * 1000;

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
        private String path;
        private String description;

        public FsPhotoLink() {}
        public FsPhotoLink(String path, String description) {
            this.path = path;
            this.description = description;
        }

        public String getPath() { return path; }
        public void setPath(String path) { this.path = path; }
        public String getDescription() { return description; }
        public void setDescription(String description) { this.description = description; }
    }

    public static class TimelineGroup {
        private String eventId;
        private String eventName;
        private String eventType;
        private Date eventDate;
        private List<TimelinePhoto> photos;
        private List<TimelinePhoto> videos;
        private List<FsPhotoLink> fsPhotoLinks;

        public TimelineGroup() {}

        public String getEventId() { return eventId; }
        public void setEventId(String eventId) { this.eventId = eventId; }
        public String getEventName() { return eventName; }
        public void setEventName(String eventName) { this.eventName = eventName; }
        public String getEventType() { return eventType; }
        public void setEventType(String eventType) { this.eventType = eventType; }
        public Date getEventDate() { return eventDate; }
        public void setEventDate(Date eventDate) { this.eventDate = eventDate; }
        public List<TimelinePhoto> getPhotos() { return photos; }
        public void setPhotos(List<TimelinePhoto> photos) { this.photos = photos; }
        public List<TimelinePhoto> getVideos() { return videos; }
        public void setVideos(List<TimelinePhoto> videos) { this.videos = videos; }
        public List<FsPhotoLink> getFsPhotoLinks() { return fsPhotoLinks; }
        public void setFsPhotoLinks(List<FsPhotoLink> fsPhotoLinks) { this.fsPhotoLinks = fsPhotoLinks; }
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

    @GetMapping(value = "/timeline", produces = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<TimelineResponse> getPhotoTimeline(
            @RequestHeader(value = "user-id", required = false) String userId,
            @RequestParam(value = "page", defaultValue = "0") int page,
            @RequestParam(value = "size", defaultValue = "1") int size) {
        try {
            long start = System.currentTimeMillis();

            Criteria accessCriteria = getCachedAccessCriteria(userId);

            // Fetch size+1 to know if there's a next page (avoids count query)
            Query pagedQuery = new Query();
            pagedQuery.addCriteria(accessCriteria);
            pagedQuery.addCriteria(Criteria.where("fileUploadeds.fileType").regex("^image/"));
            pagedQuery.with(Sort.by(Sort.Direction.DESC, "beginEventDate"));
            pagedQuery.skip((long) page * size);
            pagedQuery.limit(size + 1);
            pagedQuery.fields()
                    .include("id")
                    .include("evenementName")
                    .include("type")
                    .include("beginEventDate")
                    .include("fileUploadeds")
                    .include("urlEvents");

            List<Evenement> events = mongoTemplate.find(pagedQuery, Evenement.class);

            boolean hasMore = events.size() > size;
            if (hasMore) {
                events = events.subList(0, size);
            }

            List<TimelineGroup> groups = new ArrayList<>();
            int totalPhotosInPage = 0;

            for (Evenement e : events) {
                List<TimelinePhoto> photos = extractPhotos(e);
                List<TimelinePhoto> videos = extractVideos(e);
                List<FsPhotoLink> fsLinks = extractFsPhotoLinks(e);
                if (!photos.isEmpty()) {
                    TimelineGroup group = new TimelineGroup();
                    group.setEventId(e.getId());
                    group.setEventName(e.getEvenementName());
                    group.setEventType(e.getType());
                    group.setEventDate(e.getBeginEventDate());
                    group.setPhotos(photos);
                    group.setVideos(videos != null ? videos : Collections.emptyList());
                    group.setFsPhotoLinks(fsLinks);
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
            @RequestParam(value = "size", defaultValue = "1") int size) {
        try {
            long start = System.currentTimeMillis();
            Criteria accessCriteria = getCachedAccessCriteria(userId);

            Criteria hasVideo = new Criteria().orOperator(
                    Criteria.where("fileUploadeds.fileType").regex("^video/"),
                    Criteria.where("fileUploadeds.fileName").regex(".*\\.(mp4|webm|ogg|ogv|mov|avi|mkv|m4v|3gp)$", "i"));
            // Only events that have no image files → they won't appear in the main photo timeline
            Criteria hasNoPhotos = new Criteria().norOperator(Criteria.where("fileUploadeds.fileType").regex("^image/"));
            Criteria combined = new Criteria().andOperator(accessCriteria, hasVideo, hasNoPhotos);
            Query pagedQuery = new Query(combined);
            pagedQuery.with(Sort.by(Sort.Direction.DESC, "beginEventDate"));
            pagedQuery.skip((long) page * size);
            pagedQuery.limit(size + 1);
            pagedQuery.fields()
                    .include("id")
                    .include("evenementName")
                    .include("type")
                    .include("beginEventDate")
                    .include("fileUploadeds");

            List<Evenement> events = mongoTemplate.find(pagedQuery, Evenement.class);

            boolean hasMore = events.size() > size;
            if (hasMore) {
                events = events.subList(0, size);
            }

            List<TimelineGroup> groups = new ArrayList<>();
            int totalVideosInPage = 0;

            for (Evenement e : events) {
                List<TimelinePhoto> videos = extractVideos(e);
                if (!videos.isEmpty()) {
                    TimelineGroup group = new TimelineGroup();
                    group.setEventId(e.getId());
                    group.setEventName(e.getEvenementName());
                    group.setEventType(e.getType());
                    group.setEventDate(e.getBeginEventDate());
                    group.setPhotos(videos);
                    group.setFsPhotoLinks(Collections.emptyList());
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
            @RequestHeader(value = "user-id", required = false) String userId) {
        try {
            long start = System.currentTimeMillis();
            Criteria accessCriteria = getCachedAccessCriteria(userId);
            List<TimelinePhoto> onThisDay = findOnThisDayPhotos(accessCriteria);
            long elapsed = System.currentTimeMillis() - start;
            log.debug("On-this-day: {} photos in {}ms for user {}", onThisDay.size(), elapsed, userId);
            return ResponseEntity.ok(onThisDay);
        } catch (Exception e) {
            log.error("Error finding on-this-day photos", e);
            return ResponseEntity.ok(Collections.emptyList());
        }
    }

    private List<FsPhotoLink> extractFsPhotoLinks(Evenement e) {
        List<FsPhotoLink> links = new ArrayList<>();
        if (e.getUrlEvents() == null) return links;
        for (var urlEvent : e.getUrlEvents()) {
            if (urlEvent.getTypeUrl() != null
                    && "PHOTOFROMFS".equalsIgnoreCase(urlEvent.getTypeUrl().trim())
                    && urlEvent.getLink() != null && !urlEvent.getLink().isEmpty()) {
                links.add(new FsPhotoLink(urlEvent.getLink(), urlEvent.getUrlDescription()));
            }
        }
        return links;
    }

    private static final String[] VIDEO_EXTENSIONS = { ".mp4", ".webm", ".ogg", ".ogv", ".mov", ".avi", ".mkv", ".m4v", ".3gp" };

    private List<TimelinePhoto> extractPhotos(Evenement e) {
        List<TimelinePhoto> photos = new ArrayList<>();
        if (e.getFileUploadeds() == null) return photos;
        for (FileUploaded file : e.getFileUploadeds()) {
            if (file.getFileType() != null && file.getFileType().startsWith("image/")) {
                photos.add(new TimelinePhoto(
                        file.getFieldId(),
                        file.getFileName(),
                        file.getFileType(),
                        null,
                        e.getId(),
                        e.getEvenementName(),
                        e.getType(),
                        e.getBeginEventDate()
                ));
            }
        }
        return photos;
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

    private Criteria getCachedAccessCriteria(String userId) {
        String cacheKey = userId != null ? userId : "__anon__";
        CachedAccessCriteria cached = accessCriteriaCache.get(cacheKey);
        if (cached != null && !cached.isExpired()) {
            return cached.criteria;
        }
        Criteria criteria = buildAccessCriteria(userId);
        accessCriteriaCache.put(cacheKey, new CachedAccessCriteria(criteria));
        return criteria;
    }

    private List<TimelinePhoto> findOnThisDayPhotos(Criteria accessCriteria) {
        LocalDate today = LocalDate.now();
        int todayMonth = today.getMonthValue();
        int todayDay = today.getDayOfMonth();
        int thisYear = today.getYear();

        // Only fetch events with matching month/day from previous years
        // MongoDB can't filter by month/day directly on Date, so we use a
        // lightweight query that only returns date + file metadata
        Query query = new Query();
        query.addCriteria(accessCriteria);
        query.addCriteria(Criteria.where("fileUploadeds.fileType").regex("^image/"));
        query.fields()
                .include("id")
                .include("evenementName")
                .include("type")
                .include("beginEventDate")
                .include("fileUploadeds");

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
            }

            Criteria friendGroupCriteria = buildFriendGroupVisibilityCriteria(userId);
            if (friendGroupCriteria != null) {
                accessCriteria.add(friendGroupCriteria);
            }
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

            List<Criteria> friendAuthorCriteria = new ArrayList<>();
            for (String friendId : friendIds) {
                try {
                    friendAuthorCriteria.add(Criteria.where("author.$id").is(new ObjectId(friendId)));
                } catch (IllegalArgumentException ex) {
                    friendAuthorCriteria.add(Criteria.where("author.id").is(friendId));
                }
            }
            if (friendAuthorCriteria.isEmpty()) return null;

            Criteria authorInFriends = new Criteria().orOperator(friendAuthorCriteria.toArray(new Criteria[0]));
            return new Criteria().andOperator(
                    Criteria.where("visibility").is("friends"),
                    authorInFriends
            );
        } catch (Exception e) {
            return null;
        }
    }

    private Criteria buildFriendGroupVisibilityCriteria(String userId) {
        try {
            Member currentUser = membersRepository.findById(userId).orElse(null);
            if (currentUser == null) return null;

            List<FriendGroup> userFriendGroups = friendGroupRepository.findByMembersContaining(currentUser);
            if (userFriendGroups.isEmpty()) return null;

            List<String> friendGroupIds = new ArrayList<>();
            for (FriendGroup group : userFriendGroups) {
                if (group.getId() != null) {
                    friendGroupIds.add(group.getId());
                }
            }
            if (friendGroupIds.isEmpty()) return null;

            List<Criteria> friendGroupCriteriaList = new ArrayList<>();
            for (String groupId : friendGroupIds) {
                friendGroupCriteriaList.add(Criteria.where("friendGroupId").is(groupId));
            }
            for (FriendGroup group : userFriendGroups) {
                if (group.getName() != null && !group.getName().trim().isEmpty()) {
                    friendGroupCriteriaList.add(Criteria.where("visibility").is(group.getName()));
                }
            }
            if (friendGroupCriteriaList.isEmpty()) return null;

            Criteria friendGroupMatch = new Criteria().orOperator(friendGroupCriteriaList.toArray(new Criteria[0]));
            return new Criteria().andOperator(
                    Criteria.where("visibility").nin("public", "private", "friends"),
                    friendGroupMatch
            );
        } catch (Exception e) {
            return null;
        }
    }
}
