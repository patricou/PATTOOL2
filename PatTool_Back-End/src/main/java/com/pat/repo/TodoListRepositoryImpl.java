package com.pat.repo;

import com.pat.repo.domain.Friend;
import com.pat.repo.domain.FriendGroup;
import com.pat.repo.domain.Member;
import com.pat.repo.domain.TodoList;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.data.domain.Sort;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.data.mongodb.core.query.Criteria;
import org.springframework.data.mongodb.core.query.Query;
import org.springframework.stereotype.Repository;
import org.springframework.util.StringUtils;

import java.util.ArrayList;
import java.util.List;
import java.util.Optional;

/**
 * Custom queries for {@link TodoList}. Visibility rules are intentionally identical to
 * {@link CalendarAppointmentRepositoryImpl}.
 */
@Repository
public class TodoListRepositoryImpl implements TodoListRepositoryCustom {

    private final MongoTemplate mongoTemplate;

    @Autowired
    private FriendRepository friendRepository;

    @Autowired
    private MembersRepository membersRepository;

    @Autowired
    private FriendGroupRepository friendGroupRepository;

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
            Member currentUser = membersRepository.findById(userId).orElse(null);
            if (currentUser == null) {
                return null;
            }
            List<Friend> friendships = friendRepository.findByUser1OrUser2(currentUser, currentUser);
            if (friendships.isEmpty()) {
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

    private Criteria buildFriendGroupVisibilityCriteria(String userId) {
        try {
            Member currentUser = membersRepository.findById(userId).orElse(null);
            if (currentUser == null) {
                return null;
            }
            List<FriendGroup> userFriendGroups = friendGroupRepository.findByMembersContaining(currentUser);
            if (userFriendGroups.isEmpty()) {
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
}
