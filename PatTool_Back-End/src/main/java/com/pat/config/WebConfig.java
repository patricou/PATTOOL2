package com.pat.config;

import org.springframework.context.annotation.Configuration;
import org.springframework.web.servlet.config.annotation.CorsRegistry;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

/**
 * Created by patricou on 5/1/2017.
 */
@Configuration
public class WebConfig implements WebMvcConfigurer {

    @Override
    public void addCorsMappings(CorsRegistry registry) {
       registry.addMapping("/api/even")
                .allowedOrigins("http://localhost:4200")
                .allowedMethods("GET","PUT","POST","DELETE","OPTIONS")
       ;//        .allowedHeaders("Content-Type, X-Requested-With, Author, accept, Origin, Access-Control-Request-Method, Access-Control-Request-Headers,Authorization,Access-Control-Allow-Origin");
        registry.addMapping("/api/even/**")
                .allowedOrigins("http://localhost:4200")
                .allowedMethods("GET","PUT","POST","DELETE","OPTIONS")
        ;//       .allowedHeaders("Content-Type, X-Requested-With, Author, accept, Origin, Access-Control-Request-Method, Access-Control-Request-Headers,Authorization,Access-Control-Allow-Origin");
        registry.addMapping("/api/memb")
                .allowedOrigins("http://localhost:4200")
                .allowedMethods("GET","PUT","POST","DELETE","OPTIONS")
        ;//       .allowedHeaders("Content-Type, X-Requested-With, Author, accept, Origin, Access-Control-Request-Method, Access-Control-Request-Headers,Authorization,Access-Control-Allow-Origin");
        registry.addMapping("/api/memb/*")
                .allowedOrigins("http://localhost:4200")
                .allowedMethods("GET","PUT","POST","DELETE","OPTIONS")
        ;//        .allowedHeaders("Content-Type, X-Requested-With, Author, accept, Origin, Access-Control-Request-Method, Access-Control-Request-Headers,Authorization,Access-Control-Allow-Origin");
        registry.addMapping("/api/memb/user")
                .allowedOrigins("http://localhost:4200")
                .allowedMethods("GET","PUT","POST","DELETE","OPTIONS")
        ;//        .allowedHeaders("Content-Type", "X-Requested-With", "Author", "accept", "Origin", "Access-Control-Request-Method", "Access-Control-Request-Headers,Authorization","Access-Control-Allow-Origin");
        registry.addMapping("/api/memb/**")
                .allowedOrigins("http://localhost:4200")
                .allowedMethods("GET","PUT","POST","DELETE","OPTIONS")
        ;//       .allowedHeaders("Content-Type, X-Requested-With, Author, accept, Origin, Access-Control-Request-Method, Access-Control-Request-Headers,Authorization,Access-Control-Allow-Origin");
        registry.addMapping("/api/file/**")
                .allowedMethods("GET","PUT","POST","DELETE","OPTIONS")
                .allowedOrigins("http://localhost:4200");
        registry.addMapping("/api/file/*")
                .allowedMethods("GET","PUT","POST","DELETE","OPTIONS")
                .allowedOrigins("http://localhost:4200");
        registry.addMapping("/uploadfile/**")
                .allowedMethods("GET","PUT","POST","DELETE","OPTIONS")
                .allowedOrigins("http://localhost:4200");
        registry.addMapping("/uploadondisk")
                .allowedMethods("GET","PUT","POST","DELETE","OPTIONS")
                .allowedOrigins("http://localhost:4200")
                .allowedHeaders("*");
        registry.addMapping("/uploadondisk/")
                .allowedMethods("GET","PUT","POST","DELETE","OPTIONS")
                .allowedOrigins("http://localhost:4200")
                .allowedHeaders("*");
        registry.addMapping("/api/urllink/**")
                .allowedMethods("GET","PUT","POST","DELETE","OPTIONS")
                .allowedOrigins("http://localhost:4200");
        registry.addMapping("/api/visibility/")
                .allowedMethods("GET","PUT","POST","DELETE","OPTIONS")
                .allowedOrigins("http://localhost:4200");
        registry.addMapping("/api/categories/")
                .allowedMethods("GET","PUT","POST","DELETE","OPTIONS")
                .allowedOrigins("http://localhost:4200");
        registry.addMapping("/api/v1/chat/")
                .allowedMethods("GET","PUT","POST","DELETE","OPTIONS")
                .allowedOrigins("http://localhost:4200");
        registry.addMapping("/api/chat/**")
                .allowedMethods("GET","PUT","POST","DELETE","OPTIONS")
                .allowedOrigins("http://localhost:4200");
        registry.addMapping("/api/delchat/")
                .allowedMethods("GET","PUT","POST","DELETE","OPTIONS")
                .allowedOrigins("http://localhost:4200");
        registry.addMapping("/api/opcl/**")
                .allowedMethods("GET","PUT","POST","DELETE","OPTIONS")
                .allowedOrigins("http://localhost:4200");
     registry.addMapping("/api/testarduino/")
             .allowedMethods("GET","PUT","POST","DELETE","OPTIONS")
             .allowedOrigins("http://localhost:4200");

    }
}
