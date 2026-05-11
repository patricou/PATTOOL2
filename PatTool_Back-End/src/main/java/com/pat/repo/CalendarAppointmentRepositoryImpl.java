package com.pat.repo;

import com.pat.repo.domain.CalendarAppointment;
import com.pat.repo.domain.Friend;
import com.pat.repo.domain.FriendGroup;
import com.pat.service.AgendaSocialGraphCache;
import com.pat.service.MemberSocialEdges;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.data.mongodb.core.query.Criteria;
import org.springframework.data.mongodb.core.query.Query;
import org.springframework.stereotype.Repository;
import org.springframework.util.StringUtils;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.Date;
import java.util.List;
import java.util.Optional;

@Repository
public class CalendarAppointmentRepositoryImpl implements CalendarAppointmentRepositoryCustom {

    private final MongoTemplate mongoTemplate;

    @Autowired
    private AgendaSocialGraphCache agendaSocialGraphCache;

    @Autowired
    public CalendarAppointmentRepositoryImpl(MongoTemplate mongoTemplate) {
        this.mongoTemplate = mongoTemplate;
    }

    @Override
    public List<CalendarAppointment> findAccessibleOverlappingRange(Date rangeStart, Date rangeEnd, String userId) {
        if (rangeStart == null || rangeEnd == null || rangeStart.after(rangeEnd)) {
            return new ArrayList<>();
        }
        Query query = new Query();
        query.addCriteria(buildAccessCriteria(userId));
        query.addCriteria(Criteria.where("startDate").lte(rangeEnd));
        query.addCriteria(Criteria.where("endDate").gte(rangeStart));
        query.fields()
                .include("_id")
                .include("ownerMemberId")
                .include("title")
                .include("notes")
                .include("startDate")
                .include("endDate")
                .include("visibility")
                .include("friendGroupId")
                .include("friendGroupIds")
                .include("createdAt");
        List<CalendarAppointment> list = mongoTemplate.find(query, CalendarAppointment.class);
        list.sort(Comparator
                .comparing(CalendarAppointment::getStartDate, Comparator.nullsLast(Comparator.naturalOrder()))
                .thenComparing(CalendarAppointment::getTitle, Comparator.nullsLast(String.CASE_INSENSITIVE_ORDER)));
        return list;
    }

    @Override
    public Optional<CalendarAppointment> findAccessibleByIdAndMember(String id, String memberId) {
        if (!StringUtils.hasText(id)) {
            return Optional.empty();
        }
        Query query = new Query();
        query.addCriteria(Criteria.where("_id").is(id));
        query.addCriteria(buildAccessCriteria(memberId));
        CalendarAppointment one = mongoTemplate.findOne(query, CalendarAppointment.class);
        return Optional.ofNullable(one);
    }

    private Criteria buildAccessCriteria(String userId) {
        List<Criteria> accessCriteria = new ArrayList<>();
        accessCriteria.add(Criteria.where("visibility").is("public"));

        if (StringUtils.hasText(userId)) {
            accessCriteria.add(Criteria.where("ownerMemberId").is(userId));
            MemberSocialEdges edges = agendaSocialGraphCache.getEdges(userId);
            Criteria friendsCriteria = buildFriendsVisibilityCriteria(userId, edges.friendships());
            if (friendsCriteria != null) {
                accessCriteria.add(friendsCriteria);
            }
            Criteria friendGroupCriteria = buildFriendGroupVisibilityCriteria(userId, edges.friendGroups());
            if (friendGroupCriteria != null) {
                accessCriteria.add(friendGroupCriteria);
            }
        }

        if (accessCriteria.size() == 1) {
            return accessCriteria.get(0);
        }
        return new Criteria().orOperator(accessCriteria.toArray(new Criteria[0]));
    }

    private Criteria buildFriendsVisibilityCriteria(String userId, List<Friend> friendships) {
        try {
            if (friendships == null || friendships.isEmpty()) {
                return null;
            }
            List<String> friendIds = new ArrayList<>();
            for (Friend friendship : friendships) {
                if (friendship.getUser1() != null && !friendship.getUser1().getId().equals(userId)) {
                    friendIds.add(friendship.getUser1().getId());
                }
                if (friendship.getUser2() != null && !friendship.getUser2().getId().equals(userId)) {
                    friendIds.add(friendship.getUser2().getId());
                }
            }
            if (friendIds.isEmpty()) {
                return null;
            }
            List<Criteria> ownerCriteria = new ArrayList<>();
            for (String friendId : friendIds) {
                ownerCriteria.add(Criteria.where("ownerMemberId").is(friendId));
            }
            if (ownerCriteria.isEmpty()) {
                return null;
            }
            Criteria ownerInFriends = new Criteria().orOperator(ownerCriteria.toArray(new Criteria[0]));
            return new Criteria().andOperator(
                    Criteria.where("visibility").is("friends"),
                    ownerInFriends
            );
        } catch (Exception e) {
            return null;
        }
    }

    private Criteria buildFriendGroupVisibilityCriteria(String userId, List<FriendGroup> userFriendGroups) {
        try {
            if (userFriendGroups == null || userFriendGroups.isEmpty()) {
                return null;
            }
            List<String> groupIds = new ArrayList<>();
            for (FriendGroup group : userFriendGroups) {
                if (group.getId() != null) {
                    groupIds.add(group.getId());
                }
            }
            if (groupIds.isEmpty()) {
                return null;
            }

            List<Criteria> legacyMatches = new ArrayList<>();
            for (String groupId : groupIds) {
                legacyMatches.add(Criteria.where("friendGroupId").is(groupId));
            }
            for (FriendGroup group : userFriendGroups) {
                if (group.getName() != null && !group.getName().trim().isEmpty()) {
                    legacyMatches.add(Criteria.where("visibility").is(group.getName()));
                }
            }
            if (legacyMatches.isEmpty()) {
                return null;
            }
            Criteria legacyMatch = new Criteria().orOperator(legacyMatches.toArray(new Criteria[0]));
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

    @Override
    public List<CalendarAppointment> findAllOverlappingRange(Date rangeStart, Date rangeEnd) {
        if (rangeStart == null || rangeEnd == null || rangeStart.after(rangeEnd)) {
            return new ArrayList<>();
        }
        Query query = new Query();
        query.addCriteria(Criteria.where("startDate").lte(rangeEnd));
        query.addCriteria(Criteria.where("endDate").gte(rangeStart));
        List<CalendarAppointment> list = mongoTemplate.find(query, CalendarAppointment.class);
        list.sort(Comparator
                .comparing(CalendarAppointment::getStartDate, Comparator.nullsLast(Comparator.naturalOrder()))
                .thenComparing(CalendarAppointment::getTitle, Comparator.nullsLast(String.CASE_INSENSITIVE_ORDER)));
        return list;
    }
}
