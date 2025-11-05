package com.pat.service;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.core.io.FileSystemResource;
import org.springframework.core.io.InputStreamResource;
import org.springframework.core.io.InputStreamSource;
import org.springframework.core.io.Resource;
import org.springframework.mail.javamail.JavaMailSender;
import org.springframework.mail.javamail.MimeMessageHelper;
import org.springframework.scheduling.annotation.Async;
import org.springframework.stereotype.Component;

import jakarta.mail.MessagingException;
import jakarta.mail.internet.MimeMessage;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;

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
        MimeMessage mail = javaMailSender.createMimeMessage();
        try {
            MimeMessageHelper helper = new MimeMessageHelper(mail, true);
            helper.setTo(to);
            helper.setReplyTo(from);
            helper.setFrom(from);
            helper.setSubject(subject);
            helper.setText(body, isHtml);
            
            log.debug("Sending email via SMTP - To: {}, Subject: {}, HTML: {}", to, subject, isHtml);
            javaMailSender.send(mail);
            log.debug("Email sent successfully to {}", to);
        } catch (MessagingException e) {
            log.error("MessagingException while sending email to {}: {}", to, e.getMessage(), e);
            e.printStackTrace();
            throw new RuntimeException("Failed to send email: " + e.getMessage(), e);
        } catch (Exception e) {
            log.error("Exception while sending email to {}: {}", to, e.getMessage(), e);
            e.printStackTrace();
            throw new RuntimeException("Failed to send email: " + e.getMessage(), e);
        }
    }
    @Async
    public void sendMail(String from,String to, String subject, String body, String attachement){
        MimeMessage mail = javaMailSender.createMimeMessage();
        try {
            MimeMessageHelper helper = new MimeMessageHelper(mail, true);
            helper.setTo(to);
            helper.setReplyTo(from);
            helper.setFrom(from);
            helper.setSubject(subject);
            helper.setText(body);
            helper.addAttachment(attachement, new FileSystemResource(new File(attachement)));

        } catch (MessagingException e) {
            e.printStackTrace();
        } finally {}
        javaMailSender.send(mail);
        //return helper;
    }

}
