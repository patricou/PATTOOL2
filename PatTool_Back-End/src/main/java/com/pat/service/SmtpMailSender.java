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
        String[] recipients = parseRecipients(to);
        for (String recipient : recipients) {
            MimeMessage mail = javaMailSender.createMimeMessage();
            try {
                MimeMessageHelper helper = new MimeMessageHelper(mail, true);
                helper.setTo(recipient);
                helper.setReplyTo(from);
                helper.setFrom(from);
                helper.setSubject(subject);
                helper.setText(body, isHtml);
                
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
