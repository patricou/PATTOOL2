package com.pat.controller;

import com.pat.service.SmtpMailSender;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api")
public class MailController {

    private static final Logger log = LoggerFactory.getLogger(MailController.class);

    @Autowired
    private SmtpMailSender smtpMailSender;

    @Value("${app.mailsentfrom}")
    String mailSentFrom;

    @Value("${app.mailsentto}")
    String mailSentTo;

    @Value("${app.sendmail}")
    Boolean sendmail;

    // Internal method for sending emails (called from other controllers)
    public String sendMail(String subject, String body){
        log.info("=== MAIL SENDING ATTEMPT ===");
        log.info("Subject: {}", subject);
        log.info("To: {}", mailSentTo);
        log.info("From: {}", mailSentFrom);
        log.info("Mail enabled (app.sendmail): {}", sendmail);
        
        try {
            if (sendmail) {
                log.info("Sending mail to {}...", mailSentTo);
                smtpMailSender.sendMail(mailSentFrom, mailSentTo, subject, body);
                log.info("✓ Mail sent successfully to {} - Subject: '{}'", mailSentTo, subject);
            } else {
                log.warn("✗ Mail sending skipped - app.sendmail is set to false");
            }
        }catch(Exception e){
            log.error("✗ ERROR sending mail to {} - Subject: '{}' - Error: {}", 
                     mailSentTo, subject, e.getMessage(), e);
            e.printStackTrace();
        }
        
        log.info("=== END MAIL SENDING ATTEMPT ===\n");
        return null;
    };
    
    // REST endpoint for sending emails via HTTP
    @PostMapping(value = "sendmail")
    public String sendMailViaRest(@RequestParam String subject, @RequestParam String body){
        return sendMail(subject, body);
    };

    public String sendMailWithAttachement(String subject, String body, String attachement){
        log.info("=== MAIL SENDING ATTEMPT (WITH ATTACHMENT) ===");
        log.info("Subject: {}", subject);
        log.info("To: {}", mailSentTo);
        log.info("From: {}", mailSentFrom);
        log.info("Attachment: {}", attachement);
        log.info("Mail enabled (app.sendmail): {}", sendmail);
        
        try {
            if (sendmail) {
                log.info("Sending mail with attachment to {}...", mailSentTo);
                smtpMailSender.sendMail(mailSentFrom, mailSentTo, subject, body, attachement);
                log.info("✓ Mail with attachment sent successfully to {} - Subject: '{}' - Attachment: '{}'", 
                        mailSentTo, subject, attachement);
            } else {
                log.warn("✗ Mail sending skipped - app.sendmail is set to false");
            }
        }catch(Exception e){
            log.error("✗ ERROR sending mail with attachment to {} - Subject: '{}' - Attachment: '{}' - Error: {}", 
                     mailSentTo, subject, attachement, e.getMessage(), e);
            e.printStackTrace();
        }
        
        log.info("=== END MAIL SENDING ATTEMPT (WITH ATTACHMENT) ===\n");
        return null;
    };
}
