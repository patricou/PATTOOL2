package com.pat.service;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.core.io.FileSystemResource;
import org.springframework.mail.javamail.JavaMailSender;
import org.springframework.mail.javamail.MimeMessageHelper;
import org.springframework.scheduling.annotation.Async;
import org.springframework.stereotype.Component;

import jakarta.mail.MessagingException;
import jakarta.mail.internet.MimeMessage;
import java.io.File;

/**
 * Created by patricou on 01/06/2016.
 */
@Component
public class SmtpMailSender {

    private static final Logger log = LoggerFactory.getLogger(SmtpMailSender.class);

    @Autowired
    private JavaMailSender javaMailSender;

    @Async
    public void sendMail(String from,String to, String subject, String body){
        sendMail(from, to, subject, body, false);
    }

    @Async
    public void sendMail(String from,String to, String subject, String body, boolean isHtml){
        sendMail(from, to, null, subject, body, isHtml);
    }

    @Async
    public void sendMail(String from, String to, String bcc, String subject, String body, boolean isHtml){
        String[] recipients = parseRecipients(to);
        for (String recipient : recipients) {
            MimeMessage mail = javaMailSender.createMimeMessage();
            try {
                MimeMessageHelper helper = new MimeMessageHelper(mail, true, "UTF-8");
                helper.setTo(recipient);
                if (bcc != null && !bcc.trim().isEmpty()) {
                    String[] bccRecipients = parseRecipients(bcc);
                    helper.setBcc(bccRecipients);
                }
                helper.setReplyTo(from);
                helper.setFrom(from);
                helper.setSubject(subject);
                
                if (isHtml) {
                    // For HTML emails, set both HTML and plain text versions to avoid spam filters
                    String plainText = htmlToPlainText(body);
                    helper.setText(plainText, body);
                } else {
                    helper.setText(body, false);
                }
                
                // Add anti-spam headers
                mail.setHeader("X-Mailer", "PatTool Application");
                mail.setHeader("X-Priority", "3"); // Normal priority
                mail.setHeader("X-MSMail-Priority", "Normal");
                mail.setHeader("Importance", "Normal");
                mail.setHeader("Precedence", "bulk");
                mail.setHeader("Auto-Submitted", "auto-generated");
                
                // Add Message-ID for better deliverability
                if (mail.getMessageID() == null) {
                    mail.setHeader("Message-ID", generateMessageId());
                }
                
                log.debug("Sending email via SMTP - To: {}, Subject: {}, HTML: {}", recipient, subject, isHtml);
                javaMailSender.send(mail);
                log.debug("Email sent successfully to {}", recipient);
            } catch (MessagingException e) {
                log.error("MessagingException while sending email to {}: {}", recipient, e.getMessage(), e);
                throw new RuntimeException("Failed to send email: " + e.getMessage(), e);
            } catch (Exception e) {
                log.error("Exception while sending email to {}: {}", recipient, e.getMessage(), e);
                throw new RuntimeException("Failed to send email: " + e.getMessage(), e);
            }
        }
    }
    
    /**
     * Convert HTML to plain text for email clients that don't support HTML
     * This helps avoid spam filters by providing a text alternative
     */
    private String htmlToPlainText(String html) {
        if (html == null) {
            return "";
        }
        // Simple HTML to text conversion
        String text = html
                .replaceAll("<style[^>]*>.*?</style>", "") // Remove style tags
                .replaceAll("<script[^>]*>.*?</script>", "") // Remove script tags
                .replaceAll("<[^>]+>", " ") // Remove all HTML tags
                .replaceAll("&nbsp;", " ")
                .replaceAll("&amp;", "&")
                .replaceAll("&lt;", "<")
                .replaceAll("&gt;", ">")
                .replaceAll("&quot;", "\"")
                .replaceAll("&#39;", "'")
                .replaceAll("\\s+", " ") // Multiple spaces to single space
                .trim();
        
        // Limit length to avoid issues
        if (text.length() > 50000) {
            text = text.substring(0, 50000) + "... [Content truncated]";
        }
        
        return text.isEmpty() ? "Exception & Connection Report (HTML email - please enable HTML to view)" : text;
    }
    
    /**
     * Generate a unique Message-ID for better email deliverability
     */
    private String generateMessageId() {
        return "<" + System.currentTimeMillis() + "." + 
               System.nanoTime() + "@pattool>";
    }
    @Async
    public void sendMail(String from,String to, String subject, String body, String attachement){
        String[] recipients = parseRecipients(to);
        for (String recipient : recipients) {
            MimeMessage mail = javaMailSender.createMimeMessage();
            try {
                MimeMessageHelper helper = new MimeMessageHelper(mail, true);
                helper.setTo(recipient);
                helper.setReplyTo(from);
                helper.setFrom(from);
                helper.setSubject(subject);
                helper.setText(body);
                helper.addAttachment(attachement, new FileSystemResource(new File(attachement)));
                javaMailSender.send(mail);
                log.debug("Email with attachment sent successfully to {}", recipient);
            } catch (MessagingException e) {
                log.error("MessagingException while sending email with attachment to {}: {}", recipient, e.getMessage(), e);
                throw new RuntimeException("Failed to send email with attachment: " + e.getMessage(), e);
            }
        }
    }

    private String[] parseRecipients(String recipients) {
        if (recipients == null || recipients.trim().isEmpty()) {
            return new String[0];
        }
        return recipients.split("\\s*,\\s*");
    }
}
