package com.pat.config;

import com.pat.util.FriendlyErrorHtml;
import jakarta.servlet.RequestDispatcher;
import jakarta.servlet.http.HttpServletRequest;
import java.util.Map;
import org.springframework.boot.web.error.ErrorAttributeOptions;
import org.springframework.boot.web.servlet.error.ErrorAttributes;
import org.springframework.boot.web.servlet.error.ErrorController;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.context.request.ServletWebRequest;

/**
 * Replaces Spring Boot {@link org.springframework.boot.autoconfigure.web.servlet.error.BasicErrorController} to serve
 * PatTool HTML directly (avoids Whitelabel and Tomcat’s bare “HTTP Status 500” when MVC error view resolution fails).
 */
@RestController
@RequestMapping("${server.error.path:${error.path:/error}}")
public class PatToolErrorController implements ErrorController {

    private static final Logger log = LoggerFactory.getLogger(PatToolErrorController.class);

    private final ErrorAttributes errorAttributes;

    public PatToolErrorController(ErrorAttributes errorAttributes) {
        this.errorAttributes = errorAttributes;
    }

    @RequestMapping(produces = MediaType.TEXT_HTML_VALUE)
    public ResponseEntity<String> errorHtml(HttpServletRequest request) {
        try {
            HttpStatus status = getStatus(request);
            String[] td = titleAndDetail(status.value());
            String html = FriendlyErrorHtml.page(true, "en", "Error", td[0], td[1], "Error · ");
            return ResponseEntity.status(status).contentType(MediaType.TEXT_HTML).body(html);
        } catch (Exception e) {
            log.warn("Could not build styled error page, using fallback: {}", e.getMessage());
            String fallback = "<!DOCTYPE html><html lang=\"en\"><head><meta charset=\"UTF-8\"/><title>Error · PatTool</title></head>"
                    + "<body style=\"font-family:system-ui,sans-serif;padding:2rem;background:#0b1220;color:#e2e8f0\">"
                    + "<p>PatTool — something went wrong. Please try again later.</p></body></html>";
            return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR)
                    .contentType(MediaType.TEXT_HTML)
                    .body(fallback);
        }
    }

    @RequestMapping
    public ResponseEntity<Map<String, Object>> error(HttpServletRequest request) {
        HttpStatus status = getStatus(request);
        if (status == HttpStatus.NO_CONTENT) {
            return ResponseEntity.status(status).build();
        }
        Map<String, Object> body = errorAttributes.getErrorAttributes(new ServletWebRequest(request),
                ErrorAttributeOptions.defaults());
        return ResponseEntity.status(status).body(body);
    }

    private static HttpStatus getStatus(HttpServletRequest request) {
        Integer code = (Integer) request.getAttribute(RequestDispatcher.ERROR_STATUS_CODE);
        if (code == null) {
            return HttpStatus.INTERNAL_SERVER_ERROR;
        }
        try {
            return HttpStatus.valueOf(code);
        } catch (Exception ex) {
            return HttpStatus.INTERNAL_SERVER_ERROR;
        }
    }

    static String[] titleAndDetail(int code) {
        return switch (code) {
            case 400 -> new String[]{
                    "Bad request",
                    "The request sent to the server is invalid or malformed."};
            case 401 -> new String[]{
                    "Unauthorized",
                    "You must sign in to access this resource."};
            case 403 -> new String[]{
                    "Forbidden",
                    "You are not allowed to access this page or API."};
            case 404 -> new String[]{
                    "Not found",
                    "The resource does not exist, was removed, or the URL is wrong."};
            case 405 -> new String[]{
                    "Method not allowed",
                    "This operation is not supported for this resource."};
            case 408 -> new String[]{
                    "Request timeout",
                    "The server took too long to receive the request."};
            case 413 -> new String[]{
                    "Payload too large",
                    "The data sent exceeds the maximum size allowed."};
            case 429 -> new String[]{
                    "Too many requests",
                    "Please wait before trying again."};
            case 500 -> new String[]{
                    "Server error",
                    "An unexpected error occurred. Please try again in a few moments."};
            case 502 -> new String[]{
                    "Bad gateway",
                    "The server did not receive a valid response from an upstream service."};
            case 503 -> new String[]{
                    "Service unavailable",
                    "The service is temporarily unavailable. Please try again later."};
            case 504 -> new String[]{
                    "Gateway timeout",
                    "The server did not receive a timely response from an upstream service."};
            default -> new String[]{
                    "Error " + code,
                    "Something went wrong. Please try again later."};
        };
    }
}
