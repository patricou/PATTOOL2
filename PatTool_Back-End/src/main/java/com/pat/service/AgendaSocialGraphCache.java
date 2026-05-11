package com.pat.service;

import com.google.common.cache.Cache;
import com.google.common.cache.CacheBuilder;
import com.pat.repo.FriendGroupRepository;
import com.pat.repo.FriendRepository;
import com.pat.repo.MembersRepository;
import com.pat.repo.domain.Friend;
import com.pat.repo.domain.FriendGroup;
import com.pat.repo.domain.Member;
import org.springframework.stereotype.Service;
import org.springframework.util.StringUtils;

import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;

/**
 * Charge une fois par fenêtre courte les relations nécessaires aux filtres de visibilité (amis + groupes),
 * en parallèle, pour éviter plusieurs allers-retours Mongo par requête agenda.
 */
@Service
public class AgendaSocialGraphCache {

    private static final long TTL_SECONDS = 45L;

    private final MembersRepository membersRepository;
    private final FriendRepository friendRepository;
    private final FriendGroupRepository friendGroupRepository;

    private final Cache<String, MemberSocialEdges> cache = CacheBuilder.newBuilder()
            .maximumSize(4000)
            .expireAfterWrite(TTL_SECONDS, TimeUnit.SECONDS)
            .build();

    public AgendaSocialGraphCache(
            MembersRepository membersRepository,
            FriendRepository friendRepository,
            FriendGroupRepository friendGroupRepository) {
        this.membersRepository = membersRepository;
        this.friendRepository = friendRepository;
        this.friendGroupRepository = friendGroupRepository;
    }

    public MemberSocialEdges getEdges(String userId) {
        if (!StringUtils.hasText(userId)) {
            return MemberSocialEdges.EMPTY;
        }
        try {
            return cache.get(userId, () -> computeEdges(userId));
        } catch (ExecutionException e) {
            return MemberSocialEdges.EMPTY;
        }
    }

    private MemberSocialEdges computeEdges(String userId) {
        Member member = membersRepository.findById(userId).orElse(null);
        if (member == null) {
            return MemberSocialEdges.EMPTY;
        }
        CompletableFuture<List<Friend>> friendsFut = CompletableFuture.supplyAsync(() ->
                friendRepository.findByUser1OrUser2(member, member));
        CompletableFuture<List<FriendGroup>> groupsFut = CompletableFuture.supplyAsync(() ->
                friendGroupRepository.findByMembersContaining(member));
        CompletableFuture.allOf(friendsFut, groupsFut).join();
        List<Friend> friends = friendsFut.join();
        List<FriendGroup> groups = groupsFut.join();
        return new MemberSocialEdges(
                friends != null ? friends : List.of(),
                groups != null ? groups : List.of());
    }
}
