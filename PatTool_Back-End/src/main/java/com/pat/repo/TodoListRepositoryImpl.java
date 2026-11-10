package com.pat.repo;

import com.pat.controller.dto.TodoDashboardListDto;
import com.pat.repo.domain.TodoList;
import com.pat.util.MemberReferenceIds;
import org.bson.Document;
import org.bson.types.ObjectId;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.data.domain.Sort;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.data.mongodb.core.query.Criteria;
import org.springframework.data.mongodb.core.query.Query;
import org.springframework.stereotype.Repository;
import org.springframework.util.StringUtils;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;

/**
 * Custom queries for {@link TodoList}. Visibility rules are intentionally identical to
 * {@link CalendarAppointmentRepositoryImpl}.
 *
 * <p>Friend and friend-group ids are read as raw documents. Loading {@code Friend} / {@code FriendGroup}
 * entities would resolve every {@code @DBRef Member}, including GPS history, on each list request.</p>
 */
@Repository
public class TodoListRepositoryImpl implements TodoListRepositoryCustom {

    private final MongoTemplate mongoTemplate;

    @Autowired
    public TodoListRepositoryImpl(MongoTemplate mongoTemplate) {
        this.mongoTemplate = mongoTemplate;
    }

    @Override
    public List<TodoList> findAccessibleByMember(String memberId) {
        Query query = new Query();
        query.addCriteria(buildAccessCriteria(memberId));
        query.with(Sort.by(Sort.Direction.DESC, "createdAt"));
        return mongoTemplate.find(query, TodoList.class);
    }

    @Override
    public List<TodoDashboardListDto> findDashboardByMember(String memberId) {
        Query query = new Query();
        query.addCriteria(buildAccessCriteria(memberId));
        query.addCriteria(Criteria.where("status").nin(TodoList.STATUS_DONE, TodoList.STATUS_ARCHIVED));
        query.fields()
                .include("ownerMemberId")
                .include("name")
                .include("status")
                .include("items.id")
                .include("items.title")
                .include("items.status")
                .include("items.dueDate")
                .include("items.assigneeMemberId");
        query.with(Sort.by(Sort.Direction.DESC, "createdAt"));
        List<TodoList> lists = mongoTemplate.find(query, TodoList.class);

        Set<String> memberIds = new HashSet<>();
        for (TodoList list : lists) {
            if (StringUtils.hasText(list.getOwnerMemberId())) {
                memberIds.add(list.getOwnerMemberId().trim());
            }
            if (list.getItems() == null) {
                continue;
            }
            for (var item : list.getItems()) {
                if (item != null && StringUtils.hasText(item.getAssigneeMemberId())) {
                    memberIds.add(item.getAssigneeMemberId().trim());
                }
            }
        }
        Map<String, String> names = loadDisplayNames(memberIds);

        List<TodoDashboardListDto> rows = new ArrayList<>();
        for (TodoList list : lists) {
            List<TodoDashboardListDto.Item> openItems = new ArrayList<>();
            if (list.getItems() != null) {
                for (var item : list.getItems()) {
                    if (item == null || !StringUtils.hasText(item.getTitle())) {
                        continue;
                    }
                    if (TodoList.STATUS_DONE.equals(item.getStatus())
                            || TodoList.STATUS_ARCHIVED.equals(item.getStatus())) {
                        continue;
                    }
                    TodoDashboardListDto.Item row = new TodoDashboardListDto.Item();
                    row.setId(item.getId());
                    row.setTitle(item.getTitle().trim());
                    row.setStatus(item.getStatus());
                    row.setDueDate(item.getDueDate());
                    String assigneeId = StringUtils.hasText(item.getAssigneeMemberId())
                            ? item.getAssigneeMemberId().trim() : null;
                    row.setAssigneeMemberId(assigneeId);
                    row.setAssigneeName(displayName(names, assigneeId));
                    openItems.add(row);
                }
            }
            if (openItems.isEmpty()) {
                continue;
            }
            TodoDashboardListDto dto = new TodoDashboardListDto();
            dto.setId(list.getId());
            dto.setName(list.getName());
            dto.setStatus(list.getStatus());
            String ownerId = StringUtils.hasText(list.getOwnerMemberId())
                    ? list.getOwnerMemberId().trim() : null;
            dto.setOwnerMemberId(ownerId);
            dto.setOwnerName(displayName(names, ownerId));
            dto.setItems(openItems);
            rows.add(dto);
        }
        return rows;
    }

    @Override
    public Optional<TodoList> findAccessibleByIdAndMember(String id, String memberId) {
        if (!StringUtils.hasText(id)) {
            return Optional.empty();
        }
        Query query = new Query();
        query.addCriteria(Criteria.where("_id").is(id));
        query.addCriteria(buildAccessCriteria(memberId));
        TodoList one = mongoTemplate.findOne(query, TodoList.class);
        return Optional.ofNullable(one);
    }

    private Criteria buildAccessCriteria(String userId) {
        List<Criteria> accessCriteria = new ArrayList<>();
        accessCriteria.add(Criteria.where("visibility").is("public"));

        if (StringUtils.hasText(userId)) {
            accessCriteria.add(Criteria.where("ownerMemberId").is(userId));
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

    private Criteria buildFriendsVisibilityCriteria(String userId) {
        try {
            List<String> friendIds = loadFriendIdsRaw(userId);
            if (friendIds.isEmpty()) {
                return null;
            }
            return new Criteria().andOperator(
                    Criteria.where("visibility").is("friends"),
                    Criteria.where("ownerMemberId").in(friendIds)
            );
        } catch (Exception e) {
            return null;
        }
    }

    private Criteria buildFriendGroupVisibilityCriteria(String userId) {
        try {
            List<GroupRef> groups = loadFriendGroupsRaw(userId);
            if (groups.isEmpty()) {
                return null;
            }
            List<String> groupIds = new ArrayList<>();
            List<String> groupNames = new ArrayList<>();
            for (GroupRef group : groups) {
                if (StringUtils.hasText(group.id)) {
                    groupIds.add(group.id);
                }
                if (StringUtils.hasText(group.name)) {
                    groupNames.add(group.name.trim());
                }
            }
            if (groupIds.isEmpty()) {
                return null;
            }

            List<Criteria> legacyMatches = new ArrayList<>();
            if (!groupIds.isEmpty()) {
                legacyMatches.add(Criteria.where("friendGroupId").in(groupIds));
            }
            if (!groupNames.isEmpty()) {
                legacyMatches.add(Criteria.where("visibility").in(groupNames));
            }
            Criteria legacyMatch = legacyMatches.size() == 1
                    ? legacyMatches.get(0)
                    : new Criteria().orOperator(legacyMatches.toArray(new Criteria[0]));
            Criteria legacyBranch = new Criteria().andOperator(
                    Criteria.where("visibility").nin("public", "private", "friends", "friendGroups"),
                    legacyMatch
            );

            Criteria friendGroupsBranch = new Criteria().andOperator(
                    Criteria.where("visibility").is("friendGroups"),
                    Criteria.where("friendGroupIds").in(groupIds)
            );

            return new Criteria().orOperator(legacyBranch, friendGroupsBranch);
        } catch (Exception e) {
            return null;
        }
    }

    /**
     * Other member ids from {@code friends}, without resolving member documents.
     */
    private List<String> loadFriendIdsRaw(String userId) {
        List<Object> ids = idCandidates(userId);
        if (ids.isEmpty()) {
            return List.of();
        }
        Query q = new Query(new Criteria().orOperator(
                Criteria.where("user1.$id").in(ids),
                Criteria.where("user2.$id").in(ids)
        ));
        q.fields().include("user1").include("user2");
        List<Document> rows = mongoTemplate.find(q, Document.class, "friends");
        String self = userId.trim().toLowerCase();
        Set<String> out = new HashSet<>();
        for (Document row : rows) {
            addOtherMember(out, self, row.get("user1"));
            addOtherMember(out, self, row.get("user2"));
        }
        return new ArrayList<>(out);
    }

    /**
     * Groups the user belongs to ({@code members} only, same rule as {@code findByMembersContaining}).
     */
    private List<GroupRef> loadFriendGroupsRaw(String userId) {
        List<Object> ids = idCandidates(userId);
        if (ids.isEmpty()) {
            return List.of();
        }
        Query q = new Query(Criteria.where("members.$id").in(ids));
        q.fields().include("_id").include("name");
        List<Document> rows = mongoTemplate.find(q, Document.class, "friendgroups");
        List<GroupRef> groups = new ArrayList<>();
        for (Document row : rows) {
            String id = scalarId(row.get("_id"));
            if (!StringUtils.hasText(id)) {
                continue;
            }
            Object name = row.get("name");
            groups.add(new GroupRef(id, name == null ? null : name.toString()));
        }
        return groups;
    }

    private Map<String, String> loadDisplayNames(Set<String> memberIds) {
        Map<String, String> names = new HashMap<>();
        if (memberIds == null || memberIds.isEmpty()) {
            return names;
        }
        List<Object> candidates = new ArrayList<>();
        for (String id : memberIds) {
            candidates.addAll(idCandidates(id));
        }
        if (candidates.isEmpty()) {
            return names;
        }
        Query q = new Query(Criteria.where("_id").in(candidates));
        q.fields().include("firstName").include("lastName").include("userName");
        List<Document> docs = mongoTemplate.find(q, Document.class, "members");
        for (Document doc : docs) {
            String id = scalarId(doc.get("_id"));
            if (!StringUtils.hasText(id)) {
                continue;
            }
            String label = displayLabel(doc);
            names.put(id, label);
            names.put(id.toLowerCase(), label);
        }
        return names;
    }

    private static String displayLabel(Document doc) {
        String first = text(doc.get("firstName"));
        String last = text(doc.get("lastName"));
        String full = (first + " " + last).trim();
        if (!full.isEmpty()) {
            return full;
        }
        return text(doc.get("userName"));
    }

    private static String displayName(Map<String, String> names, String id) {
        if (!StringUtils.hasText(id)) {
            return "";
        }
        String trimmed = id.trim();
        String direct = names.get(trimmed);
        if (direct != null) {
            return direct;
        }
        String lower = names.get(trimmed.toLowerCase());
        return lower == null ? "" : lower;
    }

    private static void addOtherMember(Set<String> out, String selfLower, Object ref) {
        String id = scalarId(ref);
        if (!StringUtils.hasText(id) || id.toLowerCase().equals(selfLower)) {
            return;
        }
        out.add(id);
    }

    private static String scalarId(Object raw) {
        String extracted = MemberReferenceIds.extractMemberId(raw);
        if (StringUtils.hasText(extracted)) {
            return extracted;
        }
        if (raw == null) {
            return null;
        }
        String text = raw.toString().trim();
        return text.isEmpty() ? null : text;
    }

    private static String text(Object raw) {
        return raw == null ? "" : raw.toString().trim();
    }

    /** String and {@link ObjectId} forms, so a DBRef {@code $id} matches either storage. */
    private static List<Object> idCandidates(String userId) {
        if (!StringUtils.hasText(userId)) {
            return List.of();
        }
        String trimmed = userId.trim();
        List<Object> ids = new ArrayList<>();
        ids.add(trimmed);
        if (ObjectId.isValid(trimmed)) {
            try {
                ids.add(new ObjectId(trimmed));
            } catch (IllegalArgumentException ignored) {
                // keep the string form only
            }
        }
        return ids;
    }

    private static final class GroupRef {
        private final String id;
        private final String name;

        private GroupRef(String id, String name) {
            this.id = id;
            this.name = name;
        }
    }
}
