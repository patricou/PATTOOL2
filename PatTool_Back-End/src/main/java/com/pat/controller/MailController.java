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
        return sendMail(subject, body, false);
    }

    // Internal method for sending HTML emails (called from other controllers)
    public String sendMail(String subject, String body, boolean isHtml){
        log.debug("=== MAIL SENDING ATTEMPT ===");
        log.debug("Subject: {}", subject);
        log.debug("To: {}", mailSentTo);
        log.debug("From: {}", mailSentFrom);
        log.debug("Mail enabled (app.sendmail): {}", sendmail);
        log.debug("HTML format: {}", isHtml);
        
        try {
            if (sendmail) {
                String[] recipients = parseRecipients(mailSentTo);
                log.debug("Sending mail to {} recipient(s)...", recipients.length);
                for (String recipient : recipients) {
                    smtpMailSender.sendMail(mailSentFrom, recipient, subject, body, isHtml);
                    log.debug("✓ Mail sent successfully to {} - Subject: '{}'", recipient, subject);
                }
            } else {
                log.warn("✗ Mail sending skipped - app.sendmail is set to false");
            }
        }catch(Exception e){
            log.error("✗ ERROR sending mail to {} - Subject: '{}' - Error: {}", 
                     mailSentTo, subject, e.getMessage(), e);
            e.printStackTrace();
        }
        
        log.debug("=== END MAIL SENDING ATTEMPT ===\n");
        return null;
    };

    // Internal method for sending emails to a specific recipient (called from other controllers)
    public String sendMailToRecipient(String recipientEmail, String subject, String body, boolean isHtml){
        return sendMailToRecipient(recipientEmail, subject, body, isHtml, null);
    }

    // Internal method for sending emails to a specific recipient with BCC (called from other controllers)
    public String sendMailToRecipient(String recipientEmail, String subject, String body, boolean isHtml, String bcc){
        log.debug("=== MAIL SENDING ATTEMPT (TO SPECIFIC RECIPIENT) ===");
        log.debug("Subject: {}", subject);
        log.debug("To: {}", recipientEmail);
        log.debug("BCC: {}", bcc != null ? bcc : "none");
        log.debug("From: {}", mailSentFrom);
        log.debug("Mail enabled (app.sendmail): {}", sendmail);
        log.debug("HTML format: {}", isHtml);
        
        try {
            if (sendmail && recipientEmail != null && !recipientEmail.trim().isEmpty()) {
                smtpMailSender.sendMail(mailSentFrom, recipientEmail, bcc, subject, body, isHtml);
                log.debug("✓ Mail sent successfully to {} - Subject: '{}'", recipientEmail, subject);
            } else {
                if (!sendmail) {
                    log.warn("✗ Mail sending skipped - app.sendmail is set to false");
                } else {
                    log.warn("✗ Mail sending skipped - recipient email is empty");
                }
            }
        }catch(Exception e){
            log.error("✗ ERROR sending mail to {} - Subject: '{}' - Error: {}", 
                     recipientEmail, subject, e.getMessage(), e);
            e.printStackTrace();
        }
        
        log.debug("=== END MAIL SENDING ATTEMPT (TO SPECIFIC RECIPIENT) ===\n");
        return null;
    };
    
    // REST endpoint for sending emails via HTTP
    @PostMapping(value = "sendmail")
    public String sendMailViaRest(@RequestParam String subject, @RequestParam String body){
        return sendMail(subject, body);
    };

    public String sendMailWithAttachement(String subject, String body, String attachement){
        log.debug("=== MAIL SENDING ATTEMPT (WITH ATTACHMENT) ===");
        log.debug("Subject: {}", subject);
        log.debug("To: {}", mailSentTo);
        log.debug("From: {}", mailSentFrom);
        log.debug("Attachment: {}", attachement);
        log.debug("Mail enabled (app.sendmail): {}", sendmail);
        
        try {
            if (sendmail) {
                String[] recipients = parseRecipients(mailSentTo);
                log.debug("Sending mail with attachment to {} recipient(s)...", recipients.length);
                for (String recipient : recipients) {
                    smtpMailSender.sendMail(mailSentFrom, recipient, subject, body, attachement);
                    log.debug("✓ Mail with attachment sent successfully to {} - Subject: '{}' - Attachment: '{}'", 
                            recipient, subject, attachement);
                }
            } else {
                log.warn("✗ Mail sending skipped - app.sendmail is set to false");
            }
        }catch(Exception e){
            log.error("✗ ERROR sending mail with attachment to {} - Subject: '{}' - Attachment: '{}' - Error: {}", 
                     mailSentTo, subject, attachement, e.getMessage(), e);
            e.printStackTrace();
        }
        
        log.debug("=== END MAIL SENDING ATTEMPT (WITH ATTACHMENT) ===\n");
        return null;
    };

    private String[] parseRecipients(String recipients) {
        if (recipients == null || recipients.trim().isEmpty()) {
            return new String[0];
        }
        return recipients.split("\\s*,\\s*");
    }

    // Getter for mailSentTo (used for BCC in invitation emails)
    public String getMailSentTo() {
        return mailSentTo;
    }
}
