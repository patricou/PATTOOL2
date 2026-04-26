package com.pat.service;

import com.pat.controller.dto.CalendarVisibilityRecipientDTO;
import com.pat.repo.FriendGroupRepository;
import com.pat.repo.FriendRepository;
import com.pat.repo.MembersRepository;
import com.pat.repo.domain.Friend;
import com.pat.repo.domain.FriendGroup;
import com.pat.repo.domain.Member;
import com.pat.repo.domain.TodoList;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;
import org.springframework.util.StringUtils;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashSet;
import java.util.List;
import java.util.Optional;
import java.util.Set;

/**
 * Resolves which members can see a given {@link TodoList}. Logic mirrors
 * {@link CalendarAppointmentReminderMailService#resolveRecipientMemberIds(com.pat.repo.domain.CalendarAppointment)}.
 *
 * <p>The {@link CalendarVisibilityRecipientDTO} type is reused so the front-end can share its
 * existing recipient picker.</p>
 */
@Service
public class TodoListVisibilityService {

    @Autowired
    private MembersRepository membersRepository;

    @Autowired
    private FriendRepository friendRepository;

    @Autowired
    private FriendGroupRepository friendGroupRepository;

    public List<CalendarVisibilityRecipientDTO> listVisibilityRecipients(TodoList list) {
        Set<String> ids = resolveRecipientMemberIds(list);
        List<CalendarVisibilityRecipientDTO> out = new ArrayList<>();
        for (String memberId : ids) {
            Optional<Member> opt = membersRepository.findById(memberId);
            if (opt.isEmpty()) {
                continue;
            }
            Member m = opt.get();
            String userName = StringUtils.hasText(m.getUserName()) ? m.getUserName().trim() : null;
            out.add(new CalendarVisibilityRecipientDTO(
                    memberId,
                    organizerLabel(m),
                    userName,
                    StringUtils.hasText(m.getAddressEmail())));
        }
        out.sort(Comparator.comparing(CalendarVisibilityRecipientDTO::getDisplayName,
                String.CASE_INSENSITIVE_ORDER));
        return out;
    }

    public Set<String> resolveRecipientMemberIds(TodoList list) {
        Set<String> ids = new HashSet<>();
        String ownerId = list.getOwnerMemberId();
        if (StringUtils.hasText(ownerId)) {
            ids.add(ownerId.trim());
        }
        String vis = list.getVisibility();
        if (!StringUtils.hasText(vis) || "private".equals(vis) || "public".equals(vis)) {
            return ids;
        }
        if ("friends".equals(vis) && StringUtils.hasText(ownerId)) {
            ids.addAll(friendIdsOf(ownerId.trim()));
            return ids;
        }
        if ("friendGroups".equals(vis)) {
            if (list.getFriendGroupIds() != null) {
                for (String gid : list.getFriendGroupIds()) {
                    if (StringUtils.hasText(gid)) {
                        ids.addAll(memberIdsWithAccessToFriendGroup(gid.trim()));
                    }
                }
            }
            if (StringUtils.hasText(list.getFriendGroupId())) {
                ids.addAll(memberIdsWithAccessToFriendGroup(list.getFriendGroupId().trim()));
            }
            return ids;
        }
        if (StringUtils.hasText(list.getFriendGroupId())) {
            ids.addAll(memberIdsWithAccessToFriendGroup(list.getFriendGroupId().trim()));
            return ids;
        }
        // Legacy: visibility holds a friend-group display name.
        List<FriendGroup> named = friendGroupRepository.findByName(vis.trim());
        for (FriendGroup g : named) {
            if (g != null && StringUtils.hasText(g.getId())) {
                ids.addAll(memberIdsWithAccessToFriendGroup(g.getId()));
            }
        }
        return ids;
    }

    private Set<String> friendIdsOf(String ownerMemberId) {
        Set<String> out = new HashSet<>();
        Optional<Member> ownerOpt = membersRepository.findById(ownerMemberId);
        if (ownerOpt.isEmpty()) {
            return out;
        }
        Member owner = ownerOpt.get();
        List<Friend> friendships = friendRepository.findByUser1OrUser2(owner, owner);
        for (Friend f : friendships) {
            if (f.getUser1() != null && StringUtils.hasText(f.getUser1().getId())
                    && !f.getUser1().getId().equals(ownerMemberId)) {
                out.add(f.getUser1().getId());
            }
            if (f.getUser2() != null && StringUtils.hasText(f.getUser2().getId())
                    && !f.getUser2().getId().equals(ownerMemberId)) {
                out.add(f.getUser2().getId());
            }
        }
        return out;
    }

    private Set<String> memberIdsWithAccessToFriendGroup(String groupId) {
        Set<String> out = new HashSet<>();
        Optional<FriendGroup> groupOpt = friendGroupRepository.findById(groupId);
        if (groupOpt.isEmpty()) {
            return out;
        }
        FriendGroup g = groupOpt.get();
        if (g.getOwner() != null && StringUtils.hasText(g.getOwner().getId())) {
            out.add(g.getOwner().getId());
        }
        if (g.getMembers() != null) {
            for (Member m : g.getMembers()) {
                if (m != null && StringUtils.hasText(m.getId())) {
                    out.add(m.getId());
                }
            }
        }
        if (g.getAuthorizedUsers() != null) {
            for (Member m : g.getAuthorizedUsers()) {
                if (m != null && StringUtils.hasText(m.getId())) {
                    out.add(m.getId());
                }
            }
        }
        return out;
    }

    private String organizerLabel(Member m) {
        if (m == null) {
            return "";
        }
        String first = StringUtils.hasText(m.getFirstName()) ? m.getFirstName().trim() : "";
        String last = StringUtils.hasText(m.getLastName()) ? m.getLastName().trim() : "";
        String full = (first + " " + last).trim();
        if (StringUtils.hasText(full)) {
            return full;
        }
        if (StringUtils.hasText(m.getUserName())) {
            return m.getUserName().trim();
        }
        return m.getId();
    }
}
