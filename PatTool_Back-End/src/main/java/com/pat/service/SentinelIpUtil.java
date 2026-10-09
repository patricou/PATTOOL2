package com.pat.service;

import com.pat.dto.SentinelFlowDto;

import java.net.Inet4Address;
import java.net.Inet6Address;
import java.net.InetAddress;
import java.net.UnknownHostException;
import java.util.ArrayList;
import java.util.Collection;
import java.util.List;
import java.util.Locale;

/**
 * Address scope helpers for the network sentinel (no DNS lookups, string parsing only).
 */
public final class SentinelIpUtil {

    private SentinelIpUtil() {
    }

    /** Network prefix: address bytes + prefix length. */
    public record Cidr(byte[] network, int prefix, String text) {

        public boolean contains(InetAddress address) {
            if (address == null) {
                return false;
            }
            byte[] a = address.getAddress();
            if (a.length != network.length) {
                return false;
            }
            int fullBytes = prefix / 8;
            int remaining = prefix % 8;
            for (int i = 0; i < fullBytes; i++) {
                if (a[i] != network[i]) {
                    return false;
                }
            }
            if (remaining == 0) {
                return true;
            }
            int mask = (0xFF << (8 - remaining)) & 0xFF;
            return (a[fullBytes] & mask) == (network[fullBytes] & mask);
        }

        @Override
        public String toString() {
            return text;
        }
    }

    /**
     * Parses "192.168.1.0/24", "10.0.0.5" (host → /32) or "2001:db8::/32". Returns null when invalid.
     */
    public static Cidr parseCidr(String raw) {
        if (raw == null) {
            return null;
        }
        String s = raw.trim();
        if (s.isEmpty()) {
            return null;
        }
        String addrPart = s;
        int prefix = -1;
        int slash = s.indexOf('/');
        if (slash >= 0) {
            addrPart = s.substring(0, slash);
            try {
                prefix = Integer.parseInt(s.substring(slash + 1).trim());
            } catch (NumberFormatException e) {
                return null;
            }
        }
        InetAddress addr = parseAddress(addrPart);
        if (addr == null) {
            return null;
        }
        int bits = addr.getAddress().length * 8;
        if (prefix < 0) {
            prefix = bits;
        }
        if (prefix > bits) {
            return null;
        }
        return new Cidr(addr.getAddress(), prefix, addr.getHostAddress() + "/" + prefix);
    }

    public static List<Cidr> parseCidrs(Collection<String> raws) {
        List<Cidr> out = new ArrayList<>();
        if (raws == null) {
            return out;
        }
        for (String r : raws) {
            Cidr c = parseCidr(r);
            if (c != null) {
                out.add(c);
            }
        }
        return out;
    }

    /** Literal IPv4 / IPv6 parse without DNS. Strips zone ids ("%eth0") and brackets. */
    public static InetAddress parseAddress(String raw) {
        if (raw == null) {
            return null;
        }
        String s = raw.trim();
        if (s.startsWith("[") && s.endsWith("]")) {
            s = s.substring(1, s.length() - 1);
        }
        int zone = s.indexOf('%');
        if (zone > 0) {
            s = s.substring(0, zone);
        }
        if (s.isEmpty() || s.equals("*")) {
            return null;
        }
        boolean looksV4 = s.matches("\\d{1,3}(\\.\\d{1,3}){3}");
        boolean looksV6 = s.indexOf(':') >= 0 && s.matches("[0-9A-Fa-f:.]+");
        if (!looksV4 && !looksV6) {
            return null;
        }
        try {
            return InetAddress.getByName(s);
        } catch (UnknownHostException e) {
            return null;
        }
    }

    public static boolean isPrivateRange(InetAddress a) {
        if (a instanceof Inet4Address) {
            byte[] b = a.getAddress();
            int b0 = b[0] & 0xFF;
            int b1 = b[1] & 0xFF;
            if (b0 == 10) {
                return true;
            }
            if (b0 == 172 && b1 >= 16 && b1 <= 31) {
                return true;
            }
            if (b0 == 192 && b1 == 168) {
                return true;
            }
            if (b0 == 169 && b1 == 254) {
                return true; // link-local
            }
            if (b0 == 100 && b1 >= 64 && b1 <= 127) {
                return true; // CGNAT 100.64/10 (ISP-side, not internet)
            }
            return false;
        }
        if (a instanceof Inet6Address) {
            byte[] b = a.getAddress();
            int b0 = b[0] & 0xFF;
            if ((b0 & 0xFE) == 0xFC) {
                return true; // fc00::/7 ULA
            }
            if (b0 == 0xFE && ((b[1] & 0xC0) == 0x80)) {
                return true; // fe80::/10 link-local
            }
            return false;
        }
        return false;
    }

    public static boolean isUnspecified(InetAddress a) {
        return a != null && a.isAnyLocalAddress();
    }

    /**
     * LOOPBACK | LAN | PRIVATE | PUBLIC | MULTICAST | UNSPECIFIED.
     */
    public static String classify(String rawAddress, Collection<Cidr> lanCidrs) {
        if (rawAddress == null || rawAddress.isBlank() || rawAddress.equals("*")) {
            return SentinelFlowDto.SCOPE_UNSPECIFIED;
        }
        InetAddress a = parseAddress(rawAddress);
        if (a == null) {
            return SentinelFlowDto.SCOPE_UNSPECIFIED;
        }
        if (a.isAnyLocalAddress()) {
            return SentinelFlowDto.SCOPE_UNSPECIFIED;
        }
        if (a.isLoopbackAddress()) {
            return SentinelFlowDto.SCOPE_LOOPBACK;
        }
        if (a.isMulticastAddress() || isBroadcastV4(a)) {
            return SentinelFlowDto.SCOPE_MULTICAST;
        }
        if (lanCidrs != null) {
            for (Cidr c : lanCidrs) {
                if (c.contains(a)) {
                    return SentinelFlowDto.SCOPE_LAN;
                }
            }
        }
        if (isPrivateRange(a)) {
            return SentinelFlowDto.SCOPE_PRIVATE;
        }
        return SentinelFlowDto.SCOPE_PUBLIC;
    }

    private static boolean isBroadcastV4(InetAddress a) {
        if (!(a instanceof Inet4Address)) {
            return false;
        }
        byte[] b = a.getAddress();
        return (b[3] & 0xFF) == 255 && (b[0] & 0xFF) == 255 && (b[1] & 0xFF) == 255 && (b[2] & 0xFF) == 255;
    }

    public static boolean inAny(String rawAddress, Collection<Cidr> cidrs) {
        if (cidrs == null || cidrs.isEmpty()) {
            return false;
        }
        InetAddress a = parseAddress(rawAddress);
        if (a == null) {
            return false;
        }
        for (Cidr c : cidrs) {
            if (c.contains(a)) {
                return true;
            }
        }
        return false;
    }

    public static boolean isPublic(String scope) {
        return SentinelFlowDto.SCOPE_PUBLIC.equals(scope);
    }

    public static String normalizeMac(String mac) {
        if (mac == null) {
            return "";
        }
        return mac.trim().toUpperCase(Locale.ROOT).replaceAll("[^0-9A-F]", "");
    }

    public static boolean isBroadcastOrEmptyMac(String mac) {
        String n = normalizeMac(mac);
        return n.isEmpty() || n.equals("FFFFFFFFFFFF") || n.equals("000000000000");
    }
}
