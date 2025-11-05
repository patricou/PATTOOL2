package com.pat.config;

import com.pat.converter.StringToMemberConverter;
import org.springframework.context.annotation.Configuration;
import org.springframework.format.FormatterRegistry;
import org.springframework.web.servlet.config.annotation.ResourceHandlerRegistry;
import org.springframework.web.servlet.config.annotation.ViewControllerRegistry;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

/**
 * Web configuration to register custom converters
 */
@Configuration
public class WebConfig implements WebMvcConfigurer {

    @Override
    public void addFormatters(FormatterRegistry registry) {
        registry.addConverter(new StringToMemberConverter());
    }

    @Override
    public void addResourceHandlers(ResourceHandlerRegistry registry) {
        // Register static resource handlers for Angular app
        // Note: We use specific patterns to avoid interfering with API endpoints
        // API endpoints (/api/**) are handled by controllers and should not be intercepted here
        registry.addResourceHandler("/assets/**", "/*.js", "/*.js.map", "/*.css", "/*.css.map", 
                                    "/favicon.ico", "/robots.txt", "/i18n/**", "/.well-known/**")
                .addResourceLocations("classpath:/static/assets/", "classpath:/static/")
                .resourceChain(false);
        
        // Note: We don't add a catch-all /** handler here because:
        // 1. It would interfere with API endpoints (/api/**)
        // 2. Angular routing is handled by addViewControllers below
        // 3. Controllers have higher priority than resource handlers by default
    }

    @Override
    public void addViewControllers(ViewControllerRegistry registry) {
        // Forward all non-API routes to Angular's index.html
        registry.addViewController("/{path:[^\\.]*}")
                .setViewName("forward:/index.html");
    }
}