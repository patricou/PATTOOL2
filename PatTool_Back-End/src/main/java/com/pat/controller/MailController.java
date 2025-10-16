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

    @GetMapping(value = "sendmail/{message}")
    public String sendMail(@PathVariable String subject, String body){
        try {
            //log.info("Mail to be Sent : " +subject);
            if (sendmail) {
                smtpMailSender.sendMail(mailSentFrom, mailSentTo, subject, body);
                log.info("Mail Sent successfully ");
            }
        }catch(Exception e){
            e.printStackTrace();
        }

        return null;
    };

    public String sendMailWithAttachement(String subject, String body, String attachement){
        try {
            if (sendmail) smtpMailSender.sendMail(mailSentFrom, mailSentTo, subject, body, attachement);
        }catch(Exception e){
            e.printStackTrace();
        }

        return null;
    };
}
