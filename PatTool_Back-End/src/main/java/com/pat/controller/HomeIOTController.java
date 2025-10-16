package com.pat.controller;

import com.pat.domain.Member;
import com.pat.service.HomeIOTService;
import org.apache.tomcat.util.net.openssl.ciphers.Authentication;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.web.bind.annotation.*;

import java.security.Principal;
import java.util.HashMap;
import java.util.Map;

@RestController
@RequestMapping("/api")
public class HomeIOTController {

    private static final Logger log = LoggerFactory.getLogger(HomeIOTController.class);

    @Value("${app.iot.userid}")
    String UserId;

    private final HomeIOTService homeIOTService;

    public HomeIOTController(HomeIOTService homeIOTService) {
        this.homeIOTService = homeIOTService;
    }

    @PostMapping(value = "/opcl")
    public Map<String, Object> openOrCLosePortail(@RequestBody Member member) {

        log.info(String.format(String.format("Open or close Portail / user id : %s ",member.getId() )));
        if (this.UserId.equals(member.getId()))
            return homeIOTService.openOrClosePortail();
        else {
            Map map = new HashMap();
            map.put("Unauthorized",member.getUserName() + " : You are not Authorized to Open/Close the external Gate ");
            return map;
        }
    }

    @PostMapping(value = "/testarduino")
    public Map<String, Object> testEthernetShield2(@RequestBody Member member) {
        log.info(String.format("Test Ethernet shield 2 / User id : %s ", member.getId()));

        if (this.UserId.equals(member.getId()))
            return homeIOTService.testEthernetShield2();
        else {
            Map map = new HashMap();
            map.put("Unauthorized",member.getUserName() + " : You are not Authorized to Test the Arduino ");
            return map;
        }
    }

    @GetMapping(value = "/relais1statuson", produces = { "application/json"})
    public String setValueOfRelais1On(){
        return homeIOTService.setStatusOfRelais1ToOn();
    }

    @GetMapping(value = "/relais1statusoff", produces = { "application/json"})
    public String setValueOfRelais1Off(){
        return homeIOTService.setStatusOfRelais1ToOff();
    }

    @GetMapping(value = "/relais1status", produces = { "application/json"})
    public String getValueOfRelais1(){
        return homeIOTService.getStatusOfRelais1();
    }

}
