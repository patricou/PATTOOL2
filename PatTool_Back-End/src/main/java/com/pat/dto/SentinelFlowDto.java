package com.pat.dto;

/**
 * One socket / connection observed on the PatTool backend host (connection table snapshot).
 *
 * @param protocol    tcp, udp, tcp6, udp6
 * @param direction   LISTEN | INBOUND | OUTBOUND | UNKNOWN
 * @param remoteScope LOOPBACK | LAN | PRIVATE | PUBLIC | MULTICAST | UNSPECIFIED
 */
public record SentinelFlowDto(
        String protocol,
        String localAddress,
        int localPort,
        String remoteAddress,
        int remotePort,
        String state,
        Integer pid,
        String processName,
        String direction,
        String remoteScope) {

    public static final String DIR_LISTEN = "LISTEN";
    public static final String DIR_INBOUND = "INBOUND";
    public static final String DIR_OUTBOUND = "OUTBOUND";
    public static final String DIR_UNKNOWN = "UNKNOWN";

    public static final String SCOPE_LOOPBACK = "LOOPBACK";
    public static final String SCOPE_LAN = "LAN";
    public static final String SCOPE_PRIVATE = "PRIVATE";
    public static final String SCOPE_PUBLIC = "PUBLIC";
    public static final String SCOPE_MULTICAST = "MULTICAST";
    public static final String SCOPE_UNSPECIFIED = "UNSPECIFIED";

    public boolean isListener() {
        return DIR_LISTEN.equals(direction);
    }

    public boolean isEstablished() {
        return state != null && (state.equalsIgnoreCase("ESTABLISHED") || state.equalsIgnoreCase("ESTAB"));
    }

    public SentinelFlowDto withDirection(String newDirection) {
        return new SentinelFlowDto(protocol, localAddress, localPort, remoteAddress, remotePort, state, pid,
                processName, newDirection, remoteScope);
    }

    public SentinelFlowDto withProcessName(String name) {
        return new SentinelFlowDto(protocol, localAddress, localPort, remoteAddress, remotePort, state, pid,
                name, direction, remoteScope);
    }
}
