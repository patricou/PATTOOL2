package com.pat.service.iot;

import org.springframework.stereotype.Component;

import java.net.Inet4Address;
import java.net.Inet6Address;
import java.net.InetAddress;
import java.net.URI;
import java.net.URISyntaxException;
import java.net.UnknownHostException;
import java.util.Optional;
import java.util.regex.Pattern;

/**
 * Accepts {@code http} / {@code https} URLs whose host resolves only to loopback
 * or RFC1918 IPv4 ({@code 10.x}, {@code 172.16–31.x}, {@code 192.168.x}).
 * Rejects IPv6 except {@code ::1}, link-local / multicast, and literals that look like SSRF primitives.
 *
 * <p>Note: resolving <strong>hostnames</strong> uses {@link InetAddress#getAllByName(String)} and can stall
 * for seconds on slow/unreachable DNS or mDNS (e.g. {@code *.local}). Using a numeric LAN IP avoids that.
 */
@Component
public class LanUpstreamUrlValidator {

    private static final Pattern IPV4_DOT_QUAD = Pattern.compile(
            "^([01]?\\d?\\d|2[0-4]?\\d|25[0-5])\\.([01]?\\d?\\d|2[0-4]?\\d|25[0-5])\\.([01]?\\d?\\d|2[0-4]?\\d|25[0-5])\\.([01]?\\d?\\d|2[0-4]?\\d|25[0-5])$"
    );

    /** Max length validated upstream URLs (stored and forwarded). */
    public static final int MAX_URL_LENGTH = 2048;

    public boolean isAllowedLanUrl(String raw) {
        if (raw == null || raw.isBlank()) {
            return false;
        }
        String trimmed = raw.trim();
        if (trimmed.length() > MAX_URL_LENGTH) {
            return false;
        }
        URI uri;
        try {
            uri = new URI(trimmed);
        } catch (URISyntaxException e) {
            return false;
        }
        String scheme = uri.getScheme();
        if (scheme == null || !(scheme.equalsIgnoreCase("http") || scheme.equalsIgnoreCase("https"))) {
            return false;
        }
        String host = uri.getHost();
        if (host == null || host.isBlank()) {
            return false;
        }
        if (looksLikeBlacklistLiteral(host.trim())) {
            return false;
        }
        InetAddress[] addresses;
        Optional<InetAddress[]> literalOnly = literalLanAddresses(host);
        if (literalOnly.isPresent()) {
            addresses = literalOnly.get();
        } else {
            try {
                addresses = InetAddress.getAllByName(host);
            } catch (UnknownHostException e) {
                return false;
            }
        }
        if (addresses.length == 0) {
            return false;
        }
        for (InetAddress addr : addresses) {
            if (!isAllowedInetAddress(addr)) {
                return false;
            }
        }
        return true;
    }

    /**
     * Parses dotted-quad IPv4 without DNS/OS resolver lookups (instant). Other forms fall through to
     * {@link InetAddress#getAllByName(String)} inside {@link #isAllowedLanUrl(String)}—those can block on hostname resolution.
     */
    private static Optional<InetAddress[]> literalLanAddresses(String host) {
        if (host.isEmpty() || !IPV4_DOT_QUAD.matcher(host).matches()) {
            return Optional.empty();
        }
        try {
            String[] pts = host.split("\\.");
            byte[] oct = new byte[4];
            for (int i = 0; i < 4; i++) {
                oct[i] = (byte) Integer.parseInt(pts[i]);
            }
            InetAddress a = InetAddress.getByAddress(host, oct);
            return Optional.of(new InetAddress[] { a });
        } catch (Exception e) {
            return Optional.empty();
        }
    }

    private static boolean looksLikeBlacklistLiteral(String host) {
        String lower = host.toLowerCase(java.util.Locale.ROOT);
        return lower.equals("0.0.0.0")
                || lower.startsWith("[::ffff:169.254.")
                || lower.contains("169.254.169.254");
    }

    public static boolean isAllowedInetAddress(InetAddress addr) {
        if (addr instanceof Inet6Address) {
            return addr.isLoopbackAddress();
        }
        if (addr instanceof Inet4Address) {
            byte[] b = addr.getAddress();
            int a0 = b[0] & 0xff;
            int a1 = b[1] & 0xff;
            if (addr.isMulticastAddress()) {
                return false;
            }
            if (addr.isLoopbackAddress()) {
                return true;
            }
            if (a0 == 10) {
                return true;
            }
            if (a0 == 172 && a1 >= 16 && a1 <= 31) {
                return true;
            }
            if (a0 == 192 && a1 == 168) {
                return true;
            }
        }
        return false;
    }
}
