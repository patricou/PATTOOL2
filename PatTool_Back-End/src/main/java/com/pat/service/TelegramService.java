package com.pat.service;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.pat.controller.dto.TelegramChatDto;
import com.pat.controller.dto.TelegramEmbedDto;
import com.pat.controller.dto.TelegramInboxDto;
import com.pat.controller.dto.TelegramMessageDto;
import com.pat.controller.dto.TelegramStatusDto;
import com.pat.repo.domain.AppParameter;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.web.client.RestTemplateBuilder;
import org.springframework.http.CacheControl;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.stereotype.Service;
import org.springframework.util.StringUtils;
import org.springframework.web.client.HttpStatusCodeException;
import org.springframework.web.client.RestClientException;
import org.springframework.web.client.RestTemplate;
import org.springframework.web.util.UriComponentsBuilder;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.net.URL;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Per-user Telegram Bot API access. The token is the signed-in PatTool user's
 * own BotFather token (Mongo {@code telegram.connection.&lt;username&gt;});
 * the browser never sees it and there is no shared server bot.
 * <p>
 * Official API: {@code https://api.telegram.org/bot&lt;token&gt;/METHOD_NAME}
 */
@Service
public class TelegramService {

    private static final Logger log = LoggerFactory.getLogger(TelegramService.class);
    private static final String USER_AGENT = "PatTool/1.0 (telegram helper; https://www.patrickdeschamps.com)";
    static final String CONNECTION_PREFIX = "telegram.connection.";
    static final String INBOX_PREFIX = "telegram.inbox.";
    private static final int MAX_CHATS = 40;
    private static final int MAX_MESSAGES = 80;
    private static final int MAX_TEXT = 4096;
    private static final int MAX_FILE_BYTES = 15 * 1024 * 1024;
    private static final Pattern BOT_TOKEN = Pattern.compile("^\\d{5,}:[A-Za-z0-9_-]{20,}$");
    private static final Pattern FILE_ID = Pattern.compile("^[A-Za-z0-9_:-]{10,256}$");
    private static final Pattern CHAT_ID = Pattern.compile("^(?:-?\\d{1,20}|@[A-Za-z][A-Za-z0-9_]{3,64})$");
    private static final Pattern POST_URL = Pattern.compile(
            "(?i)^https?://(?:t\\.me|telegram\\.me|www\\.t\\.me)/([A-Za-z][A-Za-z0-9_]{3,64})/(\\d{1,12})(?:\\?.*)?$");

    private final RestTemplate restTemplate;
    private final ObjectMapper objectMapper;
    private final AppParameterService appParameterService;
    private final UserOwnerService userOwnerService;
    private final String apiBase;
    private final ConcurrentHashMap<String, Object> userLocks = new ConcurrentHashMap<>();

    public TelegramService(
            RestTemplateBuilder builder,
            ObjectMapper objectMapper,
            AppParameterService appParameterService,
            UserOwnerService userOwnerService,
            @Value("${app.telegram.api-base:https://api.telegram.org}") String apiBase) {
        this.restTemplate = builder
                .setConnectTimeout(Duration.ofSeconds(5))
                .setReadTimeout(Duration.ofSeconds(20))
                .build();
        this.objectMapper = objectMapper;
        this.appParameterService = appParameterService;
        this.userOwnerService = userOwnerService;
        this.apiBase = trimSlash(apiBase);
    }

    public TelegramStatusDto status(Jwt jwt) {
        ObjectNode connection = loadConnection(jwt);
        if (connection == null) {
            return TelegramStatusDto.disconnected();
        }
        return toStatus(connection);
    }

    public TelegramStatusDto connect(Jwt jwt, String rawToken) {
        String token = normalizeToken(rawToken);
        if (token == null) {
            return TelegramStatusDto.failure("invalid_token", "Token BotFather invalide");
        }
        JsonNode me = callGet(token, "getMe", Map.of());
        if (me == null) {
            return TelegramStatusDto.failure("telegram_unavailable", "Telegram est temporairement indisponible");
        }
        if (!me.path("ok").asBoolean(false)) {
            return TelegramStatusDto.failure("invalid_token", telegramError(me));
        }
        JsonNode result = me.path("result");
        if (!result.path("is_bot").asBoolean(false)) {
            return TelegramStatusDto.failure("invalid_token", "Le token ne correspond pas à un bot");
        }
        ObjectNode stored = objectMapper.createObjectNode();
        stored.put("botToken", token);
        stored.put("botId", result.path("id").asLong());
        stored.put("botUsername", textOrEmpty(result.path("username")));
        stored.put("botFirstName", textOrEmpty(result.path("first_name")));
        stored.put("canJoinGroups", result.path("can_join_groups").asBoolean(false));
        stored.put("canReadAllGroupMessages", result.path("can_read_all_group_messages").asBoolean(false));
        stored.put("connectedAt", System.currentTimeMillis() / 1000L);
        stored.put("webhookCleared", false);
        saveConnection(jwt, stored);
        clearWebhook(token);
        stored.put("webhookCleared", true);
        saveConnection(jwt, stored);
        return toStatus(stored);
    }

    public void disconnect(Jwt jwt) {
        String sub = jwtSubject(jwt);
        userOwnerService.deleteParams(CONNECTION_PREFIX, sub);
        userOwnerService.deleteParams(INBOX_PREFIX, sub);
    }

    public TelegramInboxDto inbox(Jwt jwt) {
        ObjectNode connection = loadConnection(jwt);
        if (connection == null) {
            return TelegramInboxDto.disconnected();
        }
        String token = textOrEmpty(connection.path("botToken"));
        String username = userOwnerService.username(jwt);
        if (!StringUtils.hasText(token) || !StringUtils.hasText(username)) {
            return TelegramInboxDto.disconnected();
        }
        Object lock = userLocks.computeIfAbsent(username, k -> new Object());
        synchronized (lock) {
            if (!connection.path("webhookCleared").asBoolean(false)) {
                clearWebhook(token);
                connection.put("webhookCleared", true);
                saveConnection(jwt, connection);
            }
            ObjectNode inbox = loadInbox(jwt);
            long offset = inbox.path("offset").asLong(0L);
            JsonNode updates = pollUpdates(token, offset);
            if (updates != null && !updates.path("ok").asBoolean(false) && updates.path("error_code").asInt(0) == 409) {
                clearWebhook(token);
                connection.put("webhookCleared", true);
                saveConnection(jwt, connection);
                updates = pollUpdates(token, offset);
            }
            if (updates == null) {
                return TelegramInboxDto.failure("telegram_unavailable", "Telegram est temporairement indisponible");
            }
            if (!updates.path("ok").asBoolean(false)) {
                int code = updates.path("error_code").asInt(0);
                if (code == 401) {
                    return TelegramInboxDto.failure("invalid_token", telegramError(updates));
                }
                return TelegramInboxDto.failure("telegram_error", telegramError(updates));
            }
            JsonNode result = updates.path("result");
            long botId = connection.path("botId").asLong(0L);
            if (result.isArray()) {
                long nextOffset = offset;
                for (JsonNode update : result) {
                    long updateId = update.path("update_id").asLong(0L);
                    if (updateId >= nextOffset) {
                        nextOffset = updateId + 1;
                    }
                    applyUpdate(inbox, update, botId);
                }
                inbox.put("offset", nextOffset);
                trimInbox(inbox);
                saveInbox(jwt, inbox);
            }
            return toInboxDto(inbox);
        }
    }

    public TelegramInboxDto send(Jwt jwt, String chatIdRaw, String textRaw) {
        String chatId = normalizeChatId(chatIdRaw);
        String text = textRaw == null ? "" : textRaw.trim();
        if (chatId == null) {
            return TelegramInboxDto.failure("invalid_chat", "Identifiant de discussion invalide");
        }
        if (!StringUtils.hasText(text) || text.length() > MAX_TEXT) {
            return TelegramInboxDto.failure("invalid_text", "Message vide ou trop long (max 4096)");
        }
        ObjectNode connection = loadConnection(jwt);
        if (connection == null) {
            return TelegramInboxDto.disconnected();
        }
        String token = textOrEmpty(connection.path("botToken"));
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("chat_id", chatId);
        body.put("text", text);
        JsonNode sent = callPost(token, "sendMessage", body);
        if (sent == null) {
            return TelegramInboxDto.failure("telegram_unavailable", "Telegram est temporairement indisponible");
        }
        if (!sent.path("ok").asBoolean(false)) {
            return TelegramInboxDto.failure("send_failed", telegramError(sent));
        }
        ObjectNode inbox = loadInbox(jwt);
        applyMessage(inbox, sent.path("result"), true, connection.path("botId").asLong(0L));
        trimInbox(inbox);
        saveInbox(jwt, inbox);
        return toInboxDto(inbox);
    }

    public ResponseEntity<byte[]> file(Jwt jwt, String fileIdRaw) {
        if (fileIdRaw == null || !FILE_ID.matcher(fileIdRaw.trim()).matches()) {
            return ResponseEntity.badRequest().build();
        }
        ObjectNode connection = loadConnection(jwt);
        if (connection == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        String token = textOrEmpty(connection.path("botToken"));
        JsonNode info = callGet(token, "getFile", Map.of("file_id", fileIdRaw.trim()));
        if (info == null || !info.path("ok").asBoolean(false)) {
            return ResponseEntity.status(HttpStatus.BAD_GATEWAY).build();
        }
        String filePath = textOrEmpty(info.path("result").path("file_path"));
        if (!StringUtils.hasText(filePath) || filePath.contains("..")) {
            return ResponseEntity.status(HttpStatus.BAD_GATEWAY).build();
        }
        URI download = URI.create(apiBase + "/file/bot" + token + "/" + filePath);
        if (!isAllowedTelegramHost(download)) {
            return ResponseEntity.status(HttpStatus.FORBIDDEN).build();
        }
        HttpURLConnection conn = null;
        try {
            URL u = download.toURL();
            conn = (HttpURLConnection) u.openConnection();
            conn.setConnectTimeout(5_000);
            conn.setReadTimeout(20_000);
            conn.setInstanceFollowRedirects(true);
            conn.setRequestProperty("User-Agent", USER_AGENT);
            int code = conn.getResponseCode();
            if (code < 200 || code >= 400) {
                return ResponseEntity.status(HttpStatus.BAD_GATEWAY).build();
            }
            String contentType = conn.getContentType();
            try (InputStream is = conn.getInputStream();
                 ByteArrayOutputStream bos = new ByteArrayOutputStream(8192)) {
                byte[] buf = new byte[8192];
                int read;
                int total = 0;
                while ((read = is.read(buf)) != -1) {
                    total += read;
                    if (total > MAX_FILE_BYTES) {
                        return ResponseEntity.status(HttpStatus.PAYLOAD_TOO_LARGE).build();
                    }
                    bos.write(buf, 0, read);
                }
                HttpHeaders headers = new HttpHeaders();
                MediaType mediaType = guessMediaType(contentType, filePath);
                headers.setContentType(mediaType);
                headers.setCacheControl(CacheControl.maxAge(Duration.ofMinutes(30)).cachePrivate());
                headers.setContentLength(bos.size());
                return new ResponseEntity<>(bos.toByteArray(), headers, HttpStatus.OK);
            }
        } catch (Exception e) {
            log.warn("Telegram file download failed: {}", e.getMessage());
            return ResponseEntity.status(HttpStatus.BAD_GATEWAY).build();
        } finally {
            if (conn != null) {
                conn.disconnect();
            }
        }
    }

    public TelegramEmbedDto embed(String rawUrl) {
        if (!StringUtils.hasText(rawUrl)) {
            return TelegramEmbedDto.invalid();
        }
        String url = rawUrl.trim();
        Matcher matcher = POST_URL.matcher(url);
        if (!matcher.matches()) {
            return TelegramEmbedDto.invalid();
        }
        String channel = matcher.group(1);
        long messageId = Long.parseLong(matcher.group(2));
        String postUrl = "https://t.me/" + channel + "/" + messageId;
        return new TelegramEmbedDto(true, null, channel, messageId, postUrl + "?embed=1", postUrl);
    }

    public static String redactStoredConnection(String rawJson) {
        if (!StringUtils.hasText(rawJson)) {
            return rawJson;
        }
        try {
            ObjectMapper mapper = new ObjectMapper();
            JsonNode node = mapper.readTree(rawJson);
            if (node instanceof ObjectNode objectNode) {
                String token = textOrEmptyStatic(objectNode.path("botToken"));
                objectNode.put("botToken", maskToken(token));
                return mapper.writeValueAsString(objectNode);
            }
        } catch (Exception ignored) {
            return "{\"redacted\":true}";
        }
        return "{\"redacted\":true}";
    }

    private TelegramStatusDto toStatus(ObjectNode connection) {
        return new TelegramStatusDto(
                true,
                null,
                null,
                connection.path("botId").isNumber() ? connection.path("botId").asLong() : null,
                textOrNull(connection.path("botUsername")),
                textOrNull(connection.path("botFirstName")),
                connection.path("canJoinGroups").isBoolean() ? connection.path("canJoinGroups").asBoolean() : null,
                connection.path("canReadAllGroupMessages").isBoolean()
                        ? connection.path("canReadAllGroupMessages").asBoolean() : null,
                maskToken(textOrEmpty(connection.path("botToken"))),
                connection.path("connectedAt").isNumber() ? connection.path("connectedAt").asLong() : null
        );
    }

    private TelegramInboxDto toInboxDto(ObjectNode inbox) {
        List<TelegramChatDto> chats = new ArrayList<>();
        JsonNode chatsNode = inbox.path("chats");
        if (chatsNode.isArray()) {
            for (JsonNode chatNode : chatsNode) {
                TelegramChatDto chat = objectMapper.convertValue(chatNode, TelegramChatDto.class);
                if (chat != null && StringUtils.hasText(chat.getId())) {
                    chats.add(chat);
                }
            }
        }
        chats.sort(Comparator.comparingLong(TelegramService::lastMessageDate).reversed());
        return new TelegramInboxDto(true, null, null, chats);
    }

    private static long lastMessageDate(TelegramChatDto chat) {
        List<TelegramMessageDto> messages = chat.getMessages();
        if (messages == null || messages.isEmpty()) {
            return 0L;
        }
        TelegramMessageDto last = messages.get(messages.size() - 1);
        return last.getDate() != null ? last.getDate() : 0L;
    }

    private JsonNode pollUpdates(String token, long offset) {
        return callGet(token, "getUpdates", Map.of(
                "offset", String.valueOf(offset),
                "timeout", "0",
                "limit", "100",
                "allowed_updates", "[\"message\",\"edited_message\",\"channel_post\",\"edited_channel_post\"]"
        ));
    }

    private void applyUpdate(ObjectNode inbox, JsonNode update, long botId) {
        if (update.has("message")) {
            applyMessage(inbox, update.path("message"), false, botId);
        }
        if (update.has("edited_message")) {
            applyMessage(inbox, update.path("edited_message"), false, botId);
        }
        if (update.has("channel_post")) {
            applyMessage(inbox, update.path("channel_post"), false, botId);
        }
        if (update.has("edited_channel_post")) {
            applyMessage(inbox, update.path("edited_channel_post"), false, botId);
        }
    }

    private void applyMessage(ObjectNode inbox, JsonNode message, boolean outgoing, long botId) {
        JsonNode chatNode = message.path("chat");
        String chatId = chatNode.path("id").asText(null);
        if (!StringUtils.hasText(chatId)) {
            return;
        }
        ArrayNode chats = inbox.withArray("chats");
        ObjectNode chat = findChat(chats, chatId);
        if (chat == null) {
            chat = chats.addObject();
            chat.put("id", chatId);
        }
        chat.put("type", textOrEmpty(chatNode.path("type")));
        putIfText(chat, "title", chatNode.path("title"));
        putIfText(chat, "username", chatNode.path("username"));
        putIfText(chat, "firstName", chatNode.path("first_name"));
        putIfText(chat, "lastName", chatNode.path("last_name"));
        ArrayNode messages = chat.withArray("messages");
        long messageId = message.path("message_id").asLong(0L);
        ObjectNode existing = findMessage(messages, messageId);
        ObjectNode stored = existing != null ? existing : messages.addObject();
        stored.put("id", messageId);
        stored.put("date", message.path("date").asLong(0L));
        stored.put("text", textOrEmpty(message.path("text")));
        stored.put("caption", textOrEmpty(message.path("caption")));
        stored.put("fromName", displayName(message.path("from"), chat));
        long fromId = message.path("from").path("id").asLong(0L);
        stored.put("outgoing", outgoing || (botId > 0 && fromId == botId));
        applyMedia(stored, message);
    }

    private void applyMedia(ObjectNode stored, JsonNode message) {
        stored.put("mediaKind", "none");
        stored.put("fileId", "");
        stored.put("fileName", "");
        stored.put("mimeType", "");
        if (message.has("photo") && message.path("photo").isArray() && message.path("photo").size() > 0) {
            JsonNode largest = message.path("photo").get(message.path("photo").size() - 1);
            stored.put("mediaKind", "photo");
            stored.put("fileId", textOrEmpty(largest.path("file_id")));
            stored.put("mimeType", "image/jpeg");
            return;
        }
        if (putFile(stored, message, "video", "video")) {
            return;
        }
        if (putFile(stored, message, "animation", "animation")) {
            return;
        }
        if (putFile(stored, message, "document", "document")) {
            return;
        }
        if (putFile(stored, message, "audio", "audio")) {
            return;
        }
        if (putFile(stored, message, "voice", "voice")) {
            return;
        }
        if (message.has("sticker")) {
            JsonNode sticker = message.path("sticker");
            stored.put("mediaKind", "sticker");
            String fileId = textOrEmpty(sticker.path("thumbnail").path("file_id"));
            if (!StringUtils.hasText(fileId)) {
                fileId = textOrEmpty(sticker.path("file_id"));
            }
            stored.put("fileId", fileId);
            stored.put("mimeType", "image/webp");
        }
    }

    private boolean putFile(ObjectNode stored, JsonNode message, String field, String kind) {
        if (!message.has(field)) {
            return false;
        }
        JsonNode node = message.path(field);
        stored.put("mediaKind", kind);
        stored.put("fileId", textOrEmpty(node.path("file_id")));
        stored.put("fileName", textOrEmpty(node.path("file_name")));
        stored.put("mimeType", textOrEmpty(node.path("mime_type")));
        return true;
    }

    private ObjectNode findChat(ArrayNode chats, String chatId) {
        for (JsonNode node : chats) {
            if (node.isObject() && chatId.equals(node.path("id").asText())) {
                return (ObjectNode) node;
            }
        }
        return null;
    }

    private ObjectNode findMessage(ArrayNode messages, long messageId) {
        for (JsonNode node : messages) {
            if (node.isObject() && node.path("id").asLong(0L) == messageId) {
                return (ObjectNode) node;
            }
        }
        return null;
    }

    private void trimInbox(ObjectNode inbox) {
        ArrayNode chats = inbox.withArray("chats");
        for (JsonNode chatNode : chats) {
            if (!chatNode.isObject()) {
                continue;
            }
            ArrayNode messages = ((ObjectNode) chatNode).withArray("messages");
            while (messages.size() > MAX_MESSAGES) {
                messages.remove(0);
            }
        }
        if (chats.size() <= MAX_CHATS) {
            return;
        }
        List<ObjectNode> sorted = new ArrayList<>();
        for (JsonNode chatNode : chats) {
            if (chatNode.isObject()) {
                sorted.add((ObjectNode) chatNode);
            }
        }
        sorted.sort(Comparator.comparingLong(this::chatLastDate).reversed());
        chats.removeAll();
        for (int i = 0; i < Math.min(MAX_CHATS, sorted.size()); i++) {
            chats.add(sorted.get(i));
        }
    }

    private long chatLastDate(ObjectNode chat) {
        ArrayNode messages = chat.withArray("messages");
        if (messages.isEmpty()) {
            return 0L;
        }
        return messages.get(messages.size() - 1).path("date").asLong(0L);
    }

    private ObjectNode loadConnection(Jwt jwt) {
        Optional<AppParameter> row = userOwnerService.findParam(CONNECTION_PREFIX, jwtSubject(jwt));
        return parseObject(row.map(AppParameter::getParamValue).orElse(null));
    }

    private ObjectNode loadInbox(Jwt jwt) {
        Optional<AppParameter> row = userOwnerService.findParam(INBOX_PREFIX, jwtSubject(jwt));
        ObjectNode inbox = parseObject(row.map(AppParameter::getParamValue).orElse(null));
        if (inbox == null) {
            inbox = objectMapper.createObjectNode();
            inbox.put("offset", 0L);
            inbox.putArray("chats");
        }
        if (!inbox.has("chats") || !inbox.path("chats").isArray()) {
            inbox.putArray("chats");
        }
        return inbox;
    }

    private void saveConnection(Jwt jwt, ObjectNode connection) {
        String key = userOwnerService.writeKey(CONNECTION_PREFIX, jwtSubject(jwt));
        try {
            appParameterService.setJson(
                    key,
                    objectMapper.writeValueAsString(connection),
                    "Telegram Bot API connection for this PatTool user (personal BotFather token).");
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("Serialization telegram connection", e);
        }
        userOwnerService.dropAliasKeys(CONNECTION_PREFIX, jwtSubject(jwt));
    }

    private void saveInbox(Jwt jwt, ObjectNode inbox) {
        String key = userOwnerService.writeKey(INBOX_PREFIX, jwtSubject(jwt));
        try {
            appParameterService.setJson(
                    key,
                    objectMapper.writeValueAsString(inbox),
                    "Telegram inbox (getUpdates) for this PatTool user.");
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("Serialization telegram inbox", e);
        }
        userOwnerService.dropAliasKeys(INBOX_PREFIX, jwtSubject(jwt));
    }

    private ObjectNode parseObject(String raw) {
        if (!StringUtils.hasText(raw)) {
            return null;
        }
        try {
            JsonNode node = objectMapper.readTree(raw);
            if (node instanceof ObjectNode objectNode) {
                return objectNode;
            }
        } catch (Exception e) {
            log.debug("telegram JSON unreadable: {}", e.getMessage());
        }
        return null;
    }

    private void clearWebhook(String token) {
        callPost(token, "deleteWebhook", Map.of("drop_pending_updates", Boolean.FALSE));
    }

    private JsonNode callGet(String token, String method, Map<String, String> query) {
        UriComponentsBuilder builder = UriComponentsBuilder.fromHttpUrl(botUrl(token, method));
        for (Map.Entry<String, String> entry : query.entrySet()) {
            builder.queryParam(entry.getKey(), entry.getValue());
        }
        return exchange(builder.build().encode().toUri(), HttpMethod.GET, null, method);
    }

    private JsonNode callPost(String token, String method, Map<String, Object> body) {
        URI uri = URI.create(botUrl(token, method));
        try {
            String json = objectMapper.writeValueAsString(body);
            HttpHeaders headers = new HttpHeaders();
            headers.setContentType(MediaType.APPLICATION_JSON);
            headers.set(HttpHeaders.USER_AGENT, USER_AGENT);
            headers.set(HttpHeaders.ACCEPT, "application/json");
            return exchange(uri, HttpMethod.POST, new HttpEntity<>(json, headers), method);
        } catch (JsonProcessingException e) {
            return null;
        }
    }

    private JsonNode exchange(URI uri, HttpMethod method, HttpEntity<?> entity, String label) {
        try {
            HttpEntity<?> request = entity;
            if (request == null) {
                HttpHeaders headers = new HttpHeaders();
                headers.set(HttpHeaders.USER_AGENT, USER_AGENT);
                headers.set(HttpHeaders.ACCEPT, "application/json");
                request = new HttpEntity<>(headers);
            }
            ResponseEntity<String> response = restTemplate.exchange(uri, method, request, String.class);
            String body = response.getBody();
            if (!StringUtils.hasText(body)) {
                return null;
            }
            return objectMapper.readTree(body);
        } catch (HttpStatusCodeException e) {
            String body = e.getResponseBodyAsString();
            if (StringUtils.hasText(body)) {
                try {
                    return objectMapper.readTree(body);
                } catch (Exception ignored) {
                    return null;
                }
            }
            log.warn("Telegram HTTP {} for {}: {}", e.getStatusCode().value(), label, e.getStatusCode());
            return null;
        } catch (RestClientException e) {
            log.warn("Telegram unavailable for {}: {}", label, e.getMessage());
            return null;
        } catch (Exception e) {
            log.warn("Telegram parse failed for {}: {}", label, e.getMessage());
            return null;
        }
    }

    private String botUrl(String token, String method) {
        return apiBase + "/bot" + token + "/" + method;
    }

    private boolean isAllowedTelegramHost(URI uri) {
        try {
            URI base = URI.create(apiBase + "/");
            String expected = base.getHost();
            String host = uri.getHost();
            return expected != null && host != null && expected.equalsIgnoreCase(host);
        } catch (Exception e) {
            return false;
        }
    }

    private static String jwtSubject(Jwt jwt) {
        return jwt != null ? jwt.getSubject() : null;
    }

    private static String normalizeToken(String raw) {
        if (!StringUtils.hasText(raw)) {
            return null;
        }
        String token = raw.trim();
        if (token.regionMatches(true, 0, "bot", 0, 3)) {
            token = token.substring(3);
        }
        if (token.startsWith("/")) {
            token = token.substring(1);
        }
        return BOT_TOKEN.matcher(token).matches() ? token : null;
    }

    private static String normalizeChatId(String raw) {
        if (!StringUtils.hasText(raw)) {
            return null;
        }
        String value = raw.trim();
        return CHAT_ID.matcher(value).matches() ? value : null;
    }

    private static String maskToken(String token) {
        if (!StringUtils.hasText(token) || token.length() < 10) {
            return "••••";
        }
        int colon = token.indexOf(':');
        String prefix = colon > 0 ? token.substring(0, colon + 1) : token.substring(0, 6);
        return prefix + "…" + token.substring(token.length() - 4);
    }

    private static String telegramError(JsonNode node) {
        String description = textOrEmpty(node.path("description"));
        return StringUtils.hasText(description) ? description : "Erreur Telegram";
    }

    private static String displayName(JsonNode from, ObjectNode chat) {
        String first = textOrEmpty(from.path("first_name"));
        String last = textOrEmpty(from.path("last_name"));
        String username = textOrEmpty(from.path("username"));
        String combined = (first + " " + last).trim();
        if (StringUtils.hasText(combined)) {
            return combined;
        }
        if (StringUtils.hasText(username)) {
            return username;
        }
        String title = textOrEmpty(chat.path("title"));
        if (StringUtils.hasText(title)) {
            return title;
        }
        return (textOrEmpty(chat.path("firstName")) + " " + textOrEmpty(chat.path("lastName"))).trim();
    }

    private static void putIfText(ObjectNode node, String field, JsonNode value) {
        String text = textOrEmpty(value);
        if (StringUtils.hasText(text)) {
            node.put(field, text);
        }
    }

    private static String textOrEmpty(JsonNode node) {
        return textOrEmptyStatic(node);
    }

    private static String textOrEmptyStatic(JsonNode node) {
        if (node == null || node.isMissingNode() || node.isNull()) {
            return "";
        }
        String value = node.asText("");
        return value != null ? value.trim() : "";
    }

    private static String textOrNull(JsonNode node) {
        String value = textOrEmpty(node);
        return StringUtils.hasText(value) ? value : null;
    }

    private static MediaType guessMediaType(String contentType, String filePath) {
        if (StringUtils.hasText(contentType)) {
            try {
                return MediaType.parseMediaType(contentType.split(";")[0].trim());
            } catch (Exception ignored) {
                // fall through
            }
        }
        String path = filePath == null ? "" : filePath.toLowerCase(Locale.ROOT);
        if (path.endsWith(".png")) {
            return MediaType.IMAGE_PNG;
        }
        if (path.endsWith(".gif")) {
            return MediaType.IMAGE_GIF;
        }
        if (path.endsWith(".webp")) {
            return MediaType.parseMediaType("image/webp");
        }
        if (path.endsWith(".mp4")) {
            return MediaType.parseMediaType("video/mp4");
        }
        if (path.endsWith(".mp3")) {
            return MediaType.parseMediaType("audio/mpeg");
        }
        if (path.endsWith(".ogg") || path.endsWith(".oga")) {
            return MediaType.parseMediaType("audio/ogg");
        }
        if (path.endsWith(".pdf")) {
            return MediaType.APPLICATION_PDF;
        }
        return MediaType.IMAGE_JPEG;
    }

    private static String trimSlash(String value) {
        if (!StringUtils.hasText(value)) {
            return "https://api.telegram.org";
        }
        String trimmed = value.trim();
        while (trimmed.endsWith("/")) {
            trimmed = trimmed.substring(0, trimmed.length() - 1);
        }
        return trimmed;
    }
}
