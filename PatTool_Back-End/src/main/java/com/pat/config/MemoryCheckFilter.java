package com.pat.config;

import com.pat.service.MemoryMonitoringService;
import jakarta.servlet.Filter;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.core.annotation.Order;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Component;

import java.io.IOException;

/**
 * Filter to check memory usage before processing requests
 * Rejects requests if memory usage is critical to prevent OutOfMemoryError
 */
@Component
@Order(1) // High priority - check memory early in the filter chain
public class MemoryCheckFilter implements Filter {

    private static final Logger log = LoggerFactory.getLogger(MemoryCheckFilter.class);
    
    @Autowired
    private MemoryMonitoringService memoryMonitoringService;
    
    // Paths that should be excluded from memory checks (health checks, static resources)
    private static final String[] EXCLUDED_PATHS = {
        "/actuator/health",
        "/actuator/info",
        "/favicon.ico",
        "/assets/",
        "/.well-known/"
    };
    
    @Override
    public void doFilter(jakarta.servlet.ServletRequest request, 
                        jakarta.servlet.ServletResponse response, 
                        FilterChain chain) 
            throws IOException, ServletException {
        
        HttpServletRequest httpRequest = (HttpServletRequest) request;
        HttpServletResponse httpResponse = (HttpServletResponse) response;
        
        String requestPath = httpRequest.getRequestURI();
        
        // Skip memory check for excluded paths
        boolean shouldSkip = false;
        for (String excludedPath : EXCLUDED_PATHS) {
            if (requestPath.startsWith(excludedPath)) {
                shouldSkip = true;
                break;
            }
        }
        
        if (!shouldSkip) {
            // Check memory usage before processing request
            boolean memoryOk = memoryMonitoringService.checkMemoryUsage();
            
            if (!memoryOk) {
                // Memory usage is critical - reject request
                double usagePercent = memoryMonitoringService.getMemoryUsagePercent();
                String memoryInfo = memoryMonitoringService.getMemoryInfo();
                
                log.warn("Rejecting request {} {} due to critical memory usage: {}", 
                        httpRequest.getMethod(), requestPath, memoryInfo);
                
                httpResponse.setStatus(HttpStatus.SERVICE_UNAVAILABLE.value());
                httpResponse.setContentType("application/json");
                httpResponse.setCharacterEncoding("UTF-8");
                
                String errorMessage = String.format(
                    "{\"error\":\"Service temporarily unavailable\",\"message\":\"Server memory usage is critical (%.1f%%). Please try again later.\",\"status\":503}",
                    usagePercent
                );
                
                httpResponse.getWriter().write(errorMessage);
                httpResponse.getWriter().flush();
                return; // Stop processing - don't call chain.doFilter()
            }
        }
        
        // Memory is OK or path is excluded - continue processing
        chain.doFilter(request, response);
    }
}

