package com.pat.service;

import com.pat.repo.domain.Friend;
import com.pat.repo.domain.FriendGroup;

import java.util.List;

/**
 * Amis + groupes du membre pour construire les critères Mongo d’accès (agenda, liste d’événements).
 * Mis en cache brièvement via {@link AgendaSocialGraphCache}.
 */
public record MemberSocialEdges(List<Friend> friendships, List<FriendGroup> friendGroups) {

    public static final MemberSocialEdges EMPTY = new MemberSocialEdges(List.of(), List.of());
}
