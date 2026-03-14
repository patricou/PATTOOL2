package com.pat.config;

import jakarta.servlet.Filter;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;

import java.io.IOException;

/**
 * Logs when a POST /uploadfile request reaches the server (runs before Security).
 * If you see this log but the controller breakpoint never hits, the request is
 * being rejected by Spring Security (e.g. invalid/expired JWT) or fails during multipart parsing.
 */
@Component
@Order(Ordered.HIGHEST_PRECEDENCE + 1)
public class UploadRequestLogFilter implements Filter {

    private static final Logger log = LoggerFactory.getLogger(UploadRequestLogFilter.class);

    @Override
    public void doFilter(jakarta.servlet.ServletRequest request, jakarta.servlet.ServletResponse response, FilterChain chain)
            throws IOException, ServletException {
        if (!(request instanceof HttpServletRequest) || !(response instanceof HttpServletResponse)) {
            chain.doFilter(request, response);
            return;
        }
        HttpServletRequest req = (HttpServletRequest) request;
        String path = req.getRequestURI();
        if (path != null && path.startsWith("/uploadfile") && "POST".equalsIgnoreCase(req.getMethod())) {
            String auth = req.getHeader("Authorization");
            log.debug("[UPLOAD REQUEST RECEIVED] POST {} Authorization present={}",
                    path, auth != null && !auth.isEmpty());
        }
        chain.doFilter(request, response);
    }
}
