package com.pat;

import com.pat.service.CachePersistenceService;
import com.pat.service.SmtpMailSender;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;
import org.springframework.core.env.Environment;
import org.springframework.data.mongodb.repository.config.EnableMongoRepositories;
import org.springframework.data.jpa.repository.config.EnableJpaRepositories;
import org.springframework.scheduling.annotation.EnableAsync;
import org.springframework.scheduling.annotation.EnableScheduling;
import org.springframework.context.annotation.ComponentScan;
import org.springframework.context.annotation.FilterType;

import java.net.InetAddress;
import java.net.URI;
import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;

@SpringBootApplication(scanBasePackages = {"com.pat"})
@EnableAsync
@EnableScheduling
@EnableMongoRepositories(basePackages = "com.pat.repo")
// Tous les repos sous com.pat.repo sont Mongo : les exclure de JPA par type
// (pas par liste de .class, sinon un .class manquant après un compile raté
// déclenche TypeNotPresentException au démarrage).
@EnableJpaRepositories(
    basePackages = "com.pat.repo",
    excludeFilters = @ComponentScan.Filter(
        type = FilterType.ASSIGNABLE_TYPE,
        classes = org.springframework.data.mongodb.repository.MongoRepository.class
    )
)
public class PatToolApplication {

    private static final Logger log = LoggerFactory.getLogger(PatToolApplication.class);

    public static void main(String[] args) {
        // Dailymotion CDN (CNews / CStar / L'Équipe / …) 403s Java TLS session tickets.
        System.setProperty("jdk.tls.client.enableSessionTicketExtension", "false");
        SpringApplication.run(PatToolApplication.class, args);
    }

    @Autowired(required = false)
    private SmtpMailSender smtpMailSender;
    
    @Autowired(required = false)
    private CachePersistenceService cachePersistenceService;
    
    @Value("${app.cache.persistence.restore-on-startup:true}")
    private Boolean restoreCacheOnStartup;
    
    @Value("${app.mailsentfrom:}")
    private String mailSentFrom;
    
    @Value("${app.mailsentto:}")
    private String mailSentTo;
    
    @Value("${app.sendmail:false}")
    private Boolean sendmail;

    @EventListener(ApplicationReadyEvent.class)
    public void onApplicationReady(ApplicationReadyEvent event) {
        // Load cache from file system on startup (if enabled)
        if (restoreCacheOnStartup != null && restoreCacheOnStartup && cachePersistenceService != null) {
            log.info("Application is ready. Checking cache file existence...");
            try {
                // Check if cache file exists before attempting to load
                if (cachePersistenceService.cacheFileExists()) {
                    log.info("Cache file found. Loading cache from file system...");
                    CachePersistenceService.CacheLoadResult loadResult = cachePersistenceService.loadCache();
                    if (loadResult.isSuccess()) {
                        log.info("Cache loaded successfully on startup: {} entries, {} bytes", 
                                loadResult.getEntryCount(), loadResult.getLoadedSizeBytes());
                    } else {
                        log.info("Cache load on startup: {}", loadResult.getMessage());
                    }
                } else {
                    log.info("Cache file does not exist. Skipping cache load on startup.");
                }
            } catch (Exception e) {
                log.warn("Failed to load cache on startup: {}", e.getMessage());
            }
        } else {
            if (restoreCacheOnStartup != null && !restoreCacheOnStartup) {
                log.info("Cache restore on startup is disabled (app.cache.persistence.restore-on-startup=false)");
            }
        }
        
        log.info("Application is ready. Preparing startup notification email...");

        if (shouldSkipStartupNotificationMail(event.getApplicationContext().getEnvironment())) {
            log.info("Startup email notification skipped (local / dev; see PatToolApplication).");
            return;
        }

        if (sendmail != null && sendmail && smtpMailSender != null && 
            mailSentFrom != null && !mailSentFrom.isEmpty() && 
            mailSentTo != null && !mailSentTo.isEmpty()) {
            
            try {
                String hostname = InetAddress.getLocalHost().getHostName();
                String hostAddress = InetAddress.getLocalHost().getHostAddress();
                String timestamp = LocalDateTime.now().format(DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss"));
                
                String subject = "PatTool Application Started - " + timestamp;
                
                String body = String.format(
                    "<html><body style='font-family: Arial, sans-serif;'>" +
                    "<h2 style='color: #2c3e50;'>PatTool Application Startup Notification</h2>" +
                    "<p>The PatTool application has successfully started.</p>" +
                    "<table style='border-collapse: collapse; width: 100%%; max-width: 600px;'>" +
                    "<tr style='background-color: #f2f2f2;'><td style='padding: 8px; border: 1px solid #ddd; font-weight: bold;'>Startup Time:</td><td style='padding: 8px; border: 1px solid #ddd;'>%s</td></tr>" +
                    "<tr><td style='padding: 8px; border: 1px solid #ddd; font-weight: bold;'>Hostname:</td><td style='padding: 8px; border: 1px solid #ddd;'>%s</td></tr>" +
                    "<tr style='background-color: #f2f2f2;'><td style='padding: 8px; border: 1px solid #ddd; font-weight: bold;'>IP Address:</td><td style='padding: 8px; border: 1px solid #ddd;'>%s</td></tr>" +
                    "<tr><td style='padding: 8px; border: 1px solid #ddd; font-weight: bold;'>Java Version:</td><td style='padding: 8px; border: 1px solid #ddd;'>%s</td></tr>" +
                    "<tr style='background-color: #f2f2f2;'><td style='padding: 8px; border: 1px solid #ddd; font-weight: bold;'>OS:</td><td style='padding: 8px; border: 1px solid #ddd;'>%s %s</td></tr>" +
                    "</table>" +
                    "<p style='margin-top: 20px; color: #7f8c8d; font-size: 12px;'>This is an automated notification from the PatTool application.</p>" +
                    "</body></html>",
                    timestamp,
                    hostname,
                    hostAddress,
                    System.getProperty("java.version"),
                    System.getProperty("os.name"),
                    System.getProperty("os.version")
                );
                
                smtpMailSender.sendMail(mailSentFrom, mailSentTo, subject, body, true);
                log.info("Startup notification email sent successfully to: {}", mailSentTo);
            } catch (Exception e) {
                log.error("Failed to send startup notification email: {}", e.getMessage(), e);
            }
        } else {
            log.info("Startup email notification skipped - email sending is disabled or not configured");
        }
    }

    /**
     * Avoid startup alert emails when the API is run on a developer machine.
     * Heuristics: Spring profile dev/local, explicit loopback {@code server.address}, or
     * {@code keycloak.auth-server-url} pointing at this machine (e.g. http://localhost:8080/auth).
     */
    private static boolean shouldSkipStartupNotificationMail(Environment env) {
        if (env == null) {
            return false;
        }
        for (String p : env.getActiveProfiles()) {
            if (p == null) {
                continue;
            }
            String pl = p.toLowerCase();
            if ("local".equals(pl) || "dev".equals(pl) || "development".equals(pl)) {
                return true;
            }
        }
        String serverAddress = env.getProperty("server.address", "");
        if (serverAddress != null && !serverAddress.isBlank()) {
            String a = serverAddress.trim().toLowerCase();
            if ("127.0.0.1".equals(a) || "localhost".equals(a) || "::1".equals(a)
                    || "0:0:0:0:0:0:0:1".equals(a)) {
                return true;
            }
        }
        return keycloakAuthServerUrlIsLocalhost(env.getProperty("keycloak.auth-server-url", ""));
    }

    private static boolean keycloakAuthServerUrlIsLocalhost(String url) {
        if (url == null || url.isBlank()) {
            return false;
        }
        try {
            URI uri = URI.create(url.trim());
            String host = uri.getHost();
            if (host == null) {
                return false;
            }
            host = host.toLowerCase();
            return "localhost".equals(host) || "127.0.0.1".equals(host)
                    || "::1".equals(host) || "0:0:0:0:0:0:0:1".equals(host);
        } catch (IllegalArgumentException e) {
            return false;
        }
    }
}
