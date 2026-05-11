package com.pat.controller;

import com.pat.config.AssistantBillingLinksProperties;
import com.pat.controller.dto.AssistantChatRequestDto;
import com.pat.controller.dto.AssistantChatResponseDto;
import com.pat.controller.dto.AssistantClientConfigDto;
import com.pat.controller.dto.AssistantModelIdsDto;
import com.pat.controller.dto.AssistantConversationAssetCreatedDto;
import com.pat.controller.dto.AssistantConversationAssetUploadDto;
import com.pat.controller.dto.AssistantConversationCreatedDto;
import com.pat.controller.dto.AssistantConversationDetailDto;
import com.pat.controller.dto.AssistantConversationSaveRequestDto;
import com.pat.controller.dto.AssistantConversationSummaryDto;
import com.pat.controller.dto.AssistantOpenAiCreditsDto;
import com.pat.controller.dto.AssistantPdfExportRequestDto;
import com.pat.controller.dto.AssistantRoutingPreferenceDto;
import com.pat.service.AssistantConversationAssetService;
import com.pat.service.AssistantConversationService;
import com.pat.service.AssistantModelsCatalogService;
import com.pat.service.AssistantPdfExportService;
import com.pat.service.AssistantRoutingPreferenceService;
import com.pat.service.OpenAiBillingService;
import com.pat.service.RoutingAssistantService;
import jakarta.validation.Valid;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.ContentDisposition;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.validation.annotation.Validated;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.GrantedAuthority;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.web.bind.annotation.*;

import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.List;
import java.util.Locale;
import java.util.Optional;

@RestController
@RequestMapping("/api")
@Validated
public class AssistantController {

    private static final Logger log = LoggerFactory.getLogger(AssistantController.class);

    private final RoutingAssistantService routingAssistantService;
    private final OpenAiBillingService openAiBillingService;
    private final AssistantRoutingPreferenceService assistantRoutingPreferenceService;
    private final AssistantPdfExportService assistantPdfExportService;
    private final AssistantConversationService assistantConversationService;
    private final AssistantConversationAssetService assistantConversationAssetService;
    private final AssistantBillingLinksProperties assistantBillingLinks;
    private final AssistantModelsCatalogService assistantModelsCatalogService;

    public AssistantController(
            RoutingAssistantService routingAssistantService,
            OpenAiBillingService openAiBillingService,
            AssistantRoutingPreferenceService assistantRoutingPreferenceService,
            AssistantPdfExportService assistantPdfExportService,
            AssistantConversationService assistantConversationService,
            AssistantConversationAssetService assistantConversationAssetService,
            AssistantBillingLinksProperties assistantBillingLinks,
            AssistantModelsCatalogService assistantModelsCatalogService) {
        this.routingAssistantService = routingAssistantService;
        this.openAiBillingService = openAiBillingService;
        this.assistantRoutingPreferenceService = assistantRoutingPreferenceService;
        this.assistantPdfExportService = assistantPdfExportService;
        this.assistantConversationService = assistantConversationService;
        this.assistantConversationAssetService = assistantConversationAssetService;
        this.assistantBillingLinks = assistantBillingLinks;
        this.assistantModelsCatalogService = assistantModelsCatalogService;
    }

    /**
     * Fournisseur et modèle configurés pour l’UI (OpenAI : {@code openai.provider} / {@code openai.assistant.model},
     * Anthropic : {@code anthropic.provider-label} / {@code anthropic.model}, Gemini : {@code gemini.provider-label} /
     * {@code gemini.model}).
     */
    @GetMapping("/assistant/config")
    public ResponseEntity<AssistantClientConfigDto> assistantClientConfig() {
        String p = routingAssistantService.getConfiguredProviderLabel();
        String m = routingAssistantService.getConfiguredModel();
        String routing = routingAssistantService.getConfiguredRoutingSlug();
        String sub = currentJwtSubject();
        AssistantRoutingPreferenceDto persisted =
                sub != null
                        ? assistantRoutingPreferenceService.findForSubject(sub).orElse(null)
                        : null;
        String oai = routingAssistantService.getDefaultModelForRoutingSlug("openai");
        String ant = routingAssistantService.getDefaultModelForRoutingSlug("anthropic");
        String gem = routingAssistantService.getDefaultModelForRoutingSlug("gemini");
        String gemImg = routingAssistantService.getGeminiImageGenerationModel();
        return ResponseEntity.ok(new AssistantClientConfigDto(
                p.isEmpty() ? null : p,
                m.isEmpty() ? null : m,
                routing.isEmpty() ? null : routing,
                persisted,
                oai.isEmpty() ? null : oai,
                ant.isEmpty() ? null : ant,
                gem.isEmpty() ? null : gem,
                emptyToNull(assistantBillingLinks.getOpenaiBillingUrl()),
                emptyToNull(assistantBillingLinks.getOpenaiUsageUrl()),
                emptyToNull(assistantBillingLinks.getAnthropicUrl()),
                emptyToNull(assistantBillingLinks.getGeminiRateLimitUrl()),
                emptyToNull(assistantBillingLinks.getGeminiApiKeysUrl()),
                gemImg.isEmpty() ? null : gemImg));
    }

    /**
     * Liste des identifiants de modèles connus du fournisseur (API liste-modèles côté clé serveur).
     * Le client fusionne avec ses presets locaux ; si la clé est absente ou l’appel échoue, la liste peut être vide.
     */
    @GetMapping("/assistant/models")
    public ResponseEntity<AssistantModelIdsDto> assistantModelCatalog(
            @RequestParam("provider") String provider) {
        String p = provider == null ? "" : provider.trim().toLowerCase(Locale.ROOT);
        if (!"openai".equals(p) && !"anthropic".equals(p) && !"gemini".equals(p)) {
            return ResponseEntity.badRequest().build();
        }
        return ResponseEntity.ok(
                new AssistantModelIdsDto(assistantModelsCatalogService.listModelIds(p)));
    }

    private static String emptyToNull(String s) {
        if (s == null || s.isBlank()) {
            return null;
        }
        return s.trim();
    }

    /**
     * Enregistre le fournisseur et le modèle choisis dans l'assistant (collection {@code appParameters},
     * clé {@code assistant.routing.<sub JWT>}).
     */
    @PutMapping("/assistant/routing-preference")
    public ResponseEntity<Void> saveRoutingPreference(@RequestBody @Valid AssistantRoutingPreferenceDto body) {
        String sub = currentJwtSubject();
        if (sub == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        assistantRoutingPreferenceService.saveForSubject(sub, body);
        return ResponseEntity.noContent().build();
    }

    private static Jwt jwtPrincipal() {
        Authentication auth = SecurityContextHolder.getContext().getAuthentication();
        if (auth == null || !(auth.getPrincipal() instanceof Jwt jwt)) {
            return null;
        }
        return jwt;
    }

    private static String currentJwtSubject() {
        Jwt jwt = jwtPrincipal();
        return jwt != null ? jwt.getSubject() : null;
    }

    /**
     * Rôle realm ou client Keycloak {@code Admin} / {@code admin}, exposé comme {@code ROLE_*} par
     * {@link com.pat.config.SecurityConfig}.
     */
    private static boolean assistantAdmin() {
        Authentication auth = SecurityContextHolder.getContext().getAuthentication();
        if (auth == null || auth.getAuthorities() == null) {
            return false;
        }
        for (GrantedAuthority ga : auth.getAuthorities()) {
            String a = ga.getAuthority();
            if (a != null && a.length() > 5 && a.regionMatches(true, 0, "ROLE_", 0, 5)) {
                if ("admin".equalsIgnoreCase(a.substring(5))) {
                    return true;
                }
            }
        }
        return false;
    }

    private static String preferredUsernameFromJwt() {
        Jwt jwt = jwtPrincipal();
        if (jwt == null) {
            return null;
        }
        String u = jwt.getClaimAsString("preferred_username");
        return u != null && !u.isBlank() ? u.strip() : null;
    }

    /**
     * Upload d’une image générée par le modèle (stockage Mongo séparé — évite les payloads conversation énormes).
     */
    @PostMapping("/assistant/conversation-assets")
    public ResponseEntity<AssistantConversationAssetCreatedDto> uploadConversationAsset(
            @RequestBody @Valid AssistantConversationAssetUploadDto body) {
        String sub = currentJwtSubject();
        if (sub == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        String assetId = assistantConversationAssetService.saveForOwner(sub, body);
        return ResponseEntity.status(HttpStatus.CREATED).body(new AssistantConversationAssetCreatedDto(assetId));
    }

    @GetMapping("/assistant/conversation-assets/{id}")
    public ResponseEntity<byte[]> getConversationAsset(@PathVariable String id) {
        String sub = currentJwtSubject();
        if (sub == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        Optional<byte[]> bytes =
                assistantConversationAssetService.readBytesIfOwned(sub, id, assistantAdmin());
        if (bytes.isEmpty()) {
            return ResponseEntity.notFound().build();
        }
        MediaType mt = MediaType.APPLICATION_OCTET_STREAM;
        try {
            Optional<String> mime = assistantConversationAssetService.findMimeIfOwned(sub, id, assistantAdmin());
            if (mime.isPresent() && mime.get() != null && !mime.get().isBlank()) {
                mt = MediaType.parseMediaType(mime.get());
            }
        } catch (Exception e) {
            log.debug("assistant conversation-asset mime: {}", e.getMessage());
        }
        return ResponseEntity.ok().contentType(mt).body(bytes.get());
    }

    /** Liste des conversations enregistrées (résumés) : les siennes, ou toutes (100 dernières) si rôle {@code Admin}. */
    @GetMapping("/assistant/conversations")
    public ResponseEntity<List<AssistantConversationSummaryDto>> listConversations() {
        String sub = currentJwtSubject();
        if (sub == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        return ResponseEntity.ok(
                assistantConversationService.listSummaries(sub, preferredUsernameFromJwt(), assistantAdmin()));
    }

    /** Détail d’une conversation (tours + images) : propriétaire ou administrateur PatTool ({@code Admin}). */
    @GetMapping("/assistant/conversations/{id}")
    public ResponseEntity<AssistantConversationDetailDto> getConversation(@PathVariable String id) {
        String sub = currentJwtSubject();
        if (sub == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        return assistantConversationService
                .getDetail(sub, id, assistantAdmin())
                .map(ResponseEntity::ok)
                .orElseGet(() -> ResponseEntity.notFound().build());
    }

    /** Crée une nouvelle conversation persistée (historique). */
    @PostMapping("/assistant/conversations")
    public ResponseEntity<AssistantConversationCreatedDto> createConversation(
            @RequestBody @Valid AssistantConversationSaveRequestDto body) {
        String sub = currentJwtSubject();
        if (sub == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        AssistantConversationCreatedDto created =
                assistantConversationService.create(sub, preferredUsernameFromJwt(), body);
        return ResponseEntity.status(HttpStatus.CREATED).body(created);
    }

    /** Remplace le contenu d’une conversation existante (autosauvegarde). */
    @PutMapping("/assistant/conversations/{id}")
    public ResponseEntity<Void> updateConversation(
            @PathVariable String id, @RequestBody @Valid AssistantConversationSaveRequestDto body) {
        String sub = currentJwtSubject();
        if (sub == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        assistantConversationService.update(sub, id, body, assistantAdmin(), preferredUsernameFromJwt());
        return ResponseEntity.noContent().build();
    }

    /** Supprime une conversation du propriétaire. */
    @DeleteMapping("/assistant/conversations/{id}")
    public ResponseEntity<Void> deleteConversation(@PathVariable String id) {
        String sub = currentJwtSubject();
        if (sub == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        if (!assistantConversationService.delete(sub, id, assistantAdmin())) {
            return ResponseEntity.notFound().build();
        }
        return ResponseEntity.noContent().build();
    }

    /**
     * Assistant latéral multi-tours : OpenAI, Anthropic (Messages) ou Google Gemini ({@code generateContent})
     * selon {@code assistant.provider} (ou surcharge {@code provider} dans le corps).
     */
    @PostMapping("/assistant/chat")
    public ResponseEntity<AssistantChatResponseDto> chat(@RequestBody @Valid AssistantChatRequestDto body) {
        AssistantChatResponseDto result = routingAssistantService.complete(body);
        if (result.error() != null) {
            boolean configMissingKey =
                    result.error().contains("openai.key")
                            || result.error().contains("configurez openai.key")
                            || result.error().contains("anthropic.key")
                            || result.error().contains("configurez anthropic.key")
                            || result.error().contains("gemini.key")
                            || result.error().contains("configurez gemini.key");
            HttpStatus status = configMissingKey ? HttpStatus.SERVICE_UNAVAILABLE : HttpStatus.BAD_GATEWAY;
            return ResponseEntity.status(status).body(result);
        }
        return ResponseEntity.ok(result);
    }

    /**
     * Export PDF de la conversation affichée : HTML/Markdown rendus côté serveur (OpenHTMLToPDF).
     * Les libellés et lignes de stats sont déjà localisés par le client.
     */
    @PostMapping(value = "/assistant/export-pdf", consumes = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<byte[]> exportPdf(@RequestBody @Valid AssistantPdfExportRequestDto body) {
        try {
            byte[] pdf = assistantPdfExportService.buildPdf(body);
            String filename =
                    "pat-assistant-"
                            + DateTimeFormatter.ofPattern("yyyyMMdd-HHmmss")
                                    .withZone(ZoneId.systemDefault())
                                    .format(Instant.now())
                            + ".pdf";
            ContentDisposition cd =
                    ContentDisposition.attachment().filename(filename, StandardCharsets.UTF_8).build();
            return ResponseEntity.ok()
                    .header(HttpHeaders.CONTENT_DISPOSITION, cd.toString())
                    .contentType(MediaType.APPLICATION_PDF)
                    .body(pdf);
        } catch (Exception e) {
            log.error("assistant export-pdf failed", e);
            return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).build();
        }
    }

    /**
     * Solde crédits API (prépayé) si exposé par OpenAI pour la clé {@code openai.key}.
     */
    @GetMapping("/assistant/openai/credits")
    public ResponseEntity<AssistantOpenAiCreditsDto> openAiCredits() {
        return ResponseEntity.ok(openAiBillingService.fetchCreditsSummary());
    }
}
