package com.pat.controller;

import com.pat.controller.dto.TelegramConnectRequest;
import com.pat.controller.dto.TelegramEmbedDto;
import com.pat.controller.dto.TelegramInboxDto;
import com.pat.controller.dto.TelegramSendRequest;
import com.pat.controller.dto.TelegramStatusDto;
import com.pat.service.TelegramService;
import com.pat.service.UserOwnerService;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * Per-user Telegram Bot API (official {@code api.telegram.org}).
 * The token is the signed-in PatTool user's own BotFather token — never a shared key.
 * <p>
 * {@code GET/PUT/DELETE /api/external/telegram/connection}<br>
 * {@code GET /api/external/telegram/inbox}<br>
 * {@code POST /api/external/telegram/send}<br>
 * {@code GET /api/external/telegram/file?fileId=}<br>
 * {@code GET /api/external/telegram/embed?url=}
 */
@RestController
@RequestMapping("/api/external/telegram")
public class TelegramRestController {

    private final TelegramService telegramService;

    public TelegramRestController(TelegramService telegramService) {
        this.telegramService = telegramService;
    }

    @GetMapping(value = "/connection", produces = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<TelegramStatusDto> status() {
        Jwt jwt = UserOwnerService.currentJwt();
        if (jwt == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        return ResponseEntity.ok(telegramService.status(jwt));
    }

    @PutMapping(value = "/connection", produces = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<TelegramStatusDto> connect(@RequestBody(required = false) TelegramConnectRequest body) {
        Jwt jwt = UserOwnerService.currentJwt();
        if (jwt == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        String token = body != null ? body.getBotToken() : null;
        TelegramStatusDto status = telegramService.connect(jwt, token);
        if (!status.connected()) {
            return ResponseEntity.badRequest().body(status);
        }
        return ResponseEntity.ok(status);
    }

    @DeleteMapping("/connection")
    public ResponseEntity<Void> disconnect() {
        Jwt jwt = UserOwnerService.currentJwt();
        if (jwt == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        telegramService.disconnect(jwt);
        return ResponseEntity.noContent().build();
    }

    @GetMapping(value = "/inbox", produces = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<TelegramInboxDto> inbox() {
        Jwt jwt = UserOwnerService.currentJwt();
        if (jwt == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        return ResponseEntity.ok(telegramService.inbox(jwt));
    }

    @PostMapping(value = "/send", produces = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<TelegramInboxDto> send(@RequestBody(required = false) TelegramSendRequest body) {
        Jwt jwt = UserOwnerService.currentJwt();
        if (jwt == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        String chatId = body != null ? body.getChatId() : null;
        String text = body != null ? body.getText() : null;
        TelegramInboxDto result = telegramService.send(jwt, chatId, text);
        if (result.getError() != null) {
            return ResponseEntity.badRequest().body(result);
        }
        return ResponseEntity.ok(result);
    }

    @GetMapping("/file")
    public ResponseEntity<byte[]> file(@RequestParam("fileId") String fileId) {
        Jwt jwt = UserOwnerService.currentJwt();
        if (jwt == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        return telegramService.file(jwt, fileId);
    }

    @GetMapping(value = "/embed", produces = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<TelegramEmbedDto> embed(@RequestParam("url") String url) {
        Jwt jwt = UserOwnerService.currentJwt();
        if (jwt == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        TelegramEmbedDto dto = telegramService.embed(url);
        if (!dto.ok()) {
            return ResponseEntity.badRequest().body(dto);
        }
        return ResponseEntity.ok(dto);
    }
}
