package com.pat.repo;

import com.pat.repo.domain.Friend;
import com.pat.repo.domain.FriendGroup;
import com.pat.repo.domain.Member;
import com.pat.repo.domain.TvRecording;
import com.pat.service.AgendaSocialGraphCache;
import com.pat.service.MemberSocialEdges;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.data.domain.Sort;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.data.mongodb.core.query.Criteria;
import org.springframework.data.mongodb.core.query.Query;
import org.springframework.stereotype.Repository;
import org.springframework.util.StringUtils;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

@Repository
public class TvRecordingRepositoryImpl implements TvRecordingRepositoryCustom {

    private final MongoTemplate mongoTemplate;

    @Autowired
    private AgendaSocialGraphCache agendaSocialGraphCache;

    @Autowired
    private FriendGroupRepository friendGroupRepository;

    @Autowired
    private MembersRepository membersRepository;

    @Autowired
    public TvRecordingRepositoryImpl(MongoTemplate mongoTemplate) {
        this.mongoTemplate = mongoTemplate;
    }

    @Override
    public List<TvRecording> findAccessible(String jwtSubject, String memberId) {
        Query query = new Query();
        query.addCriteria(buildAccessCriteria(jwtSubject, memberId));
        query.with(Sort.by(Sort.Direction.DESC, "startedAt"));
        return mongoTemplate.find(query, TvRecording.class);
    }

    @Override
    public Optional<TvRecording> findAccessibleById(String id, String jwtSubject, String memberId) {
        if (!StringUtils.hasText(id)) {
            return Optional.empty();
        }
        Query query = new Query();
        query.addCriteria(Criteria.where("_id").is(id));
        query.addCriteria(buildAccessCriteria(jwtSubject, memberId));
        return Optional.ofNullable(mongoTemplate.findOne(query, TvRecording.class));
    }

    private Criteria buildAccessCriteria(String jwtSubject, String memberId) {
        List<Criteria> accessCriteria = new ArrayList<>();
        accessCriteria.add(Criteria.where("visibility").is("public"));

        if (StringUtils.hasText(jwtSubject)) {
            accessCriteria.add(Criteria.where("ownerSub").is(jwtSubject));
        }

        if (StringUtils.hasText(memberId)) {
            accessCriteria.add(Criteria.where("ownerMemberId").is(memberId));
            MemberSocialEdges edges = agendaSocialGraphCache.getEdges(memberId);
            Criteria friendsCriteria = buildFriendsVisibilityCriteria(memberId, edges.friendships());
            if (friendsCriteria != null) {
                accessCriteria.add(friendsCriteria);
            }
            Criteria friendGroupCriteria = buildFriendGroupVisibilityCriteria(memberId, resolveAccessibleGroups(memberId));
            if (friendGroupCriteria != null) {
                accessCriteria.add(friendGroupCriteria);
            }
        }

        if (accessCriteria.size() == 1) {
            return accessCriteria.get(0);
        }
        return new Criteria().orOperator(accessCriteria.toArray(new Criteria[0]));
    }

    private List<FriendGroup> resolveAccessibleGroups(String memberId) {
        Member member = membersRepository.findById(memberId).orElse(null);
        if (member == null) {
            return List.of();
        }
        Map<String, FriendGroup> byId = new LinkedHashMap<>();
        for (FriendGroup g : friendGroupRepository.findByMembersContaining(member)) {
            if (g != null && g.getId() != null) {
                byId.putIfAbsent(g.getId(), g);
            }
        }
        for (FriendGroup g : friendGroupRepository.findByOwner(member)) {
            if (g != null && g.getId() != null) {
                byId.putIfAbsent(g.getId(), g);
            }
        }
        for (FriendGroup g : friendGroupRepository.findByAuthorizedUsersContaining(member)) {
            if (g != null && g.getId() != null) {
                byId.putIfAbsent(g.getId(), g);
            }
        }
        return new ArrayList<>(byId.values());
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
}
