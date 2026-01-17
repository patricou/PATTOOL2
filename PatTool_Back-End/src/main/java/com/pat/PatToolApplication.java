package com.pat;

import com.pat.repo.CategoryLinkRepository;
import com.pat.repo.UrlLinkRepository;
import com.pat.service.CachePersistenceService;
import com.pat.service.SmtpMailSender;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.CommandLineRunner;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;
import org.springframework.data.mongodb.repository.config.EnableMongoRepositories;
import org.springframework.data.jpa.repository.config.EnableJpaRepositories;
import org.springframework.scheduling.annotation.EnableScheduling;
import org.springframework.context.annotation.ComponentScan;
import org.springframework.context.annotation.FilterType;

import java.net.InetAddress;
import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;

@SpringBootApplication(scanBasePackages = {"com.pat"})
@EnableScheduling
@EnableMongoRepositories(basePackages = "com.pat.repo")
// Exclude MongoDB repositories from JPA scanning to avoid warnings
// Only ChatRequestRepository should be processed as a JPA repository
@EnableJpaRepositories(
    basePackages = "com.pat.repo",
    excludeFilters = @ComponentScan.Filter(
        type = FilterType.ASSIGNABLE_TYPE,
        classes = {
            com.pat.repo.CategoryLinkRepository.class,
            com.pat.repo.DiscussionRepository.class,
            com.pat.repo.EvenementsRepository.class,
            com.pat.repo.FriendGroupRepository.class,
            com.pat.repo.FriendRepository.class,
            com.pat.repo.FriendRequestRepository.class,
            com.pat.repo.MacVendorMappingRepository.class,
            com.pat.repo.MembersRepository.class,
            com.pat.repo.NetworkDeviceMappingRepository.class,
            com.pat.repo.NewDeviceHistoryRepository.class,
            com.pat.repo.UrlLinkRepository.class,
            com.pat.repo.UserConnectionLogRepository.class
        }
    )
)
public class PatToolApplication implements CommandLineRunner {

    private static final Logger log = LoggerFactory.getLogger(PatToolApplication.class);

    public static void main(String[] args) {
        SpringApplication.run(PatToolApplication.class, args);
    }

    @Autowired
    CategoryLinkRepository categoryLinkRepository;
    @Autowired
    UrlLinkRepository urlLinkRepository;
    
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

    public void run(String... arg0) throws Exception {
         //initData();
    }
    
    @EventListener(ApplicationReadyEvent.class)
    public void onApplicationReady() {
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

    private void initData() {

      /*  CategoryLink categoryLink = new CategoryLink("1", "Commerce", "Commerce");
        categoryLinkRepository.save(categoryLink);
        categoryLinkRepository.save(new CategoryLink("2", "Administratif", "Administratif"));
        categoryLinkRepository.save(new CategoryLink("3", "Journeaux", "Journeaux"));
        categoryLinkRepository.save(new CategoryLink("4", "Social Media", "Social Media"));
        categoryLinkRepository.save(new CategoryLink("5", "Maison", "Maison"));
        categoryLinkRepository.save(new CategoryLink("7", "Professional", "Professional"));
        categoryLinkRepository.save(new CategoryLink("8", "Sport", "Sport"));
        categoryLinkRepository.save(new CategoryLink("9", "IT Knowledge", "IT Knowledge"));
        categoryLinkRepository.save(new CategoryLink("10", "IA", "IA"));
        categoryLinkRepository.save(new CategoryLink("11", "Famille", "Famille"));

        urlLinkRepository.save(new UrlLink("1", "Credit Agricole Centre EST", "CA Centre EST", "https://www.credit-agricole.fr/ca-centrest/professionnel/acceder-a-mes-comptes.html", "2"));
        urlLinkRepository.save(new UrlLink("2", "Maria DB", "Maria DB", "http://192.168.1.6/phpmyadmin/index.php?route=/sql&pos=0&db=patdb&table=urllinks", "5"));
        urlLinkRepository.save(new UrlLink("3", "NAS-DS216J Synology", "NAS-DS216J Synology", "http://192.168.1.6:5000/", "5"));
        urlLinkRepository.save(new UrlLink("4", "Courrier International", "Courrier International", "https://www.courrierinternational.com/", "3"));
        urlLinkRepository.save(new UrlLink("5", "Router Orbi R860", "Router Orbi", "http://192.168.1.1/start.htm", "5"));
        urlLinkRepository.save(new UrlLink("6", "Google Photo", "Google Photo", "https://photos.google.com/?tab=oq&pageId=none&pli=1", "4"));
        urlLinkRepository.save(new UrlLink("7", "Cams NAS Synology", "Cams NAS Synology", "https://patrickdeschamps.com:8004/webman/3rdparty/SurveillanceStation/", "5"));
        urlLinkRepository.save(new UrlLink("8", "Le Gessien", "Le Gessien", "https://lepaysgessien.lemessager.fr//", "3"));
        urlLinkRepository.save(new UrlLink("9", "Router Orbi Sattelite", "Router Orbi Sattelite", "http://192.168.1.14/", "5"));
        urlLinkRepository.save(new UrlLink("10", "Amazon", "Amazon", "https://www.amazon.fr/", "1"));
        urlLinkRepository.save(new UrlLink("11", "FaceBook", "FaceBook", "https://fr-fr.facebook.com/", "4"));
        urlLinkRepository.save(new UrlLink("12", "ChatGPT", "ChatGPT", "https://chat.openai.com/", "10"));
        urlLinkRepository.save(new UrlLink("13", "Next Bank", "Next Bank", "https://ebanking.ca-nextbank.ch/auth/login?afp-locale=fr", "2"));
        urlLinkRepository.save(new UrlLink("14", "Workspace", "Workspace", "https://myworkspace.jpmchase.com/vpn/myworkspace.html", "7"));
        urlLinkRepository.save(new UrlLink("15", "My Teckhub", "My Teckhub", "https://mytechub.jpmorganchase.com/#/", "7"));
        urlLinkRepository.save(new UrlLink("16", "HR View", "HR View", "https://myhrview.jpmorganchase.com/", "7"));
        urlLinkRepository.save(new UrlLink("17", "NAD Salon", "NAD", "http://192.168.1.5/", "5"));
        urlLinkRepository.save(new UrlLink("18", "Gigaset C530", "Gigaset C530", "http://192.168.1.19/", "5"));
        urlLinkRepository.save(new UrlLink("19", "Digit Radio", "Digit Radio", "http://192.168.1.7/", "5"));
        urlLinkRepository.save(new UrlLink("20", "Cam Salon", "Cam Salon", "http://192.168.1.47:88/?var=c6a23f9d", "5"));
        urlLinkRepository.save(new UrlLink("21", "Cam Entrée", "Cam Entrée", "http://192.168.1.48:88/", "5"));
        urlLinkRepository.save(new UrlLink("22", "Cam Garage", "Cam Garage", "http://192.168.1.3/", "5"));
        urlLinkRepository.save(new UrlLink("24", "Squeezbox radio", "Squeezbox radio", "https://www.mysqueezebox.com/player/viewPlayers", "5"));
        urlLinkRepository.save(new UrlLink("27", "Cam Cuisine", "Cam Cuisine", "http://192.168.1.52:88/?var=2f313a45", "5"));
        urlLinkRepository.save(new UrlLink("28", "Cam Jardin", "Cam Jardin", "http://192.168.1.37:88/", "5"));
        urlLinkRepository.save(new UrlLink("29", "Cam Portail", "Cam Portail", "http://192.168.1.60:88/?var=bbb29118", "5"));
        urlLinkRepository.save(new UrlLink("30", "TV LG", "TV LG", "http://192.168.1.46/", "5"));
        urlLinkRepository.save(new UrlLink("31", "Synology Account", "Synology Account", "https://www.synology.com/fr-fr", "5"));
        urlLinkRepository.save(new UrlLink("32", "SportPat", "SportPat", "https://www.patrickdeschamps.com:8000/", "8"));
        urlLinkRepository.save(new UrlLink("33", "Keycloak", "Keycloak", "https://patrickdeschamps.com:8543/", "5"));
        urlLinkRepository.save(new UrlLink("34", "Info Secheresse", "Info Secheresse", "https://info-secheresse.fr/department/indicator/groundwater", "8"));
        urlLinkRepository.save(new UrlLink("36", "Photos NAS Synology", "Photos NAS Synology", "https://patrickdeschamps.com:8004/?launchApp=SYNO.Foto.AppInstance#/personal_space/folder/2", "5"));
        urlLinkRepository.save(new UrlLink("37", "GeoPortail", "GeoPortail", "https://www.geoportail.gouv.fr/", "8"));
        urlLinkRepository.save(new UrlLink("38", "Le Monde", "Le Monde", "https://www.lemonde.fr/", "3"));
        urlLinkRepository.save(new UrlLink("39", "PeakFinder", "PeakFinder", "https://www.peakfinder.com/fr/?lat=46.34140&lng=6.10556&azi=90&alt=-2&fov=22.5&cfg=s&name=Mont%20Mourex", "8"));
        urlLinkRepository.save(new UrlLink("40", "EDemarche", "EDemarche", "https://www.ge.ch/e-demarches-fiscales", "2"));
        urlLinkRepository.save(new UrlLink("41", "Orange", "Orange", "https://www.orange.fr", "2"));
        urlLinkRepository.save(new UrlLink("42", "Google Earth", "Google Earth", "https://earth.google.com/web", "8"));
        urlLinkRepository.save(new UrlLink("43", "20 Minutes", "20 Minutes", "https://www.20minutes.fr/", "3"));
        urlLinkRepository.save(new UrlLink("44", "X (Twitter)", "X (Twitter)", "https://twitter.com/", "4"));
        urlLinkRepository.save(new UrlLink("45", "Carrefour", "Carrefour", "https://www.carrefour.fr/mon-compte", "1"));
        urlLinkRepository.save(new UrlLink("46", "Google Shopping", "Google Shopping", "https://shopping.google.com/?nord=1", "1"));
        urlLinkRepository.save(new UrlLink("47", "Oreilly", "Oreilly", "https://www.oreilly.com/member/login/", "7"));
        urlLinkRepository.save(new UrlLink("48", "Udemy", "Udemy", "https://www.udemy.com/", "7"));
        urlLinkRepository.save(new UrlLink("49", "Duckduckgo", "Duckduckgo", "https://duckduckgo.com/", "4"));
        urlLinkRepository.save(new UrlLink("50", "Gemini", "Gemini", "https://gemini.google.com/", "10"));
        urlLinkRepository.save(new UrlLink("51", "Stackblitz", "Stackblitz", "https://stackblitz.com/", "7"));
        urlLinkRepository.save(new UrlLink("52", "Sora", "Sora", "https://openai.com/sora", "4"));
        urlLinkRepository.save(new UrlLink("53", "Netflix", "Netflix", "https://www.netflix.com/", "4"));
        urlLinkRepository.save(new UrlLink("54", "Academind", "Academind", "https://academind.com/tutorials/", "9"));
        urlLinkRepository.save(new UrlLink("55", "Garmin Connect", "Garmin Connect", "https://www.garmin.com/fr-FR/c/apps/", "8"));
        urlLinkRepository.save(new UrlLink("56", "France Connect", "France Connect", "https://franceconnect.gouv.fr/", "2"));
        urlLinkRepository.save(new UrlLink("57", "EDF", "EDF", "https://www.edf.fr/", "2"));
        urlLinkRepository.save(new UrlLink("58", "Tutorialspoint", "Tutorialspoint", "https://www.tutorialspoint.com/index.htm", "9"));
        urlLinkRepository.save(new UrlLink("59", "PAT-NAS-DS923+", "PAT-NAS-DS923+", "https://patrickdeschamps.com:8004/", "5"));
        urlLinkRepository.save(new UrlLink("60", "Geneanet", "Geneanet", "https://www.geneanet.org/", "11"));
        urlLinkRepository.save(new UrlLink("61", "Microspot", "Microspot", "https://www.microspot.ch/", "1"));
        urlLinkRepository.save(new UrlLink("62", "K-net", "K-net", "https://www.k-net.fr/", "5"));
        urlLinkRepository.save(new UrlLink("63", "Espace-client.k-net", "Espace-client.k-net", "https://espace-client.k-net.fr/", "5"));
        urlLinkRepository.save(new UrlLink("64", "PAT-NAS-DS923+ (local)", "PAT-NAS-DS923+ (local)", "http://192.168.1.68:5000/", "5"));
        urlLinkRepository.save(new UrlLink("65", "Fnac", "Fnac", "https://www.fnac.com/", "1")); */

    }
}
