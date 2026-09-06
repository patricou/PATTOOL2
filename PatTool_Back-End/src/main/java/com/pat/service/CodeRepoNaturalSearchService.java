package com.pat.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.pat.controller.dto.AssistantChatRequestDto;
import com.pat.controller.dto.AssistantChatResponseDto;
import com.pat.controller.dto.AssistantTurnDto;
import com.pat.controller.dto.CodeRepoSearchResponse;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.util.StringUtils;

import java.text.Normalizer;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/**
 * Turns a natural-language request into a GitHub/GitLab search, then runs it.
 */
@Service
public class CodeRepoNaturalSearchService {

    private static final Logger log = LoggerFactory.getLogger(CodeRepoNaturalSearchService.class);

    private static final String SYSTEM = String.join("\n",
            "You convert a software developer's request into a public GitHub search query.",
            "Reply with JSON only, no markdown, no extra text:",
            "{\"query\":\"...\",\"host\":\"github|gitlab|all\",\"summary\":\"...\"}",
            "Rules:",
            "- If the user names a specific project (pattool, PATTOOL2, lodash), keep that name as ONE token.",
            "  Search it with: Name in:name   Do not split it, do not add extra keywords.",
            "- Do NOT add stars:> or popularity filters unless the user asks for popular/famous libraries.",
            "- For generic requests (a html parser, rest framework), use keywords plus optional language:java.",
            "- host is github unless the user clearly asks for GitLab",
            "- summary is one short sentence in the user's language explaining the interpretation",
            "- Never help with malware, exploits, or attacking systems. If asked, search defensive security libraries instead and say so in summary.",
            "- Keep query under 120 characters.");

    private static final Set<String> STOPWORDS = Set.of(
            "a", "an", "the", "i", "me", "my", "we", "you", "please", "find", "search",
            "looking", "look", "want", "need", "get", "show", "repo", "repos", "repository",
            "repositories", "project", "projects", "github", "gitlab", "named", "called",
            "for", "of", "on", "in", "to", "and",
            "je", "tu", "il", "nous", "vous", "le", "la", "les", "un", "une", "des",
            "du", "de", "d", "l", "cherche", "chercher", "rechercher", "recherche", "trouver",
            "montre", "montrer", "depot", "depots", "projet", "projets",
            "nomme", "appele", "svp", "s", "est", "ce", "cet", "cette");

    private final RoutingAssistantService routingAssistantService;
    private final CodeRepoWorldService codeRepoWorldService;
    private final ObjectMapper objectMapper;

    public CodeRepoNaturalSearchService(
            RoutingAssistantService routingAssistantService,
            CodeRepoWorldService codeRepoWorldService,
            ObjectMapper objectMapper) {
        this.routingAssistantService = routingAssistantService;
        this.codeRepoWorldService = codeRepoWorldService;
        this.objectMapper = objectMapper;
    }

    public CodeRepoSearchResponse search(
            String utterance,
            String hostHint,
            Integer page,
            String provider,
            String model) {
        String named = extractNamedQuery(utterance);
        if (named != null) {
            CodeRepoSearchResponse res = codeRepoWorldService.search(named, hostHint, page);
            res.setNaturalLanguage(true);
            res.setInterpretedQuery(named + " in:name");
            res.setSummary(named);
            return res;
        }
        Interpreted interpreted = interpret(utterance, hostHint, provider, model);
        String host = StringUtils.hasText(interpreted.host) ? interpreted.host : hostHint;
        CodeRepoSearchResponse res;
        try {
            res = codeRepoWorldService.search(interpreted.query, host, page);
        } catch (IllegalArgumentException ex) {
            String fallback = fallbackQuery(utterance);
            res = codeRepoWorldService.search(fallback, hostHint, page);
            interpreted = new Interpreted(fallback, hostHint, interpreted.summary);
        }
        res.setNaturalLanguage(true);
        res.setInterpretedQuery(interpreted.query);
        res.setSummary(interpreted.summary);
        return res;
    }

    private Interpreted interpret(
            String utterance,
            String hostHint,
            String provider,
            String model) {
        String fallback = fallbackQuery(utterance);
        String user = "User request:\n" + utterance.trim()
                + "\nPreferred host (may override): " + (StringUtils.hasText(hostHint) ? hostHint : "all");
        try {
            AssistantChatRequestDto req = new AssistantChatRequestDto(
                    List.of(new AssistantTurnDto("user", user)),
                    SYSTEM,
                    null,
                    null,
                    trimToNull(provider),
                    trimToNull(model));
            AssistantChatResponseDto chat = routingAssistantService.complete(req);
            if (chat == null || StringUtils.hasText(chat.error()) || !StringUtils.hasText(chat.content())) {
                log.debug("NL repo search AI fallback: {}", chat != null ? chat.error() : "empty");
                return new Interpreted(fallback, hostHint, null);
            }
            JsonNode json = parseJsonObject(chat.content());
            if (json == null) {
                return new Interpreted(fallback, hostHint, null);
            }
            String q = sanitizeQuery(json.path("query").asText(""), fallback);
            String host = preferHostHint(hostHint, json.path("host").asText(""));
            String summary = json.path("summary").asText("");
            if (!StringUtils.hasText(summary)) {
                summary = null;
            } else if (summary.length() > 280) {
                summary = summary.substring(0, 280);
            }
            return new Interpreted(q, host, summary);
        } catch (RuntimeException ex) {
            log.debug("NL repo search interpret failed: {}", ex.getMessage());
            return new Interpreted(fallback, hostHint, null);
        }
    }

    private JsonNode parseJsonObject(String raw) {
        String t = raw.trim();
        int a = t.indexOf('{');
        int b = t.lastIndexOf('}');
        if (a < 0 || b <= a) {
            return null;
        }
        try {
            return objectMapper.readTree(t.substring(a, b + 1));
        } catch (Exception ex) {
            return null;
        }
    }

    static String sanitizeQuery(String query, String fallback) {
        String q = query == null ? "" : query.trim().replace('\n', ' ');
        if (q.length() > 120) {
            q = q.substring(0, 120);
        }
        q = q.replaceAll("[^A-Za-z0-9 ._\\-:+#@/\"'><=()]", " ").replaceAll("\\s+", " ").trim();
        return q.length() >= 2 ? q : fallback;
    }

    static String fallbackQuery(String utterance) {
        String q = utterance == null ? "" : utterance.trim();
        q = q.replaceAll("[^A-Za-z0-9 ._\\-:+#@/]", " ").replaceAll("\\s+", " ").trim();
        if (q.length() > 80) {
            q = q.substring(0, 80).trim();
        }
        return q.length() >= 2 ? q : "library";
    }

    static String preferHostHint(String hint, String fromModel) {
        String h = hint == null ? "" : hint.trim().toLowerCase(Locale.ROOT);
        if ("github".equals(h) || "gitlab".equals(h)) {
            return h;
        }
        return normalizeHost(fromModel, hint);
    }

    static String normalizeHost(String host, String hint) {
        String h = host == null ? "" : host.trim().toLowerCase(Locale.ROOT);
        if ("github".equals(h) || "gitlab".equals(h) || "all".equals(h)) {
            return h;
        }
        return StringUtils.hasText(hint) ? hint.trim().toLowerCase(Locale.ROOT) : "github";
    }

    private static String trimToNull(String v) {
        if (!StringUtils.hasText(v)) {
            return null;
        }
        String t = v.trim();
        return t.isEmpty() ? null : t;
    }

    /**
     * "je cherche le repo pattool" → "pattool". Null if the request looks descriptive.
     */
    static String extractNamedQuery(String utterance) {
        if (!StringUtils.hasText(utterance)) {
            return null;
        }
        String[] words = Normalizer.normalize(utterance.toLowerCase(Locale.ROOT), Normalizer.Form.NFD)
                .replaceAll("\\p{M}+", "")
                .replaceAll("[^a-z0-9._\\-/ ]", " ")
                .trim()
                .split("\\s+");
        List<String> kept = new ArrayList<>();
        for (String w : words) {
            if (w.isEmpty() || STOPWORDS.contains(w)) {
                continue;
            }
            kept.add(w);
        }
        if (kept.size() != 1) {
            return null;
        }
        String only = kept.get(0);
        if (only.matches("[a-z][a-z0-9._-]{1,80}") || only.matches("[a-z0-9._-]+/[a-z0-9._-]+")) {
            return only;
        }
        return null;
    }

    private record Interpreted(String query, String host, String summary) {}
}
