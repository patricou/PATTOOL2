package com.pat.util;

import org.junit.jupiter.api.Test;

import java.net.InetAddress;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

class SsrfGuardTest {

    @Test
    void rejectsLoopbackLinkLocalAndPrivateLiterals() {
        assertFalse(SsrfGuard.isPublicHttpUrl("http://127.0.0.1/latest/meta-data"));
        assertFalse(SsrfGuard.isPublicHttpUrl("http://169.254.169.254/"));
        assertFalse(SsrfGuard.isPublicHttpUrl("http://10.1.2.3/"));
        assertFalse(SsrfGuard.isPublicHttpUrl("http://192.168.1.10/"));
        assertFalse(SsrfGuard.isPublicHttpUrl("http://[::1]/"));
        assertFalse(SsrfGuard.isPublicHttpUrl("file:///etc/passwd"));
        assertFalse(SsrfGuard.isPublicHttpUrl("http://user:pass@example.com/"));
    }

    @Test
    void publicAddressCheckMatchesLiteralRanges() throws Exception {
        assertFalse(SsrfGuard.isPublicAddress(InetAddress.getByName("127.0.0.1")));
        assertFalse(SsrfGuard.isPublicAddress(InetAddress.getByName("169.254.169.254")));
        assertFalse(SsrfGuard.isPublicAddress(InetAddress.getByName("100.64.0.1")));
        assertTrue(SsrfGuard.isPublicAddress(InetAddress.getByName("1.1.1.1")));
    }
}
