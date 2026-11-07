package com.pat.service;

import com.pat.repo.domain.Member;
import org.bson.Document;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.data.mongodb.core.query.Query;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.Collection;
import java.util.Comparator;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

/**
 * Record counts for every MongoDB collection, plus a per-user breakdown
 * when a collection stores rows that belong to a member.
 */
@Service
public class PatToolDatabaseStatsService {

    private static final Logger log = LoggerFactory.getLogger(PatToolDatabaseStatsService.class);

    /** Collections whose owner is a member id or a DBRef. A shared row counts for each person. */
    private static final Map<String, List<String>> DBREF_FIELDS = Map.ofEntries(
            Map.entry("evenements", List.of("author")),
            Map.entry("urllink", List.of("author")),
            Map.entry("categorylink", List.of("author")),
            Map.entry("discussions", List.of("createdBy")),
            Map.entry("userConnectionLogs", List.of("member")),
            Map.entry("friendgroups", List.of("owner")),
            Map.entry("friends", List.of("user1", "user2")),
            Map.entry("friendRequests", List.of("requester", "recipient")));

    private static final Map<String, List<String>> STRING_FIELDS = Map.ofEntries(
            Map.entry("gps_sessions", List.of("ownerMemberId")),
            Map.entry("gps_itineraries", List.of("ownerMemberId")),
            Map.entry("code_projects", List.of("ownerMemberId")),
            Map.entry("video_montage_projects", List.of("ownerMemberId")),
            Map.entry("notes", List.of("ownerMemberId")),
            Map.entry("archive_audio_collections", List.of("ownerMemberId")),
            Map.entry("pdf_converter_documents", List.of("ownerMemberId")),
            Map.entry("tv_recordings", List.of("ownerMemberId")),
            Map.entry("ods_editor_documents", List.of("ownerMemberId")),
            Map.entry("calendar_appointments", List.of("ownerMemberId")),
            Map.entry("todo_lists", List.of("ownerMemberId")),
            Map.entry("astro_ground_positions", List.of("ownerUsername")),
            Map.entry("direction_cibles", List.of("ownerUsername")),
            Map.entry("direction_pattool_samples", List.of("ownerUsername")),
            Map.entry("assistant_conversations", List.of("ownerPreferredUsername")),
            Map.entry("assistant_conversation_assets", List.of("ownerSubject")),
            Map.entry("cameras", List.of("owner")),
            Map.entry("iot_proxy_targets", List.of("owner")),
            Map.entry("commentaries", List.of("commentOwner")));

    private final MongoTemplate mongoTemplate;

    public PatToolDatabaseStatsService(MongoTemplate mongoTemplate) {
        this.mongoTemplate = mongoTemplate;
    }

    /**
     * Collection sizes from catalog metadata. This does not scan documents.
     */
    public Map<String, Object> collectionCounts() {
        List<String> names = new ArrayList<>(mongoTemplate.getCollectionNames());
        names.removeIf(name -> name == null || name.startsWith("system."));
        names.sort(String.CASE_INSENSITIVE_ORDER);

        List<Map<String, Object>> collections = new ArrayList<>();
        long totalRecords = 0;
        for (String name : names) {
            long count;
            try {
                count = mongoTemplate.getCollection(name).estimatedDocumentCount();
            } catch (Exception e) {
                Map<String, Object> row = new LinkedHashMap<>();
                row.put("name", name);
                row.put("count", 0);
                row.put("perUser", false);
                row.put("error", e.getMessage() != null ? e.getMessage() : e.toString());
                collections.add(row);
                continue;
            }
            totalRecords += count;
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("name", name);
            row.put("count", count);
            row.put("perUser", DBREF_FIELDS.containsKey(name) || STRING_FIELDS.containsKey(name));
            collections.add(row);
        }

        Map<String, Object> out = new LinkedHashMap<>();
        out.put("success", true);
        out.put("collectionCount", collections.size());
        out.put("recordCount", totalRecords);
        out.put("collections", collections);
        return out;
    }

    /**
     * Per-user counts for the known owner collections. Each collection is grouped on its own thread.
     */
    public Map<String, Object> userBreakdown() {
        Set<String> existing = new HashSet<>(mongoTemplate.getCollectionNames());
        List<String> targets = new ArrayList<>();
        for (String name : DBREF_FIELDS.keySet()) {
            if (existing.contains(name)) {
                targets.add(name);
            }
        }
        for (String name : STRING_FIELDS.keySet()) {
            if (existing.contains(name) && !DBREF_FIELDS.containsKey(name)) {
                targets.add(name);
            }
        }

        MemberIndex members = loadMembers();
        Map<String, UserBucket> users = new TreeMap<>();
        int threads = Math.min(4, Math.max(1, targets.size()));
        ExecutorService pool = Executors.newFixedThreadPool(threads);
        try {
            List<Future<CollectionUsers>> futures = new ArrayList<>();
            for (String name : targets) {
                futures.add(pool.submit(() -> countUsers(name)));
            }
            for (Future<CollectionUsers> future : futures) {
                CollectionUsers part;
                try {
                    part = future.get(45, TimeUnit.SECONDS);
                } catch (Exception e) {
                    log.warn("Per-user database count failed: {}", e.toString());
                    continue;
                }
                for (Map.Entry<String, Long> entry : part.counts.entrySet()) {
                    if (entry.getKey() == null || entry.getKey().isBlank() || entry.getValue() == null || entry.getValue() <= 0) {
                        continue;
                    }
                    ResolvedUser user = members.resolve(entry.getKey());
                    UserBucket bucket = users.computeIfAbsent(user.key, ignored -> new UserBucket(user.label, user.memberId));
                    bucket.tables.merge(part.name, entry.getValue(), Long::sum);
                }
            }
        } finally {
            pool.shutdownNow();
        }

        List<Map<String, Object>> userRows = new ArrayList<>();
        for (UserBucket bucket : users.values()) {
            List<String> tables = new ArrayList<>(bucket.tables.keySet());
            tables.sort(String.CASE_INSENSITIVE_ORDER);
            for (String table : tables) {
                Map<String, Object> row = new LinkedHashMap<>();
                row.put("user", bucket.label);
                row.put("memberId", bucket.memberId);
                row.put("collection", table);
                row.put("count", bucket.tables.get(table));
                userRows.add(row);
            }
        }
        userRows.sort(Comparator
                .comparing((Map<String, Object> row) -> String.valueOf(row.get("user")), String.CASE_INSENSITIVE_ORDER)
                .thenComparing(row -> String.valueOf(row.get("collection")), String.CASE_INSENSITIVE_ORDER));

        Map<String, Object> out = new LinkedHashMap<>();
        out.put("success", true);
        out.put("userRows", userRows);
        return out;
    }

    private CollectionUsers countUsers(String name) {
        try {
            if (mongoTemplate.getCollection(name).estimatedDocumentCount() <= 0) {
                return CollectionUsers.empty(name);
            }
            Map<String, Long> counts = new LinkedHashMap<>();
            for (String field : DBREF_FIELDS.getOrDefault(name, List.of())) {
                merge(counts, group(name, new Document("$getField",
                        new Document("field", "$id").append("input", "$" + field))));
            }
            for (String field : STRING_FIELDS.getOrDefault(name, List.of())) {
                merge(counts, group(name, "$" + field));
            }
            return new CollectionUsers(name, counts);
        } catch (Exception e) {
            log.warn("Per-user count skipped for {}: {}", name, e.toString());
            return CollectionUsers.empty(name);
        }
    }

    private Map<String, Long> group(String collection, Object expression) {
        Map<String, Long> counts = new LinkedHashMap<>();
        try {
            mongoTemplate.getCollection(collection).aggregate(List.of(
                    new Document("$group", new Document("_id", expression).append("n", new Document("$sum", 1)))
            )).forEach(doc -> {
                String key = idText(doc.get("_id"));
                Object n = doc.get("n");
                if (key != null && n instanceof Number number) {
                    counts.merge(key, number.longValue(), Long::sum);
                }
            });
        } catch (Exception ignored) {
            return Map.of();
        }
        return counts;
    }

    private static void merge(Map<String, Long> target, Map<String, Long> extra) {
        for (Map.Entry<String, Long> entry : extra.entrySet()) {
            target.merge(entry.getKey(), entry.getValue(), Long::sum);
        }
    }

    private static String idText(Object id) {
        if (id == null) {
            return null;
        }
        String text = String.valueOf(id).trim();
        return text.isEmpty() || "null".equals(text) ? null : text;
    }

    private MemberIndex loadMembers() {
        Query query = new Query();
        query.fields().include("userName").include("firstName").include("lastName").include("keycloakId");
        List<Member> members = mongoTemplate.find(query, Member.class);
        return new MemberIndex(members);
    }

    private record CollectionUsers(String name, Map<String, Long> counts) {
        static CollectionUsers empty(String name) {
            return new CollectionUsers(name, Map.of());
        }
    }

    private static final class UserBucket {
        final String label;
        final String memberId;
        final Map<String, Long> tables = new LinkedHashMap<>();

        UserBucket(String label, String memberId) {
            this.label = label;
            this.memberId = memberId;
        }
    }

    private static final class MemberIndex {
        final Map<String, Member> byId = new LinkedHashMap<>();
        final Map<String, Member> byName = new LinkedHashMap<>();
        final Map<String, Member> byKeycloak = new LinkedHashMap<>();

        MemberIndex(Collection<Member> members) {
            for (Member member : members) {
                if (member == null || member.getId() == null) {
                    continue;
                }
                byId.put(member.getId(), member);
                if (member.getUserName() != null && !member.getUserName().isBlank()) {
                    byName.putIfAbsent(member.getUserName().trim().toLowerCase(Locale.ROOT), member);
                }
                if (member.getKeycloakId() != null && !member.getKeycloakId().isBlank()) {
                    byKeycloak.putIfAbsent(member.getKeycloakId().trim(), member);
                }
            }
        }

        ResolvedUser resolve(String raw) {
            Member byIdHit = byId.get(raw);
            if (byIdHit != null) {
                return ResolvedUser.of(byIdHit);
            }
            Member byKeycloakHit = byKeycloak.get(raw);
            if (byKeycloakHit != null) {
                return ResolvedUser.of(byKeycloakHit);
            }
            Member byNameHit = byName.get(raw.toLowerCase(Locale.ROOT));
            if (byNameHit != null) {
                return ResolvedUser.of(byNameHit);
            }
            return new ResolvedUser("name:" + raw.toLowerCase(Locale.ROOT), raw, null);
        }
    }

    private record ResolvedUser(String key, String label, String memberId) {
        static ResolvedUser of(Member member) {
            String name = member.getUserName();
            if (name == null || name.isBlank()) {
                String first = member.getFirstName() == null ? "" : member.getFirstName().trim();
                String last = member.getLastName() == null ? "" : member.getLastName().trim();
                name = (first + " " + last).trim();
            }
            if (name == null || name.isBlank()) {
                name = member.getId();
            }
            return new ResolvedUser("id:" + member.getId(), name, member.getId());
        }
    }
}
