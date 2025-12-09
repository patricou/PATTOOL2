package com.pat.controller;

import com.pat.repo.domain.Member;
import com.pat.service.HomeIOTService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.GrantedAuthority;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.web.bind.annotation.*;

import java.util.HashMap;
import java.util.Map;

@RestController
@RequestMapping("/api")
public class HomeIOTController {

    private static final Logger log = LoggerFactory.getLogger(HomeIOTController.class);

    private final HomeIOTService homeIOTService;
    
    /**
     * Check if the current user has Iot role (case-insensitive)
     */
    private boolean hasIotRole() {
        Authentication authentication = SecurityContextHolder.getContext().getAuthentication();
        if (authentication == null) {
            return false;
        }
        return authentication.getAuthorities().stream()
                .map(GrantedAuthority::getAuthority)
                .anyMatch(authority -> authority.equalsIgnoreCase("ROLE_Iot") || 
                                     authority.equalsIgnoreCase("ROLE_iot"));
    }

    public HomeIOTController(HomeIOTService homeIOTService) {
        this.homeIOTService = homeIOTService;
    }

    @PostMapping(value = "/opcl")
    public Map<String, Object> openOrCLosePortail(@RequestBody Member member) {

        log.info(String.format("Open or close Portail / user id : %s ", member.getId()));
        if (hasIotRole()) {
            return homeIOTService.openOrClosePortail();
        } else {
            Map<String, Object> map = new HashMap<>();
            map.put("Unauthorized", member.getUserName() + " : You are not Authorized to Open/Close the external Gate. Iot role required.");
            return map;
        }
    }

    @PostMapping(value = "/testarduino")
    public Map<String, Object> testEthernetShield2(@RequestBody Member member) {
        log.info(String.format("Test Ethernet shield 2 / User id : %s ", member.getId()));

        if (hasIotRole()) {
            return homeIOTService.testEthernetShield2();
        } else {
            Map<String, Object> map = new HashMap<>();
            map.put("Unauthorized", member.getUserName() + " : You are not Authorized to Test the Arduino. Iot role required.");
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
