package com.pat.controller;

import com.pat.repo.domain.Member;
import com.pat.repo.MembersRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.web.bind.annotation.*;


import jakarta.servlet.http.HttpServletRequest;
import java.net.InetAddress;
import java.net.UnknownHostException;
import java.util.Enumeration;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Created by patricou on 4/20/2017.
 */
@RestController
@RequestMapping("/api/memb")
public class MemberRestController {

    private static final Logger log = LoggerFactory.getLogger(MemberRestController.class);

    @Autowired
    private MembersRepository membersRepository;

    @Autowired
    private MailController mailController;

    @RequestMapping(method = RequestMethod.GET)
    public List<Member> getListMembers(){
        return membersRepository.findAll();
    }

    @RequestMapping(
            value = "/user",
            method = RequestMethod.POST,
            consumes = {"application/json"},
            produces = { "application/json"}
    )
    @ResponseBody
    public Member getMemberbyUserNameAndRetrieveId(@RequestBody Member member, HttpServletRequest request){
        log.info("Member Recieved : " +  member.getKeycloakId() );
        member.setId(null);
        // retrieve Mlab Id by userName ( would have been better by keycloakId )
        Member memberWithId = membersRepository.findByUserName(member.getUserName());
        // Update the ID
        if (memberWithId != null ) {
            log.info("memberWithId " + memberWithId.getId());
            member.setId(memberWithId.getId());

            String ipAddress = request.getHeader("X-Forwarded-For");
            if (ipAddress == null) {
                ipAddress = request.getRemoteAddr();
            }

            String subject = "Connection User " + member.getUserName() + " ( "+ member.getFirstName()+ " "+member.getLastName() +" )";
            String body = subject +  " \nConnected on server "+ getIp() +" \nFrom Ip : " + ipAddress+"\n\n Headers :";

            Enumeration<String> headerNames = request.getHeaderNames();
            Map<String, String> headers = new HashMap<>();

            while (headerNames.hasMoreElements()) {
                String headerName = headerNames.nextElement();
                String headerValue = request.getHeader(headerName);
                if (! "authorization".equals(headerName.toString()))
                    body = body + "\n" + headerName + " : "+ headerValue;
            }
            if (!"patricou".equals(member.getUserName().toLowerCase()))
                mailController.sendMail(subject,body);
            log.info(subject + " From ip : "+ getIp());
        }

        // Save the member in Mlab ( if modif ( like email or... ) ( userName is unqiue )
        Member newMember = membersRepository.save(member);
        return newMember;
    }

    @RequestMapping(
            value = "/{id}",
            method = RequestMethod.GET,
            produces = { "application/json"}
            )
    public Member getMember(@PathVariable String id) {
        log.info("Get Member : " +  id );
        return membersRepository.findById(id).orElse(null);
    }

    private String getIp(){
        try{
            return InetAddress.getLocalHost().getHostAddress().toString();
        }catch(UnknownHostException e){

            return "UnknownHostException.";

        }
    }

}
