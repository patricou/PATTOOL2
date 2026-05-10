package com.pat.service.assistant;

import com.pat.controller.dto.AssistantAttachedImageDto;
import com.pat.controller.dto.AssistantTurnDto;

import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.Set;

/** Logique partagée entre fournisseurs (OpenAI, Anthropic, Gemini) pour l’assistant latéral. */
public final class AssistantMessageSupport {

    public static final int MAX_TURNS = 40;
    public static final int MAX_CONTENT_CHARS = 120_000;
    public static final int MAX_IMAGE_DECODED_BYTES = 8 * 1024 * 1024;

    public static final Set<String> ALLOWED_IMAGE_MIMES =
            Set.of("image/jpeg", "image/png", "image/gif", "image/webp");

    private AssistantMessageSupport() {}

    public static List<AssistantTurnDto> trimTurns(List<AssistantTurnDto> messages) {
        List<AssistantTurnDto> out = new ArrayList<>();
        int from = Math.max(0, messages.size() - MAX_TURNS);
        for (int i = from; i < messages.size(); i++) {
            AssistantTurnDto t = messages.get(i);
            if (t == null || t.role() == null || t.content() == null) {
                continue;
            }
            String role = t.role().trim().toLowerCase();
            if (!"user".equals(role) && !"assistant".equals(role)) {
                continue;
            }
            String content = t.content().trim();
            if (content.isEmpty()) {
                continue;
            }
            out.add(new AssistantTurnDto(role, content));
        }
        return out;
    }

    /** Image décodée + type MIME, ou message d’erreur. */
    public record DecodedImage(byte[] bytes, String mediaType, String error) {
        public static DecodedImage err(String message) {
            return new DecodedImage(null, null, message);
        }

        public static DecodedImage ok(byte[] bytes, String mediaType) {
            return new DecodedImage(bytes, mediaType, null);
        }
    }

    /**
     * Valide et décode l’image jointe au dernier tour utilisateur.
     * {@code dataUrl} : préfixe {@code data:mime;base64,} + données (pour OpenAI).
     */
    public record ResolvedImage(String dataUrl, DecodedImage decoded, String error) {
        public static ResolvedImage err(String message) {
            return new ResolvedImage(null, null, message);
        }

        public static ResolvedImage ok(String dataUrl, DecodedImage decoded) {
            return new ResolvedImage(dataUrl, decoded, null);
        }
    }

    public static ResolvedImage resolveAttachedImage(
            AssistantAttachedImageDto attached, List<AssistantTurnDto> turns) {
        if (attached == null) {
            return ResolvedImage.ok(null, null);
        }
        if (turns.isEmpty() || !"user".equals(turns.get(turns.size() - 1).role())) {
            return ResolvedImage.err(
                    "Une image ne peut être analysée qu’avec un message utilisateur en dernier.");
        }
        String mimeRaw = attached.mimeType();
        String b64Raw = attached.base64();
        if (mimeRaw == null || mimeRaw.isBlank() || b64Raw == null || b64Raw.isBlank()) {
            return ResolvedImage.err("Image jointe incomplète (mimeType ou base64 manquant).");
        }
        String mime = mimeRaw.trim().toLowerCase();
        String b64 = b64Raw.strip().replaceAll("\\s+", "");
        String useMime = mime;
        if (b64.startsWith("data:")) {
            int comma = b64.indexOf(',');
            if (comma < 6) {
                return ResolvedImage.err("Image jointe : data URL invalide.");
            }
            String header = b64.substring(5, comma);
            int semi = header.indexOf(';');
            String declared =
                    semi > 0 ? header.substring(0, semi).trim().toLowerCase() : header.trim().toLowerCase();
            if (!declared.isEmpty() && ALLOWED_IMAGE_MIMES.contains(declared)) {
                useMime = declared;
            }
            b64 = b64.substring(comma + 1).replaceAll("\\s+", "");
        }
        if (!ALLOWED_IMAGE_MIMES.contains(useMime)) {
            return ResolvedImage.err(
                    "Format d’image non pris en charge. Utilisez JPEG, PNG, GIF ou WebP.");
        }
        byte[] decoded;
        try {
            decoded = Base64.getDecoder().decode(b64);
        } catch (IllegalArgumentException e) {
            return ResolvedImage.err("Encodage base64 de l’image invalide.");
        }
        if (decoded.length == 0) {
            return ResolvedImage.err("Image jointe vide.");
        }
        if (decoded.length > MAX_IMAGE_DECODED_BYTES) {
            return ResolvedImage.err(
                    "Image trop volumineuse (max "
                            + (MAX_IMAGE_DECODED_BYTES / (1024 * 1024))
                            + " Mo après décodage).");
        }
        String dataUrl =
                "data:"
                        + useMime
                        + ";base64,"
                        + Base64.getEncoder().encodeToString(decoded);
        return ResolvedImage.ok(dataUrl, DecodedImage.ok(decoded, useMime));
    }
}
