package com.pat.service;

import com.pat.repo.domain.Member;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import java.util.Arrays;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;

/**
 * Centralized policy for deciding whether a user should be persisted into userConnectionLogs.
 *
 * Configure with:
 *   app.connection-logs.excluded-users=patricou,otherUser
 */
@Service
public class UserConnectionLogPolicy {

    private final Set<String> excludedUserNamesLower;

    public UserConnectionLogPolicy(
            @Value("${app.connection-logs.excluded-users:patricou}") String excludedUsersCsv
    ) {
        this.excludedUserNamesLower = parseCsvLower(excludedUsersCsv);
    }

    public boolean shouldLog(Member member) {
        if (member == null) {
            return true;
        }
        return shouldLog(member.getUserName());
    }

    public boolean shouldLog(String userName) {
        if (userName == null) {
            return true;
        }
        String normalized = userName.trim().toLowerCase(Locale.ROOT);
        if (normalized.isEmpty()) {
            return true;
        }
        return !excludedUserNamesLower.contains(normalized);
    }

    private static Set<String> parseCsvLower(String csv) {
        Set<String> out = new HashSet<>();
        if (csv == null || csv.trim().isEmpty()) {
            return out;
        }
        Arrays.stream(csv.split(","))
                .map(String::trim)
                .filter(s -> !s.isEmpty())
                .map(s -> s.toLowerCase(Locale.ROOT))
                .forEach(out::add);
        return out;
    }
}

