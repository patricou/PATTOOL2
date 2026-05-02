package com.pat.service.iot;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import java.nio.charset.StandardCharsets;
import java.util.Locale;
import java.security.GeneralSecurityException;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.Base64;

/**
 * HMAC-signed, time-bound token so a browser navigation to the LAN proxy succeeds without an
 * {@code Authorization: Bearer} header.
 */
@Service
public class IotProxyOpenTokenService {

    private static final SecureRandom RNG = new SecureRandom();

    private final byte[] hmacSecret;
    private final long validityMs;
    /** Config supplied a raw secret {@code ≥ 32} bytes (recommended for production stable signing). */
    private final boolean explicitOpenTokenSecretConfigured;

    public IotProxyOpenTokenService(
            @Value("${app.iot-proxy.open-token-hmac-secret:}") String secretConfig,
            @Value("${app.iot-proxy.open-token-validity-seconds:300}") long validitySeconds) {
        byte[] configured = secretConfig == null ? new byte[0] : secretConfig.getBytes(StandardCharsets.UTF_8);
        this.explicitOpenTokenSecretConfigured = configured.length >= 32;
        if (configured.length >= 32) {
            this.hmacSecret = configured;
        } else {
            this.hmacSecret = sha256ConfiguredOrRandom(configured);
        }
        this.validityMs = Math.max(60_000L, Math.min(validitySeconds * 1000L, 86_400_000L)); // 1 min .. 24 h
    }

    public long validitySeconds() {
        return validityMs / 1000L;
    }

    /** True when {@code app.iot-proxy.open-token-hmac-secret} is at least 32 bytes UTF-8 (stable across restarts when set explicitly). */
    public boolean isExplicitOpenTokenSecretConfigured() {
        return explicitOpenTokenSecretConfigured;
    }

    private static byte[] sha256ConfiguredOrRandom(byte[] configured) {
        try {
            if (configured.length > 0) {
                return MessageDigest.getInstance("SHA-256").digest(configured);
            }
        } catch (Exception ignored) {
            /* fall through */
        }
        byte[] rnd = new byte[32];
        RNG.nextBytes(rnd);
        return rnd;
    }

    public String mint(String slug, String ownerKey) {
        long expMs = System.currentTimeMillis() + validityMs;
        byte[] nonce = new byte[16];
        RNG.nextBytes(nonce);
        String nonceB64 = Base64.getUrlEncoder().withoutPadding().encodeToString(nonce);
        String payload = slug + "\n" + ownerKey + "\n" + expMs + "\n" + nonceB64;
        try {
            String sigHex = hexHmacSha256(payload);
            return Base64.getUrlEncoder().withoutPadding().encodeToString(
                    (payload + "\n" + sigHex).getBytes(StandardCharsets.UTF_8));
        } catch (GeneralSecurityException e) {
            throw new IllegalStateException(e);
        }
    }

    public String verifyAndExtractOwner(String tokenCompact, String pathSlug, long nowMs)
            throws GeneralSecurityException {
        if (tokenCompact == null || tokenCompact.isBlank() || pathSlug == null || pathSlug.isBlank()) {
            throw new GeneralSecurityException("missing token/slug");
        }
        byte[] decoded = Base64.getUrlDecoder().decode(tokenCompact.trim());
        String decodedStr = new String(decoded, StandardCharsets.UTF_8);
        int lastNl = decodedStr.lastIndexOf('\n');
        if (lastNl < 1) {
            throw new GeneralSecurityException("bad format");
        }
        String payload = decodedStr.substring(0, lastNl);
        String sigHex = decodedStr.substring(lastNl + 1);
        String expectHex = hexHmacSha256(payload);
        if (!constantTimeEquals(sigHex.toLowerCase(Locale.ROOT), expectHex.toLowerCase(Locale.ROOT))) {
            throw new GeneralSecurityException("bad signature");
        }

        String[] lines = payload.split("\n", 4);
        if (lines.length != 4) {
            throw new GeneralSecurityException("bad payload fields");
        }
        String slug = lines[0];
        String owner = lines[1];
        long exp = Long.parseLong(lines[2]);
        if (!pathSlug.equals(slug)) {
            throw new GeneralSecurityException("slug mismatch");
        }
        if (nowMs > exp) {
            throw new GeneralSecurityException("expired");
        }
        return owner;
    }

    private String hexHmacSha256(String payload) throws GeneralSecurityException {
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(hmacSecret, "HmacSHA256"));
        byte[] raw = mac.doFinal(payload.getBytes(StandardCharsets.UTF_8));
        return toHex(raw);
    }

    private static String toHex(byte[] bytes) {
        StringBuilder sb = new StringBuilder(bytes.length * 2);
        for (byte b : bytes) {
            sb.append(String.format(Locale.ROOT, "%02x", b));
        }
        return sb.toString();
    }

    private static boolean constantTimeEquals(String a, String b) {
        if (a == null || b == null || a.length() != b.length()) {
            return false;
        }
        int r = 0;
        for (int i = 0; i < a.length(); i++) {
            r |= a.charAt(i) ^ b.charAt(i);
        }
        return r == 0;
    }
}
