package com.pat.util;

import java.net.Inet4Address;
import java.net.Inet6Address;
import java.net.InetAddress;
import java.net.URI;
import java.net.UnknownHostException;
import java.util.Locale;

/**
 * Rejects outbound URLs that would reach loopback, link-local, private or
 * metadata addresses. Callers must re-check every redirect target.
 */
public final class SsrfGuard {

    private SsrfGuard() {}

    public static boolean isPublicHttpUrl(String raw) {
        if (raw == null || raw.isBlank()) {
            return false;
        }
        URI uri;
        try {
            uri = new URI(raw.trim());
        } catch (Exception e) {
            return false;
        }
        String scheme = uri.getScheme();
        if (scheme == null
                || !(scheme.equalsIgnoreCase("http") || scheme.equalsIgnoreCase("https"))) {
            return false;
        }
        if (uri.getUserInfo() != null) {
            return false;
        }
        String host = uri.getHost();
        if (host == null || host.isBlank() || isBlockedHostName(host)) {
            return false;
        }
        try {
            InetAddress[] addresses = InetAddress.getAllByName(host);
            if (addresses.length == 0) {
                return false;
            }
            for (InetAddress address : addresses) {
                if (!isPublicAddress(address)) {
                    return false;
                }
            }
            return true;
        } catch (UnknownHostException e) {
            return false;
        }
    }

    public static boolean isPublicAddress(InetAddress address) {
        if (address == null
                || address.isAnyLocalAddress()
                || address.isLoopbackAddress()
                || address.isLinkLocalAddress()
                || address.isSiteLocalAddress()
                || address.isMulticastAddress()) {
            return false;
        }
        if (address instanceof Inet4Address v4) {
            byte[] b = v4.getAddress();
            int a = b[0] & 0xff;
            int c = b[1] & 0xff;
            if (a == 0 || a == 127 || a >= 224) {
                return false;
            }
            // Carrier-grade NAT and the cloud metadata range sit outside the
            // classic private blocks that {@link InetAddress} already flags.
            if (a == 100 && c >= 64 && c <= 127) {
                return false;
            }
            return true;
        }
        if (address instanceof Inet6Address v6) {
            byte[] b = v6.getAddress();
            int first = b[0] & 0xff;
            if ((first & 0xfe) == 0xfc) {
                return false;
            }
            if (isIpv4Mapped(b)) {
                byte[] v4 = new byte[] {b[12], b[13], b[14], b[15]};
                try {
                    return isPublicAddress(InetAddress.getByAddress(v4));
                } catch (UnknownHostException e) {
                    return false;
                }
            }
        }
        return true;
    }

    private static boolean isBlockedHostName(String host) {
        String h = host.toLowerCase(Locale.ROOT);
        if (h.endsWith(".")) {
            h = h.substring(0, h.length() - 1);
        }
        return "localhost".equals(h)
                || h.endsWith(".localhost")
                || h.endsWith(".local")
                || h.endsWith(".internal")
                || h.endsWith(".intranet")
                || "metadata.google.internal".equals(h)
                || "metadata.google".equals(h);
    }

    private static boolean isIpv4Mapped(byte[] b) {
        if (b.length != 16) {
            return false;
        }
        for (int i = 0; i < 10; i++) {
            if (b[i] != 0) {
                return false;
            }
        }
        return (b[10] & 0xff) == 0xff && (b[11] & 0xff) == 0xff;
    }
}
