package com.pat.dto;

/**
 * A successful interactive / network logon or an active remote session on the backend host.
 *
 * @param kind   LOGON (from security log / journal) or SESSION (currently open: RDP, SSH, tty)
 * @param method e.g. "ssh-password", "ssh-publickey", "rdp", "network", "pts"
 */
public record SentinelLogonDto(
        String kind,
        String user,
        String sourceAddress,
        String sourceScope,
        String method,
        String when,
        String raw) {

    public static final String KIND_LOGON = "LOGON";
    public static final String KIND_SESSION = "SESSION";
}
